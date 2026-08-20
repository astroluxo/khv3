import { fetchPageAsSections } from "../_shared/notion-normalizer.ts";
import { createDefaultEmbeddingClient } from "../_shared/openai.ts";
import { serviceClient } from "../_shared/supabase.ts";
import {
  reconcileNotionDocument,
  type ChunkPersist,
  type ExistingChunk,
  type ExistingDocument,
  type SyncRepository,
} from "../_shared/sync-reconciliation.ts";

type SupabaseServiceClient = ReturnType<typeof serviceClient>;

type DocumentRow = {
  id: string;
  source_id: string;
  status: ExistingDocument["status"];
};

type ChunkRow = {
  id: string;
  source_chunk_key: string;
  content_hash: string;
  ordinal: number | null;
  embedding: number[] | string | null;
};

class SupabaseSyncRepository implements SyncRepository {
  constructor(private readonly supabase: SupabaseServiceClient) {}

  async getDocumentBySourceId(sourceId: string): Promise<ExistingDocument | null> {
    const { data, error } = await this.supabase
      .from("documents")
      .select("id,source_id,status")
      .eq("source", "notion")
      .eq("source_id", sourceId)
      .maybeSingle();
    if (error) throw error;
    return data ? documentFromRow(data as DocumentRow) : null;
  }

  async upsertDocument(
    input: Parameters<SyncRepository["upsertDocument"]>[0],
  ): Promise<ExistingDocument> {
    const payload: Record<string, unknown> = {
      source: input.source,
      source_id: input.sourceId,
      title: input.title,
      brand: input.brand ?? null,
      area: input.area ?? null,
      published_ac: input.publishedAc,
      status: input.status,
      source_url: input.sourceUrl ?? null,
      source_updated_at: input.sourceUpdatedAt ?? null,
      traceability_metadata: input.traceabilityMetadata,
      production_metadata: input.productionMetadata,
      editorial_metadata: input.editorialMetadata,
    };
    if (input.lastSyncedAt !== undefined) payload.last_synced_at = input.lastSyncedAt;
    if (input.syncError !== undefined) payload.sync_error = input.syncError;

    const { data, error } = await this.supabase
      .from("documents")
      .upsert(payload, { onConflict: "source,source_id" })
      .select("id,source_id,status")
      .single();
    if (error) throw error;
    return documentFromRow(data as DocumentRow);
  }

  async listChunks(documentId: string): Promise<ExistingChunk[]> {
    const { data, error } = await this.supabase
      .from("chunks")
      .select("id,source_chunk_key,content_hash,ordinal,embedding")
      .eq("document_id", documentId);
    if (error) throw error;
    return ((data ?? []) as ChunkRow[]).map((row) => ({
      id: row.id,
      sourceChunkKey: row.source_chunk_key,
      contentHash: row.content_hash,
      ordinal: row.ordinal ?? 0,
      embedding: parseEmbedding(row.embedding),
    }));
  }

  async upsertChunks(input: { documentId: string; chunks: ChunkPersist[] }): Promise<void> {
    if (input.chunks.length > 0) {
      const { error } = await this.supabase.from("chunks").upsert(
        input.chunks.map((chunk) => ({
          document_id: input.documentId,
          source_chunk_key: chunk.sourceChunkKey,
          section_path: chunk.sectionPath,
          content: chunk.content,
          content_hash: chunk.contentHash,
          token_estimate: chunk.tokenEstimate,
          ordinal: chunk.ordinal,
          embedding: chunk.embedding,
          metadata: chunk.metadata,
          updated_at: new Date().toISOString(),
        })),
        { onConflict: "document_id,source_chunk_key" },
      );
      if (error) throw error;
    }
  }

  async deleteChunks(input: { documentId: string; chunkIds: string[] }): Promise<void> {
    if (input.chunkIds.length > 0) {
      const { error } = await this.supabase.from("chunks").delete().in("id", input.chunkIds);
      if (error) throw error;
    }
  }
}

Deno.serve(async (req) => {
  let pageId: string | undefined;
  let eventId: string | undefined;

  try {
    const body = await req.json();
    pageId = typeof body.pageId === "string" ? body.pageId : undefined;
    eventId = typeof body.eventId === "string" ? body.eventId : undefined;
    if (!pageId) return Response.json({ error: "pageId required" }, { status: 400 });

    const supabase = serviceClient();
    const repository = new SupabaseSyncRepository(supabase);
    const source = await fetchPageAsSections(pageId);
    const result = await reconcileNotionDocument({
      source,
      repository,
      embeddingClient: createDefaultEmbeddingClient(),
    });

    if (eventId) {
      await supabase
        .from("sync_events")
        .update({ status: "processed", processed_at: new Date().toISOString(), error: null })
        .eq("provider_event_id", eventId);
    }

    return Response.json({
      documentId: result.documentId,
      status: result.status,
      chunksAdded: result.chunksAdded,
      chunksUpdated: result.chunksUpdated,
      chunksDeleted: result.chunksDeleted,
      chunksUnchanged: result.chunksUnchanged,
    });
  } catch (error) {
    console.error("sync_error", error instanceof Error ? error.message : String(error));
    if (pageId) await markSyncFailed(pageId, error, eventId);
    return Response.json({ error: "sync_failed" }, { status: 500 });
  }
});

async function markSyncFailed(
  pageId: string,
  error: unknown,
  eventId: string | undefined,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const supabase = serviceClient();
  await supabase
    .from("documents")
    .update({ sync_error: message, last_synced_at: new Date().toISOString() })
    .eq("source", "notion")
    .eq("source_id", pageId);
  if (eventId) {
    await supabase
      .from("sync_events")
      .update({ status: "failed", error: message })
      .eq("provider_event_id", eventId);
  }
}

function documentFromRow(row: DocumentRow): ExistingDocument {
  return {
    id: row.id,
    sourceId: row.source_id,
    status: row.status,
  };
}

function parseEmbedding(value: ChunkRow["embedding"]): number[] | null {
  if (Array.isArray(value)) return value.filter((item) => Number.isFinite(item));
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (!trimmed) return [];
  const parsed = trimmed.split(",").map((item) => Number.parseFloat(item.trim()));
  return parsed.every(Number.isFinite) ? parsed : null;
}
