# Product Requirements Document — Internal Knowledge Assistant MVP

## Problem

Operational knowledge currently becomes consumable only after manual consolidation into PDF manuals. That introduces multi-day latency between a policy/process change and employee access to the updated knowledge.

## Product objective

Provide an internal text chat that answers operational questions from a living knowledge base maintained in Notion, with incremental propagation of updates and source citations.

## Primary user

An authenticated employee in one internal department who needs fast, reliable answers about procedures, policies, definitions, and internal process knowledge.

## MVP scope

### In scope

- Notion as source of truth.
- Text ingestion only.
- Incremental synchronization from Notion changes.
- Chunking and embeddings.
- Hybrid retrieval: semantic + keyword + metadata filters.
- Authenticated web chat.
- Grounded answers with citations.
- Explicit no-answer behavior.
- Query/latency logging and thumbs feedback.
- Basic admin sync status.

### Out of scope

- PDF ingestion as a primary source.
- Images, charts, OCR, audio, video.
- Internet search.
- Autonomous actions or workflows.
- User-authored knowledge edits from the chat.
- Multi-tenant SaaS packaging.
- Advanced analytics dashboards.
- Fine-tuning.

## Core user stories

1. As an employee, I can ask a natural-language question and receive a concise answer grounded in approved internal content.
2. As an employee, I can see which document/section supports an answer.
3. As an employee, I receive an explicit insufficient-information response when the source does not support an answer.
4. As a content owner, I can edit an approved Notion page and have the change become searchable without rebuilding the entire corpus.
5. As an administrator, I can see whether a page sync succeeded or failed.
6. As a product owner, I can review common questions, no-answer cases, and user feedback.

## Functional requirements

### Knowledge ingestion

- Receive Notion change notifications.
- Validate webhook authenticity in production.
- Fetch the latest source content after a change event.
- Convert supported Notion blocks to normalized plain text while retaining heading context.
- Split content into stable semantic chunks.
- Hash normalized chunks.
- Embed only new/changed chunks.
- Remove stale chunks after edits and remove all chunks after archival/deletion/unpublishing.
- Support a manual full resync command for recovery/bootstrap only.

### Retrieval

- Embed the user query.
- Run vector search and full-text search.
- Apply access/status/department metadata filters before final context assembly.
- Fuse results into a deterministic ranked list.
- Select at most the configured top-K and context budget.
- Reject weak evidence below threshold.

### Answering

- Use only selected source context.
- Do not use web search or external tools.
- Return answer text plus machine-readable citations.
- Return a stable no-answer response when context is insufficient.
- Record model, latency, retrieval ids, and optional token usage.

### Web app

- Authentication.
- Chat composer and answer stream/non-stream response.
- Citation display.
- Feedback controls.
- Clear error and no-answer states.
- Small sync-status admin view.

## Non-functional requirements

- Target p50 answer latency: <4 seconds after warm-up; p95 target <8 seconds for MVP, subject to provider/network variance.
- Typical Notion content update should become searchable after webhook delivery + processing without full-corpus reindex.
- Duplicate events must not corrupt state.
- No secrets in browser bundle or logs.
- Database access must be compatible with RLS.
- Data model must support future per-department access control.

## Success metrics

- Retrieval hit rate on curated evaluation questions >= 90% for answerable questions.
- Citation correctness >= 95% on curated evaluation set.
- Unsupported-answer rate <= 2% on unanswerable evaluation questions.
- Median content-update-to-searchable latency <= 3 minutes, with the expectation that Notion may batch some content update events.
- Positive feedback rate tracked, not used as sole quality metric.

## MVP acceptance criteria

- 30+ curated questions covering semantic, exact-code, ambiguous, and no-answer cases.
- All supported answers include at least one valid citation.
- Unanswerable questions do not fabricate procedures.
- Editing one Notion page does not embed unchanged pages.
- Removing/archiving a page removes it from retrieval.
- Authenticated users can use the chat; unauthenticated calls are rejected.
- Webhook signature validation is enabled for production.
- Costs can be estimated from stored request metrics.
