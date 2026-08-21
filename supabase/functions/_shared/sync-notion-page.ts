import { fetchPageAsSections, type NotionSourceDocument } from "./notion-normalizer.ts";
import { createDefaultEmbeddingClient, type EmbeddingClient } from "./openai.ts";
import {
  reconcileNotionDocument,
  type ChunkPersist,
  type ExistingChunk,
  type ExistingDocument,
  type SyncRepository,
  type SyncResult,
} from "./sync-reconciliation.ts";

type EnvReader = { get(name: string): string | undefined };

type QueryResult = { data: unknown; error: unknown };

type PostgrestTable = {
  select(columns: string): PostgrestTable;
  eq(column: string, value: unknown): PostgrestTable;
  maybeSingle(): Promise<QueryResult>;
  single(): Promise<QueryResult>;
  upsert(values: unknown, options?: unknown): PostgrestTable;
  update(values: Record<string, unknown>): PostgrestTable;
  delete(): PostgrestTable;
  in(column: string, values: unknown[]): Promise<QueryResult>;
};

export type SupabaseSyncClient = {
  from(table: string): PostgrestTable;
};

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

export type SyncNotionPageDependencies = {
  env?: EnvReader;
  createSupabaseClient: () => SupabaseSyncClient;
  fetchPageAsSections?: (pageId: string) => Promise<NotionSourceDocument>;
  createEmbeddingClient?: () => EmbeddingClient;
  reconcile?: typeof reconcileNotionDocument;
};

type SyncAuthResult =
  | { ok: true }
  | {
      ok: false;
      status: 401 | 403 | 500;
      code: "unauthorized" | "forbidden" | "server_misconfigured";
      message: string;
    };

class SupabaseSyncRepository implements SyncRepository {
  constructor(private readonly supabase: SupabaseSyncClient) {}

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
    if (input.chunks.length === 0) return;
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

  async deleteChunks(input: { documentId: string; chunkIds: string[] }): Promise<void> {
    if (input.chunkIds.length === 0) return;
    const { error } = await this.supabase.from("chunks").delete().in("id", input.chunkIds);
    if (error) throw error;
  }
}

export function authorizeSyncRequest(
  req: Pick<Request, "headers">,
  env: EnvReader = runtimeEnv(),
): SyncAuthResult {
  const suppliedApiKey = (req.headers.get("apikey") ?? "").trim();
  const auth = req.headers.get("Authorization") ?? "";

  if (!suppliedApiKey) {
    const token = bearerToken(auth);
    if (token && looksLikeJwt(token)) {
      return {
        ok: false,
        status: 403,
        code: "forbidden",
        message: "Trusted backend credentials required",
      };
    }

    return {
      ok: false,
      status: 401,
      code: "unauthorized",
      message: "Authentication required",
    };
  }

  if (suppliedApiKey.startsWith("sb_publishable_")) {
    return {
      ok: false,
      status: 403,
      code: "forbidden",
      message: "Trusted backend credentials required",
    };
  }

  if (!suppliedApiKey.startsWith("sb_secret_")) {
    return {
      ok: false,
      status: 401,
      code: "unauthorized",
      message: "Invalid authentication",
    };
  }

  const configuredKeys = readConfiguredSecretKeys(env);
  if (configuredKeys.length === 0) {
    return {
      ok: false,
      status: 500,
      code: "server_misconfigured",
      message: "Sync authorization unavailable",
    };
  }

  if (matchesAnySecretKey(suppliedApiKey, configuredKeys)) return { ok: true };

  return {
    ok: false,
    status: 403,
    code: "forbidden",
    message: "Trusted backend credentials required",
  };
}

export async function handleSyncNotionPageRequest(
  req: Request,
  dependencies: SyncNotionPageDependencies,
): Promise<Response> {
  const auth = authorizeSyncRequest(req, dependencies.env);
  if (!auth.ok) {
    return Response.json(
      { error: { code: auth.code, message: auth.message } },
      { status: auth.status },
    );
  }

  let pageId: string | undefined;
  let eventId: string | undefined;

  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json(
        { error: { code: "invalid_request", message: "Invalid JSON" } },
        { status: 400 },
      );
    }

    if (!isRecord(body)) {
      return Response.json(
        { error: { code: "invalid_request", message: "Invalid JSON" } },
        {
          status: 400,
        },
      );
    }
    pageId = typeof body.pageId === "string" ? body.pageId.trim() : undefined;
    eventId = typeof body.eventId === "string" ? body.eventId.trim() : undefined;
    if (!pageId) {
      return Response.json(
        { error: { code: "invalid_request", message: "pageId required" } },
        { status: 400 },
      );
    }

    const result = await runTrustedNotionPageSync({ pageId, eventId }, dependencies);
    return Response.json(syncResponse(result));
  } catch (error) {
    console.error("sync_error", error instanceof Error ? error.message : String(error));
    if (pageId) await markSyncFailed({ pageId, eventId, error }, dependencies);
    return Response.json(
      { error: { code: "sync_failed", message: "Unable to sync page" } },
      { status: 500 },
    );
  }
}

export async function runTrustedNotionPageSync(
  input: { pageId: string; eventId?: string },
  dependencies: SyncNotionPageDependencies,
): Promise<SyncResult> {
  const supabase = dependencies.createSupabaseClient();
  const repository = new SupabaseSyncRepository(supabase);
  const source = await (dependencies.fetchPageAsSections ?? fetchPageAsSections)(input.pageId);
  const result = await (dependencies.reconcile ?? reconcileNotionDocument)({
    source,
    repository,
    embeddingClient: (dependencies.createEmbeddingClient ?? createDefaultEmbeddingClient)(),
  });

  if (input.eventId) {
    await supabase
      .from("sync_events")
      .update({ status: "processed", processed_at: new Date().toISOString(), error: null })
      .eq("provider_event_id", input.eventId);
  }

  return result;
}

export async function markSyncFailed(
  input: { pageId: string; eventId?: string; error: unknown },
  dependencies: Pick<SyncNotionPageDependencies, "createSupabaseClient">,
): Promise<void> {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  const supabase = dependencies.createSupabaseClient();
  await supabase
    .from("documents")
    .update({ sync_error: message, last_synced_at: new Date().toISOString() })
    .eq("source", "notion")
    .eq("source_id", input.pageId);
  if (input.eventId) {
    await supabase
      .from("sync_events")
      .update({ status: "failed", error: message })
      .eq("provider_event_id", input.eventId);
  }
}

function syncResponse(result: SyncResult): Record<string, unknown> {
  return {
    documentId: result.documentId,
    status: result.status,
    chunksAdded: result.chunksAdded,
    chunksUpdated: result.chunksUpdated,
    chunksDeleted: result.chunksDeleted,
    chunksUnchanged: result.chunksUnchanged,
  };
}

function bearerToken(value: string): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  const token = match?.[1]?.trim();
  return token ? token : null;
}

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  let diff = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return diff === 0;
}

function matchesAnySecretKey(suppliedApiKey: string, configuredKeys: string[]): boolean {
  let matched = false;
  for (const configuredKey of configuredKeys) {
    matched = constantTimeEqual(suppliedApiKey, configuredKey) || matched;
  }
  return matched;
}

function readConfiguredSecretKeys(env: EnvReader): string[] {
  const raw = env.get("SUPABASE_SECRET_KEYS");
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!isRecord(parsed)) return [];
  return Object.values(parsed).filter(
    (value): value is string => typeof value === "string" && value.trim().startsWith("sb_secret_"),
  );
}

function looksLikeJwt(value: string): boolean {
  const parts = value.split(".");
  return (
    parts.length === 3 && parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part) && part.length > 0)
  );
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

function runtimeEnv(): EnvReader {
  const maybeDeno = globalThis as typeof globalThis & { Deno?: { env: EnvReader } };
  return maybeDeno.Deno?.env ?? { get: () => undefined };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
