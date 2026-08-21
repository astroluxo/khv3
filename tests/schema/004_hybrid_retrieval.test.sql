do $$
declare
  vector_extension_schema text;
  hnsw_method text;
  hnsw_opclass_schema text;
  hnsw_opclass_name text;
  hybrid_definition text;
begin
  select n.nspname
  into vector_extension_schema
  from pg_extension e
  join pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'vector';

  if vector_extension_schema is distinct from 'extensions' then
    raise exception 'vector extension is installed in %, expected extensions', vector_extension_schema;
  end if;

  select am.amname,
         op_namespace.nspname,
         op_class.opcname
  into hnsw_method,
       hnsw_opclass_schema,
       hnsw_opclass_name
  from pg_class index_class
  join pg_index index_info on index_info.indexrelid = index_class.oid
  join pg_am am on am.oid = index_class.relam
  join unnest(index_info.indclass) with ordinality as indclass(opclass_oid, ordinal) on true
  join pg_opclass op_class on op_class.oid = indclass.opclass_oid
  join pg_namespace op_namespace on op_namespace.oid = op_class.opcnamespace
  where index_class.relname = 'chunks_embedding_hnsw_idx'
    and index_class.relnamespace = 'public'::regnamespace
  limit 1;

  if hnsw_method is distinct from 'hnsw' then
    raise exception 'chunks_embedding_hnsw_idx uses %, expected hnsw', hnsw_method;
  end if;

  if hnsw_opclass_schema is distinct from 'extensions'
     or hnsw_opclass_name is distinct from 'vector_cosine_ops' then
    raise exception
      'chunks_embedding_hnsw_idx uses %.%, expected extensions.vector_cosine_ops',
      hnsw_opclass_schema,
      hnsw_opclass_name;
  end if;

  select pg_get_functiondef(p.oid)
  into hybrid_definition
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'hybrid_search';

  if hybrid_definition is null then
    raise exception 'hybrid_search function is missing';
  end if;

  if position('e.embedding <=> query_embedding' in hybrid_definition) = 0 then
    raise exception 'hybrid_search does not use cosine distance for vector ranking';
  end if;
end $$;
