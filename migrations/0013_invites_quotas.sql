-- Multiusuario fase 1: invitaciones, tope de usuarios y cupos de IA. Solo aditivo (tablas nuevas, una columna con default). Sin DROP/RENAME/DELETE.

-- Invitaciones de un solo uso. Solo se guarda el hash SHA-256 del código; el código en claro se muestra una vez al admin.
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_by TEXT REFERENCES user(id) ON DELETE SET NULL,
  revoked_at INTEGER,
  note TEXT
);
CREATE INDEX IF NOT EXISTS invites_created ON invites (created_at);

-- Configuración chica clave/valor (tope de usuarios aprobados).
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES ('max_users', '5', 0);

-- Contadores diarios: neuronas de Workers AI de toda la cuenta (scope 'global', día UTC) y tickets leídos por usuario (scope = id, día de Buenos Aires).
CREATE TABLE IF NOT EXISTS usage_daily (
  day TEXT NOT NULL,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, scope, kind)
);

-- Lectura de tickets con IA: apagada por defecto para los usuarios nuevos; los que ya existen (Luciano) la conservan.
ALTER TABLE user ADD COLUMN ai_receipts_enabled INTEGER NOT NULL DEFAULT 0;
UPDATE user SET ai_receipts_enabled = 1;
