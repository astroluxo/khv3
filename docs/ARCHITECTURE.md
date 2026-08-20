# Architecture

## Context diagram

```text
Content owner
    |
    v
  Notion  --webhook-->  Supabase Edge Function: notion-webhook
    ^                         |
    | fetch latest            v
    +----------------  sync-notion-page
                              |
                              | normalize / chunk / hash
                              | embed changed chunks
                              v
                     Postgres + pgvector
                     documents / chunks
                              ^
                              | hybrid retrieval
                              |
Employee -> Next.js web -> Edge Function: chat -> OpenAI Responses API
                                      |        -> OpenAI Embeddings API
                                      v
                              queries / feedback
```

## Why this architecture

- Notion is an editor/CMS, not the query engine.
- Postgres stores text, metadata, access rules, logs, and vectors in one system.
- pgvector avoids a second vector SaaS for the MVP.
- Hybrid retrieval handles both semantic questions and exact internal codes/names.
- Webhooks reduce update latency and unnecessary polling.
- OpenAI calls receive only the selected context, reducing cost and hallucination surface.

## Ingestion flow

1. Notion emits an event.
2. `notion-webhook` reads the raw body, handles subscription verification, validates the signature for normal events, and records an idempotency key.
3. It invokes/schedules `sync-notion-page` for affected pages.
4. The sync function fetches current page metadata and recursively fetches supported block children.
5. It normalizes blocks into sections preserving heading ancestry.
6. It creates stable chunks around 300–700 tokens, using semantic boundaries before hard splitting.
7. It computes a SHA-256 content hash for every normalized chunk.
8. It compares hashes against current stored chunks for the document.
9. New/changed chunks are embedded; unchanged chunks retain embeddings.
10. Stale chunks are deleted in the same reconciliation transaction/sequence.
11. The document sync state is updated.

## Chunk identity

Prefer deterministic identifiers from `(source_document_id, logical_section_path, normalized_text_hash)` rather than array position alone. Position may change when content is inserted above a chunk.

## Retrieval flow

1. Validate user JWT and derive access scope.
2. Normalize query and create query embedding.
3. Run semantic candidate search.
4. Run Postgres FTS candidate search.
5. Filter candidates by `status='published'`, `published_ac=true`, access scope, and optional brand/area metadata.
6. Fuse ranks using Reciprocal Rank Fusion (RRF) or another deterministic weighted method.
7. Return final top-K and cap total context characters/tokens.
8. If there are zero usable retrieval results, skip generation and return the no-answer envelope.
9. Otherwise call the generation model with strict grounding instructions and Responses API Structured Outputs for the grounded-answer JSON contract.
10. Validate returned JSON and citation labels against the request-local evidence labels. Unknown labels, uncited substantive answers, refusals, incomplete outputs, and malformed schema responses make the generation response unsafe.
11. Persist query telemetry.

## Search design

Use the same `chunks` table for:

- `embedding vector(1536)`. The application embedding contract is centralized in the
  OpenAI embedding client: `OPENAI_EMBEDDING_DIMENSIONS` defaults to `1536`, embedding
  requests include that dimension, and returned vectors are rejected if their length
  differs. Do not truncate or pad embeddings.
- generated `tsvector` column for keyword search
- metadata columns / JSONB

Initial index strategy:

- HNSW vector index on `chunks.embedding` using cosine distance for semantic retrieval.
- GIN index on the `simple` FTS column. The MVP keeps `simple` rather than switching
  wholesale to Spanish stemming so exact internal codes, product names, and mixed Spanish/English
  identifiers remain searchable. Spanish stemming can be evaluated later as an additional lexical
  signal instead of replacing exact-friendly lookup.
- B-tree indexes on document/status/department fields.

For a tiny corpus, exact vector scan can be acceptable initially, but Phase 5 adds the HNSW index
because retrieval is now a first-class backend path and the SQL remains compatible with either exact
or indexed vector execution.

## Permissions

The MVP can begin with one department, but the schema must not assume every future user can see every document. `documents.access_scope` and membership mapping provide the extension point. RLS is the production gate.

`Brand` and `Área` are knowledge metadata only. They may filter retrieval when supplied explicitly, but they never grant access. `documents.access_scope` is the authorization field.

The `hybrid_search` RPC is `SECURITY INVOKER` with an explicit `search_path`. It is executable by `authenticated` and `service_role`, not by `anon` or `public`. User-context calls still rely on RLS. Trusted backend/service-role calls must pass explicit `allowed_access_scopes` for scoped content. `allowed_access_scopes = NULL` is reserved for default-scope content only, an empty array means no scoped access, and a non-empty array is an explicit allowlist.

## Failure modes

- Webhook duplicate: event id unique constraint makes it idempotent.
- Webhook arrives before content is consistent: sync retries with bounded backoff.
- Embedding call fails: preserve prior published chunks until a successful reconciliation when possible; mark sync failure.
- Document archived: mark document inactive and remove/exclude chunks immediately.
- No retrieval evidence: return `insufficient_evidence`.
- RRF fused scores are ranking diagnostics, not a hard evidence-sufficiency threshold in the MVP.
- Model returns unknown citation: reject the generation response as unsafe.

## Model strategy

Default generation model is environment-configured. Optimize for low cost first; quality upgrades should be driven by evaluation failure categories, not intuition.

## Future extensions, intentionally deferred

- Additional sources such as Google Drive/SharePoint.
- Visual assets and chart understanding.
- Reranker model.
- Query rewriting.
- Conversation memory.
- Multi-tenant isolation.
- Knowledge-gap analytics dashboard.
