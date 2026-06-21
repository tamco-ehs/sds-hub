-- Document validity: the established (effective) date and the +5-year expiry,
-- both stored as ISO date text (matching issue_date / revision_date). These are
-- system-derived from the extracted/reviewed dates by the Edge Function; a null
-- expiry_date means "validity unknown" and must be resolved by EHS review.

alter table public.sds_documents
  add column if not exists established_date text,
  add column if not exists expiry_date text;

create index if not exists idx_sds_documents_expiry
  on public.sds_documents(expiry_date);
