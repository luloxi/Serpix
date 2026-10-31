-- Running timer (one row per user) and saved time entries. Additive only: new tables, nothing existing is altered.
CREATE TABLE IF NOT EXISTS timer_state (
  user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  segment_start INTEGER,
  accumulated_ms INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS time_entries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  billable INTEGER NOT NULL DEFAULT 0,
  hourly_rate_minor INTEGER NOT NULL DEFAULT 0,
  amount_minor INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'ARS',
  description TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS time_entries_user_started ON time_entries (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS time_entries_task ON time_entries (task_id);
