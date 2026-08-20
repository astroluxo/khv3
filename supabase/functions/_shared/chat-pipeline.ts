import {
  generateGroundedAnswer,
  INSUFFICIENT_EVIDENCE_ANSWER,
  type Citation,
  type GenerationClient,
  type GroundedGenerationResult,
} from "./generation.ts";
import {
  retrieveKnowledge,
  type RetrievalOptions,
  type RetrievalResult,
  type RetrievalRpcClient,
} from "./retrieval.ts";

export type QueryLogInput = {
  userId: string;
  question: string;
  answer: string;
  insufficientEvidence: boolean;
  model?: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  retrievedChunkIds: string[];
  retrievedDocumentIds: string[];
};

export type QueryLogger = {
  logQuery(input: QueryLogInput): Promise<{ queryId?: string }>;
};

export type ChatAnswer = {
  answer: string;
  sources: Citation[];
  citations: Citation[];
  insufficient_evidence: boolean;
};

export async function runGroundedChat(input: {
  userId: string;
  question: string;
  supabase: RetrievalRpcClient;
  allowedAccessScopes: string[];
  logger: QueryLogger;
  retrieve?: typeof retrieveKnowledge;
  generationClient?: GenerationClient;
  model?: string;
  retrievalOptions?: Omit<RetrievalOptions, "filters">;
  maxContextChars?: number;
  now?: () => number;
}): Promise<ChatAnswer> {
  const started = input.now?.() ?? Date.now();
  const retrieve = input.retrieve ?? retrieveKnowledge;
  const retrieved = await retrieve({
    query: input.question,
    supabase: input.supabase,
    options: {
      ...input.retrievalOptions,
      filters: { accessScopes: input.allowedAccessScopes },
    },
  });
  const evidence = selectEvidence(retrieved, {
    maxContextChars: input.maxContextChars ?? 14000,
    limit: input.retrievalOptions?.limit ?? 6,
  });

  const generated =
    evidence.length === 0
      ? noEvidenceResult()
      : await generateGroundedAnswer({
          question: input.question,
          evidence,
          client: input.generationClient,
          model: input.model,
        });

  await logSafely(input.logger, {
    userId: input.userId,
    question: input.question,
    answer: generated.answer,
    insufficientEvidence: generated.insufficientEvidence,
    model: input.model,
    latencyMs: (input.now?.() ?? Date.now()) - started,
    ...(generated.usage?.inputTokens !== undefined
      ? { inputTokens: generated.usage.inputTokens }
      : {}),
    ...(generated.usage?.outputTokens !== undefined
      ? { outputTokens: generated.usage.outputTokens }
      : {}),
    retrievedChunkIds: evidence.map((result) => result.internal.chunkId),
    retrievedDocumentIds: unique(evidence.map((result) => result.internal.documentId)),
  });

  return {
    answer: generated.answer,
    sources: generated.citations,
    citations: generated.citations,
    insufficient_evidence: generated.insufficientEvidence,
  };
}

function selectEvidence(
  retrieved: RetrievalResult[],
  options: { maxContextChars: number; limit: number },
): RetrievalResult[] {
  if (retrieved.length === 0) return [];

  const selected: RetrievalResult[] = [];
  let chars = 0;
  for (const result of retrieved) {
    if (selected.length >= options.limit) break;
    if (chars + result.content.length > options.maxContextChars && selected.length > 0) break;
    selected.push(result);
    chars += result.content.length;
  }
  return selected;
}

function noEvidenceResult(): GroundedGenerationResult {
  return {
    answer: INSUFFICIENT_EVIDENCE_ANSWER,
    citations: [],
    insufficientEvidence: true,
  };
}

async function logSafely(logger: QueryLogger, input: QueryLogInput): Promise<string | undefined> {
  try {
    const result = await logger.logQuery(input);
    return result.queryId;
  } catch (error) {
    console.error("query_log_error", error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
