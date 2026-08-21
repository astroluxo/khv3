import { handleSyncNotionPageRequest } from "../_shared/sync-notion-page.ts";
import { serviceClient } from "../_shared/supabase.ts";

Deno.serve((req) =>
  handleSyncNotionPageRequest(req, {
    createSupabaseClient: serviceClient,
  }),
);
