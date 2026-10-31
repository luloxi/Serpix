-- E2E para invitados (fase C, no publicada; 0014 es cuentix_sync): modo de cuenta, envolturas de la clave de datos y almacén de registros cifrados.
-- Solo aditivo. Ver docs/E2E_SPEC.md.
ALTER TABLE user ADD COLUMN encryption_mode TEXT NOT NULL DEFAULT 'server';

-- Una fila por envoltura de la DEK (passkey con PRF o contraseña de recuperación). El servidor guarda solo texto cifrado + parámetros.
CREATE TABLE IF NOT EXISTS user_keys (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  wrap TEXT NOT NULL,
  credential_id TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS user_keys_user ON user_keys (user_id);
-- A lo sumo una envoltura de contraseña por usuario.
CREATE UNIQUE INDEX IF NOT EXISTS user_keys_one_password ON user_keys (user_id) WHERE type = 'password';

-- Registros cifrados: un registro = una fila de la app. blob = sobre JSON {"v","n","c"} (AES-256-GCM). En claro solo ids, tiempos, versión y los 4 datos de factura que necesita el aviso de vencidas.
CREATE TABLE IF NOT EXISTS records (
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  version INTEGER NOT NULL,
  blob TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  doc_type TEXT,
  doc_number INTEGER,
  doc_status TEXT,
  doc_due_date TEXT,
  PRIMARY KEY (user_id, collection, id)
);
CREATE INDEX IF NOT EXISTS records_seq ON records (user_id, seq);
CREATE INDEX IF NOT EXISTS records_due ON records (doc_status, doc_due_date) WHERE doc_due_date IS NOT NULL;

-- Contadores por usuario: 'seq' (cursor de sincronización) y numeración de presupuestos/facturas reservada por el servidor.
CREATE TABLE IF NOT EXISTS e2e_counters (
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, kind)
);
