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
