import { chunkSections } from "../_shared/chunking.ts";
import { fetchPageAsSections } from "../_shared/notion-normalizer.ts";
import { embedText } from "../_shared/openai.ts";
import { serviceClient } from "../_shared/supabase.ts";

Deno.serve(async (req) => {
  try {
    const { pageId, eventId } = await req.json();
    if (typeof pageId !== "string" || !pageId)
      return Response.json({ error: "pageId required" }, { status: 400 });
    const supabase = serviceClient();
    const source = await fetchPageAsSections(pageId);

    const { data: existingDoc } = await supabase
      .from("documents")
      .select("id,status")
      .eq("source_id", pageId)
      .maybeSingle();
    if (source.archived) {
      if (existingDoc?.id)
        await supabase
          .from("documents")
          .update({ status: "archived", last_synced_at: new Date().toISOString() })
          .eq("id", existingDoc.id);
      if (eventId)
        await supabase
          .from("sync_events")
          .update({ status: "processed", processed_at: new Date().toISOString() })
          .eq("provider_event_id", eventId);
      return Response.json({
        documentId: existingDoc?.id,
        status: "archived",
        chunksAdded: 0,
        chunksUpdated: 0,
        chunksDeleted: 0,
        chunksUnchanged: 0,
      });
    }

    const { data: doc, error: docError } = await supabase
      .from("documents")
      .upsert(
        {
          source: "notion",
          source_id: pageId,
          title: source.title,
          source_url: source.url,
          status: "published",
          source_updated_at: source.sourceUpdatedAt,
          last_synced_at: new Date().toISOString(),
          sync_error: null,
        },
        { onConflict: "source_id" },
      )
      .select("id")
      .single();
    if (docError) throw docError;

    const desired = await chunkSections(source.sections);
    const { data: existing, error: existingError } = await supabase
      .from("chunks")
      .select("id,source_chunk_key,content_hash")
      .eq("document_id", doc.id);
    if (existingError) throw existingError;
    const existingByKey = new Map((existing ?? []).map((x: any) => [x.source_chunk_key, x]));
    const desiredKeys = new Set(desired.map((x) => x.sourceChunkKey));
    let added = 0,
      updated = 0,
      unchanged = 0;

    for (const chunk of desired) {
      const prior: any = existingByKey.get(chunk.sourceChunkKey);
      if (prior?.content_hash === chunk.contentHash) {
        unchanged++;
        continue;
      }
      const embedding = await embedText(`${chunk.sectionPath}\n${chunk.content}`);
      const payload = {
        document_id: doc.id,
        source_chunk_key: chunk.sourceChunkKey,
        section_path: chunk.sectionPath,
        content: chunk.content,
        content_hash: chunk.contentHash,
        ordinal: chunk.ordinal,
        embedding,
        token_estimate: Math.ceil(chunk.content.length / 4),
        updated_at: new Date().toISOString(),
      };
      const { error } = await supabase
        .from("chunks")
        .upsert(payload, { onConflict: "document_id,source_chunk_key" });
      if (error) throw error;
      prior ? updated++ : added++;
    }

    const stale = (existing ?? [])
      .filter((x: any) => !desiredKeys.has(x.source_chunk_key))
      .map((x: any) => x.id);
    if (stale.length) {
      const { error } = await supabase.from("chunks").delete().in("id", stale);
      if (error) throw error;
    }
    if (eventId)
      await supabase
        .from("sync_events")
        .update({ status: "processed", processed_at: new Date().toISOString() })
        .eq("provider_event_id", eventId);
    return Response.json({
      documentId: doc.id,
      status: "synced",
      chunksAdded: added,
      chunksUpdated: updated,
      chunksDeleted: stale.length,
      chunksUnchanged: unchanged,
    });
  } catch (error) {
    console.error("sync_error", error instanceof Error ? error.message : String(error));
    return Response.json({ error: "sync_failed" }, { status: 500 });
  }
});
