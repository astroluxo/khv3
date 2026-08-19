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
5. Filter candidates by `status='published'`, access scope, and optional department metadata.
6. Fuse ranks using Reciprocal Rank Fusion (RRF) or another deterministic weighted method.
7. Return final top-K and cap total context characters/tokens.
8. If evidence score is below threshold, skip generation or generate only the no-answer envelope.
9. Otherwise call the generation model with strict grounding instructions.
10. Validate returned citation identifiers against retrieved candidates.
11. Persist query telemetry.

## Search design
Use the same `chunks` table for:
- `embedding vector(1536)`
- generated `tsvector` column for keyword search
- metadata columns / JSONB

Initial index strategy:
- HNSW vector index when corpus size justifies it.
- GIN index on FTS column.
- B-tree indexes on document/status/department fields.

For a tiny corpus, exact vector scan can be acceptable initially; keep the SQL compatible with adding HNSW without changing application contracts.

## Permissions
The MVP can begin with one department, but the schema must not assume every future user can see every document. `documents.access_scope` and membership mapping provide the extension point. RLS is the production gate.

## Failure modes
- Webhook duplicate: event id unique constraint makes it idempotent.
- Webhook arrives before content is consistent: sync retries with bounded backoff.
- Embedding call fails: preserve prior published chunks until a successful reconciliation when possible; mark sync failure.
- Document archived: mark document inactive and remove/exclude chunks immediately.
- No retrieval evidence: return `insufficient_evidence`.
- Model returns unknown citation: reject/repair citation list from retrieved ids.

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
