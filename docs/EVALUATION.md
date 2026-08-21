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

Phase 9E repairs that contract with benchmark-owned `documentKey` values. Fixtures no longer assert
fragile display-title equality; each positive case names a stable document key, and the benchmark
resolves it through an evaluation-only canonical registry of the six local pilot documents. Negative
cases use `documentKey: null`; near negatives may include `relatedDocumentKey` only to preserve the
related-domain rationale. Display titles remain retrieval output and citation context, but they are
not the benchmark identifier because Notion titles may include fuller source labels than a concise
test expectation.

The corrected contract still keeps section expectations semantic rather than exact: `sectionContains`
is matched against the normalized heading path. This keeps source heading hierarchy changes from
breaking unrelated document recall while still requiring the intended section label to appear.

After repairing fixture expectations, rerun `pnpm eval:retrieval` before interpreting Phase 9C/9D
paraphrase or sufficiency conclusions. If the corrected paraphrase baseline changes materially, use
that repaired baseline as the input to the next phase. Production retrieval, SQL, generation,
chunking, embedding configuration, and frontend behavior remain unchanged by this evaluation repair.

The Phase 9E re-baseline against the same local six-document corpus corrected the paraphrase
measurement:

- Original positives: Top-1 document accuracy 100%, Top-3 document recall 100%, Top-k document
  recall 100%, Top-1 section accuracy 87.5%, Top-k section hit 100%.
- Paraphrased positives: Top-1 document accuracy 100%, Top-3 document recall 100%, Top-k document
  recall 100%, Top-1 section accuracy 100%, Top-k section hit 100%.
- Far negatives: zero-evidence rate 0%, irrelevant-evidence rate 100%.
- Near negatives: zero-evidence rate 0%, irrelevant-evidence rate 100%.

The previous five apparent paraphrase failures (`p9c-pos-002`, `p9c-pos-003`, `p9c-pos-006`,
`p9c-pos-007`, and `p9c-pos-008`) all pass under the repaired contract. Their expected canonical
documents rank first, their expected sections rank first, and fusion remains neutral. The earlier
Phase 9C conclusion that paraphrase retrieval robustness was the primary blocker is therefore
superseded: the demonstrated remaining issue is evidence sufficiency for negative and near-negative
queries, not positive paraphrase retrieval. Lexical-only sufficiency still is not production-safe:
on the corrected original fixture it preserves 100% positive recall but accepts 4 of 28 negatives,
including 4 of 16 near negatives, at the 0.35 overlap threshold. On the paraphrase fixture the
offline composite strategies still reject supported paraphrases too aggressively. Phase 9F should
continue evidence-sufficiency work from the corrected baseline rather than tune production retrieval
for the old title-mismatch failures.

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
