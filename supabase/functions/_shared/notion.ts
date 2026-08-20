import { requiredEnv } from "./env.ts";

const DEFAULT_NOTION_VERSION = "2026-03-11";
const DEFAULT_PAGE_SIZE = 100;

const PROPERTY = {
  title: "IDVideo",
  brand: "Brand",
  area: "Área",
  publishedAc: "Publicado AC",
  version: "Versión",
  updates: "Rel_Actualizaciones",
  observations: "Observaciones",
} as const;

const PRODUCTION_PROPERTIES = [
  "Formato Contenido",
  "Audio",
  "Guión",
  "Video Base",
  "Video Final",
  "EstadoVid",
  "Quiz",
] as const;

export type NotionSourceErrorKind =
  | "unauthorized"
  | "not_found"
  | "rate_limited"
  | "malformed_source_data"
  | "transient_upstream_failure";

export class NotionSourceError extends Error {
  readonly kind: NotionSourceErrorKind;
  readonly status?: number;

  constructor(
    kind: NotionSourceErrorKind,
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "NotionSourceError";
    this.kind = kind;
    this.status = options.status;
  }
}

export type NotionRichText = {
  plain_text?: string;
  annotations?: {
    strikethrough?: boolean;
  };
};

type NotionSelectValue = { name?: string };
type NotionRelationValue = { id?: string };
type NotionFileValue = { name?: string; file?: { url?: string }; external?: { url?: string } };
type NotionFormulaValue = {
  type?: string;
  string?: string | null;
  boolean?: boolean | null;
  number?: number | null;
};
type NotionRollupValue = {
  type?: string;
  array?: NotionProperty[];
  number?: number | null;
};

export type NotionProperty =
  | { type: "title"; title?: NotionRichText[] }
  | { type: "rich_text"; rich_text?: NotionRichText[] }
  | { type: "checkbox"; checkbox?: boolean }
  | { type: "select"; select?: NotionSelectValue | null }
  | { type: "multi_select"; multi_select?: NotionSelectValue[] }
  | { type: "status"; status?: NotionSelectValue | null }
  | { type: "relation"; relation?: NotionRelationValue[] }
  | { type: "url"; url?: string | null }
  | { type: "email"; email?: string | null }
  | { type: "phone_number"; phone_number?: string | null }
  | { type: "number"; number?: number | null }
  | { type: "date"; date?: { start?: string; end?: string | null } | null }
  | { type: "files"; files?: NotionFileValue[] }
  | { type: "formula"; formula?: NotionFormulaValue }
  | { type: "rollup"; rollup?: NotionRollupValue }
  | { type: string; [key: string]: unknown };

export type NotionPage = {
  object?: "page";
  id?: string;
  archived?: boolean;
  in_trash?: boolean;
  url?: string;
  last_edited_time?: string;
  properties?: Record<string, NotionProperty>;
};

export type NotionBlock = {
  object?: "block";
  id?: string;
  type?: string;
  has_children?: boolean;
  [key: string]: unknown;
};

export type NotionBlockWithChildren = NotionBlock & {
  children: NotionBlockWithChildren[];
};

export type NotionListResponse<T> = {
  object?: "list";
  results: T[];
  has_more?: boolean;
  next_cursor?: string | null;
};

export type NotionDataSourceQuery = {
  dataSourceId: string;
  startCursor?: string;
  pageSize?: number;
  filter?: Record<string, unknown>;
  sorts?: Array<Record<string, unknown>>;
};

export type NotionClient = {
  retrievePage(pageId: string): Promise<NotionPage>;
  listBlockChildren(
    blockId: string,
    options?: { startCursor?: string; pageSize?: number },
  ): Promise<NotionListResponse<NotionBlock>>;
  queryDataSource(query: NotionDataSourceQuery): Promise<NotionListResponse<NotionPage>>;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type NotionApiClientOptions = {
  token: string;
  notionVersion?: string;
  fetchImpl?: FetchLike;
  baseUrl?: string;
};

export class NotionApiClient implements NotionClient {
  private readonly token: string;
  private readonly notionVersion: string;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;

  constructor(options: NotionApiClientOptions) {
    this.token = options.token;
    this.notionVersion = options.notionVersion ?? DEFAULT_NOTION_VERSION;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? "https://api.notion.com/v1";
  }

  retrievePage(pageId: string): Promise<NotionPage> {
    return this.request<NotionPage>(`/pages/${encodeURIComponent(pageId)}`);
  }

  listBlockChildren(
    blockId: string,
    options: { startCursor?: string; pageSize?: number } = {},
  ): Promise<NotionListResponse<NotionBlock>> {
    const params = new URLSearchParams({
      page_size: String(options.pageSize ?? DEFAULT_PAGE_SIZE),
    });
    if (options.startCursor) params.set("start_cursor", options.startCursor);
    return this.request<NotionListResponse<NotionBlock>>(
      `/blocks/${encodeURIComponent(blockId)}/children?${params.toString()}`,
    );
  }

  queryDataSource(query: NotionDataSourceQuery): Promise<NotionListResponse<NotionPage>> {
    const body: Record<string, unknown> = {
      page_size: query.pageSize ?? DEFAULT_PAGE_SIZE,
    };
    if (query.startCursor) body.start_cursor = query.startCursor;
    if (query.filter) body.filter = query.filter;
    if (query.sorts) body.sorts = query.sorts;
    return this.request<NotionListResponse<NotionPage>>(
      `/data_sources/${encodeURIComponent(query.dataSourceId)}/query`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          "Notion-Version": this.notionVersion,
          ...(init.headers ?? {}),
        },
      });
    } catch (error) {
      throw new NotionSourceError(
        "transient_upstream_failure",
        "Notion request failed before a response",
        {
          cause: error,
        },
      );
    }

    if (!response.ok) {
      throw mapHttpError(response.status);
    }

    try {
      return (await response.json()) as T;
    } catch (error) {
      throw new NotionSourceError(
        "transient_upstream_failure",
        "Notion returned an unreadable JSON response",
        {
          cause: error,
        },
      );
    }
  }
}

export type NotionKnowledgeMetadata = {
  pageId: string;
  sourceUrl?: string;
  lastEditedTime?: string;
  brand?: string;
  area?: string;
  publishedAc: boolean;
};

export type NotionTraceabilityMetadata = {
  Versión: string[];
  Rel_Actualizaciones: string[];
};

export type NotionProductionMetadata = Partial<
  Record<(typeof PRODUCTION_PROPERTIES)[number], string | string[] | boolean | number>
>;

export type NotionEditorialMetadata = {
  Observaciones?: string;
};

export type NotionMappedPage = {
  source: "notion";
  sourceId: string;
  title: string;
  archived: boolean;
  url?: string;
  sourceUpdatedAt?: string;
  brand?: string;
  area?: string;
  publishedAc: boolean;
  knowledgeMetadata: NotionKnowledgeMetadata;
  traceabilityMetadata: NotionTraceabilityMetadata;
  productionMetadata: NotionProductionMetadata;
  editorialMetadata: NotionEditorialMetadata;
};

export type NotionRawPageDocument = NotionMappedPage & {
  bodyBlocks: NotionBlockWithChildren[];
};

export function createDefaultNotionClient(): NotionApiClient {
  return new NotionApiClient({
    token: requiredEnv("NOTION_API_TOKEN"),
    notionVersion: requiredEnv("NOTION_API_VERSION") || DEFAULT_NOTION_VERSION,
  });
}

export function mapNotionPageToDocumentMetadata(page: NotionPage): NotionMappedPage {
  const pageId = cleanText(page.id);
  if (!pageId) {
    throw malformed("Notion page is missing a page id");
  }

  const properties = page.properties;
  if (!properties) {
    throw malformed(`Notion page ${pageId} is missing properties`);
  }

  const title = propertyText(properties[PROPERTY.title]).trim();
  if (!title) {
    throw malformed(`Notion page ${pageId} is missing required IDVideo title`);
  }

  const brand = optionalPropertyText(properties[PROPERTY.brand]);
  const area = optionalPropertyText(properties[PROPERTY.area]);
  const publishedAc = propertyCheckbox(properties[PROPERTY.publishedAc]);
  const url = cleanText(page.url);
  const lastEditedTime = cleanText(page.last_edited_time);

  const knowledgeMetadata: NotionKnowledgeMetadata = {
    pageId,
    publishedAc,
    ...(url ? { sourceUrl: url } : {}),
    ...(lastEditedTime ? { lastEditedTime } : {}),
    ...(brand ? { brand } : {}),
    ...(area ? { area } : {}),
  };

  return {
    source: "notion",
    sourceId: pageId,
    title,
    archived: Boolean(page.archived ?? page.in_trash ?? false),
    ...(url ? { url } : {}),
    ...(lastEditedTime ? { sourceUpdatedAt: lastEditedTime } : {}),
    ...(brand ? { brand } : {}),
    ...(area ? { area } : {}),
    publishedAc,
    knowledgeMetadata,
    traceabilityMetadata: {
      Versión: relationIds(properties[PROPERTY.version]),
      Rel_Actualizaciones: relationIds(properties[PROPERTY.updates]),
    },
    productionMetadata: productionMetadata(properties),
    editorialMetadata: editorialMetadata(properties),
  };
}

export async function fetchNotionRawPageDocument(
  pageId: string,
  client: NotionClient = createDefaultNotionClient(),
): Promise<NotionRawPageDocument> {
  const page = await client.retrievePage(pageId);
  const metadata = mapNotionPageToDocumentMetadata(page);
  const bodyBlocks = await fetchNotionPageBodyBlocks(metadata.sourceId, client);
  return { ...metadata, bodyBlocks };
}

export async function fetchNotionPageBodyBlocks(
  pageId: string,
  client: NotionClient = createDefaultNotionClient(),
): Promise<NotionBlockWithChildren[]> {
  return fetchNotionBlockTree(client, pageId);
}

export async function queryContenidosSource(
  options: {
    client?: NotionClient;
    dataSourceId?: string;
    pageSize?: number;
    filter?: Record<string, unknown>;
    sorts?: Array<Record<string, unknown>>;
  } = {},
): Promise<NotionMappedPage[]> {
  const client = options.client ?? createDefaultNotionClient();
  const dataSourceId = options.dataSourceId ?? requiredEnv("NOTION_CONTENTS_DATA_SOURCE_ID");
  const pages: NotionMappedPage[] = [];
  let cursor: string | undefined;

  do {
    const query: NotionDataSourceQuery = {
      dataSourceId,
      pageSize: options.pageSize ?? DEFAULT_PAGE_SIZE,
    };
    if (cursor) query.startCursor = cursor;
    if (options.filter) query.filter = options.filter;
    if (options.sorts) query.sorts = options.sorts;

    const response = await client.queryDataSource(query);
    for (const page of response.results) {
      pages.push(mapNotionPageToDocumentMetadata(page));
    }
    cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
  } while (cursor);

  return pages;
}

async function fetchNotionBlockTree(
  client: NotionClient,
  blockId: string,
): Promise<NotionBlockWithChildren[]> {
  const blocks: NotionBlockWithChildren[] = [];
  let cursor: string | undefined;

  do {
    const response = await client.listBlockChildren(blockId, {
      startCursor: cursor,
      pageSize: DEFAULT_PAGE_SIZE,
    });

    for (const block of response.results) {
      blocks.push({
        ...block,
        children:
          block.has_children && block.id ? await fetchNotionBlockTree(client, block.id) : [],
      });
    }

    cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
  } while (cursor);

  return blocks;
}

function propertyText(property: NotionProperty | undefined): string {
  if (!property) return "";
  switch (property.type) {
    case "title":
      return richTextPropertyToPlain(property.title ?? []);
    case "rich_text":
      return richTextPropertyToPlain(property.rich_text ?? []);
    case "select":
      return property.select?.name ?? "";
    case "multi_select":
      return (property.multi_select ?? [])
        .map((item) => item.name)
        .filter(isNonEmptyString)
        .join(", ");
    case "status":
      return property.status?.name ?? "";
    case "url":
      return property.url ?? "";
    case "email":
      return property.email ?? "";
    case "phone_number":
      return property.phone_number ?? "";
    case "number":
      return property.number === null || property.number === undefined
        ? ""
        : String(property.number);
    case "date":
      return property.date?.end
        ? `${property.date.start ?? ""} - ${property.date.end}`
        : (property.date?.start ?? "");
    case "files":
      return (property.files ?? [])
        .map((file) => file.name ?? file.file?.url ?? file.external?.url)
        .filter(isNonEmptyString)
        .join(", ");
    case "formula":
      return formulaText(property.formula);
    case "rollup":
      return rollupText(property.rollup);
    default:
      return "";
  }
}

function richTextPropertyToPlain(items: NotionRichText[]): string {
  return items
    .map((item) => item.plain_text ?? "")
    .join("")
    .trim();
}

function optionalPropertyText(property: NotionProperty | undefined): string | undefined {
  const text = propertyText(property).trim();
  return text || undefined;
}

function propertyCheckbox(property: NotionProperty | undefined): boolean {
  if (!property) return false;
  if (property.type === "checkbox") return property.checkbox === true;
  if (property.type === "formula" && property.formula?.type === "boolean")
    return property.formula.boolean === true;
  return false;
}

function relationIds(property: NotionProperty | undefined): string[] {
  if (!property || property.type !== "relation") return [];
  return (property.relation ?? []).map((item) => item.id).filter(isNonEmptyString);
}

function productionMetadata(properties: Record<string, NotionProperty>): NotionProductionMetadata {
  const metadata: NotionProductionMetadata = {};
  for (const name of PRODUCTION_PROPERTIES) {
    const property = properties[name];
    if (!property) continue;
    const value = productionValue(property);
    if (value !== undefined) metadata[name] = value;
  }
  return metadata;
}

function productionValue(
  property: NotionProperty,
): string | string[] | boolean | number | undefined {
  if (property.type === "checkbox") return property.checkbox === true;
  if (property.type === "number") return property.number ?? undefined;
  if (property.type === "relation") return relationIds(property);
  const text = propertyText(property).trim();
  return text || undefined;
}

function editorialMetadata(properties: Record<string, NotionProperty>): NotionEditorialMetadata {
  const observations = optionalPropertyText(properties[PROPERTY.observations]);
  return observations ? { Observaciones: observations } : {};
}

function formulaText(formula: NotionFormulaValue | undefined): string {
  if (!formula) return "";
  if (formula.type === "string" && typeof formula.string === "string") return formula.string;
  if (formula.type === "number" && typeof formula.number === "number")
    return String(formula.number);
  if (formula.type === "boolean" && typeof formula.boolean === "boolean")
    return String(formula.boolean);
  return "";
}

function rollupText(rollup: NotionRollupValue | undefined): string {
  if (!rollup) return "";
  if (Array.isArray(rollup.array)) return rollup.array.map(propertyText).filter(Boolean).join(", ");
  if (typeof rollup.number === "number") return String(rollup.number);
  return "";
}

function mapHttpError(status: number): NotionSourceError {
  if (status === 401 || status === 403) {
    return new NotionSourceError("unauthorized", "Notion request was not authorized", { status });
  }
  if (status === 404)
    return new NotionSourceError("not_found", "Notion resource was not found", { status });
  if (status === 429)
    return new NotionSourceError("rate_limited", "Notion rate limit was exceeded", { status });
  if (status >= 500) {
    return new NotionSourceError(
      "transient_upstream_failure",
      "Notion returned a transient upstream failure",
      {
        status,
      },
    );
  }
  return new NotionSourceError(
    "malformed_source_data",
    "Notion returned an unexpected request error",
    { status },
  );
}

function malformed(message: string): NotionSourceError {
  return new NotionSourceError("malformed_source_data", message);
}

function cleanText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
