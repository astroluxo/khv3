# Implementation plan

## Phase 0 — repository audit

Confirm toolchain, local Supabase, and exact Notion content structure. Freeze a small representative test corpus.

## Phase 1 — persistence

- Enable extensions.
- Create documents/chunks/events/queries/feedback/profile/access tables.
- Add FTS/vector indexes and hybrid-search RPC.
- Add initial RLS policies.

Exit: SQL can store/retrieve a synthetic corpus and isolate access scopes.

## Phase 2 — ingestion

- Implement webhook verification.
- Implement Notion page/block fetcher.
- Normalize blocks.
- Chunk + hash.
- Reconcile incremental changes.
- Embed changed chunks only.

Exit: editing one fixture page changes only its relevant chunk rows.

## Phase 3 — retrieval

- Query embeddings.
- Semantic candidates.
- Keyword candidates.
- Rank fusion and thresholding.
- Permission filters.

Exit: evaluation retrieval target passes.

## Phase 4 — answering

- Strict grounded system instruction.
- Responses API call.
- Citation validation.
- Telemetry.

Exit: answer/no-answer and citation tests pass.

## Phase 5 — web app

- Auth.
- Chat.
- Sources.
- Feedback.
- Admin sync status.

Exit: one internal test user can complete end-to-end flow.

## Phase 6 — production gate

- Security tests.
- Evaluation.
- Cost/latency observation.
- Backup/recovery and deployment runbook.

## Key decisions to postpone

- Dedicated reranker.
- Separate vector database.
- Queue infrastructure.
- Conversation memory.
- Multi-source adapters.
