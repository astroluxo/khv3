import { chunkSections, type TextChunk } from "./chunking.ts";
import { validateEmbeddingDimensions, type EmbeddingClient } from "./openai.ts";
import type { NotionSourceDocument } from "./notion-normalizer.ts";

export type DocumentStatus = "draft" | "published" | "archived" | "error";

export type ExistingDocument = {
  id: string;
  sourceId: string;
  status: DocumentStatus;
};

export type ExistingChunk = {
  id: string;
  sourceChunkKey: string;
  contentHash: string;
  ordinal: number;
  embedding: number[] | null;
};

export type DocumentUpsert = {
  source: "notion";
  sourceId: string;
  title: string;
  brand?: string;
  area?: string;
  publishedAc: boolean;
  status: DocumentStatus;
  sourceUrl?: string;
  sourceUpdatedAt?: string;
  traceabilityMetadata: Record<string, unknown>;
  productionMetadata: Record<string, unknown>;
  editorialMetadata: Record<string, unknown>;
  lastSyncedAt?: string;
  syncError?: string | null;
};

export type ChunkPersist = {
  existingId?: string;
  sourceChunkKey: string;
  sectionPath: string;
  content: string;
  contentHash: string;
  tokenEstimate: number;
  ordinal: number;
  embedding: number[];
  metadata: TextChunk["metadata"];
};

export type ChunkReconciliationPlan = {
  unchanged: Array<{ existing: ExistingChunk; chunk: TextChunk }>;
  needsEmbedding: TextChunk[];
  removed: ExistingChunk[];
};

export type ChunkApplyResult = {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
};

export type SyncResult = {
  documentId?: string;
  status: "synced" | "draft" | "archived";
  chunksAdded: number;
  chunksUpdated: number;
  chunksDeleted: number;
  chunksUnchanged: number;
};

export type SyncRepository = {
  getDocumentBySourceId(sourceId: string): Promise<ExistingDocument | null>;
  upsertDocument(input: DocumentUpsert): Promise<ExistingDocument>;
  listChunks(documentId: string): Promise<ExistingChunk[]>;
  upsertChunks(input: { documentId: string; chunks: ChunkPersist[] }): Promise<void>;
  deleteChunks(input: { documentId: string; chunkIds: string[] }): Promise<void>;
};

export function buildEmbeddingInput(chunk: TextChunk): string {
  return [
    `Document: ${chunk.documentTitle}`,
    `Heading path: ${chunk.headingPath}`,
    "",
    chunk.content,
  ].join("\n");
}

export function createChunkReconciliationPlan(
  existingChunks: ExistingChunk[],
  desiredChunks: TextChunk[],
): ChunkReconciliationPlan {
  const existingByHash = new Map<string, ExistingChunk>();
  for (const chunk of existingChunks) {
    if (!existingByHash.has(chunk.contentHash)) existingByHash.set(chunk.contentHash, chunk);
  }

  const desiredHashes = new Set(desiredChunks.map((chunk) => chunk.contentHash));
  const unchanged: ChunkReconciliationPlan["unchanged"] = [];
  const needsEmbedding: TextChunk[] = [];

  for (const chunk of desiredChunks) {
    const existing = existingByHash.get(chunk.contentHash);
    if (existing?.embedding) {
      unchanged.push({ existing, chunk });
    } else {
      needsEmbedding.push(chunk);
    }
  }

  return {
    unchanged,
    needsEmbedding,
    removed: existingChunks.filter((chunk) => !desiredHashes.has(chunk.contentHash)),
  };
}

export async function reconcileNotionDocument(input: {
  source: NotionSourceDocument;
  repository: SyncRepository;
  embeddingClient: EmbeddingClient;
  now?: Date;
}): Promise<SyncResult> {
  const now = (input.now ?? new Date()).toISOString();
  const status = documentStatus(input.source);
  const document = await input.repository.upsertDocument(buildDocumentUpsert(input.source, status));

  if (input.source.archived) {
    await input.repository.upsertDocument(buildDocumentUpsert(input.source, status, now, null));
    return {
      documentId: document.id,
      status: "archived",
      chunksAdded: 0,
      chunksUpdated: 0,
      chunksDeleted: 0,
      chunksUnchanged: 0,
    };
  }

  const existingChunks = await input.repository.listChunks(document.id);
  if (!input.source.publishedAc) {
    await input.repository.upsertDocument(buildDocumentUpsert(input.source, status, now, null));
    return {
      documentId: document.id,
      status: "draft",
      chunksAdded: 0,
      chunksUpdated: 0,
      chunksDeleted: 0,
      chunksUnchanged: existingChunks.length,
    };
  }

  const desiredChunks = await chunkSections(input.source.sections);
  const plan = createChunkReconciliationPlan(existingChunks, desiredChunks);
  const embeddingInputs = plan.needsEmbedding.map(buildEmbeddingInput);
  const embeddings =
    plan.needsEmbedding.length > 0 ? await input.embeddingClient.embedMany(embeddingInputs) : [];
  const embeddedByHash = new Map<string, number[]>();

  plan.needsEmbedding.forEach((chunk, index) => {
    const embedding = embeddings[index];
    if (!embedding) throw new Error(`Missing embedding for chunk ${chunk.contentHash}`);
    validateEmbeddingDimensions(embedding, input.embeddingClient.dimensions);
    embeddedByHash.set(chunk.contentHash, embedding);
  });

  const existingByHash = new Map(existingChunks.map((chunk) => [chunk.contentHash, chunk]));
  const finalChunks: ChunkPersist[] = desiredChunks.map((chunk) => {
    const existing = existingByHash.get(chunk.contentHash);
    const embedding = existing?.embedding ?? embeddedByHash.get(chunk.contentHash);
    if (!embedding) throw new Error(`Missing final embedding for chunk ${chunk.contentHash}`);
    validateEmbeddingDimensions(embedding, input.embeddingClient.dimensions);
    return {
      existingId: existing?.id,
      sourceChunkKey: chunk.sourceChunkKey,
      sectionPath: chunk.sectionPath,
      content: chunk.content,
      contentHash: chunk.contentHash,
      tokenEstimate: chunk.tokenEstimate,
      ordinal: chunk.ordinal,
      embedding,
      metadata: chunk.metadata,
    };
  });

  await input.repository.upsertChunks({
    documentId: document.id,
    chunks: finalChunks,
  });
  await input.repository.deleteChunks({
    documentId: document.id,
    chunkIds: plan.removed.map((chunk) => chunk.id),
  });
  await input.repository.upsertDocument(buildDocumentUpsert(input.source, status, now, null));

  const counts = summarizePlan(plan);
  return {
    documentId: document.id,
    status: "synced",
    chunksAdded: counts.added,
    chunksUpdated: counts.updated,
    chunksDeleted: counts.removed,
    chunksUnchanged: counts.unchanged,
  };
}

function summarizePlan(plan: ChunkReconciliationPlan): ChunkApplyResult {
  return {
    added: plan.needsEmbedding.length,
    updated: 0,
    removed: plan.removed.length,
    unchanged: plan.unchanged.length,
  };
}

function buildDocumentUpsert(
  source: NotionSourceDocument,
  status: DocumentStatus,
  lastSyncedAt?: string,
  syncError?: string | null,
): DocumentUpsert {
  return {
    source: "notion",
    sourceId: source.sourceId,
    title: source.title,
    ...(source.brand ? { brand: source.brand } : {}),
    ...(source.area ? { area: source.area } : {}),
    publishedAc: source.publishedAc,
    status,
    ...(source.url ? { sourceUrl: source.url } : {}),
    ...(source.sourceUpdatedAt ? { sourceUpdatedAt: source.sourceUpdatedAt } : {}),
    traceabilityMetadata: source.traceabilityMetadata,
    productionMetadata: source.productionMetadata,
    editorialMetadata: source.editorialMetadata,
    ...(lastSyncedAt !== undefined ? { lastSyncedAt } : {}),
    ...(syncError !== undefined ? { syncError } : {}),
  };
}

function documentStatus(source: NotionSourceDocument): DocumentStatus {
  if (source.archived) return "archived";
  return source.publishedAc ? "published" : "draft";
}
