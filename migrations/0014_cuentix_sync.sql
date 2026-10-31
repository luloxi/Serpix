-- Cuentix -> Serpix movement sync. Additive only: new nullable columns, one defaulted flag, one table.
-- Rows that already exist keep source NULL, deleted_at NULL and excluded_from_totals 0, so totals stay the same.

ALTER TABLE financial_transactions ADD COLUMN source TEXT;
ALTER TABLE financial_transactions ADD COLUMN source_id TEXT;
ALTER TABLE financial_transactions ADD COLUMN source_version INTEGER;
ALTER TABLE financial_transactions ADD COLUMN deleted_at INTEGER;
ALTER TABLE financial_transactions ADD COLUMN excluded_from_totals INTEGER NOT NULL DEFAULT 0;
ALTER TABLE financial_transactions ADD COLUMN linked_to TEXT;
-- Pair the user dismissed with Desvincular. Stops that exact duplicate from linking again until it no longer matches.
ALTER TABLE financial_transactions ADD COLUMN link_suppressed TEXT;
ALTER TABLE financial_transactions ADD COLUMN updated_at INTEGER;

-- One synced movement per origin id. Manual rows (source NULL) are outside the index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_source_id ON financial_transactions(source, source_id) WHERE source IS NOT NULL;

CREATE TABLE IF NOT EXISTS integration_nonces (
  source TEXT NOT NULL,
  nonce TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (source, nonce)
);
CREATE INDEX IF NOT EXISTS idx_integration_nonces_ts ON integration_nonces(source, ts);

-- Delete received for an id never seen: remember its version here (not in financial_transactions) so an older upsert arriving late is ignored.
CREATE TABLE IF NOT EXISTS integration_tombstones (
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (source, source_id)
);
