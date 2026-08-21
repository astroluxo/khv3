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
const secretKey = "sb_secret_valid_sync_key";
const wrongSecretKey = "sb_secret_wrong_sync_key";
const publishableKey = "sb_publishable_public_key";
const anonToken = jwt({ role: "anon" });
const userToken = jwt({ role: "authenticated", sub: "user-1" });
const serviceRoleToken = jwt({ role: "service_role" });

function readText(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function request(input: { auth?: string; apikey?: string; body?: string } = {}): Request {
  const headers = new Headers();
  if (input.auth !== undefined) headers.set("Authorization", input.auth);
  if (input.apikey !== undefined) headers.set("apikey", input.apikey);

  return new Request("https://functions.local/sync-notion-page", {
    method: "POST",
    headers,
    body: input.body ?? '{"pageId":"page-1"}',
  });
}

function env(rawSecretKeys = JSON.stringify({ default: secretKey })) {
  return {
    get(name: string) {
      return name === "SUPABASE_SECRET_KEYS" ? rawSecretKeys : undefined;
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
  it("rejects missing apikey before any sync side effects", async () => {
    const { calls, deps } = dependencies();
    const response = await handleSyncNotionPageRequest(request({ body: "{not-json" }), deps);

    expect(response.status).toBe(401);
    expect(calls).toEqual({ supabase: 0, notion: 0, openai: 0, reconcile: 0 });
  });

  it("rejects empty apikey with 401", async () => {
    const { calls, deps } = dependencies();
    const response = await handleSyncNotionPageRequest(request({ apikey: "   " }), deps);

    expect(response.status).toBe(401);
    expect(calls).toEqual({ supabase: 0, notion: 0, openai: 0, reconcile: 0 });
  });

  it("rejects malformed apikey values with 401", async () => {
    const { calls, deps } = dependencies();
    const response = await handleSyncNotionPageRequest(
      request({ apikey: "not-a-secret-key" }),
      deps,
    );

    expect(response.status).toBe(401);
    expect(calls).toEqual({ supabase: 0, notion: 0, openai: 0, reconcile: 0 });
  });

  it("does not parse the request body before authorization succeeds", async () => {
    const { calls, deps } = dependencies();
    const response = await handleSyncNotionPageRequest(
      request({ auth: `Bearer ${userToken}`, body: "{" }),
      deps,
    );

    expect(response.status).toBe(403);
    expect(calls).toEqual({ supabase: 0, notion: 0, openai: 0, reconcile: 0 });
  });

  it("rejects anon JWTs without trusting claims", () => {
    const result = authorizeSyncRequest(request({ auth: `Bearer ${anonToken}` }), env());

    expect(result).toMatchObject({ ok: false, status: 403, code: "forbidden" });
  });

  it("rejects normal authenticated user JWTs with 403", async () => {
    const { calls, deps } = dependencies();
    const response = await handleSyncNotionPageRequest(
      request({ auth: `Bearer ${userToken}` }),
      deps,
    );

    expect(response.status).toBe(403);
    expect(calls).toEqual({ supabase: 0, notion: 0, openai: 0, reconcile: 0 });
  });

  it("rejects publishable keys with 403", async () => {
    const { calls, deps } = dependencies();
    const response = await handleSyncNotionPageRequest(request({ apikey: publishableKey }), deps);

    expect(response.status).toBe(403);
    expect(calls).toEqual({ supabase: 0, notion: 0, openai: 0, reconcile: 0 });
  });

  it("rejects wrong secret keys with 403", async () => {
    const { calls, deps } = dependencies();
    const response = await handleSyncNotionPageRequest(request({ apikey: wrongSecretKey }), deps);

    expect(response.status).toBe(403);
    expect(calls).toEqual({ supabase: 0, notion: 0, openai: 0, reconcile: 0 });
  });

  it("fails closed when SUPABASE_SECRET_KEYS is missing", async () => {
    const { calls, deps } = dependencies();
    deps.env = { get: () => undefined };
    const response = await handleSyncNotionPageRequest(request({ apikey: secretKey }), deps);
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(500);
    expect(payload).toEqual({
      error: {
        code: "server_misconfigured",
        message: "Sync authorization unavailable",
      },
    });
    expect(JSON.stringify(payload)).not.toContain(secretKey);
    expect(calls).toEqual({ supabase: 0, notion: 0, openai: 0, reconcile: 0 });
  });

  it("fails closed when SUPABASE_SECRET_KEYS is malformed", async () => {
    const { calls, deps } = dependencies();
    deps.env = env("{not-json");
    const response = await handleSyncNotionPageRequest(request({ apikey: secretKey }), deps);

    expect(response.status).toBe(500);
    expect(calls).toEqual({ supabase: 0, notion: 0, openai: 0, reconcile: 0 });
  });

  it("fails closed when SUPABASE_SECRET_KEYS has no usable secret key", async () => {
    const { calls, deps } = dependencies();
    deps.env = env(JSON.stringify({ default: publishableKey }));
    const response = await handleSyncNotionPageRequest(request({ apikey: secretKey }), deps);

    expect(response.status).toBe(500);
    expect(calls).toEqual({ supabase: 0, notion: 0, openai: 0, reconcile: 0 });
  });

  it("accepts trusted secret-key invocation", async () => {
    const { calls, deps } = dependencies();
    const response = await handleSyncNotionPageRequest(request({ apikey: secretKey }), deps);
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ documentId: "document-1", status: "synced", chunksAdded: 1 });
    expect(calls).toEqual({ supabase: 1, notion: 1, openai: 1, reconcile: 1 });
  });

  it("does not rescue malformed JSON after trusted authorization", async () => {
    const { calls, deps } = dependencies();
    const response = await handleSyncNotionPageRequest(
      request({ apikey: secretKey, body: "{not-json" }),
      deps,
    );

    expect(response.status).toBe(400);
    expect(calls).toEqual({ supabase: 0, notion: 0, openai: 0, reconcile: 0 });
  });

  it("does not expose service-role or secret keys in rejected responses", async () => {
    const { deps } = dependencies();
    const response = await handleSyncNotionPageRequest(request({ apikey: wrongSecretKey }), deps);
    const text = await response.text();

    expect(text).not.toContain(secretKey);
    expect(text).not.toContain(wrongSecretKey);
    expect(text).not.toContain(serviceRoleToken);
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

  it("keeps chat JWT verification enabled and disables it only for direct sync", () => {
    const config = readText("supabase/config.toml");

    expect(config).toMatch(/\[functions\.chat\]\s+verify_jwt = true/);
    expect(config).toMatch(/\[functions\.sync-notion-page\]\s+verify_jwt = false/);
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
