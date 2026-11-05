-- Note images for server-mode accounts. Bytes live in D1, same idea as receipts, served only to the owner.
-- Encrypted accounts never write this table: the image is embedded in activities.body and sealed with that record.
-- A row here blocks the first key wrap, so plaintext images cannot be left behind when turning encryption on.

CREATE TABLE IF NOT EXISTS note_media (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_note_media_user_created ON note_media(user_id, created_at);

CREATE TRIGGER IF NOT EXISTS note_media_e2e_guard_insert BEFORE INSERT ON note_media FOR EACH ROW WHEN (SELECT encryption_mode FROM user WHERE id = NEW.user_id) IS NOT NULL AND (SELECT encryption_mode FROM user WHERE id = NEW.user_id) != 'server' BEGIN SELECT RAISE(ABORT, 'e2e_account_plaintext_write'); END;
CREATE TRIGGER IF NOT EXISTS note_media_e2e_guard_update BEFORE UPDATE ON note_media FOR EACH ROW WHEN (SELECT encryption_mode FROM user WHERE id = NEW.user_id) IS NOT NULL AND (SELECT encryption_mode FROM user WHERE id = NEW.user_id) != 'server' BEGIN SELECT RAISE(ABORT, 'e2e_account_plaintext_write'); END;
