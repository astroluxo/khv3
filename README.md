# Internal Knowledge MVP

A Codex-ready starter repository for a low-cost, text-only internal knowledge assistant.

## Architecture

`Notion -> webhook -> incremental sync/chunk/embed -> Supabase/Postgres+pgvector -> hybrid retrieval -> OpenAI -> authenticated web chat`

See `docs/ARCHITECTURE.md` for the detailed design and `docs/IMPLEMENTATION_PLAN.md` for the build sequence.

## MVP goals

- Notion is the editable source of truth.
- Content changes propagate incrementally.
- Answers are grounded only in retrieved internal content.
- Answers cite their source.
- Retrieval combines semantic + keyword + metadata filtering.
- Infrastructure and per-query cost stay minimal.

## Repository map

- `AGENTS.md` — durable Codex instructions.
- `docs/PRD.md` — product requirements and acceptance criteria.
- `docs/ARCHITECTURE.md` — system design and data flow.
- `docs/IMPLEMENTATION_PLAN.md` — tasks in recommended order.
- `docs/COST_MODEL.md` — cost assumptions and optimization levers.
- `docs/SECURITY.md` — MVP security model and production gate.
- `docs/EVALUATION.md` — retrieval/answer quality evaluation.
- `supabase/migrations/` — schema, RLS, search RPCs.
- `supabase/functions/` — chat, Notion webhook, and page synchronization.
- `apps/web/` — minimal Next.js UI scaffold.
- `fixtures/` — evaluation fixtures.
- `.env.example` — required configuration.

## Recommended Codex workflow

1. Open this repository in Codex.
2. Ask: `Read AGENTS.md and docs/*.md. Run a repo audit and tell me what is scaffolded vs. still TODO. Do not code yet.`
3. Then execute the prompts in `CODEX_TASKS.md` one phase at a time.
4. Review the diff and test output after every phase.

## Local prerequisites

- Node.js 20+.
- pnpm 9+.
- Supabase CLI.
- A Supabase project (or local Supabase).
- A Notion integration with access to the chosen knowledge pages/data source.
- An OpenAI API key.

## Environment

Copy `.env.example` to `.env.local` for the web app and configure equivalent Supabase secrets for Edge Functions.

## Important

The files under `supabase/functions/` are a strong implementation scaffold, not a claim that deployment is already configured. The Notion content-normalization path varies with the exact structure of your workspace; Phase 2 in `CODEX_TASKS.md` instructs Codex to finish and test that adapter against your selected Notion schema.
