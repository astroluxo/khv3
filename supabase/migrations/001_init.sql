create extension if not exists vector with schema extensions;
create extension if not exists pgcrypto;

create type public.document_status as enum ('draft','published','archived','error');

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'notion',
  source_id text not null unique,
  title text not null,
  source_url text,
  section text,
  department text,
  access_scope text not null default 'default',
  status public.document_status not null default 'draft',
  source_updated_at timestamptz,
  last_synced_at timestamptz,
  sync_error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  source_chunk_key text not null,
  section_path text,
  content text not null,
  content_hash text not null,
  token_estimate integer,
  ordinal integer not null default 0,
  embedding extensions.vector(1536),
  metadata jsonb not null default '{}'::jsonb,
  search_vector tsvector generated always as (to_tsvector('simple', coalesce(section_path,'') || ' ' || content)) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(document_id, source_chunk_key)
);

create table public.sync_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'notion',
  provider_event_id text not null,
  event_type text not null,
  entity_id text,
  payload jsonb,
  status text not null default 'received',
  error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique(provider, provider_event_id)
);

create table public.queries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  message text not null,
  status text not null,
  model text,
  latency_ms integer,
  input_tokens integer,
  output_tokens integer,
  retrieved_chunk_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);

create table public.feedback (
  id uuid primary key default gen_random_uuid(),
  query_id uuid not null references public.queries(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  rating smallint not null check (rating in (-1, 1)),
  comment text,
  created_at timestamptz not null default now(),
  unique(query_id, user_id)
);

create table public.user_access_scopes (
  user_id uuid not null references auth.users(id) on delete cascade,
  access_scope text not null,
  created_at timestamptz not null default now(),
  primary key(user_id, access_scope)
);

create index chunks_document_id_idx on public.chunks(document_id);
create index chunks_search_vector_idx on public.chunks using gin(search_vector);
create index documents_access_status_idx on public.documents(access_scope, status);
-- Add HNSW once the corpus size/pgvector version warrants it:
-- create index chunks_embedding_hnsw_idx on public.chunks using hnsw (embedding vector_cosine_ops);

alter table public.documents enable row level security;
alter table public.chunks enable row level security;
alter table public.queries enable row level security;
alter table public.feedback enable row level security;
alter table public.user_access_scopes enable row level security;

create policy "users can read allowed published documents"
on public.documents for select to authenticated
using (
  status = 'published'
  and exists (
    select 1 from public.user_access_scopes uas
    where uas.user_id = auth.uid() and uas.access_scope = documents.access_scope
  )
);

create policy "users can read chunks from allowed documents"
on public.chunks for select to authenticated
using (
  exists (
    select 1 from public.documents d
    join public.user_access_scopes uas on uas.access_scope = d.access_scope
    where d.id = chunks.document_id
      and d.status = 'published'
      and uas.user_id = auth.uid()
  )
);

create policy "users can insert own queries"
on public.queries for insert to authenticated
with check (user_id = auth.uid());

create policy "users can read own queries"
on public.queries for select to authenticated
using (user_id = auth.uid());

create policy "users can insert own feedback"
on public.feedback for insert to authenticated
with check (user_id = auth.uid());

create or replace function public.hybrid_search(
  query_text text,
  query_embedding extensions.vector(1536),
  match_count integer default 20,
  vector_weight double precision default 1.0,
  text_weight double precision default 1.0,
  rrf_k integer default 50
)
returns table (
  chunk_id uuid,
  document_id uuid,
  title text,
  section_path text,
  content text,
  source_url text,
  access_scope text,
  fused_score double precision
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
with semantic as (
  select c.id,
         row_number() over (order by c.embedding <=> query_embedding) as rank
  from public.chunks c
  join public.documents d on d.id = c.document_id
  where c.embedding is not null and d.status = 'published'
  order by c.embedding <=> query_embedding
  limit greatest(match_count, 1)
),
keyword as (
  select c.id,
         row_number() over (
           order by ts_rank_cd(c.search_vector, websearch_to_tsquery('simple', query_text)) desc
         ) as rank
  from public.chunks c
  join public.documents d on d.id = c.document_id
  where d.status = 'published'
    and c.search_vector @@ websearch_to_tsquery('simple', query_text)
  order by ts_rank_cd(c.search_vector, websearch_to_tsquery('simple', query_text)) desc
  limit greatest(match_count, 1)
),
fused as (
  select coalesce(s.id, k.id) id,
    coalesce(vector_weight / (rrf_k + s.rank), 0.0) +
    coalesce(text_weight / (rrf_k + k.rank), 0.0) as score
  from semantic s
  full outer join keyword k on k.id = s.id
)
select c.id, c.document_id, d.title, c.section_path, c.content, d.source_url, d.access_scope, fused.score
from fused
join public.chunks c on c.id = fused.id
join public.documents d on d.id = c.document_id
order by fused.score desc
limit greatest(match_count, 1);
$$;
