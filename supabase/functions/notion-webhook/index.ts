import { verifyWebhookSignature } from "npm:@notionhq/client";
import { requiredEnv } from "../_shared/env.ts";
import { markSyncFailed, runTrustedNotionPageSync } from "../_shared/sync-notion-page.ts";
import { serviceClient } from "../_shared/supabase.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const raw = await req.text();
  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  // One-time Notion subscription verification. Capture the token securely during setup.
  if (typeof payload.verification_token === "string") {
    console.log("notion_webhook_verification_received");
    return Response.json({ received: true });
  }

  const verificationToken = requiredEnv("NOTION_WEBHOOK_VERIFICATION_TOKEN");
  const signature = req.headers.get("X-Notion-Signature") ?? "";
  const valid = await verifyWebhookSignature({ body: raw, signature, verificationToken });
  if (!valid) return new Response("Invalid signature", { status: 401 });

  const eventId = String(payload.id ?? payload.event_id ?? "");
  const eventType = String(payload.type ?? "unknown");
  const entityId = String(payload.entity?.id ?? "");
  if (!eventId || !entityId) return Response.json({ received: true, ignored: true });

  const supabase = serviceClient();
  const { error } = await supabase.from("sync_events").insert({
    provider: "notion",
    provider_event_id: eventId,
    event_type: eventType,
    entity_id: entityId,
    payload,
    status: "received",
  });
  if (error && !String(error.code).includes("23505")) throw error;
  if (error) return Response.json({ received: true, duplicate: true });

  // MVP direct internal invocation. A durable queue can replace this once reliability evidence needs it.
  try {
    await runTrustedNotionPageSync(
      { pageId: entityId, eventId },
      { createSupabaseClient: () => supabase },
    );
  } catch (error) {
    await markSyncFailed(
      { pageId: entityId, eventId, error },
      { createSupabaseClient: () => supabase },
    );
  }
  return Response.json({ received: true });
});
