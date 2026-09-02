// SQLite via Node's built-in node:sqlite (no native build step).
const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");
const fs = require("node:fs");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "registry.db");

function open() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS events (
      id            INTEGER PRIMARY KEY,
      slug          TEXT NOT NULL UNIQUE,
      occasion      TEXT NOT NULL,
      title         TEXT NOT NULL,
      date          TEXT,
      suggested_min TEXT NOT NULL DEFAULT '',   -- a guide, never enforced
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS categories (
      id        INTEGER PRIMARY KEY,
      event_id  INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      name      TEXT NOT NULL,
      position  INTEGER NOT NULL
    );

    -- Everyone with a code. The code IS the identity.
    -- role: guest (sees the list) | recipient (organiser page, never the list) | organiser (non-recipient who set it up)
    CREATE TABLE IF NOT EXISTS people (
      id           INTEGER PRIMARY KEY,
      event_id     INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      email        TEXT NOT NULL DEFAULT '',
      role         TEXT NOT NULL CHECK (role IN ('guest','recipient','organiser')),
      code         TEXT NOT NULL UNIQUE,
      is_moderator INTEGER NOT NULL DEFAULT 0,
      joined_at    TEXT,                       -- first time the code was used
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS people_event ON people(event_id);

    CREATE TABLE IF NOT EXISTS gifts (
      id             INTEGER PRIMARY KEY,
      event_id       INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      giver_id       INTEGER NOT NULL REFERENCES people(id),   -- whose gift it is
      poster_id      INTEGER NOT NULL REFERENCES people(id),   -- who typed it in
      category_id    INTEGER REFERENCES categories(id),
      item           TEXT NOT NULL,
      link           TEXT NOT NULL DEFAULT '',
      open_to_join   INTEGER NOT NULL DEFAULT 0,
      removed_at     TEXT,
      removed_reason TEXT,
      created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS gifts_event ON gifts(event_id, created_at);

    CREATE TABLE IF NOT EXISTS gift_joins (
      gift_id    INTEGER NOT NULL REFERENCES gifts(id) ON DELETE CASCADE,
      person_id  INTEGER NOT NULL REFERENCES people(id),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (gift_id, person_id)
    );

    -- A removal needs two distinct moderators. First vote proposes with a reason, second agrees.
    CREATE TABLE IF NOT EXISTS removal_votes (
      gift_id    INTEGER NOT NULL REFERENCES gifts(id) ON DELETE CASCADE,
      person_id  INTEGER NOT NULL REFERENCES people(id),
      reason     TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (gift_id, person_id)
    );

    CREATE TABLE IF NOT EXISTS questions (
      id         INTEGER PRIMARY KEY,
      event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      person_id  INTEGER NOT NULL REFERENCES people(id),
      body       TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS question_replies (
      id          INTEGER PRIMARY KEY,
      question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
      person_id   INTEGER NOT NULL REFERENCES people(id),
      body        TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS notices (
      id         INTEGER PRIMARY KEY,
      event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      person_id  INTEGER NOT NULL REFERENCES people(id),
      body       TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    -- Private thread: recipients, organiser, and the two moderators.
    CREATE TABLE IF NOT EXISTS thread_messages (
      id         INTEGER PRIMARY KEY,
      event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      person_id  INTEGER NOT NULL REFERENCES people(id),
      body       TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    -- Every email the system tries to send. Visible on the organiser page.
    CREATE TABLE IF NOT EXISTS outbox (
      id         INTEGER PRIMARY KEY,
      event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      to_email   TEXT NOT NULL,
      subject    TEXT NOT NULL,
      body       TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'queued',  -- queued | sent | failed | no-mailer
      detail     TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
  return db;
}

module.exports = { open, DB_PATH };
