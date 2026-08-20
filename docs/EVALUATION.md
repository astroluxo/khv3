# Evaluation plan

## Why evaluate retrieval separately from generation

A fluent answer can hide a retrieval failure. The MVP must measure whether the correct evidence was retrieved before judging prose quality.

## Evaluation set

Start with at least 30 questions split across:

- Semantic paraphrases.
- Exact identifiers/codes/names.
- Questions requiring one section.
- Questions whose relevant answer is near a competing procedure.
- Ambiguous questions.
- Explicitly unanswerable questions.
- Questions affected by a recently updated document.

Store cases in `fixtures/eval_cases.json`.

The real Phase 8/9 retrieval baseline lives in `fixtures/retrieval_eval_phase8.json`.
Run it against the existing local Supabase corpus with:

```bash
pnpm eval:retrieval
```

The command uses real OpenAI query embeddings and the production retrieval service against local
Supabase. It writes the safe machine-readable result artifact to
`.supabase/retrieval-eval-phase9.json`, which is intentionally ignored by Git.

The Phase 9 fixture separates positive questions, far negatives, and near negatives. Near negatives
are domain-relevant questions that resemble supported procedures but ask for undocumented limits,
deadlines, authorities, penalties, or policy values. The benchmark reports near-negative behavior and
lexical-threshold sweeps for analysis only; production retrieval and abstention behavior are not
changed by the benchmark.

Phase 9C adds an evaluation-only paraphrase fixture in
`fixtures/retrieval_eval_phase9c_paraphrases.json`. It contains supported paraphrases and
near-negative paraphrases that preserve intent while varying wording. The benchmark reports these
separately from the original fixture so the committed Phase 9B baseline remains directly comparable.

Phase 9C also measures deterministic composite sufficiency signals offline:

- lexical overlap
- dominant-document concentration
- dominant-section concentration
- supporting chunk count
- top-1/top-2 document agreement
- query-token coverage
- specific-token coverage

Composite strategies and parameter sweeps are benchmark experiments only. They must not be treated as
a production evidence gate unless a later phase explicitly implements and validates one.

## Per-case fields

- `id`
- `question`
- `expected_document_ids` or source keys
- `must_answer` boolean
- `notes`

## Metrics

- Recall@K for retrieval.
- MRR / rank of first expected source.
- Answerable/no-answer classification accuracy.
- Citation validity.
- Unsupported claim rate from manual review.
- p50/p95 latency.

## Release thresholds

Initial targets from PRD:

- Retrieval hit >= 90% answerable cases.
- Citation correctness >= 95%.
- Unsupported answers <= 2% on unanswerable cases.

Do not hide failed cases by changing expected labels without documented product-owner review.
