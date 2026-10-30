CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('event','note')),
  title TEXT NOT NULL,
  body TEXT,
  occurred_at TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS activity_contacts (
  activity_id TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  PRIMARY KEY (activity_id, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_activities_user_date ON activities(user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_contacts_contact ON activity_contacts(contact_id, activity_id);
