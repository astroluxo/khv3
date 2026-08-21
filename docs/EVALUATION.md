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

Phase 9D extends the same benchmark with retrieval-component diagnostics for paraphrase failures.
It compares current production hybrid retrieval with evaluation-only vector-only, lexical-only,
vector-dominant RRF, and document-level vector aggregation views. These diagnostics read only the
existing local Supabase corpus and write safe ranks, scores, and document/section labels to the
ignored artifact. Raw embeddings, secrets, JWTs, service-role keys, and full chunk text must not be
stored.

The completed Phase 9D run found that the apparent paraphrase-positive failures were dominated by
fixture expectation mismatches, not demonstrated production retrieval failures. Several paraphrase
cases expected abbreviated document titles such as `Módulo 6: Homologaciones`, while the local corpus
stores canonical titles such as
`Módulo 6. Homologaciones - Faltas de asistencia - Consecutivo actas de grado y diplomas`. Relevant
chunks existed for the observed cases, and RRF/fusion was neutral rather than harmful. No production
retrieval, SQL, generation, chunking, embedding, or frontend change is justified from this run.
Phase 9E must repair the evaluation contract, preferably by canonical source/document identifiers or
canonical stored titles, before tuning retrieval behavior.

The Phase 9D diagnostic output is intended to decide the next retrieval-improvement direction:

- if vector-only beats hybrid, inspect lexical/RRF interference;
- if vector-only also fails, inspect embedding input, chunk representation, or embedding model fit;
- if document aggregation fixes document recall but not section recall, consider a two-stage
  document-to-section retrieval design;
- if only section granularity fails, avoid changing the embedding stack prematurely.

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
