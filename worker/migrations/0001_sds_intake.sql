PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sds_documents (
  id TEXT PRIMARY KEY,
  original_filename TEXT NOT NULL,
  original_storage_key TEXT NOT NULL UNIQUE,
  approved_filename TEXT,
  approved_storage_key TEXT,
  file_sha256 TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/pdf',
  status TEXT NOT NULL CHECK (status IN ('Uploaded','Parsing','Extracted','Needs Review','Approved','Rejected','Archived','Duplicate')),
  version INTEGER NOT NULL DEFAULT 1,
  is_likely_sds INTEGER,
  ocr_required INTEGER NOT NULL DEFAULT 0,
  extraction_method TEXT,
  gemini_used INTEGER NOT NULL DEFAULT 0,
  extracted_text TEXT,
  product_name TEXT,
  trade_name TEXT,
  supplier TEXT,
  manufacturer TEXT,
  language TEXT,
  issue_date TEXT,
  revision_date TEXT,
  cas_numbers TEXT NOT NULL DEFAULT '[]',
  signal_word TEXT,
  ghs_pictograms TEXT NOT NULL DEFAULT '[]',
  hazard_statements TEXT NOT NULL DEFAULT '[]',
  precautionary_statements TEXT NOT NULL DEFAULT '[]',
  recommended_use TEXT,
  ppe_recommendation TEXT,
  storage_summary TEXT,
  first_aid_summary TEXT,
  spill_response_summary TEXT,
  firefighting_summary TEXT,
  disposal_summary TEXT,
  extraction_confidence INTEGER NOT NULL DEFAULT 0,
  missing_fields TEXT NOT NULL DEFAULT '[]',
  possible_duplicate_flag INTEGER NOT NULL DEFAULT 0,
  duplicate_of_id TEXT,
  review_required_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  approved_at TEXT,
  approved_by TEXT,
  rejected_at TEXT,
  archived_at TEXT,
  FOREIGN KEY (duplicate_of_id) REFERENCES sds_documents(id)
);

CREATE INDEX IF NOT EXISTS idx_sds_documents_status ON sds_documents(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sds_documents_hash ON sds_documents(file_sha256);
CREATE INDEX IF NOT EXISTS idx_sds_documents_product ON sds_documents(product_name, revision_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sds_documents_approved_filename
  ON sds_documents(approved_filename)
  WHERE approved_filename IS NOT NULL AND status = 'Approved';

CREATE TABLE IF NOT EXISTS sds_extraction_logs (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  method TEXT,
  status TEXT NOT NULL,
  model TEXT,
  confidence INTEGER,
  text_length INTEGER,
  keyword_hits TEXT NOT NULL DEFAULT '[]',
  response_json TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (document_id) REFERENCES sds_documents(id)
);

CREATE INDEX IF NOT EXISTS idx_sds_extraction_logs_document
  ON sds_extraction_logs(document_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sds_review_history (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  action TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  reviewer TEXT NOT NULL,
  changes_json TEXT,
  comment TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (document_id) REFERENCES sds_documents(id)
);

CREATE INDEX IF NOT EXISTS idx_sds_review_history_document
  ON sds_review_history(document_id, created_at DESC);
