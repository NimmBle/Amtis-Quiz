module.exports = function registerAdminHandlers(io, db, socket, utils) {
  socket.on("admin_login", (code) => {
    try {
      const row = db.prepare("SELECT code FROM admin_config WHERE id = 1").get();
      if (!row || row.code == null) {
        db.prepare("UPDATE admin_config SET code = ? WHERE id = 1").run(String(code));
        socket.data.isAdmin = true;
        socket.join("admins");
        socket.emit("admin_logged_in");
        utils.sendAdminState(io, db, socket);
        return;
      }
      if (String(code) === String(row.code)) {
        socket.data.isAdmin = true;
        socket.join("admins");
        socket.emit("admin_logged_in");
        utils.sendAdminState(io, db, socket);
      } else {
        socket.emit("admin_error", "Wrong admin code");
      }
    } catch (e) {
      socket.emit("admin_error", "Login failed");
    }
  });

  socket.on("start_game", () => {
    if (!socket.data.isAdmin) return;
    db.prepare("UPDATE game_state SET started = 1, ended = 0 WHERE id = 1").run();
    // reset previous hint and answer usage
    db.prepare("DELETE FROM hints").run();
    db.prepare("DELETE FROM answers").run();
    db.prepare("UPDATE teams SET current_question = 1").run();
    io.emit("game_started");
    io.emit("teams_update", utils.getAllTeams(db));
    io.emit("questions_payload", {
      questions: utils.getQuestions(db),
      game: utils.getGameState(db),
    });
    utils.sendAdminState(io, db);
  });

  socket.on("end_game", () => {
    if (!socket.data.isAdmin) return;
    db.prepare("UPDATE game_state SET ended = 1, started = 0 WHERE id = 1").run();
    io.emit("game_ended");
    utils.sendAdminState(io, db);
  });

  socket.on("admin_set_max_hints", (value) => {
    if (!socket.data.isAdmin) return;
    let n = Number(value);
    if (!Number.isFinite(n)) return;
    n = Math.max(0, Math.floor(n));
    try {
      db.prepare("UPDATE admin_config SET max_hints = ? WHERE id = 1").run(n);
      utils.sendAdminState(io, db);
    } catch (e) {
      socket.emit("admin_error", "Failed to update max hints");
    }
  });

  socket.on("admin_add_question", ({ image_url, text, hint, correct_answer }) => {
    if (!socket.data.isAdmin) return;
    const cleanHint = (hint ?? "").toString().trim();
    const cleanAnswer = (correct_answer ?? "").toString().trim();
    if (!cleanHint) {
      socket.emit("admin_error", "Hint is required for each question");
      return;
    }
    if (!cleanAnswer) {
      socket.emit("admin_error", "Correct answer is required for each question");
      return;
    }
    const maxPosRow = db
      .prepare("SELECT COALESCE(MAX(position), 0) AS maxp FROM questions")
      .get();
    const nextPos = (maxPosRow?.maxp || 0) + 1;
    db.prepare(
      "INSERT INTO questions (image_url, text, hint, correct_answer, position) VALUES (?, ?, ?, ?, ?)"
    ).run(image_url || null, text || null, cleanHint, cleanAnswer, nextPos);
    io.to("admins").emit("questions_update", utils.getQuestions(db));
    utils.sendAdminState(io, db);
  });

  socket.on("admin_remove_question", (id) => {
    if (!socket.data.isAdmin) return;
    db.prepare("DELETE FROM questions WHERE id = ?").run(id);
    const rows = db
      .prepare("SELECT id FROM questions ORDER BY position ASC, id ASC")
      .all();
    const upd = db.prepare("UPDATE questions SET position = ? WHERE id = ?");
    let pos = 1;
    for (const r of rows) upd.run(pos++, r.id);
    io.to("admins").emit("questions_update", utils.getQuestions(db));
    utils.sendAdminState(io, db);
  });

  socket.on("admin_move_question", ({ id, direction }) => {
    if (!socket.data.isAdmin) return;
    const rows = db
      .prepare(
        "SELECT id, position FROM questions ORDER BY position ASC, id ASC"
      )
      .all();
    const idx = rows.findIndex((r) => r.id === id);
    if (idx < 0) return;
    if (direction === "up" && idx > 0) {
      const a = rows[idx - 1];
      const b = rows[idx];
      db.prepare("UPDATE questions SET position = ? WHERE id = ?").run(
        b.position,
        a.id
      );
      db.prepare("UPDATE questions SET position = ? WHERE id = ?").run(
        a.position,
        b.id
      );
    } else if (direction === "down" && idx < rows.length - 1) {
      const a = rows[idx];
      const b = rows[idx + 1];
      db.prepare("UPDATE questions SET position = ? WHERE id = ?").run(
        b.position,
        a.id
      );
      db.prepare("UPDATE questions SET position = ? WHERE id = ?").run(
        a.position,
        b.id
      );
    }
    io.to("admins").emit("questions_update", utils.getQuestions(db));
    utils.sendAdminState(io, db);
  });

  socket.on("admin_update_question", (payload) => {
    if (!socket.data.isAdmin) return;
    const { id } = payload || {};
    if (!id) return;
    const curr = db
      .prepare(
        "SELECT id, image_url, text, hint, correct_answer FROM questions WHERE id = ?"
      )
      .get(id);
    if (!curr) return;
    const image_url =
      payload.hasOwnProperty("image_url") ? payload.image_url : curr.image_url;
    const text = payload.hasOwnProperty("text") ? payload.text : curr.text;
    const hint = payload.hasOwnProperty("hint") ? payload.hint : curr.hint;
    const correct_answer = payload.hasOwnProperty("correct_answer")
      ? payload.correct_answer
      : curr.correct_answer;
    const cleanHint = (hint ?? "").toString().trim();
    const cleanAnswer = (correct_answer ?? "").toString().trim();
    if (!cleanHint || !cleanAnswer) {
      socket.emit("admin_error", "Hint and correct answer are required");
      return;
    }
    db.prepare(
      "UPDATE questions SET image_url = ?, text = ?, hint = ?, correct_answer = ? WHERE id = ?"
    ).run(image_url || null, text || null, cleanHint, cleanAnswer, id);
    io.to("admins").emit("questions_update", utils.getQuestions(db));
    utils.sendAdminState(io, db);
  });

  socket.on("admin_delete_team", (teamId) => {
    if (!socket.data.isAdmin) return;
    try {
      db.prepare("DELETE FROM answers WHERE team_id = ?").run(teamId);
      db.prepare(
        "UPDATE players SET team_id = NULL, is_creator = 0 WHERE team_id = ?"
      ).run(teamId);
      db.prepare("DELETE FROM teams WHERE id = ?").run(teamId);
      io.emit("teams_update", utils.getAllTeams(db));
      utils.sendAdminState(io, db);
    } catch (e) {
      // minimal error handling
    }
  });
};
