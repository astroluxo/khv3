import { Client } from "npm:@notionhq/client";
import { requiredEnv } from "./env.ts";
import type { NormalizedSection } from "./chunking.ts";

export const notion = new Client({ auth: requiredEnv("NOTION_API_TOKEN") });

function richTextToPlain(items: Array<{ plain_text?: string }> | undefined): string {
  return (items ?? []).map((x) => x.plain_text ?? "").join("");
}

function blockText(block: Record<string, unknown>): { kind: string; text: string } | null {
  const type = String(block.type ?? "");
  const payload = block[type] as { rich_text?: Array<{ plain_text?: string }> } | undefined;
  if (!payload?.rich_text) return null;
  return { kind: type, text: richTextToPlain(payload.rich_text) };
}

export async function fetchPageAsSections(pageId: string): Promise<{
  title: string;
  url?: string;
  archived: boolean;
  sourceUpdatedAt?: string;
  sections: NormalizedSection[];
}> {
  const page = await notion.pages.retrieve({ page_id: pageId }) as Record<string, unknown>;
  const archived = Boolean(page.archived ?? page.in_trash ?? false);
  const properties = (page.properties ?? {}) as Record<string, any>;
  let title = "Untitled";
  for (const value of Object.values(properties)) {
    if (value?.type === "title") {
      const candidate = richTextToPlain(value.title);
      if (candidate) title = candidate;
      break;
    }
  }

  const sections: NormalizedSection[] = [];
  let cursor: string | undefined;
  let headingPath = title;
  do {
    const response = await notion.blocks.children.list({ block_id: pageId, start_cursor: cursor, page_size: 100 });
    for (const raw of response.results as Array<Record<string, unknown>>) {
      const parsed = blockText(raw);
      if (!parsed?.text) continue;
      if (["heading_1", "heading_2", "heading_3"].includes(parsed.kind)) {
        headingPath = `${title} > ${parsed.text}`;
      } else {
        sections.push({ path: headingPath, text: parsed.text });
      }
    }
    cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
  } while (cursor);

  return {
    title,
    url: typeof page.url === "string" ? page.url : undefined,
    archived,
    sourceUpdatedAt: typeof page.last_edited_time === "string" ? page.last_edited_time : undefined,
    sections,
  };
}

// TODO Phase 2: recurse into child blocks, preserve nested headings/lists/tables/code,
// and map the exact Notion knowledge schema used by the pilot department.
