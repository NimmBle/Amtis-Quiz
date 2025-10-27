const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const db = require("./db");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

// Utility functions
function getAllTeams() {
  const stmt = db.prepare(`
    SELECT t.id, t.name, t.current_question,
           (SELECT name FROM players cp WHERE cp.team_id = t.id AND cp.is_creator = 1 LIMIT 1) AS captain
    FROM teams t
  `);
  const teams = stmt.all();
  return teams.map(t => {
    const members = db
      .prepare("SELECT name, external_id, is_creator FROM players WHERE team_id = ?")
      .all(t.id);
    return {
      id: t.id,
      name: t.name,
      players: members.map(m => m.name),
      players_detail: members,
      current_question: t.current_question,
      captain: t.captain || null,
    };
  });
}

function getQuestions() {
  return db
    .prepare(
      "SELECT id, image_url, text, position FROM questions ORDER BY position ASC, id ASC"
    )
    .all();
}

function getAnswers() {
  return db
    .prepare("SELECT id, team_id, question_id, answer FROM answers ORDER BY id ASC")
    .all();
}

function getGameState() {
  return db.prepare("SELECT * FROM game_state WHERE id = 1").get();
}

function isGameStarted() {
  const s = getGameState();
  return !!(s && s.started);
}

function sendAdminState(target) {
  const payload = {
    teams: getAllTeams(),
    questions: getQuestions(),
    answers: getAnswers(),
    game: getGameState(),
  };
  if (target && typeof target.emit === "function") {
    target.emit("admin_state", payload);
  } else {
    io.to("admins").emit("admin_state", payload);
  }
}

io.on("connection", (socket) => {

  socket.on("resume", (playerName) => {
    if (!playerName) return;
    const player = db.prepare("SELECT * FROM players WHERE name = ?").get(playerName);
    console.log("User connected:", player.name);
    if (player) {
      socket.data.playerName = playerName;
      socket.emit("joined_as_player", playerName);
      socket.emit("teams_update", getAllTeams());
      socket.emit("questions_payload", { questions: getQuestions(), game: getGameState() });
    } else {
      socket.emit("resume_failed");
    }
  });

  socket.on("join_player", (payload) => {
    const playerName = typeof payload === 'string' ? payload : (payload && payload.name);
    const externalId = typeof payload === 'object' && payload ? payload.external_id : null;
    if (!playerName) return;
    try {
      if (externalId != null) {
        db.prepare("INSERT INTO players (name, external_id) VALUES (?, ?)").run(playerName, externalId);
      } else {
        db.prepare("INSERT INTO players (name) VALUES (?)").run(playerName);
      }
      socket.data.playerName = playerName;
      socket.emit("joined_as_player", playerName);
      io.emit("teams_update", getAllTeams());
    } catch {
      socket.emit("name_taken");
    }
  });

  socket.on("create_team", (teamName) => {
    const playerName = socket.data.playerName;
    if (!playerName) return;
    if (isGameStarted()) {
      socket.emit("game_frozen");
      return;
    }
    try {
      const result = db.prepare("INSERT INTO teams (name) VALUES (?)").run(teamName);
      const teamId = result.lastInsertRowid;
      db.prepare("UPDATE players SET team_id = ?, is_creator = 1 WHERE name = ?").run(teamId, playerName);
      io.emit("teams_update", getAllTeams());
      sendAdminState();
    } catch {
      socket.emit("team_name_taken");
    }
  });

  socket.on("join_team", (teamName) => {
    const playerName = socket.data.playerName;
    if (!playerName) return;
    if (isGameStarted()) {
      socket.emit("game_frozen");
      return;
    }

    const team = db.prepare("SELECT id FROM teams WHERE name = ?").get(teamName);
    if (!team) return;
    // Enforce leave-first policy
    const player = db.prepare("SELECT team_id FROM players WHERE name = ?").get(playerName);
    if (player && player.team_id && player.team_id !== team.id) {
      socket.emit("must_leave_first");
      return;
    }

    const count = db.prepare("SELECT COUNT(*) as c FROM players WHERE team_id = ?").get(team.id);
    if (count.c >= 5) {
      socket.emit("team_full");
      return;
    }

    db.prepare("UPDATE players SET team_id = ? WHERE name = ?").run(team.id, playerName);
    io.emit("teams_update", getAllTeams());
    sendAdminState();
  });

  socket.on("leave_team", () => {
    const playerName = socket.data.playerName;
    if (!playerName) return;
    if (isGameStarted()) {
      socket.emit("game_frozen");
      return;
    }
    const row = db.prepare("SELECT team_id FROM players WHERE name = ?").get(playerName);
    const teamId = row ? row.team_id : null;
    db.prepare("UPDATE players SET team_id = NULL, is_creator = 0 WHERE name = ?").run(playerName);
    if (teamId) {
      const count = db.prepare("SELECT COUNT(*) as c FROM players WHERE team_id = ?").get(teamId);
      if (count && count.c === 0) {
        // Remove empty team and its answers
        db.prepare("DELETE FROM answers WHERE team_id = ?").run(teamId);
        db.prepare("DELETE FROM teams WHERE id = ?").run(teamId);
      }
    }
    io.emit("teams_update", getAllTeams());
    sendAdminState();
  });

  socket.on("admin_login", (code) => {
    try {
      const row = db.prepare("SELECT code FROM admin_config WHERE id = 1").get();
      if (!row || row.code == null) {
        db.prepare("UPDATE admin_config SET code = ? WHERE id = 1").run(String(code));
        socket.data.isAdmin = true;
        socket.join("admins");
        socket.emit("admin_logged_in");
        sendAdminState(socket);
        return;
      }
      if (String(code) === String(row.code)) {
        socket.data.isAdmin = true;
        socket.join("admins");
        socket.emit("admin_logged_in");
        sendAdminState(socket);
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
    // clear previous answers and reset progress
    db.prepare("DELETE FROM answers").run();
    // initialize team progress to first question
    db.prepare("UPDATE teams SET current_question = 1").run();
    io.emit("game_started");
    io.emit("teams_update", getAllTeams());
    io.emit("questions_payload", { questions: getQuestions(), game: getGameState() });
    sendAdminState();
  });

  socket.on("end_game", () => {
    if (!socket.data.isAdmin) return;
    db.prepare("UPDATE game_state SET ended = 1, started = 0 WHERE id = 1").run();
    io.emit("game_ended");
    sendAdminState();
  });

  socket.on("submit_answer", (answer) => {
    const playerName = socket.data.playerName;
    if (!playerName) return;

    const player = db.prepare("SELECT * FROM players WHERE name = ?").get(playerName);
    if (!player || !player.is_creator) return;

    const team = db.prepare("SELECT * FROM teams WHERE id = ?").get(player.team_id);
    const gameState = db.prepare("SELECT * FROM game_state WHERE id = 1").get();
    if (gameState.ended) return;

    const currentPosition = team.current_question;
    // Resolve the actual question id for this position to avoid id/position mismatch
    const qRow = db.prepare("SELECT id FROM questions WHERE position = ?").get(currentPosition);
    const questionId = qRow ? qRow.id : null;
    if (!questionId) return;
    db.prepare("INSERT INTO answers (team_id, question_id, answer) VALUES (?, ?, ?)").run(team.id, questionId, answer);
    db.prepare("UPDATE teams SET current_question = current_question + 1 WHERE id = ?").run(team.id);

    io.emit("teams_update", getAllTeams());
    sendAdminState();
  });

  // Player info (for client UI permissions)
  socket.on("player_get_info", () => {
    const playerName = socket.data.playerName;
    if (!playerName) return;
    const p = db.prepare("SELECT is_creator FROM players WHERE name = ?").get(playerName);
    socket.emit("player_info", { is_creator: !!(p && p.is_creator) });
  });

  // Provide questions to players on demand (resume/start)
  socket.on("player_get_questions", () => {
    socket.emit("questions_payload", { questions: getQuestions(), game: getGameState() });
  });

  // Question management (admin only)
  socket.on("admin_add_question", ({ image_url, text }) => {
    if (!socket.data.isAdmin) return;
    const maxPosRow = db.prepare("SELECT COALESCE(MAX(position), 0) AS maxp FROM questions").get();
    const nextPos = (maxPosRow?.maxp || 0) + 1;
    db.prepare("INSERT INTO questions (image_url, text, position) VALUES (?, ?, ?)").run(image_url || null, text || null, nextPos);
    io.to("admins").emit("questions_update", getQuestions());
    sendAdminState();
  });

  socket.on("admin_remove_question", (id) => {
    if (!socket.data.isAdmin) return;
    db.prepare("DELETE FROM questions WHERE id = ?").run(id);
    const rows = db.prepare("SELECT id FROM questions ORDER BY position ASC, id ASC").all();
    const upd = db.prepare("UPDATE questions SET position = ? WHERE id = ?");
    let pos = 1;
    for (const r of rows) upd.run(pos++, r.id);
    io.to("admins").emit("questions_update", getQuestions());
    sendAdminState();
  });

  socket.on("admin_move_question", ({ id, direction }) => {
    if (!socket.data.isAdmin) return;
    const rows = db.prepare("SELECT id, position FROM questions ORDER BY position ASC, id ASC").all();
    const idx = rows.findIndex((r) => r.id === id);
    if (idx < 0) return;
    if (direction === "up" && idx > 0) {
      const a = rows[idx - 1];
      const b = rows[idx];
      db.prepare("UPDATE questions SET position = ? WHERE id = ?").run(b.position, a.id);
      db.prepare("UPDATE questions SET position = ? WHERE id = ?").run(a.position, b.id);
    } else if (direction === "down" && idx < rows.length - 1) {
      const a = rows[idx];
      const b = rows[idx + 1];
      db.prepare("UPDATE questions SET position = ? WHERE id = ?").run(b.position, a.id);
      db.prepare("UPDATE questions SET position = ? WHERE id = ?").run(a.position, b.id);
    }
    io.to("admins").emit("questions_update", getQuestions());
    sendAdminState();
  });

  // Admin: delete team
  socket.on("admin_delete_team", (teamId) => {
    if (!socket.data.isAdmin) return;
    try {
      db.prepare("DELETE FROM answers WHERE team_id = ?").run(teamId);
      db.prepare("UPDATE players SET team_id = NULL, is_creator = 0 WHERE team_id = ?").run(teamId);
      db.prepare("DELETE FROM teams WHERE id = ?").run(teamId);
      io.emit("teams_update", getAllTeams());
      sendAdminState();
    } catch (e) {
      // no-op minimal error handling
    }
  });
});

server.listen(3000, () => console.log("Server running on http://localhost:3000"));
