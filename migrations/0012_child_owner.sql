-- Multiusuario fase 0: dueño explícito en las 4 tablas hijas que se llegaban solo por el padre.
-- Solo aditivo: columna nueva nullable (default NULL), relleno desde el padre con UPDATE, índices. Sin DROP/RENAME/DELETE.
ALTER TABLE activity_contacts ADD COLUMN user_id TEXT REFERENCES user(id) ON DELETE CASCADE;
ALTER TABLE document_items ADD COLUMN user_id TEXT REFERENCES user(id) ON DELETE CASCADE;
ALTER TABLE document_time_entries ADD COLUMN user_id TEXT REFERENCES user(id) ON DELETE CASCADE;
ALTER TABLE contact_relationships ADD COLUMN user_id TEXT REFERENCES user(id) ON DELETE CASCADE;

UPDATE activity_contacts SET user_id = (SELECT a.user_id FROM activities a WHERE a.id = activity_contacts.activity_id) WHERE user_id IS NULL;
UPDATE document_items SET user_id = (SELECT d.user_id FROM documents d WHERE d.id = document_items.document_id) WHERE user_id IS NULL;
UPDATE document_time_entries SET user_id = (SELECT d.user_id FROM documents d WHERE d.id = document_time_entries.document_id) WHERE user_id IS NULL;
UPDATE contact_relationships SET user_id = (SELECT c.user_id FROM contacts c WHERE c.id = contact_relationships.contact_id) WHERE user_id IS NULL;

CREATE INDEX IF NOT EXISTS activity_contacts_user ON activity_contacts (user_id);
CREATE INDEX IF NOT EXISTS document_items_user ON document_items (user_id);
CREATE INDEX IF NOT EXISTS document_time_entries_user ON document_time_entries (user_id);
CREATE INDEX IF NOT EXISTS contact_relationships_user ON contact_relationships (user_id);
