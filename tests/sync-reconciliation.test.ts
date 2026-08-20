import { describe, expect, it } from "vitest";
import {
  chunkSections,
  type NormalizedSection,
  type TextChunk,
} from "../supabase/functions/_shared/chunking.ts";
import {
  createEmbeddingConfig,
  DEFAULT_EMBEDDING_DIMENSIONS,
  OpenAIEmbeddingClient,
  OpenAIEmbeddingError,
  type EmbeddingClient,
} from "../supabase/functions/_shared/openai.ts";
import type { NotionSourceDocument } from "../supabase/functions/_shared/notion-normalizer.ts";
import {
  buildEmbeddingInput,
  reconcileNotionDocument,
  type ChunkPersist,
  type DocumentUpsert,
  type ExistingChunk,
  type ExistingDocument,
  type SyncRepository,
} from "../supabase/functions/_shared/sync-reconciliation.ts";

const SYNC_TIME = new Date("2026-08-19T12:00:00.000Z");

class MockEmbeddingClient implements EmbeddingClient {
  readonly dimensions = DEFAULT_EMBEDDING_DIMENSIONS;
  readonly calls: string[][] = [];

  constructor(private readonly behavior: "ok" | "rate_limit" | "transient" | "malformed" = "ok") {}

  async embedMany(inputs: string[]): Promise<number[][]> {
    this.calls.push(inputs);
    if (this.behavior === "rate_limit") {
      throw new OpenAIEmbeddingError("rate_limit", "rate limited", { status: 429 });
    }
    if (this.behavior === "transient") {
      throw new OpenAIEmbeddingError("transient_upstream", "temporary failure", { status: 503 });
    }
    if (this.behavior === "malformed") {
      throw new OpenAIEmbeddingError("malformed_response", "bad payload");
    }
    return inputs.map((input, index) => makeEmbedding(index + input.length / 1000));
  }
}

class MockSyncRepository implements SyncRepository {
  readonly upserts: DocumentUpsert[] = [];
  readonly chunkUpserts: ChunkPersist[][] = [];
  readonly chunkDeletes: string[][] = [];
  readonly operations: string[] = [];
  document: ExistingDocument = { id: "doc-1", sourceId: "page-m10", status: "published" };

  constructor(
    public chunks: ExistingChunk[] = [],
    private readonly failure: "none" | "upsert_chunks" | "delete_chunks" = "none",
  ) {}

  async getDocumentBySourceId(): Promise<ExistingDocument | null> {
    return this.document;
  }

  async upsertDocument(input: DocumentUpsert): Promise<ExistingDocument> {
    this.operations.push(input.lastSyncedAt !== undefined ? "document_success" : "document_start");
    this.upserts.push(input);
    this.document = { id: this.document.id, sourceId: input.sourceId, status: input.status };
    return this.document;
  }

  async listChunks(): Promise<ExistingChunk[]> {
    return this.chunks.map((chunk) => ({
      ...chunk,
      embedding: chunk.embedding ? [...chunk.embedding] : null,
    }));
  }

  async upsertChunks(input: { documentId: string; chunks: ChunkPersist[] }): Promise<void> {
    this.operations.push("chunks_upsert");
    if (this.failure === "upsert_chunks") throw new Error("chunk upsert failed");
    this.chunkUpserts.push(
      input.chunks.map((chunk) => ({ ...chunk, embedding: [...chunk.embedding] })),
    );
    this.chunks = input.chunks.map((chunk, index) => ({
      id: chunk.existingId ?? `persisted-${index}`,
      sourceChunkKey: chunk.sourceChunkKey,
      contentHash: chunk.contentHash,
      ordinal: chunk.ordinal,
      embedding: [...chunk.embedding],
    }));
  }

  async deleteChunks(input: { documentId: string; chunkIds: string[] }): Promise<void> {
    this.operations.push("chunks_delete");
    if (this.failure === "delete_chunks") throw new Error("chunk delete failed");
    this.chunkDeletes.push([...input.chunkIds]);
    this.chunks = this.chunks.filter((chunk) => !input.chunkIds.includes(chunk.id));
  }
}

function makeEmbedding(seed = 1): number[] {
  return Array.from({ length: DEFAULT_EMBEDDING_DIMENSIONS }, (_, index) => seed + index / 100000);
}

function section(overrides: Partial<NormalizedSection> = {}): NormalizedSection {
  return {
    path: "Módulo 10: Matrícula > Matrícula estudiantil",
    text: "El estudiante debe completar la matrícula antes del inicio académico.",
    documentTitle: "Módulo 10: Matrícula",
    brand: "Class Limitless",
    area: "Académica",
    sectionTitle: "Matrícula estudiantil",
    headingPath: "Módulo 10: Matrícula > Matrícula estudiantil",
    sourcePageId: "page-m10",
    sourceUrl: "https://notion.local/page-m10",
    sourceUpdatedAt: "2026-08-19T12:00:00.000Z",
    ...overrides,
  };
}

function sourceDocument(overrides: Partial<NotionSourceDocument> = {}): NotionSourceDocument {
  const sourceId = overrides.sourceId ?? "page-m10";
  const title = overrides.title ?? "Módulo 10: Matrícula";
  return {
    source: "notion",
    sourceId,
    title,
    archived: false,
    url: `https://notion.local/${sourceId}`,
    sourceUpdatedAt: "2026-08-19T12:00:00.000Z",
    brand: "Class Limitless",
    area: "Académica",
    publishedAc: true,
    knowledgeMetadata: {
      pageId: sourceId,
      sourceUrl: `https://notion.local/${sourceId}`,
      lastEditedTime: "2026-08-19T12:00:00.000Z",
      brand: "Class Limitless",
      area: "Académica",
      publishedAc: true,
    },
    traceabilityMetadata: { Versión: ["version-m10"], Rel_Actualizaciones: ["update-m10"] },
    productionMetadata: {
      "Formato Contenido": "Video",
      Audio: true,
      Guión: "Draft script",
      "Video Base": "https://video.local/base",
      "Video Final": "https://video.local/final",
      EstadoVid: "Finalizado",
      Quiz: "Production quiz property",
    },
    editorialMetadata: { Observaciones: "Editorial note" },
    sections: [section()],
    ...overrides,
  };
}

async function existingFromSection(
  normalizedSection: NormalizedSection,
  overrides: Partial<ExistingChunk> = {},
): Promise<ExistingChunk> {
  const [chunk] = await chunkSections([normalizedSection]);
  return existingFromChunk(chunk, overrides);
}

function existingFromChunk(
  chunk: TextChunk,
  overrides: Partial<ExistingChunk> = {},
): ExistingChunk {
  return {
    id: overrides.id ?? `existing-${chunk.ordinal}`,
    sourceChunkKey: overrides.sourceChunkKey ?? chunk.sourceChunkKey,
    contentHash: overrides.contentHash ?? chunk.contentHash,
    ordinal: overrides.ordinal ?? chunk.ordinal,
    embedding: overrides.embedding ?? makeEmbedding(0.25),
  };
}

describe("incremental sync reconciliation", () => {
  it("reuses unchanged chunks without embedding calls", async () => {
    const source = sourceDocument();
    const existing = await existingFromSection(source.sections[0]);
    const repository = new MockSyncRepository([existing]);
    const embeddings = new MockEmbeddingClient();

    const result = await reconcileNotionDocument({
      source,
      repository,
      embeddingClient: embeddings,
      now: SYNC_TIME,
    });

    expect(result).toMatchObject({ chunksUnchanged: 1, chunksAdded: 0, chunksDeleted: 0 });
    expect(embeddings.calls).toHaveLength(0);
    expect(repository.chunkUpserts[0][0].embedding).toEqual(existing.embedding);
  });

  it("embeds new chunks in one practical batch", async () => {
    const source = sourceDocument({
      sections: [
        section(),
        section({
          path: "Módulo 6: Homologaciones > Faltas de asistencia",
          text: "Las faltas de asistencia deben registrarse con soporte.",
          documentTitle: "Módulo 6: Homologaciones",
          sectionTitle: "Faltas de asistencia",
          headingPath: "Módulo 6: Homologaciones > Faltas de asistencia",
          sourcePageId: "page-m6",
          sourceUrl: "https://notion.local/page-m6",
        }),
      ],
    });
    const repository = new MockSyncRepository();
    const embeddings = new MockEmbeddingClient();

    const result = await reconcileNotionDocument({
      source,
      repository,
      embeddingClient: embeddings,
      now: SYNC_TIME,
    });

    expect(result.chunksAdded).toBe(2);
    expect(embeddings.calls).toHaveLength(1);
    expect(embeddings.calls[0]).toHaveLength(2);
    expect(repository.chunkUpserts[0]).toHaveLength(2);
  });

  it("treats changed content as removed old hash plus inserted new hash", async () => {
    const oldSection = section({ text: "Contenido anterior de matrícula." });
    const source = sourceDocument({
      sections: [section({ text: "Contenido actualizado de matrícula." })],
    });
    const oldChunk = await existingFromSection(oldSection, { id: "old-chunk" });
    const repository = new MockSyncRepository([oldChunk]);
    const embeddings = new MockEmbeddingClient();

    const result = await reconcileNotionDocument({
      source,
      repository,
      embeddingClient: embeddings,
      now: SYNC_TIME,
    });

    expect(result).toMatchObject({ chunksAdded: 1, chunksDeleted: 1 });
    expect(embeddings.calls).toHaveLength(1);
    expect(repository.chunkDeletes[0]).toEqual(["old-chunk"]);
  });

  it("removes existing chunks that are absent from the desired semantic state", async () => {
    const source = sourceDocument();
    const desiredExisting = await existingFromSection(source.sections[0], { id: "keep-chunk" });
    const stale = await existingFromSection(
      section({
        path: "Módulo 11: Calificación > Nota final",
        text: "La nota final se publica al cierre.",
        documentTitle: "Módulo 11: Calificación",
        sectionTitle: "Nota final",
        headingPath: "Módulo 11: Calificación > Nota final",
        sourcePageId: "page-m11",
      }),
      { id: "stale-chunk" },
    );
    const repository = new MockSyncRepository([desiredExisting, stale]);

    await reconcileNotionDocument({
      source,
      repository,
      embeddingClient: new MockEmbeddingClient(),
      now: SYNC_TIME,
    });

    expect(repository.chunkDeletes[0]).toEqual(["stale-chunk"]);
  });

  it("updates ordinal-only changes without regenerating embeddings", async () => {
    const source = sourceDocument();
    const existing = await existingFromSection(source.sections[0], {
      ordinal: 5,
      embedding: makeEmbedding(9),
    });
    const repository = new MockSyncRepository([existing]);
    const embeddings = new MockEmbeddingClient();

    await reconcileNotionDocument({
      source,
      repository,
      embeddingClient: embeddings,
      now: SYNC_TIME,
    });

    expect(embeddings.calls).toHaveLength(0);
    expect(repository.chunkUpserts[0][0]).toMatchObject({
      ordinal: 0,
      embedding: makeEmbedding(9),
    });
  });

  it("does not re-embed when production metadata changes", async () => {
    const source = sourceDocument({
      productionMetadata: { "Video Final": "https://video.local/changed", Quiz: "changed" },
    });
    const existing = await existingFromSection(source.sections[0]);
    const repository = new MockSyncRepository([existing]);
    const embeddings = new MockEmbeddingClient();

    await reconcileNotionDocument({
      source,
      repository,
      embeddingClient: embeddings,
      now: SYNC_TIME,
    });

    expect(embeddings.calls).toHaveLength(0);
    expect(repository.upserts[0].productionMetadata).toMatchObject({
      "Video Final": "https://video.local/changed",
    });
  });

  it("does not re-embed when Observaciones/editorial metadata changes", async () => {
    const source = sourceDocument({
      editorialMetadata: { Observaciones: "Changed editorial note" },
    });
    const existing = await existingFromSection(source.sections[0]);
    const repository = new MockSyncRepository([existing]);
    const embeddings = new MockEmbeddingClient();

    await reconcileNotionDocument({
      source,
      repository,
      embeddingClient: embeddings,
      now: SYNC_TIME,
    });

    expect(embeddings.calls).toHaveLength(0);
    expect(repository.upserts[0].editorialMetadata).toEqual({
      Observaciones: "Changed editorial note",
    });
  });

  it("updates Brand document metadata without re-embedding", async () => {
    const source = sourceDocument({ brand: "Innovasoft" });
    const existing = await existingFromSection(source.sections[0]);
    const repository = new MockSyncRepository([existing]);
    const embeddings = new MockEmbeddingClient();

    await reconcileNotionDocument({
      source,
      repository,
      embeddingClient: embeddings,
      now: SYNC_TIME,
    });

    expect(embeddings.calls).toHaveLength(0);
    expect(repository.upserts[0].brand).toBe("Innovasoft");
  });

  it("updates Área document metadata without re-embedding", async () => {
    const source = sourceDocument({ area: "Seguridad" });
    const existing = await existingFromSection(source.sections[0]);
    const repository = new MockSyncRepository([existing]);
    const embeddings = new MockEmbeddingClient();

    await reconcileNotionDocument({
      source,
      repository,
      embeddingClient: embeddings,
      now: SYNC_TIME,
    });

    expect(embeddings.calls).toHaveLength(0);
    expect(repository.upserts[0].area).toBe("Seguridad");
  });

  it("makes unpublished documents unretrievable without calling OpenAI", async () => {
    const source = sourceDocument({ publishedAc: false });
    const existing = await existingFromSection(source.sections[0]);
    const repository = new MockSyncRepository([existing]);
    const embeddings = new MockEmbeddingClient("transient");

    const result = await reconcileNotionDocument({
      source,
      repository,
      embeddingClient: embeddings,
      now: SYNC_TIME,
    });

    expect(result.status).toBe("draft");
    expect(repository.upserts[0]).toMatchObject({ publishedAc: false, status: "draft" });
    expect(embeddings.calls).toHaveLength(0);
    expect(repository.chunkUpserts).toHaveLength(0);
    expect(repository.chunkDeletes).toHaveLength(0);
    expect(repository.operations).toEqual(["document_start", "document_success"]);
  });

  it("is idempotent when retrying identical sync input", async () => {
    const source = sourceDocument();
    const repository = new MockSyncRepository();
    const embeddings = new MockEmbeddingClient();

    await reconcileNotionDocument({
      source,
      repository,
      embeddingClient: embeddings,
      now: SYNC_TIME,
    });
    await reconcileNotionDocument({
      source,
      repository,
      embeddingClient: embeddings,
      now: SYNC_TIME,
    });

    expect(embeddings.calls).toHaveLength(1);
    expect(repository.chunkUpserts).toHaveLength(2);
    expect(repository.chunkDeletes[1]).toEqual([]);
  });

  it("surfaces embedding rate limits predictably before persistence", async () => {
    const repository = new MockSyncRepository();

    await expect(
      reconcileNotionDocument({
        source: sourceDocument(),
        repository,
        embeddingClient: new MockEmbeddingClient("rate_limit"),
        now: SYNC_TIME,
      }),
    ).rejects.toMatchObject({ kind: "rate_limit" });
    expect(repository.chunkUpserts).toHaveLength(0);
    expect(repository.chunkDeletes).toHaveLength(0);
  });

  it("does not destroy existing valid chunks on transient embedding failure", async () => {
    const existing = await existingFromSection(section({ text: "Contenido anterior." }), {
      id: "old-valid",
    });
    const repository = new MockSyncRepository([existing]);

    await expect(
      reconcileNotionDocument({
        source: sourceDocument({ sections: [section({ text: "Contenido actualizado." })] }),
        repository,
        embeddingClient: new MockEmbeddingClient("transient"),
        now: SYNC_TIME,
      }),
    ).rejects.toMatchObject({ kind: "transient_upstream" });
    expect(repository.chunkUpserts).toHaveLength(0);
    expect(repository.chunkDeletes).toHaveLength(0);
    expect(repository.chunks).toEqual([existing]);
  });

  it("fails safely on malformed embedding responses", async () => {
    const repository = new MockSyncRepository();

    await expect(
      reconcileNotionDocument({
        source: sourceDocument(),
        repository,
        embeddingClient: new MockEmbeddingClient("malformed"),
        now: SYNC_TIME,
      }),
    ).rejects.toMatchObject({ kind: "malformed_response" });
    expect(repository.chunkUpserts).toHaveLength(0);
    expect(repository.chunkDeletes).toHaveLength(0);
  });

  it("rejects wrong-dimensional embeddings before persistence", async () => {
    const repository = new MockSyncRepository();
    const wrongDimensionClient: EmbeddingClient = {
      dimensions: DEFAULT_EMBEDDING_DIMENSIONS,
      async embedMany() {
        return [[1, 2, 3]];
      },
    };

    await expect(
      reconcileNotionDocument({
        source: sourceDocument(),
        repository,
        embeddingClient: wrongDimensionClient,
        now: SYNC_TIME,
      }),
    ).rejects.toMatchObject({ kind: "malformed_response" });
    expect(repository.chunkUpserts).toHaveLength(0);
    expect(repository.chunkDeletes).toHaveLength(0);
    expect(repository.operations).toEqual(["document_start"]);
  });

  it("does not delete stale chunks when desired chunk upsert fails", async () => {
    const oldSection = section({ text: "Contenido anterior de matrícula." });
    const oldChunk = await existingFromSection(oldSection, { id: "old-valid" });
    const repository = new MockSyncRepository([oldChunk], "upsert_chunks");

    await expect(
      reconcileNotionDocument({
        source: sourceDocument({
          sections: [section({ text: "Contenido actualizado de matrícula." })],
        }),
        repository,
        embeddingClient: new MockEmbeddingClient(),
        now: SYNC_TIME,
      }),
    ).rejects.toThrow("chunk upsert failed");
    expect(repository.operations).toEqual(["document_start", "chunks_upsert"]);
    expect(repository.chunkDeletes).toHaveLength(0);
    expect(repository.upserts.some((upsert) => upsert.lastSyncedAt !== undefined)).toBe(false);
    expect(repository.chunks).toEqual([oldChunk]);
  });

  it("deletes stale chunks only after desired state is persisted", async () => {
    const source = sourceDocument();
    const desiredExisting = await existingFromSection(source.sections[0], { id: "keep-chunk" });
    const stale = await existingFromSection(section({ text: "Contenido anterior." }), {
      id: "stale-chunk",
    });
    const repository = new MockSyncRepository([desiredExisting, stale]);

    await reconcileNotionDocument({
      source,
      repository,
      embeddingClient: new MockEmbeddingClient(),
      now: SYNC_TIME,
    });

    expect(repository.operations).toEqual([
      "document_start",
      "chunks_upsert",
      "chunks_delete",
      "document_success",
    ]);
    expect(repository.chunkDeletes[0]).toEqual(["stale-chunk"]);
  });

  it("does not record successful sync metadata after failed stale deletion", async () => {
    const source = sourceDocument();
    const desiredExisting = await existingFromSection(source.sections[0], { id: "keep-chunk" });
    const stale = await existingFromSection(section({ text: "Contenido anterior." }), {
      id: "stale-chunk",
    });
    const repository = new MockSyncRepository([desiredExisting, stale], "delete_chunks");

    await expect(
      reconcileNotionDocument({
        source,
        repository,
        embeddingClient: new MockEmbeddingClient(),
        now: SYNC_TIME,
      }),
    ).rejects.toThrow("chunk delete failed");
    expect(repository.operations).toEqual(["document_start", "chunks_upsert", "chunks_delete"]);
    expect(repository.upserts.some((upsert) => upsert.lastSyncedAt !== undefined)).toBe(false);
  });

  it("builds embedding text only from approved retrievable context", async () => {
    const chunk = (await chunkSections(sourceDocument().sections))[0];
    const input = buildEmbeddingInput(chunk);

    expect(input).toBe(
      [
        "Document: Módulo 10: Matrícula",
        "Heading path: Módulo 10: Matrícula > Matrícula estudiantil",
        "",
        "El estudiante debe completar la matrícula antes del inicio académico.",
      ].join("\n"),
    );
    for (const forbidden of [
      "Class Limitless",
      "Académica",
      "Formato Contenido",
      "Audio",
      "Guión",
      "Video Base",
      "Video Final",
      "EstadoVid",
      "Quiz",
      "Observaciones",
    ]) {
      expect(input).not.toContain(forbidden);
    }
  });
});

describe("OpenAI embedding client", () => {
  it("accepts correct 1536-dimensional embedding responses", async () => {
    const client = new OpenAIEmbeddingClient({
      apiKey: "test-key",
      fetchImpl: async () => Response.json({ data: [{ embedding: makeEmbedding() }] }),
    });

    await expect(client.embedMany(["text"])).resolves.toEqual([makeEmbedding()]);
  });

  it("classifies authentication, rate-limit, and transient HTTP failures", async () => {
    const cases = [
      { status: 401, kind: "authentication" },
      { status: 429, kind: "rate_limit" },
      { status: 503, kind: "transient_upstream" },
    ] as const;

    for (const item of cases) {
      const client = new OpenAIEmbeddingClient({
        apiKey: "test-key",
        fetchImpl: async () => new Response("{}", { status: item.status }),
      });

      await expect(client.embedMany(["text"])).rejects.toMatchObject({
        kind: item.kind,
        status: item.status,
      });
    }
  });

  it("classifies malformed embedding payloads", async () => {
    const client = new OpenAIEmbeddingClient({
      apiKey: "test-key",
      fetchImpl: async () => Response.json({ data: [{ embedding: ["bad"] }] }),
    });

    await expect(client.embedMany(["text"])).rejects.toMatchObject({
      kind: "malformed_response",
    });
  });

  it("keeps embedding model and dimension configuration centralized", async () => {
    let requestBody: unknown;
    const config = createEmbeddingConfig({
      get(name: string) {
        if (name === "OPENAI_EMBEDDING_MODEL") return "text-embedding-3-small";
        if (name === "OPENAI_EMBEDDING_DIMENSIONS") return "1536";
        return undefined;
      },
    });
    const client = new OpenAIEmbeddingClient({
      apiKey: "test-key",
      ...config,
      fetchImpl: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body));
        return Response.json({ data: [{ embedding: makeEmbedding() }] });
      },
    });

    await client.embedMany(["text"]);

    expect(config).toEqual({ model: "text-embedding-3-small", dimensions: 1536 });
    expect(requestBody).toEqual({
      model: "text-embedding-3-small",
      dimensions: 1536,
      input: ["text"],
    });
  });
});
