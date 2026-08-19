# Cost model

## Cost philosophy

For this MVP, fixed infrastructure should be near zero during development. Variable AI cost is controlled mainly by context size and answer length.

## Configurable models

- Generation default: `gpt-5.6-luna`.
- Embeddings default: `text-embedding-3-small`.

Keep both model IDs in environment variables so pricing/quality decisions are operational, not code changes.

## Approximate per-query token budget

Example target:

- System/instructions: 350 tokens.
- User query: 50 tokens.
- Retrieved context: 2,000 tokens.
- Answer: 350 tokens.

Using the current listed GPT-5.6 Luna rates at project creation ($0.20/M input, $1.20/M output), that example is roughly:

- Input: 2,400 * 0.20 / 1,000,000 = $0.00048.
- Output: 350 * 1.20 / 1,000,000 = $0.00042.
- Generation total: about $0.00090/query, excluding small embedding and infrastructure costs.

This is a planning estimate, not a billing guarantee.

## Main optimization levers

1. Reduce final retrieved context, not retrieval candidate breadth.
2. Cap answer length.
3. Skip generation on insufficient evidence.
4. Cache/retain document embeddings via chunk hashes.
5. Do not send conversation history in MVP unless evidence shows it is necessary.
6. Track actual token usage before optimizing further.

## Avoid premature complexity

Do not add a cache service until logs show repeat-query volume that can repay the operational complexity.
