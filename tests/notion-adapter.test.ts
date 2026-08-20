import { describe, expect, it } from "vitest";
import { fetchNotionPageDocument } from "../supabase/functions/_shared/notion-normalizer.ts";
import {
  mapNotionPageToDocumentMetadata,
  NotionApiClient,
  NotionSourceError,
  queryContenidosSource,
  type NotionBlock,
  type NotionClient,
  type NotionDataSourceQuery,
  type NotionListResponse,
  type NotionPage,
} from "../supabase/functions/_shared/notion.ts";

const DATA_SOURCE_ID = "test-data-source-id";

function richText(text: string, options: { strikethrough?: boolean } = {}) {
  return {
    plain_text: text,
    annotations: {
      strikethrough: options.strikethrough === true,
    },
  };
}

function pageFixture(options: {
  id: string;
  title: string;
  brand?: string;
  area?: string;
  publishedAc?: boolean;
  versionIds?: string[];
  updateIds?: string[];
  observations?: string;
  production?: Partial<
    Record<
      "Formato Contenido" | "Audio" | "Guión" | "Video Base" | "Video Final" | "EstadoVid" | "Quiz",
      string | boolean
    >
  >;
}): NotionPage {
  return {
    object: "page",
    id: options.id,
    url: `https://notion.local/${options.id}`,
    last_edited_time: "2026-08-19T12:00:00.000Z",
    properties: {
      IDVideo: { type: "title", title: [richText(options.title)] },
      Brand: options.brand
        ? { type: "select", select: { name: options.brand } }
        : { type: "select", select: null },
      Área: options.area
        ? { type: "select", select: { name: options.area } }
        : { type: "select", select: null },
      "Publicado AC": { type: "checkbox", checkbox: options.publishedAc === true },
      Versión: {
        type: "relation",
        relation: (options.versionIds ?? []).map((id) => ({ id })),
      },
      Rel_Actualizaciones: {
        type: "relation",
        relation: (options.updateIds ?? []).map((id) => ({ id })),
      },
      Observaciones: {
        type: "rich_text",
        rich_text: options.observations ? [richText(options.observations)] : [],
      },
      "Formato Contenido": {
        type: "select",
        select: options.production?.["Formato Contenido"]
          ? { name: String(options.production["Formato Contenido"]) }
          : null,
      },
      Audio: { type: "checkbox", checkbox: options.production?.Audio === true },
      Guión: {
        type: "rich_text",
        rich_text: options.production?.Guión ? [richText(String(options.production.Guión))] : [],
      },
      "Video Base": {
        type: "url",
        url: options.production?.["Video Base"] ? String(options.production["Video Base"]) : null,
      },
      "Video Final": {
        type: "url",
        url: options.production?.["Video Final"] ? String(options.production["Video Final"]) : null,
      },
      EstadoVid: {
        type: "status",
        status: options.production?.EstadoVid
          ? { name: String(options.production.EstadoVid) }
          : null,
      },
      Quiz: {
        type: "rich_text",
        rich_text: options.production?.Quiz ? [richText(String(options.production.Quiz))] : [],
      },
    },
  };
}

function paragraph(
  id: string,
  text: string,
  options: { strikethrough?: boolean } = {},
): NotionBlock {
  return {
    object: "block",
    id,
    type: "paragraph",
    paragraph: {
      rich_text: [richText(text, options)],
    },
  };
}

function heading(
  id: string,
  type: "heading_1" | "heading_2" | "heading_3",
  text: string,
): NotionBlock {
  return {
    object: "block",
    id,
    type,
    [type]: {
      rich_text: [richText(text)],
    },
  };
}

class MockNotionClient implements NotionClient {
  readonly queryCalls: NotionDataSourceQuery[] = [];
  readonly blockCalls: Array<{ blockId: string; startCursor?: string }> = [];

  constructor(
    private readonly pages: Record<string, NotionPage>,
    private readonly dataSourcePages: NotionListResponse<NotionPage>[],
    private readonly blockPages: Record<string, NotionListResponse<NotionBlock>[]>,
  ) {}

  async retrievePage(pageId: string): Promise<NotionPage> {
    const page = this.pages[pageId];
    if (!page) throw new NotionSourceError("not_found", "missing test page", { status: 404 });
    return page;
  }

  async listBlockChildren(
    blockId: string,
    options: { startCursor?: string } = {},
  ): Promise<NotionListResponse<NotionBlock>> {
    this.blockCalls.push({ blockId, startCursor: options.startCursor });
    const responses = this.blockPages[blockId] ?? [{ results: [] }];
    const index = options.startCursor ? Number.parseInt(options.startCursor, 10) : 0;
    return responses[index] ?? { results: [] };
  }

  async queryDataSource(query: NotionDataSourceQuery): Promise<NotionListResponse<NotionPage>> {
    this.queryCalls.push(query);
    const index = query.startCursor ? Number.parseInt(query.startCursor, 10) : 0;
    return this.dataSourcePages[index] ?? { results: [] };
  }
}

const modulePages = [
  pageFixture({
    id: "page-m10",
    title: "Módulo 10: Matrícula",
    brand: "Class Limitless",
    area: "Académica",
    publishedAc: true,
    versionIds: ["version-m10"],
    updateIds: ["update-m10"],
    observations: "Editorial note for matrícula",
    production: {
      "Formato Contenido": "Video",
      Audio: true,
      Guión: "Draft script",
      "Video Base": "https://video.local/base",
      "Video Final": "https://video.local/final",
      EstadoVid: "Finalizado",
      Quiz: "Do not retrieve this property",
    },
  }),
  pageFixture({
    id: "page-m6",
    title: "Módulo 6: Homologaciones",
    brand: "Class Limitless",
    area: "Académica",
    publishedAc: false,
  }),
  pageFixture({
    id: "page-m11",
    title: "Módulo 11: Calificación",
    brand: "Class Limitless",
    area: "Evaluación",
    publishedAc: true,
  }),
  pageFixture({
    id: "page-m3",
    title: "Módulo 3: Seguridad",
    brand: "Innovasoft",
    area: "Seguridad",
    publishedAc: true,
  }),
];

describe("Notion source adapter", () => {
  it("maps Contenidos knowledge fields explicitly", () => {
    const mapped = modulePages.map(mapNotionPageToDocumentMetadata);

    expect(mapped.map((page) => page.title)).toEqual([
      "Módulo 10: Matrícula",
      "Módulo 6: Homologaciones",
      "Módulo 11: Calificación",
      "Módulo 3: Seguridad",
    ]);
    expect(mapped[0].brand).toBe("Class Limitless");
    expect(mapped[0].area).toBe("Académica");
    expect(mapped[0].publishedAc).toBe(true);
    expect(mapped[1].publishedAc).toBe(false);
    expect(mapped[3].brand).toBe("Innovasoft");
  });

  it("isolates production, editorial, and traceability metadata from knowledge metadata", () => {
    const mapped = mapNotionPageToDocumentMetadata(modulePages[0]);
    const knowledgeJson = JSON.stringify(mapped.knowledgeMetadata);

    for (const forbidden of [
      "Formato Contenido",
      "Audio",
      "Guión",
      "Video Base",
      "Video Final",
      "EstadoVid",
      "Quiz",
      "Observaciones",
    ]) {
      expect(knowledgeJson).not.toContain(forbidden);
    }

    expect(mapped.productionMetadata).toMatchObject({
      "Formato Contenido": "Video",
      Audio: true,
      Guión: "Draft script",
      "Video Base": "https://video.local/base",
      "Video Final": "https://video.local/final",
      EstadoVid: "Finalizado",
      Quiz: "Do not retrieve this property",
    });
    expect(mapped.editorialMetadata).toEqual({ Observaciones: "Editorial note for matrícula" });
    expect(mapped.traceabilityMetadata).toEqual({
      Versión: ["version-m10"],
      Rel_Actualizaciones: ["update-m10"],
    });
  });

  it("handles missing optional fields safely", () => {
    const mapped = mapNotionPageToDocumentMetadata(
      pageFixture({
        id: "page-optional",
        title: "Módulo opcional",
      }),
    );

    expect(mapped.brand).toBeUndefined();
    expect(mapped.area).toBeUndefined();
    expect(mapped.publishedAc).toBe(false);
    expect(mapped.productionMetadata).toEqual({ Audio: false });
    expect(mapped.editorialMetadata).toEqual({});
    expect(mapped.traceabilityMetadata).toEqual({ Versión: [], Rel_Actualizaciones: [] });
  });

  it("fails predictably when required IDVideo is malformed", () => {
    const malformedPage = pageFixture({ id: "page-malformed", title: "" });

    expect(() => mapNotionPageToDocumentMetadata(malformedPage)).toThrow(NotionSourceError);
    try {
      mapNotionPageToDocumentMetadata(malformedPage);
    } catch (error) {
      expect(error).toBeInstanceOf(NotionSourceError);
      expect((error as NotionSourceError).kind).toBe("malformed_source_data");
    }
  });

  it("fetches a page by id and normalizes paginated body content without Quiz evidence", async () => {
    const client = new MockNotionClient({ "page-m10": modulePages[0] }, [], {
      "page-m10": [
        {
          results: [
            heading("heading-main", "heading_1", "Matrícula estudiantil"),
            paragraph("body-1", "El estudiante debe completar la matrícula."),
          ],
          has_more: true,
          next_cursor: "1",
        },
        {
          results: [
            heading("heading-quiz", "heading_1", "Quiz"),
            paragraph("body-quiz", "This quiz text must not become evidence."),
            heading("heading-next", "heading_1", "Excepciones"),
            paragraph("body-2", "Las excepciones requieren aprobación académica."),
            paragraph("body-strike", "Retired instruction", { strikethrough: true }),
          ],
        },
      ],
    });

    const document = await fetchNotionPageDocument("page-m10", client);

    expect(document.sections).toEqual([
      {
        path: "Módulo 10: Matrícula > Matrícula estudiantil",
        text: "El estudiante debe completar la matrícula.",
        documentTitle: "Módulo 10: Matrícula",
        brand: "Class Limitless",
        area: "Académica",
        sectionTitle: "Matrícula estudiantil",
        headingPath: "Módulo 10: Matrícula > Matrícula estudiantil",
        sourcePageId: "page-m10",
        sourceUrl: "https://notion.local/page-m10",
        sourceUpdatedAt: "2026-08-19T12:00:00.000Z",
      },
      {
        path: "Módulo 10: Matrícula > Excepciones",
        text: "Las excepciones requieren aprobación académica.",
        documentTitle: "Módulo 10: Matrícula",
        brand: "Class Limitless",
        area: "Académica",
        sectionTitle: "Excepciones",
        headingPath: "Módulo 10: Matrícula > Excepciones",
        sourcePageId: "page-m10",
        sourceUrl: "https://notion.local/page-m10",
        sourceUpdatedAt: "2026-08-19T12:00:00.000Z",
      },
    ]);
    expect(document.sections.map((section) => section.text).join("\n")).not.toContain("quiz");
    expect(document.sections.map((section) => section.text).join("\n")).not.toContain(
      "Retired instruction",
    );
    expect(client.blockCalls).toEqual([
      { blockId: "page-m10", startCursor: undefined },
      { blockId: "page-m10", startCursor: "1" },
    ]);
  });

  it("queries the Contenidos data source with pagination", async () => {
    const client = new MockNotionClient(
      {},
      [
        {
          results: [modulePages[0], modulePages[1]],
          has_more: true,
          next_cursor: "1",
        },
        {
          results: [modulePages[2], modulePages[3]],
        },
      ],
      {},
    );

    const pages = await queryContenidosSource({
      client,
      dataSourceId: DATA_SOURCE_ID,
      pageSize: 2,
    });

    expect(pages.map((page) => page.title)).toEqual([
      "Módulo 10: Matrícula",
      "Módulo 6: Homologaciones",
      "Módulo 11: Calificación",
      "Módulo 3: Seguridad",
    ]);
    expect(client.queryCalls).toEqual([
      { dataSourceId: DATA_SOURCE_ID, startCursor: undefined, pageSize: 2 },
      { dataSourceId: DATA_SOURCE_ID, startCursor: "1", pageSize: 2 },
    ]);
  });

  it("maps Notion API failures to clear adapter error types", async () => {
    const cases = [
      { status: 401, kind: "unauthorized" },
      { status: 404, kind: "not_found" },
      { status: 429, kind: "rate_limited" },
      { status: 503, kind: "transient_upstream_failure" },
    ] as const;

    for (const item of cases) {
      const client = new NotionApiClient({
        token: "test-token",
        fetchImpl: async () => new Response("{}", { status: item.status }),
      });

      await expect(client.retrievePage("page-id")).rejects.toMatchObject({
        kind: item.kind,
        status: item.status,
      });
    }
  });
});
