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

## Production gate
Do not label production-ready until:
- RLS tests prove unauthorized users cannot retrieve restricted chunks.
- Webhook signature validation is active.
- Secrets are stored in deployment secret managers.
- No service-role key is present in browser JS.
- No-answer evaluation passes.
- Deletion/unpublishing removes content from retrieval.
- Basic backup/recovery path exists.
