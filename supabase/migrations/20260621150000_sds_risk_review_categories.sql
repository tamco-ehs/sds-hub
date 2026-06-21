-- Additive pre-screen metadata used to route SDS records to the smallest safe
-- EHS review path. Publication status and the existing approval gate are unchanged.

alter table public.sds_documents
  add column if not exists risk_level text
    check (risk_level in ('low', 'medium', 'high', 'unknown')) default 'unknown',
  add column if not exists review_decision text
    check (review_decision in (
      'no_review_required_existing_unchanged',
      'auto_prescreen_pass',
      'quick_check_required',
      'full_review_required',
      'ocr_review_required',
      'conflict_duplicate',
      'not_sds_or_replace_file',
      'error_needs_review'
    )),
  add column if not exists review_reasons jsonb not null default '[]'::jsonb,
  add column if not exists evidence_snippets jsonb not null default '{}'::jsonb,
  add column if not exists extraction_conflicts jsonb not null default '[]'::jsonb,
  add column if not exists ai_verification_status text,
  add column if not exists existing_catalog_match boolean not null default false,
  add column if not exists prescreened_at timestamptz;

create index if not exists sds_documents_review_decision_idx
  on public.sds_documents (review_decision)
  where deleted_at is null and archived_at is null;

create index if not exists sds_documents_risk_level_idx
  on public.sds_documents (risk_level)
  where deleted_at is null and archived_at is null;
