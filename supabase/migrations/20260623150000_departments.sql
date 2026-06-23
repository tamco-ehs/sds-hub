-- Department master + per-document SDS<->department links (many-to-many). Additive: existing tables,
-- the public catalog, and review/approval flows are untouched. The older record-based
-- sds_department_links table (from the language-variant migration) is left as-is (unused by the UI).

create table if not exists public.departments (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  code text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create table if not exists public.sds_document_departments (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.sds_documents(id) on delete cascade,
  department_id uuid not null references public.departments(id) on delete restrict,
  created_at timestamptz not null default now(),
  created_by text,
  unique (document_id, department_id)
);
create index if not exists idx_sds_doc_dept_document on public.sds_document_departments (document_id);
create index if not exists idx_sds_doc_dept_department on public.sds_document_departments (department_id);

-- Seed the known facility departments (idempotent).
insert into public.departments (name) values
  ('Paintshop'), ('GIS'), ('RMU'), ('Fabrication'), ('Store'),
  ('Testing'), ('Maintenance'), ('Facility'), ('Warehouse'), ('Incoming QC')
on conflict (name) do nothing;

alter table public.departments enable row level security;
alter table public.sds_document_departments enable row level security;
revoke all on public.departments from anon, authenticated;
revoke all on public.sds_document_departments from anon, authenticated;
grant all on public.departments to service_role;
grant all on public.sds_document_departments to service_role;
