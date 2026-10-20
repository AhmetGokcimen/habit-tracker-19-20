-- Habit Tracker schema. Relationships:
--   users 1──* habits 1──* checkins
--                    1──* comments *──1 users
-- CHECK constraints are a second line of defence behind the server-side validators.

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Server-side session registry: a JWT is only valid while its jti row exists
-- and is not revoked. This is what makes logout (and "delete user") effective
-- immediately instead of waiting for the token to expire.
CREATE TABLE IF NOT EXISTS sessions (
  jti        TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  revoked    INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Fixed-window rate-limit counters, shared by every serverless instance.
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket       TEXT    PRIMARY KEY,
  window_start INTEGER NOT NULL,
  hits         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS habits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT    NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  description TEXT    NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  category    TEXT    NOT NULL CHECK (category IN ('health', 'fitness', 'learning', 'productivity', 'mindfulness', 'social', 'other')),
  is_public   INTEGER NOT NULL DEFAULT 0 CHECK (is_public IN (0, 1)),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_habits_user ON habits(user_id);
CREATE INDEX IF NOT EXISTS idx_habits_public_category ON habits(is_public, category);

-- Check-ins are PRIVATE (F5): visible only to the habit owner and admins,
-- even when the habit itself is public.
CREATE TABLE IF NOT EXISTS checkins (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  habit_id       INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  checkin_date   TEXT    NOT NULL CHECK (checkin_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  note           TEXT    NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  -- Proof photo is stored in the database (Vercel's filesystem is not
  -- persistent). It is only ever served through an authorized route.
  photo_data     BLOB    CHECK (photo_data IS NULL OR length(photo_data) <= 1048576),
  photo_mime     TEXT    CHECK (photo_mime IS NULL OR photo_mime IN ('image/jpeg', 'image/png', 'image/webp')),
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (habit_id, checkin_date)
);
CREATE INDEX IF NOT EXISTS idx_checkins_habit ON checkins(habit_id);

-- A check-in always belongs to the owner of its habit. Enforced by the
-- database too, so even an application bug cannot attach a check-in to
-- someone else's habit, or move one between habits/users afterwards.
CREATE TRIGGER IF NOT EXISTS checkins_owner_must_match
BEFORE INSERT ON checkins
WHEN NEW.user_id IS NOT (SELECT user_id FROM habits WHERE id = NEW.habit_id)
BEGIN
  SELECT RAISE(ABORT, 'checkin owner must match habit owner');
END;

CREATE TRIGGER IF NOT EXISTS checkins_owner_immutable
BEFORE UPDATE OF habit_id, user_id ON checkins
WHEN NEW.habit_id IS NOT OLD.habit_id OR NEW.user_id IS NOT OLD.user_id
BEGIN
  SELECT RAISE(ABORT, 'checkin owner and habit are immutable');
END;

CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  habit_id   INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT    NOT NULL CHECK (length(body) BETWEEN 1 AND 500),
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_comments_habit ON comments(habit_id);
