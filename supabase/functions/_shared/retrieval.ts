import {
  createDefaultEmbeddingClient,
  validateEmbeddingDimensions,
  type EmbeddingClient,
} from "./openai.ts";

const DEFAULT_RETRIEVAL_LIMIT = 6;
const MAX_RETRIEVAL_LIMIT = 20;
const DEFAULT_VECTOR_WEIGHT = 1.0;
const DEFAULT_TEXT_WEIGHT = 1.0;
const DEFAULT_RRF_K = 50;
const MAX_WEIGHT = 10;
const MAX_RRF_K = 1000;
const MAX_FILTER_LENGTH = 200;

export type RetrievalErrorKind = "invalid_query" | "rpc_failed" | "malformed_rpc_response";

export class RetrievalError extends Error {
  readonly kind: RetrievalErrorKind;

  constructor(kind: RetrievalErrorKind, message: string, options: { cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "RetrievalError";
    this.kind = kind;
  }
}

export type RetrievalFilters = {
  brand?: string;
  area?: string;
  accessScopes?: string[];
};

export type RetrievalOptions = {
  limit?: number;
  vectorWeight?: number;
  textWeight?: number;
  rrfK?: number;
  filters?: RetrievalFilters;
};

export type RetrievalRpcClient = {
  rpc(
    functionName: "hybrid_search",
    args: HybridSearchRpcArgs,
  ): Promise<{ data: unknown; error: unknown }>;
};

export type HybridSearchRpcArgs = {
  query_text: string;
  query_embedding: number[];
  match_count: number;
  vector_weight: number;
  text_weight: number;
  rrf_k: number;
  filter_brand: string | null;
  filter_area: string | null;
  allowed_access_scopes: string[] | null;
};

export type RetrievalResult = {
  internal: {
    chunkId: string;
    documentId: string;
    source: string;
    sourceId: string;
    accessScope: string;
  };
  document: {
    title: string;
    sourceUrl?: string;
    brand?: string;
    area?: string;
  };
  sectionPath?: string;
  content: string;
  diagnostics: {
    rank: number;
    fusedScore: number;
    vectorRank?: number;
    textRank?: number;
  };
};

type NormalizedRetrievalFilters = {
  brand: string | null;
  area: string | null;
  accessScopes: string[] | null;
};

type HybridSearchRow = {
  chunk_id: string;
  document_id: string;
  source: string;
  source_id: string;
  title: string;
  section_path: string | null;
  content: string;
  source_url: string | null;
  brand: string | null;
  area: string | null;
  access_scope: string;
  fused_score: number;
  vector_rank: number | null;
  text_rank: number | null;
};

export async function retrieveKnowledge(input: {
  query: string;
  supabase: RetrievalRpcClient;
  embeddingClient?: EmbeddingClient;
  options?: RetrievalOptions;
}): Promise<RetrievalResult[]> {
  const query = normalizeQuery(input.query);
  const embeddingClient = input.embeddingClient ?? createDefaultEmbeddingClient();
  const limit = normalizeLimit(input.options?.limit);
  const filters = normalizeFilters(input.options?.filters);
  const [embedding] = await embeddingClient.embedMany([query]);
  if (!embedding) {
    throw new RetrievalError("malformed_rpc_response", "Embedding client returned no query vector");
  }
  validateEmbeddingDimensions(embedding, embeddingClient.dimensions);

  const { data, error } = await input.supabase.rpc("hybrid_search", {
    query_text: query,
    query_embedding: embedding,
    match_count: limit,
    vector_weight: normalizeWeight(input.options?.vectorWeight, DEFAULT_VECTOR_WEIGHT),
    text_weight: normalizeWeight(input.options?.textWeight, DEFAULT_TEXT_WEIGHT),
    rrf_k: normalizeRrfK(input.options?.rrfK),
    filter_brand: filters.brand,
    filter_area: filters.area,
    allowed_access_scopes: filters.accessScopes,
  });

  if (error) {
    throw new RetrievalError("rpc_failed", "Hybrid retrieval RPC failed", { cause: error });
  }

  if (data === null || data === undefined) return [];
  if (!Array.isArray(data)) {
    throw new RetrievalError("malformed_rpc_response", "Hybrid retrieval RPC did not return rows");
  }

  return data.slice(0, limit).map((row, index) => mapRetrievalRow(row, index));
}

function normalizeQuery(query: string): string {
  const normalized = query.trim();
  if (!normalized) throw new RetrievalError("invalid_query", "Retrieval query must not be empty");
  return normalized;
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_RETRIEVAL_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) return DEFAULT_RETRIEVAL_LIMIT;
  return Math.min(limit, MAX_RETRIEVAL_LIMIT);
}

function normalizeWeight(weight: number | undefined, fallback: number): number {
  if (weight === undefined) return fallback;
  if (!Number.isFinite(weight) || weight < 0) return fallback;
  return Math.min(weight, MAX_WEIGHT);
}

function normalizeRrfK(rrfK: number | undefined): number {
  if (rrfK === undefined) return DEFAULT_RRF_K;
  if (!Number.isInteger(rrfK) || rrfK <= 0) return DEFAULT_RRF_K;
  return Math.min(rrfK, MAX_RRF_K);
}

function normalizeFilters(filters: RetrievalFilters | undefined): NormalizedRetrievalFilters {
  return {
    brand: normalizeOptionalFilter(filters?.brand, "brand"),
    area: normalizeOptionalFilter(filters?.area, "area"),
    accessScopes: normalizeAccessScopes(filters?.accessScopes),
  };
}

function normalizeOptionalFilter(value: string | undefined, label: string): string | null {
  if (value === undefined) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > MAX_FILTER_LENGTH) {
    throw new RetrievalError("invalid_query", `Retrieval ${label} filter is too long`);
  }
  return normalized;
}

function normalizeAccessScopes(scopes: string[] | undefined): string[] | null {
  if (scopes === undefined) return null;
  const normalized = scopes
    .map((scope) => scope.trim())
    .filter(Boolean)
    .filter((scope) => scope.length <= MAX_FILTER_LENGTH);
  return [...new Set(normalized)];
}

function mapRetrievalRow(row: unknown, index: number): RetrievalResult {
  if (!isHybridSearchRow(row)) {
    throw new RetrievalError("malformed_rpc_response", "Hybrid retrieval row is malformed");
  }

  return {
    internal: {
      chunkId: row.chunk_id,
      documentId: row.document_id,
      source: row.source,
      sourceId: row.source_id,
      accessScope: row.access_scope,
    },
    document: {
      title: row.title,
      ...(row.source_url ? { sourceUrl: row.source_url } : {}),
      ...(row.brand ? { brand: row.brand } : {}),
      ...(row.area ? { area: row.area } : {}),
    },
    ...(row.section_path ? { sectionPath: row.section_path } : {}),
    content: row.content,
    diagnostics: {
      rank: index + 1,
      fusedScore: row.fused_score,
      ...(row.vector_rank !== null ? { vectorRank: row.vector_rank } : {}),
      ...(row.text_rank !== null ? { textRank: row.text_rank } : {}),
    },
  };
}

function isHybridSearchRow(value: unknown): value is HybridSearchRow {
  if (!isRecord(value)) return false;
  return (
    typeof value.chunk_id === "string" &&
    typeof value.document_id === "string" &&
    typeof value.source === "string" &&
    typeof value.source_id === "string" &&
    typeof value.title === "string" &&
    (typeof value.section_path === "string" || value.section_path === null) &&
    typeof value.content === "string" &&
    (typeof value.source_url === "string" || value.source_url === null) &&
    (typeof value.brand === "string" || value.brand === null) &&
    (typeof value.area === "string" || value.area === null) &&
    typeof value.access_scope === "string" &&
    typeof value.fused_score === "number" &&
    Number.isFinite(value.fused_score) &&
    (typeof value.vector_rank === "number" || value.vector_rank === null) &&
    (typeof value.text_rank === "number" || value.text_rank === null)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
