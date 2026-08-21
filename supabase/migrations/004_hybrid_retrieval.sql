drop function if exists public.hybrid_search(
  text,
  extensions.vector(1536),
  integer,
  double precision,
  double precision,
  integer
);

create or replace function public.hybrid_search(
  query_text text,
  query_embedding extensions.vector(1536),
  match_count integer default 20,
  vector_weight double precision default 1.0,
  text_weight double precision default 1.0,
  rrf_k integer default 50,
  filter_brand text default null,
  filter_area text default null,
  allowed_access_scopes text[] default null
)
returns table (
  chunk_id uuid,
  document_id uuid,
  source text,
  source_id text,
  title text,
  section_path text,
  content text,
  source_url text,
  brand text,
  area text,
  access_scope text,
  fused_score double precision,
  vector_rank bigint,
  text_rank bigint
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
with params as (
  select least(greatest(coalesce(match_count, 20), 1), 50) as limit_count,
         least(greatest(coalesce(rrf_k, 50), 1), 1000) as safe_rrf_k,
         least(greatest(coalesce(vector_weight, 1.0), 0.0), 10.0) as safe_vector_weight,
         least(greatest(coalesce(text_weight, 1.0), 0.0), 10.0) as safe_text_weight,
         case
           when filter_brand is null then null
           when length(btrim(filter_brand)) between 1 and 200 then btrim(filter_brand)
           else '__invalid_brand_filter__'
         end as safe_filter_brand,
         case
           when filter_area is null then null
           when length(btrim(filter_area)) between 1 and 200 then btrim(filter_area)
           else '__invalid_area_filter__'
         end as safe_filter_area,
         coalesce(
           array(
             select distinct btrim(scope)
             from unnest(coalesce(allowed_access_scopes, '{}'::text[])) as allowed(scope)
             where length(btrim(scope)) between 1 and 200
           ),
           '{}'::text[]
         ) as safe_allowed_access_scopes,
         websearch_to_tsquery('simple', left(coalesce(query_text, ''), 1000)) as lexical_query
),
eligible_chunks as (
  select c.id,
         c.document_id,
         c.section_path,
         c.content,
         c.embedding,
         c.search_vector,
         d.source,
         d.source_id,
         d.title,
         d.source_url,
         d.brand,
         d.area,
         d.access_scope
  from public.chunks c
  join public.documents d on d.id = c.document_id
  cross join params p
  where d.status = 'published'::public.document_status
    and d.published_ac is true
    and (p.safe_filter_brand is null or d.brand = p.safe_filter_brand)
    and (p.safe_filter_area is null or d.area = p.safe_filter_area)
    and (
      (allowed_access_scopes is null and d.access_scope = 'default')
      or (
        allowed_access_scopes is not null
        and cardinality(p.safe_allowed_access_scopes) > 0
        and d.access_scope = any(p.safe_allowed_access_scopes)
      )
    )
),
semantic as (
  select e.id,
         row_number() over (order by e.embedding <=> query_embedding, e.id) as vector_rank
  from eligible_chunks e, params p
  where e.embedding is not null
  order by e.embedding <=> query_embedding, e.id
  limit (select limit_count from params)
),
keyword as (
  select e.id,
         row_number() over (
           order by ts_rank_cd(e.search_vector, p.lexical_query) desc, e.id
         ) as text_rank
  from eligible_chunks e, params p
  where e.search_vector @@ p.lexical_query
  order by ts_rank_cd(e.search_vector, p.lexical_query) desc, e.id
  limit (select limit_count from params)
),
fused as (
  select coalesce(s.id, k.id) as id,
         s.vector_rank,
         k.text_rank,
         coalesce((select safe_vector_weight from params) / ((select safe_rrf_k from params) + s.vector_rank), 0.0) +
         coalesce((select safe_text_weight from params) / ((select safe_rrf_k from params) + k.text_rank), 0.0) as fused_score
  from semantic s
  full outer join keyword k on k.id = s.id
)
select e.id as chunk_id,
       e.document_id,
       e.source,
       e.source_id,
       e.title,
       e.section_path,
       e.content,
       e.source_url,
       e.brand,
       e.area,
       e.access_scope,
       f.fused_score,
       f.vector_rank,
       f.text_rank
from fused f
join eligible_chunks e on e.id = f.id
order by f.fused_score desc,
         coalesce(f.vector_rank, 9223372036854775807),
         coalesce(f.text_rank, 9223372036854775807),
         e.id
limit (select limit_count from params);
$$;

create index if not exists chunks_embedding_hnsw_idx
  on public.chunks using hnsw (embedding extensions.vector_cosine_ops)
  where embedding is not null;

comment on function public.hybrid_search(
  text,
  extensions.vector(1536),
  integer,
  double precision,
  double precision,
  integer,
  text,
  text,
  text[]
) is
  'Hybrid retrieval using cosine vector similarity plus simple-configuration PostgreSQL FTS fused with Reciprocal Rank Fusion. Filters require published_ac=true and status=published. Brand/Área are optional knowledge filters, never authorization. allowed_access_scopes=NULL returns only default access_scope; an empty array returns no scoped content; non-empty arrays are explicit authorization allowlists for trusted backend/service-role use. Production/editorial metadata is intentionally ignored.';

comment on index public.chunks_embedding_hnsw_idx is
  'HNSW index for pgvector cosine distance used by hybrid_search semantic ranking.';

revoke all on function public.hybrid_search(
  text,
  extensions.vector(1536),
  integer,
  double precision,
  double precision,
  integer,
  text,
  text,
  text[]
) from public;

revoke all on function public.hybrid_search(
  text,
  extensions.vector(1536),
  integer,
  double precision,
  double precision,
  integer,
  text,
  text,
  text[]
) from anon;

grant execute on function public.hybrid_search(
  text,
  extensions.vector(1536),
  integer,
  double precision,
  double precision,
  integer,
  text,
  text,
  text[]
) to authenticated, service_role;
