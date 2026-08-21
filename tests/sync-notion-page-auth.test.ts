import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { EmbeddingClient } from "../supabase/functions/_shared/openai.ts";
import type { NotionSourceDocument } from "../supabase/functions/_shared/notion-normalizer.ts";
import {
  authorizeSyncRequest,
  handleSyncNotionPageRequest,
  runTrustedNotionPageSync,
  type SupabaseSyncClient,
  type SyncNotionPageDependencies,
} from "../supabase/functions/_shared/sync-notion-page.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const serviceRoleToken = jwt({ role: "service_role" });
const anonToken = jwt({ role: "anon" });
const userToken = jwt({ role: "authenticated", sub: "user-1" });

function readText(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function request(auth?: string, body = '{"pageId":"page-1"}'): Request {
  return new Request("https://functions.local/sync-notion-page", {
    method: "POST",
    ...(auth ? { headers: { Authorization: auth } } : {}),
    body,
  });
}

function env(token = serviceRoleToken) {
  return {
    get(name: string) {
      return name === "SUPABASE_SERVICE_ROLE_KEY" ? token : undefined;
    },
  };
}

function dependencies() {
  const calls = {
    supabase: 0,
    notion: 0,
    openai: 0,
    reconcile: 0,
  };

  const fakeEmbeddingClient: EmbeddingClient = {
    dimensions: 1536,
    async embedMany(inputs: string[]) {
      calls.openai += 1;
      return inputs.map(() => Array.from({ length: 1536 }, () => 0.1));
    },
  };

  const reconcile: NonNullable<SyncNotionPageDependencies["reconcile"]> = async () => {
    calls.reconcile += 1;
    return {
      documentId: "document-1",
      status: "synced",
      chunksAdded: 1,
      chunksUpdated: 0,
      chunksDeleted: 0,
      chunksUnchanged: 0,
    };
  };

  const deps: SyncNotionPageDependencies = {
    env: env(),
    createSupabaseClient() {
      calls.supabase += 1;
      return fakeSupabase();
    },
    async fetchPageAsSections() {
      calls.notion += 1;
      return sourceDocument();
    },
    createEmbeddingClient() {
      calls.openai += 1;
      return fakeEmbeddingClient;
    },
    reconcile,
  };

  return { calls, deps };
}

describe("sync-notion-page trusted caller authorization", () => {
  it("rejects missing Authorization before any sync side effects", async () => {
    const { calls, deps } = dependencies();
    const response = await handleSyncNotionPageRequest(request(undefined, "{not-json"), deps);

    expect(response.status).toBe(401);
    expect(calls).toEqual({ supabase: 0, notion: 0, openai: 0, reconcile: 0 });
  });

  it("rejects malformed bearer tokens with 401", async () => {
    const { calls, deps } = dependencies();
    const response = await handleSyncNotionPageRequest(request("Bearer not-a-jwt"), deps);

    expect(response.status).toBe(401);
    expect(calls).toEqual({ supabase: 0, notion: 0, openai: 0, reconcile: 0 });
  });

  it("rejects tokens without the Bearer scheme with 401", async () => {
    const { calls, deps } = dependencies();
    const response = await handleSyncNotionPageRequest(request(serviceRoleToken), deps);

    expect(response.status).toBe(401);
    expect(calls).toEqual({ supabase: 0, notion: 0, openai: 0, reconcile: 0 });
  });

  it("does not parse the request body before authorization succeeds", async () => {
    const { calls, deps } = dependencies();
    const response = await handleSyncNotionPageRequest(request(`Bearer ${userToken}`, "{"), deps);

    expect(response.status).toBe(403);
    expect(calls).toEqual({ supabase: 0, notion: 0, openai: 0, reconcile: 0 });
  });

  it("rejects anon JWTs as valid but unauthorized callers", () => {
    const result = authorizeSyncRequest(request(`Bearer ${anonToken}`), env());

    expect(result).toMatchObject({ ok: false, status: 403, code: "forbidden" });
  });

  it("rejects normal authenticated user JWTs with 403", async () => {
    const { calls, deps } = dependencies();
    const response = await handleSyncNotionPageRequest(request(`Bearer ${userToken}`), deps);

    expect(response.status).toBe(403);
    expect(calls).toEqual({ supabase: 0, notion: 0, openai: 0, reconcile: 0 });
  });

  it("accepts trusted service-role invocation", async () => {
    const { calls, deps } = dependencies();
    const response = await handleSyncNotionPageRequest(request(`Bearer ${serviceRoleToken}`), deps);
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ documentId: "document-1", status: "synced", chunksAdded: 1 });
    expect(calls).toEqual({ supabase: 1, notion: 1, openai: 1, reconcile: 1 });
  });

  it("does not rescue malformed JSON after trusted authorization", async () => {
    const { calls, deps } = dependencies();
    const response = await handleSyncNotionPageRequest(
      request(`Bearer ${serviceRoleToken}`, "{not-json"),
      deps,
    );

    expect(response.status).toBe(400);
    expect(calls).toEqual({ supabase: 0, notion: 0, openai: 0, reconcile: 0 });
  });
});

describe("sync-notion-page internal webhook path", () => {
  it("allows trusted internal sync logic without an HTTP service-role round trip", async () => {
    const { calls, deps } = dependencies();
    const result = await runTrustedNotionPageSync({ pageId: "page-1", eventId: "event-1" }, deps);

    expect(result.status).toBe("synced");
    expect(calls).toEqual({ supabase: 1, notion: 1, openai: 1, reconcile: 1 });
  });

  it("webhook verifies the signature before invoking the trusted internal sync path", () => {
    const source = readText("supabase/functions/notion-webhook/index.ts");

    expect(source).toContain("verifyWebhookSignature");
    expect(source).toContain("runTrustedNotionPageSync");
    expect(source.indexOf("verifyWebhookSignature")).toBeLessThan(
      source.indexOf("runTrustedNotionPageSync("),
    );
    expect(source).not.toContain("/functions/v1/sync-notion-page");
    expect(source).not.toContain(
      'Authorization: `Bearer ${requiredEnv("SUPABASE_SERVICE_ROLE_KEY")}`',
    );
  });
});

function sourceDocument(): NotionSourceDocument {
  return {
    source: "notion",
    sourceId: "page-1",
    title: "Módulo 10: Matrícula",
    archived: false,
    publishedAc: true,
    knowledgeMetadata: {},
    traceabilityMetadata: {},
    productionMetadata: {},
    editorialMetadata: {},
    sections: [],
  };
}

function fakeSupabase(): SupabaseSyncClient {
  return {
    from() {
      return new FakePostgrestTable();
    },
  };
}

class FakePostgrestTable {
  select(): this {
    return this;
  }

  eq(): this {
    return this;
  }

  maybeSingle(): Promise<{ data: unknown; error: unknown }> {
    return Promise.resolve({ data: null, error: null });
  }

  single(): Promise<{ data: unknown; error: unknown }> {
    return Promise.resolve({
      data: { id: "document-1", source_id: "page-1", status: "published" },
      error: null,
    });
  }

  upsert(): this {
    return this;
  }

  update(): this {
    return this;
  }

  delete(): this {
    return this;
  }

  in(): Promise<{ data: unknown; error: unknown }> {
    return Promise.resolve({ data: null, error: null });
  }
}

function jwt(payload: Record<string, unknown>): string {
  return [base64Url({ alg: "HS256", typ: "JWT" }), base64Url(payload), "signature"].join(".");
}

function base64Url(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value))
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
