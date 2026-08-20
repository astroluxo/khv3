import { describe, expect, it } from "vitest";
import {
  chunkSections,
  estimateTokens,
  type NormalizedSection,
} from "../supabase/functions/_shared/chunking.ts";
import { normalizeNotionPageBody } from "../supabase/functions/_shared/notion-normalizer.ts";
import type { NotionRawPageDocument } from "../supabase/functions/_shared/notion.ts";

function words(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`).join(" ");
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

function rawDocumentWithBody(): NotionRawPageDocument {
  return {
    source: "notion",
    sourceId: "page-m3",
    title: "Módulo 3: Seguridad",
    archived: false,
    url: "https://notion.local/page-m3",
    sourceUpdatedAt: "2026-08-19T12:00:00.000Z",
    brand: "Innovasoft",
    area: "Seguridad",
    publishedAc: true,
    knowledgeMetadata: {
      pageId: "page-m3",
      sourceUrl: "https://notion.local/page-m3",
      lastEditedTime: "2026-08-19T12:00:00.000Z",
      brand: "Innovasoft",
      area: "Seguridad",
      publishedAc: true,
    },
    traceabilityMetadata: { Versión: [], Rel_Actualizaciones: [] },
    productionMetadata: { Quiz: "Production quiz property" },
    editorialMetadata: { Observaciones: "Editorial note" },
    bodyBlocks: [
      {
        object: "block",
        id: "heading-policy",
        type: "heading_1",
        heading_1: { rich_text: [{ plain_text: "Política de seguridad" }] },
        children: [],
      },
      {
        object: "block",
        id: "paragraph-policy",
        type: "paragraph",
        paragraph: { rich_text: [{ plain_text: "La contraseña debe mantenerse privada." }] },
        children: [],
      },
      {
        object: "block",
        id: "heading-quiz",
        type: "heading_1",
        heading_1: { rich_text: [{ plain_text: "Quiz" }] },
        children: [],
      },
      {
        object: "block",
        id: "paragraph-quiz",
        type: "paragraph",
        paragraph: { rich_text: [{ plain_text: "Quiz content must not be indexed." }] },
        children: [],
      },
      {
        object: "block",
        id: "heading-next",
        type: "heading_1",
        heading_1: { rich_text: [{ plain_text: "Accesos" }] },
        children: [],
      },
      {
        object: "block",
        id: "paragraph-strike",
        type: "paragraph",
        paragraph: {
          rich_text: [
            {
              plain_text: "Retired security instruction",
              annotations: { strikethrough: true },
            },
          ],
        },
        children: [],
      },
      {
        object: "block",
        id: "paragraph-access",
        type: "paragraph",
        paragraph: { rich_text: [{ plain_text: "El acceso requiere usuario individual." }] },
        children: [],
      },
    ],
  };
}

describe("semantic chunking", () => {
  it("keeps multiple sibling sections separate and preserves heading metadata", async () => {
    const chunks = await chunkSections([
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
      section({
        path: "Módulo 6: Homologaciones > Consecutivos",
        text: "Los consecutivos se asignan en orden documental.",
        documentTitle: "Módulo 6: Homologaciones",
        sectionTitle: "Consecutivos",
        headingPath: "Módulo 6: Homologaciones > Consecutivos",
        sourcePageId: "page-m6",
        sourceUrl: "https://notion.local/page-m6",
      }),
    ]);

    expect(chunks).toHaveLength(3);
    expect(chunks.map((chunk) => chunk.headingPath)).toEqual([
      "Módulo 10: Matrícula > Matrícula estudiantil",
      "Módulo 6: Homologaciones > Faltas de asistencia",
      "Módulo 6: Homologaciones > Consecutivos",
    ]);
    expect(chunks[0]).toMatchObject({
      documentTitle: "Módulo 10: Matrícula",
      brand: "Class Limitless",
      area: "Académica",
      sectionTitle: "Matrícula estudiantil",
      sourcePageId: "page-m10",
      sourceUrl: "https://notion.local/page-m10",
      ordinal: 0,
    });
    expect(chunks[0].metadata).not.toHaveProperty("productionMetadata");
    expect(chunks[0].metadata).not.toHaveProperty("editorialMetadata");
  });

  it("splits a long section at semantic boundaries and preserves short sections", async () => {
    const short = section({
      path: "Módulo 11: Calificación > Nota final",
      text: "La nota final se publica cuando el proceso de revisión termina.",
      documentTitle: "Módulo 11: Calificación",
      sectionTitle: "Nota final",
      headingPath: "Módulo 11: Calificación > Nota final",
      sourcePageId: "page-m11",
    });
    const long = section({
      text: [words("a", 120), words("b", 120), words("c", 120), words("d", 120)].join("\n\n"),
    });

    const chunks = await chunkSections([short, long], { minTokens: 90, maxTokens: 160 });

    expect(chunks[0].content).toBe(short.text);
    expect(chunks[0].tokenEstimate).toBeLessThan(90);
    expect(chunks.slice(1).length).toBeGreaterThan(1);
    expect(chunks.slice(1).every((chunk) => chunk.tokenEstimate <= 160)).toBe(true);
    expect(chunks.slice(1).map((chunk) => chunk.content)).toEqual([
      words("a", 120),
      words("b", 120),
      words("c", 120),
      words("d", 120),
    ]);
  });

  it("uses deterministic ordering and deterministic content hashes", async () => {
    const sections = [
      section({ text: "Primer paso de matrícula." }),
      section({ text: "Segundo paso de matrícula." }),
    ];

    const first = await chunkSections(sections);
    const second = await chunkSections(sections);

    expect(first.map((chunk) => chunk.ordinal)).toEqual([0]);
    expect(first.map((chunk) => chunk.content)).toEqual(second.map((chunk) => chunk.content));
    expect(first.map((chunk) => chunk.contentHash)).toEqual(
      second.map((chunk) => chunk.contentHash),
    );
    expect(first[0].content).toBe("Primer paso de matrícula.\n\nSegundo paso de matrícula.");
  });

  it("does not let production, editorial, brand, or area changes alter content hashes", async () => {
    const base = section();
    const changedMetadata = {
      ...base,
      brand: "Another Brand",
      area: "Otra Área",
      productionMetadata: { "Video Final": "changed" },
      editorialMetadata: { Observaciones: "changed" },
    } as NormalizedSection;

    const [baseChunk] = await chunkSections([base]);
    const [metadataChangedChunk] = await chunkSections([changedMetadata]);

    expect(metadataChangedChunk.contentHash).toBe(baseChunk.contentHash);
    expect(metadataChangedChunk.brand).toBe("Another Brand");
    expect(metadataChangedChunk.area).toBe("Otra Área");
  });

  it("changes content hashes when heading path or content changes", async () => {
    const [baseChunk] = await chunkSections([section()]);
    const [sectionChangedChunk] = await chunkSections([
      section({
        path: "Módulo 10: Matrícula > Reintegros",
        sectionTitle: "Reintegros",
        headingPath: "Módulo 10: Matrícula > Reintegros",
      }),
    ]);
    const [contentChangedChunk] = await chunkSections([
      section({ text: "El estudiante debe completar una matrícula extraordinaria." }),
    ]);

    expect(sectionChangedChunk.contentHash).not.toBe(baseChunk.contentHash);
    expect(contentChangedChunk.contentHash).not.toBe(baseChunk.contentHash);
  });

  it("does not include Quiz or strikethrough content after normalization", async () => {
    const sections = normalizeNotionPageBody(rawDocumentWithBody());
    const chunks = await chunkSections(sections);
    const content = chunks.map((chunk) => chunk.content).join("\n");

    expect(content).toContain("La contraseña debe mantenerse privada.");
    expect(content).toContain("El acceso requiere usuario individual.");
    expect(content).not.toContain("Quiz content must not be indexed.");
    expect(content).not.toContain("Retired security instruction");
  });

  it("uses a deterministic MVP token estimate", () => {
    expect(estimateTokens("uno")).toBe(1);
    expect(estimateTokens("")).toBe(0);
  });
});
