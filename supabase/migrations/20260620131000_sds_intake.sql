create extension if not exists pgcrypto;

create table if not exists public.sds_documents (
  id uuid primary key default gen_random_uuid(),
  original_filename text not null,
  original_storage_key text not null unique,
  original_asset_id bigint,
  original_download_url text,
  approved_filename text,
  approved_storage_key text,
  approved_asset_id bigint,
  approved_download_url text,
  file_sha256 text not null,
  file_size bigint not null check (file_size > 0),
  mime_type text not null default 'application/pdf',
  status text not null check (status in ('Uploaded','Parsing','Extracted','Needs Review','Approved','Rejected','Archived','Duplicate')),
  version integer not null default 1,
  is_likely_sds boolean,
  ocr_required boolean not null default false,
  extraction_method text,
  gemini_used boolean not null default false,
  extracted_text text,
  product_name text,
  trade_name text,
  supplier text,
  manufacturer text,
  language text,
  issue_date text,
  revision_date text,
  cas_numbers jsonb not null default '[]'::jsonb,
  signal_word text,
  ghs_pictograms jsonb not null default '[]'::jsonb,
  hazard_statements jsonb not null default '[]'::jsonb,
  precautionary_statements jsonb not null default '[]'::jsonb,
  recommended_use text,
  ppe_recommendation text,
  storage_summary text,
  first_aid_summary text,
  spill_response_summary text,
  firefighting_summary text,
  disposal_summary text,
  extraction_confidence integer not null default 0 check (extraction_confidence between 0 and 100),
  missing_fields jsonb not null default '[]'::jsonb,
  possible_duplicate_flag boolean not null default false,
  duplicate_of_id uuid references public.sds_documents(id),
  review_required_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  approved_at timestamptz,
  approved_by text,
  rejected_at timestamptz,
  archived_at timestamptz
);

create index if not exists idx_sds_documents_status on public.sds_documents(status, updated_at desc);
create index if not exists idx_sds_documents_hash on public.sds_documents(file_sha256);
create index if not exists idx_sds_documents_product on public.sds_documents(product_name, revision_date);
create index if not exists idx_sds_documents_approved_filename on public.sds_documents(approved_filename, status);

create table if not exists public.sds_extraction_logs (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.sds_documents(id) on delete cascade,
  stage text not null,
  method text,
  status text not null,
  model text,
  confidence integer,
  text_length integer,
  keyword_hits jsonb not null default '[]'::jsonb,
  response_json jsonb,
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists idx_sds_extraction_logs_document
  on public.sds_extraction_logs(document_id, created_at desc);

create table if not exists public.sds_review_history (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.sds_documents(id) on delete cascade,
  action text not null,
  from_status text,
  to_status text,
  reviewer text not null,
  changes_json jsonb,
  comment text,
  created_at timestamptz not null default now()
);

create index if not exists idx_sds_review_history_document
  on public.sds_review_history(document_id, created_at desc);

alter table public.sds_documents enable row level security;
alter table public.sds_extraction_logs enable row level security;
alter table public.sds_review_history enable row level security;

revoke all on public.sds_documents from anon, authenticated;
revoke all on public.sds_extraction_logs from anon, authenticated;
revoke all on public.sds_review_history from anon, authenticated;

grant all on public.sds_documents to service_role;
grant all on public.sds_extraction_logs to service_role;
grant all on public.sds_review_history to service_role;
