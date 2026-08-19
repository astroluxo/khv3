# Notion source contract — Contenidos

## Purpose

This document defines the adapter contract between the existing Notion database `Contenidos` and the MVP knowledge retrieval layer. The RAG must adapt to the existing editorial/production workflow; the Notion database must not be redesigned merely to serve the assistant.

## Source identity

- Database title: `Contenidos`
- Database page ID: `c4c77c5b-8401-4495-91a8-1ee20debc74a`
- Data source ID: `bca10c9e-a5dc-4a13-bf01-716208507ff6`
- Current hierarchy: `Innovasoft -> Autocapacitación -> Contenidos`

All IDs must remain environment-configurable. Never hard-code them into generic retrieval logic.

## Knowledge allowlist

Only the following source properties affect knowledge ingestion or retrieval in the MVP:

| Notion property       | Purpose in RAG                    | Rule                                                                        |
| --------------------- | --------------------------------- | --------------------------------------------------------------------------- |
| `IDVideo`             | Canonical source title            | Required; map to `documents.title`                                          |
| `Brand`               | Product/domain routing metadata   | Store and allow retrieval filtering/boosting                                |
| `Área`                | Functional-area routing metadata  | Store and allow retrieval filtering/boosting                                |
| `Publicado AC`        | Publication gate                  | Only `true` pages may have active retrievable chunks                        |
| `Versión`             | Traceability metadata             | Preserve relation identifiers; do not inject into answer context by default |
| `Rel_Actualizaciones` | Change/history traceability       | Preserve relation identifiers; do not inject into answer context by default |
| Notion page ID        | Stable source identity            | Required                                                                    |
| Notion page URL       | Citation/source link              | Required when available                                                     |
| `last_edited_time`    | Incremental sync/change detection | Required when available                                                     |
| Page body             | Authoritative knowledge text      | Normalize and index according to rules below                                |

## Production metadata: explicitly not knowledge

These fields belong to the training/video production workflow. They MUST NOT influence retrieval ranking or be included in the model context in the MVP:

- `Formato Contenido`
- `Audio`
- `Guión`
- `Video Base`
- `Video Final`
- `EstadoVid`
- `Quiz` (property)

They may be retained in `documents.metadata.production` for observability/future product features, but code must treat them as non-authoritative metadata.

`Observaciones` is editorial/production metadata. Preserve it separately but never use it as answer evidence unless a future ADR explicitly changes this policy.

## Publication semantics

`Publicado AC` is the source-of-truth publication gate.

- `Publicado AC = true`: page is eligible for normalization, chunking, embeddings, and retrieval.
- `Publicado AC = false`: document status becomes `draft` (or equivalent inactive state) and all active chunks must be deleted or made unretrievable immediately.
- Archived/deleted Notion page: document status becomes `archived`; chunks must be removed/excluded immediately.

Never infer publication from video-production state such as `Video Final = OK`.

## Body normalization

The page body contains operational content plus editor/training artifacts. The ingestion adapter must preserve semantic structure while removing non-authoritative noise.

### Include

- headings and their hierarchy
- paragraphs
- bulleted and numbered list items
- callouts as text, retaining their heading ancestry
- tables as structured text when encountered
- inline links as anchor text; preserve destination in metadata when practical
- emphasized/highlighted text as ordinary authoritative text

### Exclude from the knowledge corpus

- content under a top-level or section heading named `Quiz` (case-insensitive, surrounding whitespace ignored)
- bookmark/unknown blocks with no useful textual content
- empty blocks
- comments/discussion URLs and other Notion editor markup
- rich-text spans whose `annotations.strikethrough` is `true`

Strikethrough text is intentionally excluded because it can represent retired or superseded instructions.

### Highlights

Highlighted/background-colored text remains indexable. Preserve an annotation flag only if useful for later editorial analytics; highlighting does not make text less authoritative.

## Semantic sectioning

Never vectorize an entire Notion page as one chunk and never split only by fixed character counts.

1. Parse heading hierarchy (`heading_1` -> `heading_2` -> `heading_3`).
2. Group body blocks under the nearest heading path.
3. Build chunk context using the hierarchy:
   `Brand -> Área -> Document title -> Heading path`.
4. Prefer paragraph/list boundaries.
5. Target roughly 300–700 tokens per chunk; hard split only as a fallback.
6. Do not merge unrelated sibling headings merely to hit a target size.

Example heading path:

`Class Limitless > Académica > Módulo 10: Matrícula > Matrícula estudiantil`

A page containing several operational subtopics (for example homologations, attendance rules, and graduation-document numbering) must produce separate section groups.

## Chunk representation

Each retrievable chunk must minimally preserve:

```json
{
  "notion_page_id": "...",
  "document_title": "...",
  "brand": "Class Limitless",
  "area": "Académica",
  "heading_path": "...",
  "section": "...",
  "content": "...",
  "published": true,
  "source_url": "...",
  "source_updated_at": "...",
  "chunk_index": 0,
  "content_hash": "..."
}
```

The embedding input SHOULD prepend compact hierarchy context to the chunk content. The answer context SHOULD contain the section path and content, not unrelated production metadata.

## Stable hashing and incremental updates

- Hash normalized content plus semantic heading path.
- Reuse embeddings when both path and normalized content are unchanged.
- When a page changes, reconcile only that page.
- Delete chunks no longer present after reconciliation.
- Duplicate webhook events must be idempotent.
- A false publication gate must remove retrievability even if embedding generation is unavailable.

## Retrieval behavior

Hybrid retrieval uses vector similarity + full-text search + metadata filters.

`Brand` and `Área` may be explicit filters when supplied by product context or high-confidence routing; otherwise they may be soft boosts. They must not be required for every query.

Do not filter or boost using `Formato Contenido`, `Audio`, `Guión`, `Video Base`, `Video Final`, `EstadoVid`, or `Quiz`.

## Citation contract

Citations shown to users should expose:

- document title (`IDVideo`)
- nearest meaningful heading/section
- Notion source URL

Internal chunk IDs and retrieval scores are not user-facing.

## Future-proofing

Use an explicit allowlist rather than serializing the entire Notion schema into retrieval prompts. New production columns added to `Contenidos` must have zero effect on RAG behavior until explicitly approved in this contract.
