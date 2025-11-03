const getAllTeams = (db) => {
  const stmt = db.prepare(
    `SELECT t.id, t.name, t.current_question,
            (SELECT name FROM players cp WHERE cp.team_id = t.id AND cp.is_creator = 1 LIMIT 1) AS captain
      FROM teams t`
  );
  const teams = stmt.all();
  return teams.map((t) => {
    const members = db
      .prepare("SELECT name, external_id, is_creator FROM players WHERE team_id = ?")
      .all(t.id);
    return {
      id: t.id,
      name: t.name,
      players: members.map((m) => m.name),
      players_detail: members,
      current_question: t.current_question,
      captain: t.captain || null,
    };
  });
};

const getQuestions = (db) =>
  db
    .prepare(
      "SELECT id, image_url, text, hint, correct_answer, position FROM questions ORDER BY position ASC, id ASC"
    )
    .all();

const getQuestionsPublic = (db) =>
  db
    .prepare(
      "SELECT id, image_url, text, hint, position FROM questions ORDER BY position ASC, id ASC"
    )
    .all();

const getAnswers = (db) =>
  db
    .prepare("SELECT id, team_id, question_id, answer FROM answers ORDER BY id ASC")
    .all();

const getGameState = (db) => db.prepare("SELECT * FROM game_state WHERE id = 1").get();

const getUsedHints = (db) => db.prepare("SELECT id, team_id, question_id, created_at FROM hints")

const isGameStarted = (db) => {
  const s = getGameState(db);
  return !!(s && s.started);
};

const getMaxHints = (db) => {
  const row = db.prepare("SELECT max_hints FROM admin_config WHERE id = 1").get();
  return row && row.max_hints != null ? Number(row.max_hints) : 3;
};

const getTeamHintsState = (db, teamId) => {
  if (!teamId) return { used: 0, left: getMaxHints(db), hintedQuestionIds: [] };
  const max = getMaxHints(db);
  const rows = db
    .prepare("SELECT question_id FROM hints WHERE team_id = ? ORDER BY id ASC")
    .all(teamId);
  const used = rows.length;
  const left = Math.max(0, max - used);
  return { used, left, max, hintedQuestionIds: rows.map((r) => r.question_id) };
};

const sendAdminState = (io, db, target) => {
  const payload = {
    teams: getAllTeams(db),
    questions: getQuestions(db),
    answers: getAnswers(db),
    game: getGameState(db),
    max_hints: getMaxHints(db),
    used_hints: getUsedHints(db)
  };
  if (target && typeof target.emit === "function") {
    target.emit("admin_state", payload);
  } else {
    io.to("admins").emit("admin_state", payload);
  }
};

module.exports = {
  getAllTeams,
  getQuestions,
  getQuestionsPublic,
  getAnswers,
  getGameState,
  isGameStarted,
  getMaxHints,
  getTeamHintsState,
  sendAdminState,
};
