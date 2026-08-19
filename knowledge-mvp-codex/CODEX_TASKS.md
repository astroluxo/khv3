# Codex execution prompts

Run these as separate Codex tasks and review each diff before moving on.

## Phase 0 — audit
`Read AGENTS.md, README.md, and every file under docs/. Audit the repository. Identify incomplete code, risky assumptions, and exact external setup needed. Do not implement anything. Produce a checklist mapped to the acceptance criteria.`

## Phase 1 — database and local foundation
`Implement and validate the Supabase schema and search RPCs from the architecture. Ensure pgvector, full-text search, RLS-ready ownership/access fields, query logging, feedback, sync event idempotency, and safe deletion/unpublishing. Add SQL tests or reproducible verification queries. Do not build UI yet.`

## Phase 2 — Notion incremental ingestion
`Finish the Notion adapter and sync pipeline. Support page.content_updated and relevant create/delete/archive events, verify webhook signatures using the raw request body, fetch current page/block content, normalize text with heading context, chunk semantically, hash chunks, embed only changed chunks, delete stale chunks, and make event replay idempotent. Add unit tests with fixtures. Avoid full-corpus reindex for normal updates.`

## Phase 3 — hybrid retrieval
`Implement hybrid retrieval using vector similarity + Postgres full-text search + metadata/permission filters. Fuse rankings deterministically, cap context, return source metadata, and add threshold behavior that yields insufficient evidence instead of weak matches. Add evaluation tests covering semantic queries, exact codes, ambiguous queries, and no-answer cases.`

## Phase 4 — grounded answer endpoint
`Implement the chat Edge Function with Supabase JWT validation, hybrid retrieval, OpenAI Responses API generation, strict grounding instructions, citations, latency/query logging, configurable model, and safe errors. Output a stable JSON contract documented in docs/API.md. Add tests with mocked OpenAI.`

## Phase 5 — internal web UI
`Build the minimal authenticated Next.js interface: sign in, single conversation view, loading/error states, answer citations, source links, thumbs up/down feedback, and a small admin sync-status view. Keep styling simple and accessible. Do not add features outside the MVP.`

## Phase 6 — quality gate
`Run the full test suite, typecheck, lint, migration validation, and retrieval evaluation. Fix failures. Produce a release-readiness report against docs/PRD.md acceptance criteria and docs/SECURITY.md production gate. Do not claim production ready if any gate remains open.`

## Phase 7 — deployment runbook
`Create exact deployment instructions for Supabase, Notion webhook registration, secrets, web deployment, first full index, smoke tests, rollback, and monitoring. Keep provider assumptions configurable. Update README with only verified commands.`
