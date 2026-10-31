-- Link ICS de Luma del dueño, cifrado en reposo. Solo aditivo: una tabla nueva.
-- Sin DROP, DELETE ni RENAME.
-- luma_settings no lleva la guardia de texto plano (0016/0017): no es un registro del usuario.
-- Es la configuración del calendario del dueño (admin), no un dato de contacto, y ninguna ruta
-- de la cuenta cifrada la lee como texto plano. El link vive en ics_cipher, nunca en claro.
-- Quitar el link pone ics_cipher, ics_iv e ics_hint en NULL. No se borra la fila ni luma_events.

CREATE TABLE IF NOT EXISTS luma_settings (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  ics_cipher TEXT,
  ics_iv TEXT,
  ics_hint TEXT,
  saved_at INTEGER,
  last_attempt_at INTEGER,
  last_sync_at INTEGER,
  last_status TEXT,
  last_count INTEGER,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);
