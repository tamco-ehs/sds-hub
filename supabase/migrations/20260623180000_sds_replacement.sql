-- SDS replacement workflow: a newly uploaded SDS can point at the approved SDS it replaces. The old
-- record is retired (Archived), never deleted, so the replacement chain stays auditable. Additive.
alter table public.sds_documents
  add column if not exists replaces_document_id uuid references public.sds_documents(id) on delete set null;
create index if not exists idx_sds_documents_replaces on public.sds_documents (replaces_document_id);
