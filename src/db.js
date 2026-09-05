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
      date          TEXT NOT NULL,               -- ISO YYYY-MM-DD, the event day
      timezone      TEXT NOT NULL,               -- IANA zone of the venue
      suggested_min TEXT NOT NULL DEFAULT '',    -- a guide, never enforced
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS categories (
      id        INTEGER PRIMARY KEY,
      event_id  INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      name      TEXT NOT NULL,
      position  INTEGER NOT NULL
    );

    -- Everyone with a code. The code IS the identity.
    -- role: guest (the list) | moderator (the list + the organiser page) | recipient (organiser page; the list only after the unlock)
    CREATE TABLE IF NOT EXISTS people (
      id           INTEGER PRIMARY KEY,
      event_id     INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      role         TEXT NOT NULL CHECK (role IN ('guest','moderator','recipient')),
      code         TEXT NOT NULL UNIQUE,
      joined_at    TEXT,                         -- first time the code was used
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
      proxy_ack      INTEGER NOT NULL DEFAULT 0,               -- giver confirmed a gift posted in their name
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

    -- A moderator's flag on a gift. The first flag shows the poster a banner with the note.
    -- A second, different moderator agreeing removes the gift. Flags are never shown with a name.
    CREATE TABLE IF NOT EXISTS flags (
      gift_id    INTEGER NOT NULL REFERENCES gifts(id) ON DELETE CASCADE,
      person_id  INTEGER NOT NULL REFERENCES people(id),
      note       TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (gift_id, person_id)
    );

    -- A recipient looked up one guest's code. Shown on the organiser page.
    CREATE TABLE IF NOT EXISTS lookups (
      id           INTEGER PRIMARY KEY,
      event_id     INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      person_id    INTEGER NOT NULL REFERENCES people(id),   -- whose code was shown
      requester_id INTEGER NOT NULL REFERENCES people(id),   -- who asked for it
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
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

    -- Private thread: recipients and moderators.
    CREATE TABLE IF NOT EXISTS thread_messages (
      id         INTEGER PRIMARY KEY,
      event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      person_id  INTEGER NOT NULL REFERENCES people(id),
      body       TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
  return db;
}

module.exports = { open, DB_PATH };
