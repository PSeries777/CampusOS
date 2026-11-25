-- Existing rows have no recorded original filename.
ALTER TABLE documents ADD COLUMN original_filename TEXT;
