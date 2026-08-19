import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));

function readText(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

describe("repository foundation", () => {
  it("documents all required environment variables as placeholders", () => {
    const env = readText(".env.example");
    const requiredNames = [
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      "NEXT_PUBLIC_CHAT_FUNCTION_URL",
      "SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
      "OPENAI_API_KEY",
      "OPENAI_CHAT_MODEL",
      "OPENAI_EMBEDDING_MODEL",
      "NOTION_API_TOKEN",
      "NOTION_WEBHOOK_VERIFICATION_TOKEN",
      "NOTION_ROOT_PAGE_ID",
      "NOTION_CONTENTS_DATABASE_ID",
      "NOTION_CONTENTS_DATA_SOURCE_ID",
      "NOTION_API_VERSION",
      "RAG_VECTOR_TOP_K",
      "RAG_TEXT_TOP_K",
      "RAG_FINAL_TOP_K",
      "RAG_MIN_SCORE",
      "RAG_MAX_CONTEXT_CHARS",
    ];

    for (const name of requiredNames) {
      expect(env).toMatch(new RegExp(`^${name}=`, "m"));
    }

    expect(env).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
    expect(env).not.toMatch(/ghp_[A-Za-z0-9]{20,}/);
  });

  it("keeps evaluation fixtures in the documented shape", () => {
    const cases = JSON.parse(readText("fixtures/eval_cases.json")) as Array<{
      id?: unknown;
      question?: unknown;
      expected_source_keys?: unknown;
      must_answer?: unknown;
      notes?: unknown;
    }>;

    expect(Array.isArray(cases)).toBe(true);
    expect(cases.length).toBeGreaterThan(0);

    for (const item of cases) {
      expect(typeof item.id).toBe("string");
      expect(typeof item.question).toBe("string");
      expect(Array.isArray(item.expected_source_keys)).toBe(true);
      expect(typeof item.must_answer).toBe("boolean");
    }
  });

  it("declares the web app as the pnpm workspace package", () => {
    expect(readText("pnpm-workspace.yaml")).toContain("- apps/*");
  });
});
