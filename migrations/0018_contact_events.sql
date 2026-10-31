-- Dónde se conoció un contacto y qué pasó. Calendario de Luma para sugerir el evento.
-- Solo aditivo: columnas nuevas nullable y una tabla nueva. Sin DROP, DELETE ni RENAME.
-- luma_events no lleva la guardia de texto plano (0016/0017): no es un registro del usuario,
-- es la caché del calendario del dueño y GET /api/luma-events la lee también en cuentas cifradas.
-- Nada se borra: un evento deja de sugerirse por el filtro de la consulta, no por un DELETE.

ALTER TABLE contacts ADD COLUMN met_event TEXT;
ALTER TABLE contacts ADD COLUMN met_event_at TEXT;
ALTER TABLE contacts ADD COLUMN met_note TEXT;

CREATE TABLE IF NOT EXISTS luma_events (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  uid TEXT NOT NULL,
  name TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  url TEXT,
  location TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, uid)
);

CREATE INDEX IF NOT EXISTS idx_luma_events_user_starts ON luma_events(user_id, starts_at);
