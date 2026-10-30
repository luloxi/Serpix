-- Additive: GitHub link and an optional stored avatar (client-resized ~256px WebP data URL).
ALTER TABLE contacts ADD COLUMN github_url TEXT;
ALTER TABLE contacts ADD COLUMN avatar_data TEXT;
ALTER TABLE contacts ADD COLUMN avatar_source TEXT;
