-- Habit Tracker schema. Relationships:
--   users 1──* habits 1──* checkins
--                    1──* comments *──1 users
-- CHECK constraints are a second line of defence behind the server-side validators.

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  -- Unique (case-insensitive) through idx_users_email, created in
  -- db/migrations.js so a database that already holds duplicates still starts.
  email         TEXT    NOT NULL COLLATE NOCASE,
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

-- Sliding-window rate-limit counters (current + previous window), shared by
-- every serverless instance. See src/middleware/rateLimit.js.
CREATE TABLE IF NOT EXISTS rate_limit_windows (
  bucket       TEXT    PRIMARY KEY,
  window_start INTEGER NOT NULL,
  hits         INTEGER NOT NULL,
  prev_hits    INTEGER NOT NULL DEFAULT 0
);

-- Networks an account signed in from successfully, as an HMAC of the client
-- IP bucket (IPv4 address or IPv6 /64), never the address itself. Over the
-- per-account daily failed-login limit, logins from these networks are still
-- let through, so strangers cannot lock out the owner. At most 10 per user,
-- kept for 30 days after last use (src/middleware/rateLimit.js).
CREATE TABLE IF NOT EXISTS login_trusted_ips (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip_hash   TEXT    NOT NULL CHECK (length(ip_hash) = 64),
  last_used INTEGER NOT NULL,
  PRIMARY KEY (user_id, ip_hash)
);

CREATE TABLE IF NOT EXISTS habits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT    NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  description TEXT    NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  category    TEXT    NOT NULL CHECK (category IN ('health', 'fitness', 'learning', 'productivity', 'mindfulness', 'social', 'other')),
  is_public   INTEGER NOT NULL DEFAULT 0 CHECK (is_public IN (0, 1)),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  -- When the habit is due (services/schedule.js):
  --   daily     every day
  --   weekdays  the ISO weekdays set in days_mask (bit 0 = Monday ... bit 6 = Sunday)
  --   weekly    weekly_target times per Monday-to-Sunday week, on any days
  -- Columns added after the first release are also listed in db/migrations.js.
  frequency     TEXT    NOT NULL DEFAULT 'daily' CHECK (frequency IN ('daily', 'weekdays', 'weekly')),
  days_mask     INTEGER NOT NULL DEFAULT 127 CHECK (days_mask BETWEEN 1 AND 127),
  weekly_target INTEGER NOT NULL DEFAULT 7 CHECK (weekly_target BETWEEN 1 AND 7),
  -- Optional local reminder time "HH:MM". Private to the owner.
  reminder_time TEXT    CHECK (reminder_time IS NULL OR reminder_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  -- Measurable habits: a day counts as done when a check-in's amount reaches
  -- target_count ("8 glasses"). Plain habits have target 1 and no unit.
  target_count  INTEGER NOT NULL DEFAULT 1 CHECK (target_count BETWEEN 1 AND 1000),
  unit          TEXT    NOT NULL DEFAULT '' CHECK (length(unit) <= 20),
  -- Archived habits leave the dashboard and Explore but keep their history.
  archived_at   TEXT,
  -- Owner-defined order on the dashboard (ascending).
  position      INTEGER NOT NULL DEFAULT 0
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
  -- Progress towards the habit's target_count on that day.
  amount         INTEGER NOT NULL DEFAULT 1 CHECK (amount BETWEEN 1 AND 100000),
  UNIQUE (habit_id, checkin_date)
);
CREATE INDEX IF NOT EXISTS idx_checkins_habit ON checkins(habit_id);
CREATE INDEX IF NOT EXISTS idx_checkins_user ON checkins(user_id);

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

-- Total bytes of all proof photos, as ONE counter row kept up to date by the
-- triggers below, so the global storage cap is checked without scanning
-- checkins (routes/checkins.js). MAX(0, ...) instead of a CHECK: a drifted
-- counter must never make deleting a photo fail.
CREATE TABLE IF NOT EXISTS photo_storage (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  bytes INTEGER NOT NULL
);

CREATE TRIGGER IF NOT EXISTS photo_storage_on_insert
AFTER INSERT ON checkins
WHEN NEW.photo_data IS NOT NULL
BEGIN
  UPDATE photo_storage SET bytes = bytes + length(NEW.photo_data) WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS photo_storage_on_update
AFTER UPDATE OF photo_data ON checkins
BEGIN
  UPDATE photo_storage
     SET bytes = MAX(0, bytes + COALESCE(length(NEW.photo_data), 0) - COALESCE(length(OLD.photo_data), 0))
   WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS photo_storage_on_delete
AFTER DELETE ON checkins
WHEN OLD.photo_data IS NOT NULL
BEGIN
  UPDATE photo_storage SET bytes = MAX(0, bytes - length(OLD.photo_data)) WHERE id = 1;
END;

-- Initialised once from the existing data. The triggers exist first, so a
-- photo written in between is either counted by them or by this sum, never
-- lost. The sum only runs while the row is missing (not on every start).
INSERT OR IGNORE INTO photo_storage (id, bytes)
SELECT 1, (SELECT COALESCE(SUM(length(photo_data)), 0) FROM checkins)
 WHERE NOT EXISTS (SELECT 1 FROM photo_storage WHERE id = 1);

-- Streak freezes (F-freeze): a missed day that keeps the streak alive.
-- The monthly allowance is enforced atomically by the INSERT in routes/freezes.js.
CREATE TABLE IF NOT EXISTS streak_freezes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  habit_id    INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  freeze_date TEXT    NOT NULL CHECK (freeze_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (habit_id, freeze_date)
);
CREATE INDEX IF NOT EXISTS idx_freezes_user_date ON streak_freezes(user_id, freeze_date);

CREATE TRIGGER IF NOT EXISTS freezes_owner_must_match
BEFORE INSERT ON streak_freezes
WHEN NEW.user_id IS NOT (SELECT user_id FROM habits WHERE id = NEW.habit_id)
BEGIN
  SELECT RAISE(ABORT, 'freeze owner must match habit owner');
END;

CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  habit_id   INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT    NOT NULL CHECK (length(body) BETWEEN 1 AND 500),
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_comments_habit ON comments(habit_id);

-- One-tap reactions on shared habits (F12). Only counts are ever returned.
CREATE TABLE IF NOT EXISTS reactions (
  habit_id   INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT    NOT NULL CHECK (kind IN ('clap', 'fire', 'muscle')),
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (habit_id, user_id, kind)
);

-- Following (F11). Grants no access: the feed only shows public habits.
CREATE TABLE IF NOT EXISTS follows (
  follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id);

-- Group challenges (F13). Created by admins only; joining shares the number
-- of completed days of ONE of the member's own habits with other users.
CREATE TABLE IF NOT EXISTS challenges (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT    NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  description TEXT    NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  category    TEXT    NOT NULL CHECK (category IN ('health', 'fitness', 'learning', 'productivity', 'mindfulness', 'social', 'other')),
  start_date  TEXT    NOT NULL CHECK (start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  end_date    TEXT    NOT NULL CHECK (end_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  CHECK (end_date >= start_date)
);

CREATE TABLE IF NOT EXISTS challenge_members (
  challenge_id INTEGER NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  habit_id     INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  joined_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (challenge_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_challenge_members_habit ON challenge_members(habit_id);

CREATE TRIGGER IF NOT EXISTS challenge_member_owns_habit
BEFORE INSERT ON challenge_members
WHEN NEW.user_id IS NOT (SELECT user_id FROM habits WHERE id = NEW.habit_id)
BEGIN
  SELECT RAISE(ABORT, 'challenge habit must belong to the member');
END;

-- The system can never be left without an administrator. Writes are
-- serialized by SQLite, so this also holds when two admins act concurrently.
CREATE TRIGGER IF NOT EXISTS users_keep_last_admin_on_update
BEFORE UPDATE OF role ON users
WHEN OLD.role = 'admin' AND NEW.role <> 'admin'
 AND (SELECT COUNT(*) FROM users WHERE role = 'admin') <= 1
BEGIN
  SELECT RAISE(ABORT, 'cannot remove the last admin');
END;

CREATE TRIGGER IF NOT EXISTS users_keep_last_admin_on_delete
BEFORE DELETE ON users
WHEN OLD.role = 'admin' AND (SELECT COUNT(*) FROM users WHERE role = 'admin') <= 1
BEGIN
  SELECT RAISE(ABORT, 'cannot remove the last admin');
END;

-- Append-only audit trail of administrator actions. No foreign keys, so
-- entries survive the deletion of the users they mention.
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id       INTEGER NOT NULL,
  actor_username TEXT    NOT NULL,
  action         TEXT    NOT NULL,
  target_type    TEXT    NOT NULL,
  target_id      INTEGER NOT NULL,
  details        TEXT    NOT NULL DEFAULT '{}',
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER IF NOT EXISTS admin_audit_log_no_update
BEFORE UPDATE ON admin_audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit log is append-only');
END;

CREATE TRIGGER IF NOT EXISTS admin_audit_log_no_delete
BEFORE DELETE ON admin_audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit log is append-only');
END;
