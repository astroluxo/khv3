export type NormalizedSection = {
  path: string;
  text: string;
  documentTitle?: string;
  brand?: string;
  area?: string;
  sectionTitle?: string;
  headingPath?: string;
  sourcePageId?: string;
  sourceUrl?: string;
  sourceUpdatedAt?: string;
};

export type TextChunk = {
  sourceChunkKey: string;
  sourcePageId?: string;
  sourceUrl?: string;
  documentTitle: string;
  brand?: string;
  area?: string;
  sectionTitle: string;
  headingPath: string;
  sectionPath: string;
  content: string;
  ordinal: number;
  tokenEstimate: number;
  contentHash: string;
  metadata: {
    source: "notion";
    sourcePageId?: string;
    sourceUrl?: string;
    sourceUpdatedAt?: string;
    documentTitle: string;
    brand?: string;
    area?: string;
    sectionTitle: string;
    headingPath: string;
  };
};

export type ChunkingOptions = {
  minTokens?: number;
  maxTokens?: number;
};

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizedParagraph(value: string): string {
  return normalizeWhitespace(value).replace(/\n/g, " ");
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function estimateTokens(value: string): number {
  const cleaned = normalizeWhitespace(value);
  if (!cleaned) return 0;
  const lexicalUnits = cleaned.match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu) ?? [];
  return Math.max(1, Math.ceil(cleaned.length / 4), lexicalUnits.length);
}

export async function chunkSections(
  sections: NormalizedSection[],
  options: ChunkingOptions = {},
): Promise<Array<TextChunk>> {
  const minTokens = options.minTokens ?? 300;
  const maxTokens = options.maxTokens ?? 700;
  const result: TextChunk[] = [];
  let ordinal = 0;

  for (const group of groupSections(sections)) {
    let buffer: string[] = [];

    const flush = async () => {
      if (buffer.length === 0) return;
      const content = normalizeWhitespace(buffer.join("\n\n"));
      buffer = [];
      if (!content) return;
      result.push(await buildChunk(group.metadata, content, ordinal++));
    };

    for (let unitIndex = 0; unitIndex < group.units.length; unitIndex++) {
      const unit = group.units[unitIndex];
      const unitTokens = estimateTokens(unit);
      const bufferedTokens = estimateTokens(buffer.join("\n\n"));
      const wouldExceedMax = buffer.length > 0 && bufferedTokens + unitTokens > maxTokens;

      if (wouldExceedMax) await flush();

      if (unitTokens > maxTokens) {
        await flush();
        for (const split of hardSplitUnit(unit, maxTokens)) {
          result.push(await buildChunk(group.metadata, split, ordinal++));
        }
        continue;
      }

      buffer.push(unit);

      const reachedUsefulTarget = estimateTokens(buffer.join("\n\n")) >= minTokens;
      if (reachedUsefulTarget && bufferHasSemanticBoundary(buffer)) {
        const nextUnit = group.units[unitIndex + 1];
        if (
          nextUnit &&
          estimateTokens(buffer.join("\n\n")) + estimateTokens(nextUnit) > maxTokens
        ) {
          await flush();
        }
      }
    }

    await flush();
  }

  return result;
}

type SectionGroup = {
  metadata: Required<Pick<NormalizedSection, "documentTitle" | "sectionTitle" | "headingPath">> &
    Pick<NormalizedSection, "brand" | "area" | "sourcePageId" | "sourceUrl" | "sourceUpdatedAt">;
  units: string[];
};

function groupSections(sections: NormalizedSection[]): SectionGroup[] {
  const groups: SectionGroup[] = [];

  for (const section of sections) {
    const units = semanticUnits(section.text);
    if (units.length === 0) continue;

    const metadata = sectionMetadata(section);
    const prior = groups.at(-1);
    if (prior && sameSection(prior.metadata, metadata)) {
      prior.units.push(...units);
      continue;
    }

    groups.push({ metadata, units });
  }

  return groups;
}

function sectionMetadata(section: NormalizedSection): SectionGroup["metadata"] {
  const headingPath = normalizeWhitespace(section.headingPath ?? section.path);
  const parts = headingPath
    .split(">")
    .map((part) => part.trim())
    .filter(Boolean);
  const documentTitle = section.documentTitle ?? parts[0] ?? "Untitled";
  const sectionTitle = section.sectionTitle ?? parts.at(-1) ?? documentTitle;

  return {
    documentTitle,
    sectionTitle,
    headingPath,
    ...(section.brand ? { brand: section.brand } : {}),
    ...(section.area ? { area: section.area } : {}),
    ...(section.sourcePageId ? { sourcePageId: section.sourcePageId } : {}),
    ...(section.sourceUrl ? { sourceUrl: section.sourceUrl } : {}),
    ...(section.sourceUpdatedAt ? { sourceUpdatedAt: section.sourceUpdatedAt } : {}),
  };
}

function sameSection(left: SectionGroup["metadata"], right: SectionGroup["metadata"]): boolean {
  return left.sourcePageId === right.sourcePageId && left.headingPath === right.headingPath;
}

function semanticUnits(text: string): string[] {
  const paragraphs = normalizeWhitespace(text)
    .split(/\n{2,}/)
    .map(normalizedParagraph)
    .filter(Boolean);
  const units: string[] = [];
  let listBuffer: string[] = [];

  const flushList = () => {
    if (listBuffer.length === 0) return;
    units.push(listBuffer.join("\n"));
    listBuffer = [];
  };

  for (const paragraph of paragraphs) {
    if (/^([-*]|\d+[.)])\s+/.test(paragraph)) {
      listBuffer.push(paragraph);
      continue;
    }
    flushList();
    units.push(paragraph);
  }

  flushList();
  return units;
}

function hardSplitUnit(unit: string, maxTokens: number): string[] {
  const words = unit.split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  let buffer: string[] = [];

  for (const word of words) {
    const candidate = [...buffer, word].join(" ");
    if (buffer.length > 0 && estimateTokens(candidate) > maxTokens) {
      chunks.push(buffer.join(" "));
      buffer = [word];
    } else {
      buffer.push(word);
    }
  }

  if (buffer.length > 0) chunks.push(buffer.join(" "));
  return chunks.length > 0 ? chunks : [unit];
}

function bufferHasSemanticBoundary(buffer: string[]): boolean {
  return buffer.length > 0;
}

async function buildChunk(
  metadata: SectionGroup["metadata"],
  content: string,
  ordinal: number,
): Promise<TextChunk> {
  const contentHash = await sha256Hex(`${metadata.headingPath}\n${content}`);
  const sourcePrefix = metadata.sourcePageId ?? metadata.documentTitle;
  const sourceChunkKey = `${sourcePrefix}:${metadata.headingPath}:${contentHash}`;

  return {
    sourceChunkKey,
    ...(metadata.sourcePageId ? { sourcePageId: metadata.sourcePageId } : {}),
    ...(metadata.sourceUrl ? { sourceUrl: metadata.sourceUrl } : {}),
    documentTitle: metadata.documentTitle,
    ...(metadata.brand ? { brand: metadata.brand } : {}),
    ...(metadata.area ? { area: metadata.area } : {}),
    sectionTitle: metadata.sectionTitle,
    headingPath: metadata.headingPath,
    sectionPath: metadata.headingPath,
    content,
    ordinal,
    tokenEstimate: estimateTokens(content),
    contentHash,
    metadata: {
      source: "notion",
      ...(metadata.sourcePageId ? { sourcePageId: metadata.sourcePageId } : {}),
      ...(metadata.sourceUrl ? { sourceUrl: metadata.sourceUrl } : {}),
      ...(metadata.sourceUpdatedAt ? { sourceUpdatedAt: metadata.sourceUpdatedAt } : {}),
      documentTitle: metadata.documentTitle,
      ...(metadata.brand ? { brand: metadata.brand } : {}),
      ...(metadata.area ? { area: metadata.area } : {}),
      sectionTitle: metadata.sectionTitle,
      headingPath: metadata.headingPath,
    },
  };
}
