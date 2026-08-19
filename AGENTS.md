# Knowledge MVP — Codex project instructions

## Mission

Build a low-cost internal knowledge assistant. Notion is the source of truth; Supabase/Postgres + pgvector is the retrieval layer; OpenAI generates embeddings and grounded answers; the web app is a minimal authenticated chat.

## Non-negotiable MVP boundaries

- Text only. No images, charts, OCR, voice, agents, web search, or external knowledge.
- Never answer from model memory when retrieved evidence is insufficient.
- Every substantive answer must return citations to source document/section.
- Notion changes must update incrementally; do not reindex the full corpus unless explicitly requested.
- Preserve document permissions in retrieval. RLS is required before production.
- Keep infrastructure minimal: Supabase + OpenAI + Notion + one web deployment.
- Do not add Pinecone, Redis, Elasticsearch, LangChain, LlamaIndex, queues, or extra SaaS unless an accepted ADR justifies it.

## Default stack

- Web: Next.js + TypeScript.
- Database/Auth/Vector/Functions: Supabase.
- Vector extension: pgvector, embedding dimension 1536.
- Generation model: `gpt-5.6-luna` (configurable).
- Embeddings: `text-embedding-3-small` (configurable).
- Source: Notion API + Notion webhooks.

## Engineering rules

- TypeScript strict mode; avoid `any`.
- Validate request bodies and external payloads.
- Secrets only via environment variables / Supabase secrets; never commit them.
- Webhook handler must validate `X-Notion-Signature` in production.
- Store hashes so unchanged chunks are never re-embedded.
- Retrieval must be hybrid: vector + full-text + metadata/permission filters.
- Log query latency, retrieved chunk ids, model, token usage when available, and feedback; never log secrets.
- Prefer simple functions and SQL over framework abstractions.

## Required verification before declaring a task done

1. Run formatter/linter/typecheck for touched package.
2. Run unit tests relevant to touched code.
3. For SQL changes, confirm migration is idempotent in a clean local Supabase database where possible.
4. For retrieval changes, run the evaluation fixture set and report deltas.
5. Summarize files changed, tests run, remaining risks, and any manual setup.

## Product acceptance rules

- If no evidence passes threshold, answer with an explicit insufficient-information response and no invented procedure.
- Citation objects must include document title, section when known, and source URL when available.
- A Notion update should become queryable without a full-corpus rebuild.
- Duplicate webhook events must be safe to replay.
- Deleted/unpublished documents must no longer appear in retrieval.

## Working style for Codex

- Read `docs/PRD.md`, `docs/ARCHITECTURE.md`, and `docs/IMPLEMENTATION_PLAN.md` before large changes.
- For multi-file features, make a short plan first.
- Keep commits/task scopes small and reviewable.
- If requirements conflict, prefer this file, then PRD, then architecture docs.
- Update documentation when behavior or environment variables change.
