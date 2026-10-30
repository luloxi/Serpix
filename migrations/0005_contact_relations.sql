-- Additive: independent relations per contact (client / partner / supplier, each potential or confirmed).
-- NULL means "derive from the legacy role column"; existing rows are not backfilled.
ALTER TABLE contacts ADD COLUMN relations TEXT;
