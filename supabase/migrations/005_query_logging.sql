alter table public.queries
  add column if not exists answer_text text,
  add column if not exists insufficient_evidence boolean not null default false,
  add column if not exists retrieved_document_ids uuid[] not null default '{}';

comment on column public.queries.answer_text is
  'Grounded answer text returned to the user, or the insufficient-evidence message.';

comment on column public.queries.insufficient_evidence is
  'True when retrieval/generation returned the explicit insufficient-evidence result.';

comment on column public.queries.retrieved_document_ids is
  'Document ids selected as evidence for the answer. Does not include hidden prompts or raw source text.';
