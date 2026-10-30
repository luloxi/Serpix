-- Additive: remember when automatic photo lookup last failed (and for which set of networks), so it is not retried needlessly.
ALTER TABLE contacts ADD COLUMN avatar_tried_at INTEGER;
ALTER TABLE contacts ADD COLUMN avatar_tried_key TEXT;
