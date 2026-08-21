import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildChatRequest,
  getAuthView,
  publicSourcesFor,
  safeChatError,
  validateChatResponse,
} from "../apps/web/components/chat.tsx";
import type { Session } from "@supabase/supabase-js";

const root = fileURLToPath(new URL("..", import.meta.url));

function readText(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function session(): Session {
  return {
    access_token: "user-jwt",
    refresh_token: "refresh-token",
    expires_in: 3600,
    token_type: "bearer",
    user: {
      id: "user-1",
      app_metadata: {},
      user_metadata: {},
      aud: "authenticated",
      created_at: "2026-01-01T00:00:00.000Z",
      email: "pilot@example.test",
    },
  };
}

describe("pilot web chat auth state", () => {
  it("shows login for unauthenticated users", () => {
    expect(getAuthView(false, null)).toBe("login");
  });

  it("shows chat for authenticated users", () => {
    expect(getAuthView(false, session())).toBe("chat");
  });

  it("keeps loading separate from unauthenticated state", () => {
    expect(getAuthView(true, null)).toBe("loading");
  });

  it("logout implementation clears session transcript state", () => {
    const source = readText("apps/web/components/chat.tsx");
    expect(source).toContain("await supabase.auth.signOut()");
    expect(source).toContain("setTranscript([])");
    expect(source).toContain("setSession(null)");
  });
});

describe("pilot web chat request and response contract", () => {
  it("uses the authenticated Bearer token for chat requests", () => {
    const request = buildChatRequest("token-123", "¿Qué debo hacer para matricular?");

    expect(request.method).toBe("POST");
    expect(request.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer token-123",
    });
    expect(request.body).toBe(JSON.stringify({ message: "¿Qué debo hacer para matricular?" }));
  });

  it("validates and sanitizes supported answers", () => {
    const response = validateChatResponse({
      answer: "Debes revisar prerrequisitos. [S1]",
      insufficient_evidence: false,
      citations: [
        {
          label: "S1",
          title: "Módulo 10: Matrícula",
          section: "Matrícula estudiantil",
          sourceUrl: "https://notion.local/matricula",
          chunkId: "must-not-render",
          documentId: "must-not-render",
          fusedScore: 1,
        },
      ],
      sources: [],
      diagnostics: { rank: 1 },
    });

    expect(response.insufficient_evidence).toBe(false);
    expect(publicSourcesFor(response)).toEqual([
      {
        label: "S1",
        title: "Módulo 10: Matrícula",
        section: "Matrícula estudiantil",
        sourceUrl: "https://notion.local/matricula",
      },
    ]);
    expect(JSON.stringify(publicSourcesFor(response))).not.toMatch(
      /chunkId|documentId|fusedScore|diagnostics/,
    );
  });

  it("renders insufficient evidence without citation placeholders", () => {
    const response = validateChatResponse({
      answer:
        "No encuentro información suficiente en la base de conocimiento aprobada para responder con seguridad.",
      insufficient_evidence: true,
      citations: [
        {
          label: "S1",
          title: "Módulo 10: Matrícula",
          sourceUrl: "https://notion.local/matricula",
        },
      ],
      sources: [
        {
          title: "Módulo 10: Matrícula",
        },
      ],
    });

    expect(response.insufficient_evidence).toBe(true);
    expect(publicSourcesFor(response)).toEqual([]);
  });

  it("deduplicates citations and falls back to sources when citations are empty", () => {
    const response = validateChatResponse({
      answer: "Respuesta citada.",
      insufficient_evidence: false,
      citations: [],
      sources: [
        { title: "Módulo 11: Calificación", section: "Calificar estudiantes" },
        { title: "Módulo 11: Calificación", section: "Calificar estudiantes" },
      ],
    });

    expect(publicSourcesFor(response)).toEqual([
      { title: "Módulo 11: Calificación", section: "Calificar estudiantes" },
    ]);
  });

  it("handles malformed responses safely", () => {
    expect(() =>
      validateChatResponse({
        answer: "Respuesta sin bandera",
        citations: [],
        sources: [],
      }),
    ).toThrow(/formato esperado/);
  });

  it("maps HTTP failures to generic user-facing messages", () => {
    expect(safeChatError(401)).toMatch(/sesión expiró/);
    expect(safeChatError(403)).toMatch(/No tienes acceso/);
    expect(safeChatError(500)).toMatch(/No fue posible/);
    expect(safeChatError(null)).toMatch(/conectar/);
  });
});

describe("pilot web chat frontend security", () => {
  it("does not reference service-role secrets in browser code", () => {
    const source = readText("apps/web/components/chat.tsx");

    expect(source).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(source).not.toContain("SERVICE_ROLE");
    expect(source).toContain("NEXT_PUBLIC_SUPABASE_URL");
    expect(source).toContain("NEXT_PUBLIC_SUPABASE_ANON_KEY");
    expect(source).toContain("NEXT_PUBLIC_CHAT_FUNCTION_URL");
  });

  it("does not render internal retrieval diagnostics from response data", () => {
    const response = validateChatResponse({
      answer: "Respuesta citada. [S1]",
      insufficient_evidence: false,
      citations: [
        {
          label: "S1",
          title: "Módulo 3. Seguridad",
          section: "Políticas de Contraseña",
          sourceUrl: "https://notion.local/seguridad",
          score: 0.9,
          embedding: [1, 2, 3],
          accessScope: "default",
        },
      ],
      sources: [],
    });

    expect(JSON.stringify(response)).not.toMatch(/score|embedding|accessScope/);
  });
});
