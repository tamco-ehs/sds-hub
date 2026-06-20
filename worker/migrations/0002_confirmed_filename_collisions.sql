DROP INDEX IF EXISTS idx_sds_documents_approved_filename;

CREATE INDEX IF NOT EXISTS idx_sds_documents_approved_filename
  ON sds_documents(approved_filename, status);
