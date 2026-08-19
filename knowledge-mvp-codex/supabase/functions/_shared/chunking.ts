export type NormalizedSection = {
  path: string;
  text: string;
};

export type TextChunk = {
  sourceChunkKey: string;
  sectionPath: string;
  content: string;
  ordinal: number;
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function chunkSections(
  sections: NormalizedSection[],
  maxChars = 2600,
): Promise<Array<TextChunk & { contentHash: string }>> {
  const result: Array<TextChunk & { contentHash: string }> = [];
  let ordinal = 0;

  for (const section of sections) {
    const cleaned = normalizeWhitespace(section.text);
    if (!cleaned) continue;
    const paragraphs = cleaned.split(/\n\n+/);
    let buffer = "";

    const flush = async () => {
      const content = normalizeWhitespace(buffer);
      if (!content) return;
      const contentHash = await sha256Hex(`${section.path}\n${content}`);
      result.push({
        sourceChunkKey: `${section.path}:${contentHash}`,
        sectionPath: section.path,
        content,
        ordinal: ordinal++,
        contentHash,
      });
      buffer = "";
    };

    for (const paragraph of paragraphs) {
      if (buffer && buffer.length + paragraph.length + 2 > maxChars) await flush();
      if (paragraph.length > maxChars) {
        for (let i = 0; i < paragraph.length; i += maxChars) {
          buffer = paragraph.slice(i, i + maxChars);
          await flush();
        }
      } else {
        buffer += `${buffer ? "\n\n" : ""}${paragraph}`;
      }
    }
    await flush();
  }

  return result;
}
