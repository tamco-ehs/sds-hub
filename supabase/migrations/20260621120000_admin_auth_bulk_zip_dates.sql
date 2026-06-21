-- Additive document-control upgrade: authenticated EHS roles, actor-based audit,
-- soft archive/delete, ZIP intake batches, and explicit SDS date provenance.
-- Existing document rows and approved URLs are preserved.

create table if not exists public.admin_users (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (length(trim(display_name)) > 0),
  role text not null check (role in ('EHS_ADMIN', 'EHS_REVIEWER')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create index if not exists idx_admin_users_active_role
  on public.admin_users(is_active, role);

create table if not exists public.sds_upload_batches (
  id uuid primary key default gen_random_uuid(),
  uploaded_by uuid references auth.users(id) on delete set null,
  uploaded_by_name text not null,
  uploaded_by_role text not null check (uploaded_by_role in ('EHS_ADMIN', 'EHS_REVIEWER')),
  uploaded_at timestamptz not null default now(),
  original_zip_filename text not null,
  total_files integer not null default 0 check (total_files >= 0),
  accepted_pdf_count integer not null default 0 check (accepted_pdf_count >= 0),
  rejected_file_count integer not null default 0 check (rejected_file_count >= 0),
  duplicate_count integer not null default 0 check (duplicate_count >= 0),
  failed_count integer not null default 0 check (failed_count >= 0),
  status text not null default 'Uploaded' check (status in ('Uploaded','Extracting','Processing','Completed','Completed with warnings','Failed')),
  results_json jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.sds_documents
  add column if not exists uploaded_by uuid references auth.users(id) on delete set null,
  add column if not exists batch_id uuid references public.sds_upload_batches(id) on delete set null,
  add column if not exists archived_by uuid references auth.users(id) on delete set null,
  add column if not exists archive_reason text,
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references auth.users(id) on delete set null,
  add column if not exists delete_reason text,
  add column if not exists preparation_date text,
  add column if not exists print_date text,
  add column if not exists effective_date text,
  add column if not exists establishment_date text,
  add column if not exists detected_date_source text,
  add column if not exists detected_date_confidence integer check (detected_date_confidence between 0 and 100),
  add column if not exists validity_date_basis text check (validity_date_basis in ('revision_date','issue_date','preparation_date','establishment_date','effective_date','print_date')),
  add column if not exists validity_date_value text,
  add column if not exists date_detection_warnings jsonb not null default '[]'::jsonb,
  add column if not exists section_detection_confidence integer not null default 0 check (section_detection_confidence between 0 and 100);

alter table public.sds_review_history
  add column if not exists actor_user_id uuid references auth.users(id) on delete set null,
  add column if not exists reviewer_role text;

create table if not exists public.sds_audit_events (
  id uuid primary key default gen_random_uuid(),
  document_id uuid references public.sds_documents(id) on delete set null,
  batch_id uuid references public.sds_upload_batches(id) on delete set null,
  action text not null,
  product_name text,
  original_filename text,
  actor_user_id uuid references auth.users(id) on delete set null,
  display_name text not null,
  role text not null,
  reason text,
  before_json jsonb,
  after_json jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_sds_documents_deleted_at on public.sds_documents(deleted_at);
create index if not exists idx_sds_documents_archived_at on public.sds_documents(archived_at);
create index if not exists idx_sds_documents_uploaded_by on public.sds_documents(uploaded_by);
create index if not exists idx_sds_documents_batch_id on public.sds_documents(batch_id);
create index if not exists idx_sds_documents_revision_date on public.sds_documents(revision_date);
create index if not exists idx_sds_documents_issue_date on public.sds_documents(issue_date);
create index if not exists idx_sds_upload_batches_uploaded_by on public.sds_upload_batches(uploaded_by, uploaded_at desc);
create index if not exists idx_sds_audit_document on public.sds_audit_events(document_id, created_at desc);
create index if not exists idx_sds_audit_actor on public.sds_audit_events(actor_user_id, created_at desc);
create index if not exists idx_sds_audit_action on public.sds_audit_events(action, created_at desc);

alter table public.admin_users enable row level security;
alter table public.sds_upload_batches enable row level security;
alter table public.sds_audit_events enable row level security;

revoke all on public.admin_users from anon, authenticated;
revoke all on public.sds_upload_batches from anon, authenticated;
revoke all on public.sds_audit_events from anon, authenticated;

grant all on public.admin_users to service_role;
grant all on public.sds_upload_batches to service_role;
grant all on public.sds_audit_events to service_role;

-- Preserve the old established_date field for existing clients. New extraction
-- writes both it and validity_date_value so old public cards and QR routes remain valid.
update public.sds_documents
set validity_date_basis = case
      when nullif(revision_date, '') is not null then 'revision_date'
      when nullif(issue_date, '') is not null then 'issue_date'
      else validity_date_basis
    end,
    validity_date_value = coalesce(nullif(validity_date_value, ''), nullif(revision_date, ''), nullif(issue_date, ''), nullif(established_date, ''))
where validity_date_value is null;
