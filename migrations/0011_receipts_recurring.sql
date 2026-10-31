-- Additive only: receipt photos/PDFs (stored in D1, served from the app to their owner) and recurring movement rules.
-- Nothing existing is dropped or rewritten; financial_transactions gets two nullable columns.
CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  transaction_id TEXT REFERENCES financial_transactions(id) ON DELETE CASCADE,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  data TEXT NOT NULL,
  extracted TEXT,
  read_ok INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_receipts_transaction ON receipts(transaction_id);
CREATE INDEX IF NOT EXISTS idx_receipts_user_created ON receipts(user_id, created_at);

CREATE TABLE IF NOT EXISTS recurring_rules (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES financial_accounts(id) ON DELETE CASCADE,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('income', 'expense')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  category TEXT NOT NULL,
  description TEXT,
  frequency TEXT NOT NULL CHECK (frequency IN ('weekly', 'monthly', 'yearly')),
  anchor_date TEXT NOT NULL,
  end_date TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'ended')),
  from_date TEXT NOT NULL,
  generated_through TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recurring_user_status ON recurring_rules(user_id, status);

ALTER TABLE financial_transactions ADD COLUMN recurring_id TEXT REFERENCES recurring_rules(id) ON DELETE SET NULL;
ALTER TABLE financial_transactions ADD COLUMN recurring_period TEXT;
-- Idempotency: one movement per rule and period, enforced by the database.
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_recurring_period ON financial_transactions(recurring_id, recurring_period) WHERE recurring_id IS NOT NULL;
