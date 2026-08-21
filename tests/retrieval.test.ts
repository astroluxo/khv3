import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EMBEDDING_DIMENSIONS,
  OpenAIEmbeddingError,
  type EmbeddingClient,
} from "../supabase/functions/_shared/openai.ts";
import {
  retrieveKnowledge,
  RetrievalError,
  type HybridSearchRpcArgs,
  type RetrievalRpcClient,
} from "../supabase/functions/_shared/retrieval.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const migrationSql = readFileSync(
  join(root, "supabase/migrations/004_hybrid_retrieval.sql"),
  "utf8",
);
const returnsTableSql = migrationSql.match(/returns table \(([\s\S]*?)\)\nlanguage sql/)?.[1] ?? "";

class MockEmbeddingClient implements EmbeddingClient {
  readonly dimensions = DEFAULT_EMBEDDING_DIMENSIONS;
  readonly inputs: string[][] = [];

  constructor(private readonly failure: "none" | "rate_limit" = "none") {}

  async embedMany(inputs: string[]): Promise<number[][]> {
    this.inputs.push(inputs);
    if (this.failure === "rate_limit") {
      throw new OpenAIEmbeddingError("rate_limit", "rate limit", { status: 429 });
    }
    return inputs.map(() => makeEmbedding());
  }
}

class MockRpcClient implements RetrievalRpcClient {
  readonly calls: Array<{ functionName: string; args: HybridSearchRpcArgs }> = [];

  constructor(
    private readonly response: { data: unknown; error: unknown } = { data: [], error: null },
  ) {}

  async rpc(
    functionName: "hybrid_search",
    args: HybridSearchRpcArgs,
  ): Promise<{ data: unknown; error: unknown }> {
    this.calls.push({ functionName, args });
    return this.response;
  }
}

function makeEmbedding(): number[] {
  return Array.from({ length: DEFAULT_EMBEDDING_DIMENSIONS }, (_, index) => index / 100000);
}

function row(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    chunk_id: "chunk-1",
    document_id: "document-1",
    source: "notion",
    source_id: "page-1",
    title: "Módulo 10: Matrícula",
    section_path: "Módulo 10: Matrícula > Matrícula estudiantil",
    content: "El estudiante debe completar la matrícula.",
    source_url: "https://notion.local/page-1",
    brand: "Class Limitless",
    area: "Académica",
    access_scope: "default",
    fused_score: 0.032,
    vector_rank: 1,
    text_rank: null,
    ...overrides,
  };
}

describe("retrieval service", () => {
  it("retrieves semantic vector matches through the hybrid_search RPC", async () => {
    const supabase = new MockRpcClient({ data: [row()], error: null });
    const embeddingClient = new MockEmbeddingClient();

    const results = await retrieveKnowledge({
      query: "cómo funciona la matrícula",
      supabase,
      embeddingClient,
    });

    expect(results[0]).toMatchObject({
      content: "El estudiante debe completar la matrícula.",
      diagnostics: { rank: 1, vectorRank: 1 },
    });
    expect(supabase.calls[0].functionName).toBe("hybrid_search");
    expect(supabase.calls[0].args.query_embedding).toHaveLength(DEFAULT_EMBEDDING_DIMENSIONS);
  });

  it("allows exact terms or codes to win through the FTS component", async () => {
    const supabase = new MockRpcClient({
      data: [
        row({
          chunk_id: "chunk-code",
          content: "El consecutivo AC-2026-017 debe conservarse.",
          fused_score: 0.02,
          vector_rank: null,
          text_rank: 1,
        }),
      ],
      error: null,
    });

    const results = await retrieveKnowledge({
      query: "AC-2026-017",
      supabase,
      embeddingClient: new MockEmbeddingClient(),
    });

    expect(results[0].content).toContain("AC-2026-017");
    expect(results[0].diagnostics).toMatchObject({ textRank: 1 });
    expect(results[0].diagnostics.vectorRank).toBeUndefined();
  });

  it("preserves deterministic vector and FTS rank fusion order from SQL", async () => {
    const supabase = new MockRpcClient({
      data: [
        row({ chunk_id: "chunk-a", fused_score: 0.04, vector_rank: 1, text_rank: 3 }),
        row({ chunk_id: "chunk-b", fused_score: 0.03, vector_rank: 2, text_rank: 1 }),
      ],
      error: null,
    });

    const results = await retrieveKnowledge({
      query: "matrícula homologación",
      supabase,
      embeddingClient: new MockEmbeddingClient(),
    });

    expect(results.map((result) => result.internal.chunkId)).toEqual(["chunk-a", "chunk-b"]);
    expect(results.map((result) => result.diagnostics.rank)).toEqual([1, 2]);
  });

  it("passes explicit Brand as a retrieval filter", async () => {
    const supabase = new MockRpcClient();

    await retrieveKnowledge({
      query: "matrícula",
      supabase,
      embeddingClient: new MockEmbeddingClient(),
      options: { filters: { brand: "Class Limitless" } },
    });

    expect(supabase.calls[0].args.filter_brand).toBe("Class Limitless");
  });

  it("passes explicit Área as a retrieval filter", async () => {
    const supabase = new MockRpcClient();

    await retrieveKnowledge({
      query: "seguridad",
      supabase,
      embeddingClient: new MockEmbeddingClient(),
      options: { filters: { area: "Seguridad" } },
    });

    expect(supabase.calls[0].args.filter_area).toBe("Seguridad");
  });

  it("keeps Brand and Área separate from access permissions", async () => {
    const supabase = new MockRpcClient();

    await retrieveKnowledge({
      query: "calificación",
      supabase,
      embeddingClient: new MockEmbeddingClient(),
      options: {
        filters: {
          brand: "Class Limitless",
          area: "Académica",
          accessScopes: ["internal-ac"],
        },
      },
    });

    expect(supabase.calls[0].args).toMatchObject({
      filter_brand: "Class Limitless",
      filter_area: "Académica",
      allowed_access_scopes: ["internal-ac"],
    });
  });

  it("passes an empty access scope array as no scoped access", async () => {
    const supabase = new MockRpcClient();

    await retrieveKnowledge({
      query: "matrícula",
      supabase,
      embeddingClient: new MockEmbeddingClient(),
      options: { filters: { accessScopes: [] } },
    });

    expect(supabase.calls[0].args.allowed_access_scopes).toEqual([]);
  });

  it("does not let Brand grant access when access scopes are empty", async () => {
    const supabase = new MockRpcClient();

    await retrieveKnowledge({
      query: "matrícula",
      supabase,
      embeddingClient: new MockEmbeddingClient(),
      options: {
        filters: {
          brand: "Class Limitless",
          accessScopes: [],
        },
      },
    });

    expect(supabase.calls[0].args).toMatchObject({
      filter_brand: "Class Limitless",
      allowed_access_scopes: [],
    });
  });

  it("does not let Área grant access when access scopes are empty", async () => {
    const supabase = new MockRpcClient();

    await retrieveKnowledge({
      query: "seguridad",
      supabase,
      embeddingClient: new MockEmbeddingClient(),
      options: {
        filters: {
          area: "Seguridad",
          accessScopes: [],
        },
      },
    });

    expect(supabase.calls[0].args).toMatchObject({
      filter_area: "Seguridad",
      allowed_access_scopes: [],
    });
  });

  it("bounds invalid match_count and rrf_k before RPC", async () => {
    const supabase = new MockRpcClient();

    await retrieveKnowledge({
      query: "matrícula",
      supabase,
      embeddingClient: new MockEmbeddingClient(),
      options: { limit: -10, rrfK: 0 },
    });

    expect(supabase.calls[0].args.match_count).toBe(6);
    expect(supabase.calls[0].args.rrf_k).toBe(50);
  });

  it("bounds pathological weights before RPC", async () => {
    const supabase = new MockRpcClient();

    await retrieveKnowledge({
      query: "matrícula",
      supabase,
      embeddingClient: new MockEmbeddingClient(),
      options: { vectorWeight: -1, textWeight: 200 },
    });

    expect(supabase.calls[0].args.vector_weight).toBe(1);
    expect(supabase.calls[0].args.text_weight).toBe(10);
  });

  it("rejects excessively long Brand and Área filters", async () => {
    await expect(
      retrieveKnowledge({
        query: "matrícula",
        supabase: new MockRpcClient(),
        embeddingClient: new MockEmbeddingClient(),
        options: { filters: { brand: "x".repeat(201) } },
      }),
    ).rejects.toBeInstanceOf(RetrievalError);

    await expect(
      retrieveKnowledge({
        query: "matrícula",
        supabase: new MockRpcClient(),
        embeddingClient: new MockEmbeddingClient(),
        options: { filters: { area: "x".repeat(201) } },
      }),
    ).rejects.toMatchObject({ kind: "invalid_query" });
  });

  it("fails predictably on malformed RPC responses", async () => {
    await expect(
      retrieveKnowledge({
        query: "matrícula",
        supabase: new MockRpcClient({ data: [{ ...row(), fused_score: "bad" }], error: null }),
        embeddingClient: new MockEmbeddingClient(),
      }),
    ).rejects.toMatchObject({ kind: "malformed_rpc_response" });
  });

  it("propagates embedding failures safely", async () => {
    await expect(
      retrieveKnowledge({
        query: "matrícula",
        supabase: new MockRpcClient(),
        embeddingClient: new MockEmbeddingClient("rate_limit"),
      }),
    ).rejects.toMatchObject({ kind: "rate_limit" });
  });

  it("returns an empty array for empty retrieval results", async () => {
    await expect(
      retrieveKnowledge({
        query: "sin resultados",
        supabase: new MockRpcClient({ data: [], error: null }),
        embeddingClient: new MockEmbeddingClient(),
      }),
    ).resolves.toEqual([]);
  });

  it("enforces the retrieval limit for RPC and returned rows", async () => {
    const supabase = new MockRpcClient({
      data: [
        row({ chunk_id: "chunk-1" }),
        row({ chunk_id: "chunk-2" }),
        row({ chunk_id: "chunk-3" }),
      ],
      error: null,
    });

    const results = await retrieveKnowledge({
      query: "matrícula",
      supabase,
      embeddingClient: new MockEmbeddingClient(),
      options: { limit: 2 },
    });

    expect(supabase.calls[0].args.match_count).toBe(2);
    expect(results.map((result) => result.internal.chunkId)).toEqual(["chunk-1", "chunk-2"]);
  });

  it("generates the query embedding only once per retrieval call", async () => {
    const embeddingClient = new MockEmbeddingClient();

    await retrieveKnowledge({
      query: "homologaciones",
      supabase: new MockRpcClient({ data: [row()], error: null }),
      embeddingClient,
    });

    expect(embeddingClient.inputs).toEqual([["homologaciones"]]);
  });
});

describe("hybrid retrieval SQL contract", () => {
  it("requires the publication gate inside SQL", () => {
    expect(migrationSql).toContain("d.status = 'published'::public.document_status");
    expect(migrationSql).toContain("d.published_ac is true");
  });

  it("excludes draft or unpublished content even with service-role-style access scopes", () => {
    expect(migrationSql).toContain("where d.status = 'published'::public.document_status");
    expect(migrationSql).toContain("and d.published_ac is true");
    expect(migrationSql).toContain("d.access_scope = any(p.safe_allowed_access_scopes)");
  });

  it("makes access-scope semantics explicit and safe", () => {
    expect(migrationSql).toContain(
      "(allowed_access_scopes is null and d.access_scope = 'default')",
    );
    expect(migrationSql).toContain("allowed_access_scopes is not null");
    expect(migrationSql).toContain("cardinality(p.safe_allowed_access_scopes) > 0");
    expect(migrationSql).toContain("d.access_scope = any(p.safe_allowed_access_scopes)");
  });

  it("keeps Brand and Área out of authorization logic", () => {
    expect(migrationSql).toContain(
      "(p.safe_filter_brand is null or d.brand = p.safe_filter_brand)",
    );
    expect(migrationSql).toContain("(p.safe_filter_area is null or d.area = p.safe_filter_area)");
    expect(migrationSql).toContain(
      "Brand/Área are optional knowledge filters, never authorization",
    );
  });

  it("uses deliberate function security and execution privileges", () => {
    expect(migrationSql).toContain("security invoker");
    expect(migrationSql).toContain("set search_path = public, extensions");
    expect(migrationSql).toContain("from public;");
    expect(migrationSql).toContain("from anon;");
    expect(migrationSql).toContain("to authenticated, service_role;");
  });

  it("bounds direct RPC inputs inside SQL", () => {
    expect(migrationSql).toContain("least(greatest(coalesce(match_count, 20), 1), 50)");
    expect(migrationSql).toContain("least(greatest(coalesce(rrf_k, 50), 1), 1000)");
    expect(migrationSql).toContain("least(greatest(coalesce(vector_weight, 1.0), 0.0), 10.0)");
    expect(migrationSql).toContain("least(greatest(coalesce(text_weight, 1.0), 0.0), 10.0)");
    expect(migrationSql).toContain("length(btrim(filter_brand)) between 1 and 200");
    expect(migrationSql).toContain("length(btrim(filter_area)) between 1 and 200");
  });

  it("does not use production or editorial metadata for ranking", () => {
    expect(migrationSql).not.toContain("production_metadata");
    expect(migrationSql).not.toContain("editorial_metadata");
  });

  it("does not return production, editorial, Quiz, Observaciones, or raw embeddings", () => {
    expect(returnsTableSql).not.toContain("production_metadata");
    expect(returnsTableSql).not.toContain("editorial_metadata");
    expect(returnsTableSql).not.toContain("Observaciones");
    expect(returnsTableSql).not.toContain("Quiz");
    expect(returnsTableSql).not.toContain("embedding");
  });

  it("uses cosine vector search, simple FTS, and deterministic RRF", () => {
    expect(migrationSql).toContain("e.embedding <=> query_embedding");
    expect(migrationSql).toContain(
      "websearch_to_tsquery('simple', left(coalesce(query_text, ''), 1000))",
    );
    expect(migrationSql).toContain(
      "(select safe_vector_weight from params) / ((select safe_rrf_k from params) + s.vector_rank)",
    );
    expect(migrationSql).toContain(
      "(select safe_text_weight from params) / ((select safe_rrf_k from params) + k.text_rank)",
    );
    expect(migrationSql).toContain("order by f.fused_score desc");
    expect(migrationSql).toContain("e.id");
  });

  it("adds the HNSW cosine index for semantic retrieval", () => {
    expect(migrationSql).toContain("using hnsw (embedding extensions.vector_cosine_ops)");
  });
});
