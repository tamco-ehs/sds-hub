-- Store the SDS "supersedes/replaces" date (the date of the PREVIOUS edition) as its own field, so it
-- is never confused with the live revision/issue date and never compared against them as a conflict.
-- Additive + ISO date text, matching revision_date / preparation_date.
alter table public.sds_documents
  add column if not exists supersedes_date text;
