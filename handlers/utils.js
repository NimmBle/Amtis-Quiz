const formatIsoFromParts = (parts, offsetRaw) => {
  const map = (type) => parts.find((p) => p.type === type)?.value || "00";
  const year = map("year");
  const month = map("month");
  const day = map("day");
  const hour = map("hour");
  const minute = map("minute");
  const second = map("second");
  const offset = (offsetRaw || "GMT+02:00").replace("GMT", "");
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`;
};

const getBgIsoString = () => {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Sofia",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const offsetFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Sofia",
    timeZoneName: "shortOffset",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const offsetParts = offsetFormatter.formatToParts(now);
  const offsetRaw = offsetParts.find((p) => p.type === "timeZoneName")?.value || "GMT+02:00";
  return formatIsoFromParts(parts, offsetRaw);
};

const recordTeamProgress = (db, teamId, questionPosition, timestamp) => {
  if (!teamId || !questionPosition) return;
  const recorded_at = timestamp || getBgIsoString();
  db.prepare(
    "INSERT INTO team_progress (team_id, question_position, recorded_at) VALUES (?, ?, ?)"
  ).run(teamId, questionPosition, recorded_at);
};

const getTeamProgress = (db) =>
  db
    .prepare(
      "SELECT team_id, question_position, recorded_at FROM team_progress ORDER BY recorded_at ASC"
    )
    .all();

const getAllTeams = (db) => {
  const stmt = db.prepare(
    `SELECT t.id, t.name, t.current_question, t.start_time, t.finished_at,
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
      start_time: t.start_time || null,
      finished_at: t.finished_at || null,
    };
  });
};

const splitStoredAnswers = (value) => {
  if (value == null) return [];
  return value
    .toString()
    .split(/\r?\n|,/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
};

const getQuestions = (db) => {
  const rows = db
    .prepare(
      "SELECT id, image_url, text, hint, correct_answer, position FROM questions ORDER BY position ASC, id ASC"
    )
    .all();
  const answerRows = db
    .prepare("SELECT question_id, answer FROM question_answers ORDER BY question_id ASC, id ASC")
    .all();
  const grouped = new Map();
  answerRows.forEach(({ question_id, answer }) => {
    if (!grouped.has(question_id)) grouped.set(question_id, []);
    const bucket = grouped.get(question_id);
    splitStoredAnswers(answer).forEach((ans) => {
      if (!bucket.includes(ans)) bucket.push(ans);
    });
  });
  return rows.map((row) => ({
    ...row,
    answers: grouped.get(row.id) || [],
  }));
};

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

const getUsedHints = (db) =>
  db.prepare("SELECT id, team_id, question_id, created_at FROM hints ORDER BY id ASC").all();

const getAllPlayers = (db) =>
  db
    .prepare(
      `SELECT p.id, p.name, p.external_id, p.team_id, p.is_creator,
              t.name AS team_name
       FROM players p
       LEFT JOIN teams t ON p.team_id = t.id
       ORDER BY LOWER(p.name)`
    )
    .all();

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
    players: getAllPlayers(db),
    max_hints: getMaxHints(db),
    used_hints: getUsedHints(db),
    progress: getTeamProgress(db),
  };
  if (target && typeof target.emit === "function") {
    target.emit("admin_state", payload);
  } else {
    io.to("admins").emit("admin_state", payload);
  }
};

module.exports = {
  getBgIsoString,
  recordTeamProgress,
  getAllTeams,
  getQuestions,
  getQuestionsPublic,
  getAnswers,
  getAllPlayers,
  getGameState,
  isGameStarted,
  getMaxHints,
  getTeamHintsState,
  getTeamProgress,
  sendAdminState,
};
