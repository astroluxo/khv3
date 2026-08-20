import type { NormalizedSection } from "./chunking.ts";
import {
  fetchNotionRawPageDocument,
  type NotionBlockWithChildren,
  type NotionClient,
  type NotionMappedPage,
  type NotionRawPageDocument,
} from "./notion.ts";

export type NotionSourceDocument = NotionMappedPage & {
  sections: NormalizedSection[];
};

export function normalizeNotionPageBody(document: NotionRawPageDocument): NormalizedSection[] {
  const sections: NormalizedSection[] = [];
  appendBlocks(document.bodyBlocks, document, [], sections, undefined);
  return sections;
}

export async function fetchNotionPageDocument(
  pageId: string,
  client?: NotionClient,
): Promise<NotionSourceDocument> {
  const document = await fetchNotionRawPageDocument(pageId, client);
  return {
    ...document,
    sections: normalizeNotionPageBody(document),
  };
}

export async function fetchPageAsSections(
  pageId: string,
  client?: NotionClient,
): Promise<NotionSourceDocument> {
  return fetchNotionPageDocument(pageId, client);
}

function appendBlocks(
  blocks: NotionBlockWithChildren[],
  metadata: NotionMappedPage,
  headingState: string[],
  sections: NormalizedSection[],
  initialSkipHeadingDepth: number | undefined,
): void {
  let skipHeadingDepth = initialSkipHeadingDepth;

  for (const block of blocks) {
    skipHeadingDepth = appendBlock(block, metadata, headingState, sections, skipHeadingDepth);
  }
}

function appendBlock(
  block: NotionBlockWithChildren,
  metadata: NotionMappedPage,
  headingState: string[],
  sections: NormalizedSection[],
  skipHeadingDepth: number | undefined,
): number | undefined {
  const parsed = blockText(block);
  const headingLevel = headingBlockLevel(block.type);

  if (headingLevel) {
    const heading = parsed?.text.trim() ?? "";

    if (skipHeadingDepth !== undefined) {
      if (headingLevel > skipHeadingDepth) return skipHeadingDepth;
      skipHeadingDepth = undefined;
    }

    headingState.splice(headingLevel - 1);
    if (isQuizHeading(heading)) return headingLevel;
    if (heading) headingState[headingLevel - 1] = heading;
    return undefined;
  }

  if (skipHeadingDepth !== undefined) return skipHeadingDepth;

  if (parsed?.text) {
    const headingPath = buildHeadingPath(metadata, headingState);
    sections.push({
      path: headingPath,
      text: parsed.text,
      documentTitle: metadata.title,
      ...(metadata.brand ? { brand: metadata.brand } : {}),
      ...(metadata.area ? { area: metadata.area } : {}),
      sectionTitle: headingState.at(-1) ?? metadata.title,
      headingPath,
      sourcePageId: metadata.sourceId,
      ...(metadata.url ? { sourceUrl: metadata.url } : {}),
      ...(metadata.sourceUpdatedAt ? { sourceUpdatedAt: metadata.sourceUpdatedAt } : {}),
    });
  }

  if (block.children.length > 0) {
    appendBlocks(block.children, metadata, headingState, sections, skipHeadingDepth);
  }

  return skipHeadingDepth;
}

function buildHeadingPath(metadata: NotionMappedPage, headingState: string[]): string {
  return [metadata.title, ...headingState]
    .filter((part): part is string => Boolean(part))
    .join(" > ");
}

function blockText(block: NotionBlockWithChildren): { kind: string; text: string } | null {
  const type = block.type;
  if (!type) return null;
  const payload = block[type];
  if (!isRecord(payload)) return null;

  if (type === "table_row") {
    const cells = Array.isArray(payload.cells) ? payload.cells : [];
    const text = cells
      .map((cell) => richTextToPlain(Array.isArray(cell) ? cell : []))
      .filter(Boolean)
      .join(" | ");
    return text ? { kind: type, text } : null;
  }

  const richText = Array.isArray(payload.rich_text) ? payload.rich_text : [];
  const text = richTextToPlain(richText);
  if (!text) return null;
  if (type === "bulleted_list_item") return { kind: type, text: `- ${text}` };
  if (type === "numbered_list_item") return { kind: type, text: `1. ${text}` };
  return { kind: type, text };
}

function richTextToPlain(items: unknown[]): string {
  return items
    .filter(isRecord)
    .filter((item) => !isRecord(item.annotations) || item.annotations.strikethrough !== true)
    .map((item) => (typeof item.plain_text === "string" ? item.plain_text : ""))
    .join("")
    .trim();
}

function headingBlockLevel(type: string | undefined): number | undefined {
  if (type === "heading_1") return 1;
  if (type === "heading_2") return 2;
  if (type === "heading_3") return 3;
  return undefined;
}

function isQuizHeading(value: string): boolean {
  const tokens =
    value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .match(/[a-z0-9]+/g) ?? [];
  return tokens.includes("quiz");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
