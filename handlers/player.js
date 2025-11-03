module.exports = function registerPlayerHandlers(io, db, socket, utils) {
  socket.on("resume", (playerName) => {
    if (!playerName) return;
    const player = db
      .prepare("SELECT * FROM players WHERE name = ?")
      .get(playerName);
    if (player) {
      socket.data.playerName = playerName;
      socket.emit("joined_as_player", playerName);
      // Send game/questions first so the client knows if the game is started
      socket.emit("questions_payload", {
        questions: utils.getQuestionsPublic(db),
        game: utils.getGameState(db),
      });
      // Then send team info; client can decide visibility based on game state
      socket.emit("teams_update", utils.getAllTeams(db));
    } else {
      socket.emit("resume_failed");
    }
  });

  socket.on("join_player", (payload) => {
    const playerName = typeof payload === "string" ? payload : payload?.name;
    const externalId = typeof payload === "object" && payload ? payload.external_id : null;
    if (!playerName) return;
    try {
      if (externalId != null) {
        db.prepare("INSERT INTO players (name, external_id) VALUES (?, ?)").run(
          playerName,
          externalId
        );
      } else {
        db.prepare("INSERT INTO players (name) VALUES (?)").run(playerName);
      }
      socket.data.playerName = playerName;
      socket.emit("joined_as_player", playerName);
      io.emit("teams_update", utils.getAllTeams(db));
    } catch {
      socket.emit("name_taken");
    }
  });

  socket.on("create_team", (teamName) => {
    const playerName = socket.data.playerName;
    if (!playerName) return;
    const gameStarted = utils.isGameStarted(db);
    if (gameStarted) {
      const p = db.prepare("SELECT team_id FROM players WHERE name = ?").get(playerName);
      if (p && p.team_id) { socket.emit("game_frozen"); return; }
    }
    try {
      const result = db
        .prepare("INSERT INTO teams (name) VALUES (?)")
        .run(teamName);
      const teamId = result.lastInsertRowid;
      // db.prepare("UPDATE teams SET creator_name = ? WHERE id = ?").run(playerName, teamId);
      if (gameStarted) {
        db.prepare("UPDATE teams SET current_question = 1 WHERE id = ?").run(teamId);
      }
      db.prepare(
        "UPDATE players SET team_id = ?, is_creator = 1 WHERE name = ?"
      ).run(teamId, playerName);
      io.emit("teams_update", utils.getAllTeams(db));
      if (gameStarted) {
        socket.emit("questions_payload", { questions: utils.getQuestionsPublic(db), game: utils.getGameState(db) });
      }
      utils.sendAdminState(io, db);
    } catch {
      socket.emit("team_name_taken");
    }
  });

  socket.on("join_team", (teamName) => {
    const playerName = socket.data.playerName;
    if (!playerName) return;
    const gameStarted = utils.isGameStarted(db);
    const team = db
      .prepare("SELECT id FROM teams WHERE name = ?")
      .get(teamName);
    if (!team) return;
    const player = db
      .prepare("SELECT team_id FROM players WHERE name = ?")
      .get(playerName);
    if (gameStarted && player && player.team_id) { socket.emit("must_leave_first"); return; }
    if (player && player.team_id && player.team_id !== team.id) {
      socket.emit("must_leave_first");
      return;
    }
    const count = db
      .prepare("SELECT COUNT(*) as c FROM players WHERE team_id = ?")
      .get(team.id);
    if (count.c >= 5) {
      socket.emit("team_full");
      return;
    }
    // Check if the team already has a captain BEFORE we reassign this player to the team
    const existingCap = db
      .prepare(
        "SELECT 1 FROM players WHERE team_id = ? AND is_creator = 1 LIMIT 1"
      )
      .get(team.id);
    // Now assign the player to the team
    db.prepare("UPDATE players SET team_id = ? WHERE name = ?").run(
      team.id,
      playerName
    );
    if (existingCap) {
      db.prepare("UPDATE players SET is_creator = 0 WHERE name = ?").run(
        playerName
      );
    } else {
      // No captain in this team; make the joiner captain
      db.prepare("UPDATE players SET is_creator = 1 WHERE name = ?").run(
        playerName
      );
    }
    io.emit("teams_update", utils.getAllTeams(db));
    if (gameStarted) {
      socket.emit("questions_payload", { questions: utils.getQuestionsPublic(db), game: utils.getGameState(db) });
    }
    utils.sendAdminState(io, db);
  });

  socket.on("leave_team", () => {
    const playerName = socket.data.playerName;
    if (!playerName) return;
    if (utils.isGameStarted(db)) {
      socket.emit("game_frozen");
      return;
    }
    const row = db
      .prepare("SELECT team_id FROM players WHERE name = ?")
      .get(playerName);
    const teamId = row ? row.team_id : null;
    db.prepare("UPDATE players SET team_id = NULL, is_creator = 0 WHERE name = ?").run(playerName);
    if (teamId) {
      const count = db
        .prepare("SELECT COUNT(*) as c FROM players WHERE team_id = ?")
        .get(teamId);
      if (count && count.c === 0) {
        db.prepare("DELETE FROM answers WHERE team_id = ?").run(teamId);
        db.prepare("DELETE FROM teams WHERE id = ?").run(teamId);
      }
    }
    io.emit("teams_update", utils.getAllTeams(db));
    utils.sendAdminState(io, db);
  });

  socket.on("submit_answer", (answer) => {
    const playerName = socket.data.playerName;
    if (!playerName) return;
    const player = db
      .prepare("SELECT * FROM players WHERE name = ?")
      .get(playerName);
    if (!player || !player.is_creator) return;
    const team = db
      .prepare("SELECT * FROM teams WHERE id = ?")
      .get(player.team_id);
    const gameState = db
      .prepare("SELECT * FROM game_state WHERE id = 1")
      .get();
    if (gameState.ended) return;
    const currentPosition = team.current_question;
    const qRow = db
      .prepare("SELECT id, correct_answer FROM questions WHERE position = ?")
      .get(currentPosition);
    if (!qRow) return;
    const normalize = (s) => (s ?? "").toString().trim().toLowerCase().replace(/\s+/g, " ");
    const given = normalize(answer);
    const correct = normalize(qRow.correct_answer);
    if (given && correct && given === correct) {
      db.prepare(
        "INSERT INTO answers (team_id, question_id, answer) VALUES (?, ?, ?)"
      ).run(team.id, qRow.id, answer);
      db.prepare(
        "UPDATE teams SET current_question = current_question + 1 WHERE id = ?"
      ).run(team.id);
      io.emit("teams_update", utils.getAllTeams(db));
      socket.emit("answer_result", { correct: true });
      utils.sendAdminState(io, db);
    } else {
      socket.emit("answer_result", { correct: false, message: "Wrong answer. Try again." });
    }
  });

  socket.on("player_get_questions", () => {
    socket.emit("questions_payload", {
      questions: utils.getQuestionsPublic(db),
      game: utils.getGameState(db),
    });
  });

  socket.on("player_get_hints_state", () => {
    const playerName = socket.data.playerName;
    if (!playerName) return;
    const player = db
      .prepare("SELECT team_id FROM players WHERE name = ?")
      .get(playerName);
    const teamId = player ? player.team_id : null;
    const hs = utils.getTeamHintsState(db, teamId);
    socket.emit("hints_state", hs);
  });

  socket.on("request_hint", () => {
    const playerName = socket.data.playerName;
    if (!playerName) return;
    const player = db
      .prepare("SELECT * FROM players WHERE name = ?")
      .get(playerName);
    if (!player || !player.is_creator) return;
    const gs = utils.getGameState(db);
    if (!gs || !gs.started || gs.ended) return;
    const team = db
      .prepare("SELECT * FROM teams WHERE id = ?")
      .get(player.team_id);
    if (!team) return;
    const pos = team.current_question;
    const q = db
      .prepare("SELECT id, hint FROM questions WHERE position = ?")
      .get(pos);
    if (!q) return;
    const state = utils.getTeamHintsState(db, team.id);
    if (state.left <= 0) return;
    const exists = db
      .prepare("SELECT 1 FROM hints WHERE team_id = ? AND question_id = ?")
      .get(team.id, q.id);
    if (exists) {
      // already took a hint for this question; still emit state
      const hs = utils.getTeamHintsState(db, team.id);
      socket.emit("hints_state", hs);
      utils.sendAdminState(io, db);
      return;
    }
    db.prepare("INSERT INTO hints (team_id, question_id) VALUES (?, ?)").run(team.id, q.id);
    const hs = utils.getTeamHintsState(db, team.id);
    // Broadcast hint reveal to all clients; clients filter by team
    // Also send latest hints state to trigger counters update client-side
    io.emit("hint_revealed", {
      teamId: team.id,
      questionId: q.id,
      hint: q.hint || "",
      used: hs.used,
      left: hs.left,
      max: hs.max,
    });
    utils.sendAdminState(io, db);
  });

  socket.on("player_get_info", () => {
    const playerName = socket.data.playerName;
    if (!playerName) return;
    const p = db
      .prepare("SELECT is_creator FROM players WHERE name = ?")
      .get(playerName);
    socket.emit("player_info", { is_creator: !!(p && p.is_creator) });

  // ---------- Join requests (captain approval) ----------

  // Applicants request to join a team (does not assign immediately)
  socket.on("request_join_team", (teamName) => {
    const playerName = socket.data.playerName;
    if (!playerName || !teamName) return;
    const team = db.prepare("SELECT id, name FROM teams WHERE name = ?").get(teamName);
    if (!team) return;

    // Must be unassigned
    const applicant = db.prepare("SELECT team_id FROM players WHERE name = ?").get(playerName);
    if (!applicant || applicant.team_id) {
      socket.emit("join_result", { playerName, accepted: false, reason: "already_in_team" });
      return;
    }
    // Soft capacity check
    const cnt = db.prepare("SELECT COUNT(*) as c FROM players WHERE team_id = ?").get(team.id);
    if (cnt.c >= 5) {
      socket.emit("join_result", { playerName, accepted: false, reason: "team_full" });
      return;
    }

    try {
      db.prepare("INSERT INTO join_requests (team_id, player_name) VALUES (?, ?)").run(team.id, playerName);
    } catch (e) {
      // ignore duplicate
    }

    // Acknowledge to applicant and notify captains (client will filter by team)
    socket.emit("join_request_ack", { teamId: team.id, teamName: team.name });
    io.emit("join_request", { teamId: team.id, teamName: team.name, playerName });
  });

  // Captain fetches pending requests for their team
  socket.on("captain_list_requests", () => {
    const playerName = socket.data.playerName;
    if (!playerName) return;
    const cap = db.prepare("SELECT is_creator, team_id FROM players WHERE name = ?").get(playerName);
    if (!cap || !cap.is_creator || !cap.team_id) return;
    const items = db
      .prepare("SELECT player_name, created_at FROM join_requests WHERE team_id = ? ORDER BY created_at ASC")
      .all(cap.team_id);
    socket.emit("join_requests", { teamId: cap.team_id, items });
  });

  // Captain decision on a pending request
  socket.on("captain_decide_join", ({ playerName: applicantName, accept }) => {
    const captainName = socket.data.playerName;
    if (!captainName || !applicantName) return;
    const cap = db.prepare("SELECT is_creator, team_id FROM players WHERE name = ?").get(captainName);
    if (!cap || !cap.is_creator || !cap.team_id) return;

    const req = db
      .prepare("SELECT id FROM join_requests WHERE team_id = ? AND player_name = ?")
      .get(cap.team_id, applicantName);
    if (!req) return;

    if (!accept) {
      db.prepare("DELETE FROM join_requests WHERE id = ?").run(req.id);
      io.emit("join_result", { playerName: applicantName, accepted: false, teamId: cap.team_id, reason: "rejected" });
      const items = db
        .prepare("SELECT player_name, created_at FROM join_requests WHERE team_id = ? ORDER BY created_at ASC")
        .all(cap.team_id);
      socket.emit("join_requests", { teamId: cap.team_id, items });
      return;
    }

    // Accept: ensure applicant still unassigned and capacity available
    const applicant = db.prepare("SELECT team_id FROM players WHERE name = ?").get(applicantName);
    if (!applicant || applicant.team_id) {
      db.prepare("DELETE FROM join_requests WHERE id = ?").run(req.id);
      io.emit("join_result", { playerName: applicantName, accepted: false, teamId: cap.team_id, reason: "stale" });
      const items = db
        .prepare("SELECT player_name, created_at FROM join_requests WHERE team_id = ? ORDER BY created_at ASC")
        .all(cap.team_id);
      socket.emit("join_requests", { teamId: cap.team_id, items });
      return;
    }
    const cnt2 = db.prepare("SELECT COUNT(*) as c FROM players WHERE team_id = ?").get(cap.team_id);
    if (cnt2.c >= 5) {
      db.prepare("DELETE FROM join_requests WHERE id = ?").run(req.id);
      io.emit("join_result", { playerName: applicantName, accepted: false, teamId: cap.team_id, reason: "team_full" });
      const items = db
        .prepare("SELECT player_name, created_at FROM join_requests WHERE team_id = ? ORDER BY created_at ASC")
        .all(cap.team_id);
      socket.emit("join_requests", { teamId: cap.team_id, items });
      return;
    }
    // Assign and cleanup
    db.prepare("UPDATE players SET team_id = ? WHERE name = ?").run(cap.team_id, applicantName);
    db.prepare("DELETE FROM join_requests WHERE id = ?").run(req.id);

    io.emit("teams_update", utils.getAllTeams(db));
    io.emit("join_result", { playerName: applicantName, accepted: true, teamId: cap.team_id });
    if (utils.isGameStarted(db)) {
      io.emit("questions_payload_for", {
        playerName: applicantName,
        questions: utils.getQuestionsPublic(db),
        game: utils.getGameState(db),
      });
    }
    const items = db
      .prepare("SELECT player_name, created_at FROM join_requests WHERE team_id = ? ORDER BY created_at ASC")
      .all(cap.team_id);
    socket.emit("join_requests", { teamId: cap.team_id, items });
  });
  });
};

