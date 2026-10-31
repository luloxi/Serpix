-- Presupuestos y facturas (comprobantes internos, no fiscales). Additive only: new tables and indexes, nothing existing is altered.
-- Estados guardados: draft | sent | paid | void. "Vencida" se calcula (factura enviada con vencimiento anterior a hoy), no se guarda.
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('quote', 'invoice')),
  number INTEGER NOT NULL CHECK (number > 0),
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  issue_date TEXT NOT NULL,
  due_date TEXT,
  currency TEXT NOT NULL CHECK (currency IN ('ARS', 'USD')),
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'paid', 'void')),
  source_quote_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  transaction_id TEXT REFERENCES financial_transactions(id) ON DELETE SET NULL,
  paid_at TEXT,
  overdue_notified_on TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- Correlativo por usuario y tipo.
CREATE UNIQUE INDEX IF NOT EXISTS documents_number ON documents (user_id, doc_type, number);
-- Un ingreso por factura y una factura por presupuesto: cobrar o convertir dos veces no duplica.
CREATE UNIQUE INDEX IF NOT EXISTS documents_transaction ON documents (transaction_id) WHERE transaction_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS documents_source_quote ON documents (source_quote_id) WHERE source_quote_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS documents_user_status ON documents (user_id, doc_type, status, due_date);

CREATE TABLE IF NOT EXISTS document_items (
  id TEXT PRIMARY KEY NOT NULL,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  description TEXT NOT NULL,
  quantity_milli INTEGER NOT NULL CHECK (quantity_milli > 0),
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),
  time_entry_id TEXT REFERENCES time_entries(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS document_items_doc ON document_items (document_id, position);

-- Horas facturables ya incluidas en un documento (para no cobrarlas dos veces).
CREATE TABLE IF NOT EXISTS document_time_entries (
  time_entry_id TEXT PRIMARY KEY NOT NULL REFERENCES time_entries(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS document_time_entries_doc ON document_time_entries (document_id);
