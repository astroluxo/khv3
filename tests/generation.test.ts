import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildEvidenceContext,
  generateGroundedAnswer,
  GenerationError,
  GROUNDED_ANSWER_RESPONSE_FORMAT,
  INSUFFICIENT_EVIDENCE_ANSWER,
  OpenAIGenerationClient,
  type GenerationClient,
  type GenerationClientRequest,
  type GenerationClientResponse,
} from "../supabase/functions/_shared/generation.ts";
import {
  runGroundedChat,
  type QueryLogInput,
} from "../supabase/functions/_shared/chat-pipeline.ts";
import type {
  RetrievalResult,
  RetrievalRpcClient,
} from "../supabase/functions/_shared/retrieval.ts";

class MockGenerationClient implements GenerationClient {
  readonly requests: GenerationClientRequest[] = [];

  constructor(
    private readonly response: GenerationClientResponse | GenerationError = {
      text: JSON.stringify({
        answer: "La matrícula debe completarse antes del inicio académico. [S1]",
        sourceLabels: ["S1"],
        insufficientEvidence: false,
      }),
      usage: { inputTokens: 10, outputTokens: 20 },
    },
  ) {}

  async generate(request: GenerationClientRequest): Promise<GenerationClientResponse> {
    this.requests.push(request);
    if (this.response instanceof GenerationError) throw this.response;
    return this.response;
  }
}

class FailingGenerationClient implements GenerationClient {
  async generate(): Promise<GenerationClientResponse> {
    throw new Error("generation should have been skipped");
  }
}

class MockLogger {
  readonly entries: QueryLogInput[] = [];

  constructor(private readonly shouldFail = false) {}

  async logQuery(input: QueryLogInput): Promise<{ queryId?: string }> {
    this.entries.push(input);
    if (this.shouldFail) throw new Error("log failed");
    return { queryId: "query-1" };
  }
}

const mockSupabase: RetrievalRpcClient = {
  async rpc() {
    return { data: [], error: null };
  },
};

function retrieval(overrides: Partial<RetrievalResult> = {}): RetrievalResult {
  return {
    internal: {
      chunkId: "chunk-secret-1",
      documentId: "00000000-0000-0000-0000-000000000001",
      source: "notion",
      sourceId: "page-secret-1",
      accessScope: "default",
    },
    document: {
      title: "Módulo 10: Matrícula",
      sourceUrl: "https://notion.local/page-1",
      brand: "Class Limitless",
      area: "Académica",
    },
    sectionPath: "Módulo 10: Matrícula > Matrícula estudiantil",
    content: "El estudiante debe completar la matrícula antes del inicio académico.",
    diagnostics: {
      rank: 1,
      fusedScore: 0.42,
      vectorRank: 1,
      textRank: 2,
    },
    ...overrides,
  };
}

function jsonResponse(value: {
  answer: string;
  sourceLabels?: string[];
  insufficientEvidence?: boolean;
}): GenerationClientResponse {
  return {
    text: JSON.stringify({
      sourceLabels: value.sourceLabels ?? [],
      insufficientEvidence: value.insufficientEvidence ?? false,
      answer: value.answer,
    }),
  };
}

describe("grounded answer generation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("skips generation when there are zero retrieval results", async () => {
    const result = await generateGroundedAnswer({
      question: "¿Cuál es el proceso?",
      evidence: [],
      client: new FailingGenerationClient(),
    });

    expect(result).toEqual({
      answer: INSUFFICIENT_EVIDENCE_ANSWER,
      citations: [],
      insufficientEvidence: true,
    });
  });

  it("returns a grounded answer with one valid citation", async () => {
    const client = new MockGenerationClient();
    const result = await generateGroundedAnswer({
      question: "¿Cuándo se completa la matrícula?",
      evidence: [retrieval()],
      client,
      model: "test-model",
    });

    expect(result.answer).toContain("[S1]");
    expect(result.citations).toEqual([
      {
        label: "S1",
        title: "Módulo 10: Matrícula",
        section: "Módulo 10: Matrícula > Matrícula estudiantil",
        sourceUrl: "https://notion.local/page-1",
      },
    ]);
    expect(result.insufficientEvidence).toBe(false);
    expect(client.requests[0].responseFormat).toEqual(GROUNDED_ANSWER_RESPONSE_FORMAT);
    expect(client.requests[0].responseFormat).toMatchObject({
      type: "json_schema",
      name: "grounded_answer",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["answer", "sourceLabels", "insufficientEvidence"],
      },
    });
  });

  it("supports answers using multiple citations", async () => {
    const result = await generateGroundedAnswer({
      question: "¿Qué dicen las fuentes?",
      evidence: [
        retrieval(),
        retrieval({
          internal: {
            chunkId: "chunk-secret-2",
            documentId: "00000000-0000-0000-0000-000000000002",
            source: "notion",
            sourceId: "page-secret-2",
            accessScope: "default",
          },
          document: { title: "Módulo 6: Homologaciones", sourceUrl: "https://notion.local/page-2" },
          sectionPath: "Módulo 6: Homologaciones > Faltas de asistencia",
          content: "Las faltas deben registrarse con soporte.",
        }),
      ],
      client: new MockGenerationClient(
        jsonResponse({
          answer: "La matrícula tiene fecha previa [S1] y las faltas requieren soporte [S2].",
          sourceLabels: ["S1", "S2"],
        }),
      ),
    });

    expect(result.citations.map((citation) => citation.label)).toEqual(["S1", "S2"]);
  });

  it("rejects invented-only citation labels", async () => {
    await expect(
      generateGroundedAnswer({
        question: "¿Qué hacer?",
        evidence: [retrieval()],
        client: new MockGenerationClient(
          jsonResponse({
            answer: "La matrícula debe completarse antes del inicio académico. [S99]",
            sourceLabels: ["S99"],
          }),
        ),
      }),
    ).rejects.toMatchObject({ kind: "malformed_response" });
  });

  it("rejects mixed valid and invented citation labels", async () => {
    await expect(
      generateGroundedAnswer({
        question: "¿Qué hacer?",
        evidence: [retrieval()],
        client: new MockGenerationClient(
          jsonResponse({
            answer: "La matrícula debe completarse antes del inicio académico. [S1] [S99]",
            sourceLabels: ["S1", "S99"],
          }),
        ),
      }),
    ).rejects.toMatchObject({ kind: "malformed_response" });
  });

  it("deduplicates duplicate citation labels", async () => {
    const result = await generateGroundedAnswer({
      question: "¿Qué hacer?",
      evidence: [retrieval()],
      client: new MockGenerationClient(
        jsonResponse({
          answer: "Debe completarse antes del inicio. [S1] También aplica al calendario. [S1]",
          sourceLabels: ["S1", "S1"],
        }),
      ),
    });

    expect(result.citations).toHaveLength(1);
  });

  it("rejects model world knowledge when evidence lacks a valid citation", async () => {
    await expect(
      generateGroundedAnswer({
        question: "¿Cuál es una política interna no recuperada?",
        evidence: [retrieval({ content: "Solo hay información de matrícula." })],
        client: new MockGenerationClient(
          jsonResponse({
            answer: "La empresa permite una prórroga automática de 30 días.",
            sourceLabels: [],
          }),
        ),
      }),
    ).rejects.toMatchObject({ kind: "malformed_response" });
  });

  it("returns structured insufficient evidence when the model refuses", async () => {
    const result = await generateGroundedAnswer({
      question: "¿Qué dice una fuente ausente?",
      evidence: [retrieval()],
      client: new MockGenerationClient(
        jsonResponse({
          answer: INSUFFICIENT_EVIDENCE_ANSWER,
          insufficientEvidence: true,
        }),
      ),
    });

    expect(result).toMatchObject({
      answer: INSUFFICIENT_EVIDENCE_ANSWER,
      citations: [],
      insufficientEvidence: true,
    });
  });

  it("rejects contradictory insufficient-evidence responses with citations", async () => {
    await expect(
      generateGroundedAnswer({
        question: "¿Qué dice una fuente ausente?",
        evidence: [retrieval()],
        client: new MockGenerationClient(
          jsonResponse({
            answer: `${INSUFFICIENT_EVIDENCE_ANSWER} [S1]`,
            sourceLabels: ["S1"],
            insufficientEvidence: true,
          }),
        ),
      }),
    ).rejects.toMatchObject({ kind: "malformed_response" });
  });

  it("surfaces conflicting evidence conservatively when cited", async () => {
    const result = await generateGroundedAnswer({
      question: "¿Cuál fecha aplica?",
      evidence: [retrieval(), retrieval({ content: "Otra fuente indica una fecha distinta." })],
      client: new MockGenerationClient(
        jsonResponse({
          answer:
            "Hay un conflicto entre las fuentes; una indica el inicio académico y otra una fecha distinta. [S1] [S2]",
          sourceLabels: ["S1", "S2"],
        }),
      ),
    });

    expect(result.answer).toContain("conflicto");
    expect(result.citations.map((citation) => citation.label)).toEqual(["S1", "S2"]);
  });

  it("keeps production, editorial, scores, embeddings, and internal ids out of context", async () => {
    const client = new MockGenerationClient();
    await generateGroundedAnswer({
      question: "¿Qué evidencia hay?",
      evidence: [retrieval()],
      client,
    });

    const input = client.requests[0].input;
    expect(input).toContain("[S1]");
    expect(input).not.toContain("https://notion.local/page-1");
    expect(input).not.toContain("production_metadata");
    expect(input).not.toContain("editorial_metadata");
    expect(input).not.toContain("Observaciones");
    expect(input).not.toContain("Quiz");
    expect(input).not.toContain("0.42");
    expect(input).not.toContain("vectorRank");
    expect(input).not.toContain("embedding");
    expect(input).not.toContain("chunk-secret-1");
    expect(input).not.toContain("page-secret-1");
    expect(input).not.toContain("Class Limitless");
    expect(input).not.toContain("Académica");
    expect(input).not.toContain("default");
  });

  it("rejects additional model response properties", async () => {
    await expect(
      generateGroundedAnswer({
        question: "¿Qué hacer?",
        evidence: [retrieval()],
        client: new MockGenerationClient({
          text: JSON.stringify({
            answer: "Debe completarse antes del inicio. [S1]",
            sourceLabels: ["S1"],
            insufficientEvidence: false,
            sourceUrl: "https://model-invented.local",
          }),
        }),
      }),
    ).rejects.toMatchObject({ kind: "malformed_response" });
  });

  it("uses source URLs from retrieval data, not model output", async () => {
    const result = await generateGroundedAnswer({
      question: "¿Qué hacer?",
      evidence: [retrieval()],
      client: new MockGenerationClient(
        jsonResponse({
          answer: "Debe completarse antes del inicio. [S1]",
          sourceLabels: ["S1"],
        }),
      ),
    });

    expect(result.citations[0].sourceUrl).toBe("https://notion.local/page-1");
  });

  it("rejects responses with missing or wrongly typed fields", async () => {
    await expect(
      generateGroundedAnswer({
        question: "¿Qué hacer?",
        evidence: [retrieval()],
        client: new MockGenerationClient({
          text: JSON.stringify({
            answer: "Debe completarse antes del inicio. [S1]",
            insufficientEvidence: false,
          }),
        }),
      }),
    ).rejects.toMatchObject({ kind: "malformed_response" });

    await expect(
      generateGroundedAnswer({
        question: "¿Qué hacer?",
        evidence: [retrieval()],
        client: new MockGenerationClient({
          text: JSON.stringify({
            answer: 42,
            sourceLabels: ["S1"],
            insufficientEvidence: false,
          }),
        }),
      }),
    ).rejects.toMatchObject({ kind: "malformed_response" });

    await expect(
      generateGroundedAnswer({
        question: "¿Qué hacer?",
        evidence: [retrieval()],
        client: new MockGenerationClient({
          text: JSON.stringify({
            answer: "Debe completarse antes del inicio. [S1]",
            sourceLabels: ["S1"],
            insufficientEvidence: "false",
          }),
        }),
      }),
    ).rejects.toMatchObject({ kind: "malformed_response" });

    await expect(
      generateGroundedAnswer({
        question: "¿Qué hacer?",
        evidence: [retrieval()],
        client: new MockGenerationClient({
          text: JSON.stringify({
            answer: "Debe completarse antes del inicio. [S1]",
            sourceLabels: ["S1", 99],
            insufficientEvidence: false,
          }),
        }),
      }),
    ).rejects.toMatchObject({ kind: "malformed_response" });
  });

  it("rejects Responses API refusal and incomplete states safely", async () => {
    stubDenoEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          status: "completed",
          output: [{ content: [{ type: "refusal", refusal: "No puedo ayudar." }] }],
        }),
      ),
    );

    await expect(
      generateGroundedAnswer({
        question: "¿Qué hacer?",
        evidence: [retrieval()],
        client: new OpenAIGenerationClient(),
        model: "test-model",
      }),
    ).rejects.toMatchObject({ kind: "malformed_response" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        }),
      ),
    );

    await expect(
      generateGroundedAnswer({
        question: "¿Qué hacer?",
        evidence: [retrieval()],
        client: new OpenAIGenerationClient(),
        model: "test-model",
      }),
    ).rejects.toMatchObject({ kind: "malformed_response" });
  });

  it("sends strict Structured Outputs schema to the Responses API", async () => {
    stubDenoEnv();
    const fetchMock = vi.fn(async () =>
      Response.json({
        status: "completed",
        output_text: JSON.stringify({
          answer: "Debe completarse antes del inicio. [S1]",
          sourceLabels: ["S1"],
          insufficientEvidence: false,
        }),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await generateGroundedAnswer({
      question: "¿Qué hacer?",
      evidence: [retrieval()],
      client: new OpenAIGenerationClient(),
      model: "test-model",
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.text.format).toEqual(GROUNDED_ANSWER_RESPONSE_FORMAT);
    expect(body.text.format.schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["answer", "sourceLabels", "insufficientEvidence"],
      properties: {
        answer: { type: "string" },
        sourceLabels: { type: "array", items: { type: "string" } },
        insufficientEvidence: { type: "boolean" },
      },
    });
  });

  it("parses structured text from raw Responses API output content", async () => {
    stubDenoEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          status: "completed",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    answer: "Debe completarse antes del inicio. [S1]",
                    sourceLabels: ["S1"],
                    insufficientEvidence: false,
                  }),
                },
              ],
            },
          ],
        }),
      ),
    );

    const result = await generateGroundedAnswer({
      question: "¿Qué hacer?",
      evidence: [retrieval()],
      client: new OpenAIGenerationClient(),
      model: "test-model",
    });

    expect(result.insufficientEvidence).toBe(false);
    expect(result.citations.map((citation) => citation.label)).toEqual(["S1"]);
  });

  it("rejects unexpected Responses API payloads safely", async () => {
    stubDenoEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          status: "completed",
          output: [],
        }),
      ),
    );

    await expect(
      generateGroundedAnswer({
        question: "¿Qué hacer?",
        evidence: [retrieval()],
        client: new OpenAIGenerationClient(),
        model: "test-model",
      }),
    ).rejects.toMatchObject({ kind: "malformed_response" });
  });

  it("fails predictably on malformed model responses", async () => {
    await expect(
      generateGroundedAnswer({
        question: "¿Qué hacer?",
        evidence: [retrieval()],
        client: new MockGenerationClient({ text: "not json" }),
      }),
    ).rejects.toBeInstanceOf(GenerationError);
  });

  it("propagates generation rate-limit and transient failures predictably", async () => {
    await expect(
      generateGroundedAnswer({
        question: "¿Qué hacer?",
        evidence: [retrieval()],
        client: new MockGenerationClient(new GenerationError("rate_limit", "rate limited")),
      }),
    ).rejects.toMatchObject({ kind: "rate_limit" });

    await expect(
      generateGroundedAnswer({
        question: "¿Qué hacer?",
        evidence: [retrieval()],
        client: new MockGenerationClient(
          new GenerationError("transient_upstream", "temporary failure"),
        ),
      }),
    ).rejects.toMatchObject({ kind: "transient_upstream" });
  });

  it("builds evidence context only from approved fields", () => {
    const context = buildEvidenceContext([retrieval()]);

    expect(context).toContain("Document: Módulo 10: Matrícula");
    expect(context).toContain("Section: Módulo 10: Matrícula > Matrícula estudiantil");
    expect(context).toContain("Content: El estudiante debe completar la matrícula");
    expect(context).not.toContain("Class Limitless");
    expect(context).not.toContain("Académica");
    expect(context).not.toContain("chunk-secret-1");
  });
});

describe("grounded chat pipeline", () => {
  it("logs expected safe fields for a valid answer", async () => {
    const logger = new MockLogger();
    const result = await runGroundedChat({
      userId: "user-1",
      question: "¿Cuándo se completa la matrícula?",
      supabase: mockSupabase,
      allowedAccessScopes: ["default"],
      logger,
      retrieve: async () => [retrieval()],
      generationClient: new MockGenerationClient(),
      model: "test-model",
      now: clock([100, 150]),
    });

    expect(logger.entries[0]).toMatchObject({
      userId: "user-1",
      question: "¿Cuándo se completa la matrícula?",
      answer: "La matrícula debe completarse antes del inicio académico. [S1]",
      insufficientEvidence: false,
      model: "test-model",
      latencyMs: 50,
      inputTokens: 10,
      outputTokens: 20,
      retrievedChunkIds: ["chunk-secret-1"],
      retrievedDocumentIds: ["00000000-0000-0000-0000-000000000001"],
    });
    expect(JSON.stringify(logger.entries[0])).not.toContain("SOURCES");
    expect(JSON.stringify(logger.entries[0])).not.toContain("developer");
    expect(JSON.stringify(logger.entries[0])).not.toContain("embedding");
    expect(JSON.stringify(logger.entries[0])).not.toContain("Observaciones");
    expect(JSON.stringify(logger.entries[0])).not.toContain("Quiz");
  });

  it("does not corrupt a valid answer when logging fails", async () => {
    const result = await runGroundedChat({
      userId: "user-1",
      question: "¿Cuándo se completa la matrícula?",
      supabase: mockSupabase,
      allowedAccessScopes: ["default"],
      logger: new MockLogger(true),
      retrieve: async () => [retrieval()],
      generationClient: new MockGenerationClient(),
    });

    expect(result.insufficient_evidence).toBe(false);
    expect(result.answer).toContain("[S1]");
  });

  it("propagates retrieval failure safely", async () => {
    await expect(
      runGroundedChat({
        userId: "user-1",
        question: "¿Cuándo se completa la matrícula?",
        supabase: mockSupabase,
        allowedAccessScopes: ["default"],
        logger: new MockLogger(),
        retrieve: async () => {
          throw new Error("retrieval failed");
        },
      }),
    ).rejects.toThrow("retrieval failed");
  });

  it("passes access scopes into retrieval and never infers them from Brand or Área", async () => {
    const calls: unknown[] = [];

    await runGroundedChat({
      userId: "user-1",
      question: "¿Qué dice Class Limitless Académica?",
      supabase: mockSupabase,
      allowedAccessScopes: ["scope-a"],
      logger: new MockLogger(),
      retrieve: async (input) => {
        calls.push(input.options);
        return [retrieval()];
      },
      generationClient: new MockGenerationClient(),
    });

    expect(calls[0]).toEqual({ filters: { accessScopes: ["scope-a"] } });
  });

  it("returns insufficient evidence and skips generation for zero retrieval results", async () => {
    const logger = new MockLogger();
    const result = await runGroundedChat({
      userId: "user-1",
      question: "¿Qué dice una fuente ausente?",
      supabase: mockSupabase,
      allowedAccessScopes: [],
      logger,
      retrieve: async () => [],
      generationClient: new FailingGenerationClient(),
    });

    expect(result).toMatchObject({
      answer: INSUFFICIENT_EVIDENCE_ANSWER,
      sources: [],
      insufficient_evidence: true,
    });
    expect(logger.entries[0]).toMatchObject({
      insufficientEvidence: true,
      retrievedChunkIds: [],
      retrievedDocumentIds: [],
    });
  });

  it("does not treat low fused RRF score as a hard evidence threshold", async () => {
    const client = new MockGenerationClient();
    const result = await runGroundedChat({
      userId: "user-1",
      question: "¿Cuándo se completa la matrícula?",
      supabase: mockSupabase,
      allowedAccessScopes: ["default"],
      logger: new MockLogger(),
      retrieve: async () => [
        retrieval({
          diagnostics: {
            rank: 1,
            fusedScore: 0,
            vectorRank: 1,
            textRank: 1,
          },
        }),
      ],
      generationClient: client,
    });

    expect(result.insufficient_evidence).toBe(false);
    expect(client.requests).toHaveLength(1);
  });

  it("keeps user-facing chat output free of internal retrieval diagnostics", async () => {
    const result = await runGroundedChat({
      userId: "user-1",
      question: "¿Cuándo se completa la matrícula?",
      supabase: mockSupabase,
      allowedAccessScopes: ["default"],
      logger: new MockLogger(),
      retrieve: async () => [retrieval()],
      generationClient: new MockGenerationClient(),
    });

    const output = JSON.stringify(result);
    expect(output).not.toContain("chunk-secret-1");
    expect(output).not.toContain("00000000-0000-0000-0000-000000000001");
    expect(output).not.toContain("default");
    expect(output).not.toContain("0.42");
    expect(output).not.toContain("vectorRank");
    expect(output).not.toContain("textRank");
    expect(output).not.toContain("query-1");
  });
});

function clock(values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

function stubDenoEnv(): void {
  vi.stubGlobal("Deno", {
    env: {
      get(name: string): string | undefined {
        return name === "OPENAI_API_KEY" ? "test-api-key" : undefined;
      },
    },
  });
}
