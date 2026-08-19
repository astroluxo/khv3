# Architecture decision log

## ADR-001 — Notion is source of truth

Status: accepted for MVP.
Rationale: minimizes content publishing friction; separates authoring from retrieval.

## ADR-002 — Supabase/Postgres + pgvector

Status: accepted for MVP.
Rationale: one datastore for vectors, full-text, metadata, auth, logs, and future RLS.

## ADR-003 — Hybrid retrieval

Status: accepted.
Rationale: semantic search handles paraphrases; FTS handles exact codes and terms.

## ADR-004 — Incremental webhook-driven sync

Status: accepted.
Rationale: lowers update latency and avoids polling/full reindexing.

## ADR-005 — No conversation memory in MVP

Status: accepted.
Rationale: reduces token cost and retrieval ambiguity. Revisit after usage data.

## ADR-006 — No orchestration framework

Status: accepted.
Rationale: the pipeline is simple enough for direct TypeScript/SQL; fewer dependencies and failure modes.
