const Database = require("better-sqlite3");
const path = require("path");
const dbPath = path.join(__dirname, "quiz.db");
const db = new Database(dbPath);

db.exec(`
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  team_id INTEGER,
  is_creator BOOLEAN DEFAULT 0
);

CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  current_question INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  image_url TEXT,
  text TEXT,
  hint TEXT
);

CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER,
  question_id INTEGER,
  answer TEXT
);

-- Track per-team hint usage per question
CREATE TABLE IF NOT EXISTS hints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER,
  question_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(team_id, question_id)
);

CREATE TABLE IF NOT EXISTS game_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  started BOOLEAN DEFAULT 0,
  ended BOOLEAN DEFAULT 0
);

INSERT OR IGNORE INTO game_state (id, started, ended) VALUES (1, 0, 0);

CREATE TABLE IF NOT EXISTS admin_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  code TEXT,
  max_hints INTEGER
);

INSERT OR IGNORE INTO admin_config (id, code) VALUES (1, NULL);
`);

const columns = db.prepare("PRAGMA table_info(questions)").all();
const hasPosition = columns.some(c => c.name === 'position');
if (!hasPosition) {
  db.exec(`
    ALTER TABLE questions ADD COLUMN position INTEGER;
    UPDATE questions SET position = id WHERE position IS NULL;
  `);
}

// Ensure questions.hint exists (for existing DBs)
const hasHint = columns.some(c => c.name === 'hint');
if (!hasHint) {
  db.exec(`
    ALTER TABLE questions ADD COLUMN hint TEXT;
  `);
}

// Ensure players.external_id exists
const pcols = db.prepare("PRAGMA table_info(players)").all();
const hasExternalId = pcols.some(c => c.name === 'external_id');
if (!hasExternalId) {
  db.exec(`
    ALTER TABLE players ADD COLUMN external_id TEXT;
  `);
}

// Ensure admin_config.max_hints exists and has a default
const acols = db.prepare("PRAGMA table_info(admin_config)").all();
const hasMaxHints = acols.some(c => c.name === 'max_hints');
if (!hasMaxHints) {
  db.exec(`
    ALTER TABLE admin_config ADD COLUMN max_hints INTEGER;
  `);
}
db.exec(`
  UPDATE admin_config SET max_hints = COALESCE(max_hints, 3) WHERE id = 1;
`);

module.exports = db;
