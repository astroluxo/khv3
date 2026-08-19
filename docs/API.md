# API contracts

## POST /chat
Authenticated request handled by the `chat` Edge Function.

Request:
```json
{
  "message": "¿Cuál es el procedimiento para cancelar una matrícula?",
  "conversationId": "optional-uuid"
}
```

Success:
```json
{
  "status": "answered",
  "answer": "...",
  "citations": [
    {
      "chunkId": "uuid",
      "documentId": "uuid",
      "title": "Cancelación de matrícula",
      "section": "Solicitud posterior al inicio",
      "sourceUrl": "https://www.notion.so/..."
    }
  ],
  "queryId": "uuid"
}
```

Insufficient evidence:
```json
{
  "status": "insufficient_evidence",
  "answer": "No encuentro información suficiente en la base de conocimiento aprobada para responder con seguridad.",
  "citations": [],
  "queryId": "uuid"
}
```

Errors use a stable `{ "error": { "code": "...", "message": "..." } }` envelope and must not expose secrets or raw provider errors.

## POST /notion-webhook
- Must read raw body bytes/string before JSON parsing for signature validation.
- Subscription verification payloads are acknowledged and the verification token must be captured through secure operational setup, not logged casually.
- Normal events require valid `X-Notion-Signature` in production.
- Return quickly; expensive work belongs in the sync function.

## POST /sync-notion-page
Server-to-server/admin only.

Request:
```json
{ "pageId": "notion-page-id", "eventId": "optional-event-id" }
```

Response:
```json
{
  "documentId": "uuid",
  "status": "synced",
  "chunksAdded": 2,
  "chunksUpdated": 1,
  "chunksDeleted": 0,
  "chunksUnchanged": 12
}
```
