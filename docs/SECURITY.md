# Security and production gate

## Threat model highlights

- Unauthorized access to internal procedures.
- Leaked Supabase service role, OpenAI, or Notion tokens.
- Forged Notion webhook requests.
- Retrieval crossing department/access boundaries.
- Prompt injection embedded in source documents.
- Sensitive content in logs.

## Required controls

- Supabase Auth for user-facing requests.
- Service role key only in server-side functions.
- RLS enabled and tested before production.
- Webhook HMAC signature verification using the exact raw body.
- HTTPS only for webhook endpoint.
- Least-privilege Notion integration access.
- Do not render source HTML; normalize to plain text.
- Treat retrieved content as data, never as instructions that can override the system prompt.
- Log identifiers/metrics rather than full confidential text where possible.
- Rate limit authenticated chat calls if abuse becomes possible.
- `sync-notion-page` is backend/admin-only. Browser clients and normal authenticated users must
  never call it directly. Direct HTTP invocation uses Supabase's current secret-key model with an
  `apikey: sb_secret_...` header and application-level verification against the hosted
  `SUPABASE_SECRET_KEYS` registry. Secret keys remain server-side only.
- Notion webhooks may trigger sync only after raw-body signature verification, then through the
  trusted internal sync path rather than a browser-accessible workflow.
- Internal privileged Supabase database operations still use the runtime server-side Supabase client
  credential. This is separate from direct caller authorization and must never be exposed to browser
  code.

## Production gate

Do not label production-ready until:

- RLS tests prove unauthorized users cannot retrieve restricted chunks.
- Webhook signature validation is active.
- Secrets are stored in deployment secret managers.
- No service-role key is present in browser JS.
- No-answer evaluation passes.
- Deletion/unpublishing removes content from retrieval.
- Basic backup/recovery path exists.
