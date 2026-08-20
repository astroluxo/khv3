import { runGroundedChat, type QueryLogInput, type QueryLogger } from "../_shared/chat-pipeline.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { envInt } from "../_shared/env.ts";
import { serviceClient, userClient } from "../_shared/supabase.ts";

type SupabaseClient = ReturnType<typeof userClient>;

class SupabaseQueryLogger implements QueryLogger {
  constructor(private readonly supabase: SupabaseClient) {}

  async logQuery(input: QueryLogInput): Promise<{ queryId?: string }> {
    const { data, error } = await this.supabase
      .from("queries")
      .insert({
        user_id: input.userId,
        message: input.question,
        answer_text: input.answer,
        insufficient_evidence: input.insufficientEvidence,
        status: input.insufficientEvidence ? "insufficient_evidence" : "answered",
        model: input.model ?? null,
        latency_ms: input.latencyMs,
        input_tokens: input.inputTokens ?? null,
        output_tokens: input.outputTokens ?? null,
        retrieved_chunk_ids: input.retrievedChunkIds,
        retrieved_document_ids: input.retrievedDocumentIds,
      })
      .select("id")
      .single();
    if (error) throw error;
    return typeof data?.id === "string" ? { queryId: data.id } : {};
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const auth = req.headers.get("Authorization") ?? "";
    if (!auth.startsWith("Bearer ")) {
      return Response.json(
        { error: { code: "unauthorized", message: "Authentication required" } },
        { status: 401, headers: corsHeaders },
      );
    }

    const body = await req.json();
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message || message.length > 4000) {
      return Response.json(
        { error: { code: "invalid_request", message: "Invalid message" } },
        { status: 400, headers: corsHeaders },
      );
    }

    const supabase = userClient(auth);
    const { data: authData, error: authError } = await supabase.auth.getUser();
    if (authError || !authData.user) {
      return Response.json(
        { error: { code: "unauthorized", message: "Invalid session" } },
        { status: 401, headers: corsHeaders },
      );
    }

    const allowedAccessScopes = await resolveAllowedAccessScopes(authData.user.id);
    const model = Deno.env.get("OPENAI_CHAT_MODEL") ?? undefined;
    const answer = await runGroundedChat({
      userId: authData.user.id,
      question: message,
      supabase,
      allowedAccessScopes,
      logger: new SupabaseQueryLogger(supabase),
      model,
      retrievalOptions: { limit: envInt("RAG_FINAL_TOP_K", 6) },
      maxContextChars: envInt("RAG_MAX_CONTEXT_CHARS", 14000),
    });

    return Response.json(answer, { headers: corsHeaders });
  } catch (error) {
    console.error("chat_error", error instanceof Error ? error.message : String(error));
    return Response.json(
      { error: { code: "internal_error", message: "Unable to answer right now" } },
      { status: 500, headers: corsHeaders },
    );
  }
});

async function resolveAllowedAccessScopes(userId: string): Promise<string[]> {
  const { data, error } = await serviceClient()
    .from("user_access_scopes")
    .select("access_scope")
    .eq("user_id", userId);
  if (error) throw error;
  return [...new Set((data ?? []).map((row) => row.access_scope).filter(isString))];
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
