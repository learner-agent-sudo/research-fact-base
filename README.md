# research-fact-base

A Claude-style legal research assistant. Ask a legal question and get an answer
that is **grounded** in real sources and independently **checked**:

- **Gather sources** from a designated Google Drive corpus (RAG) and a live web
  search — every source carries a link.
- **Draft** with an ensemble of models (free tier via OpenRouter, or Claude on
  the paid tier), answering only from those linked sources.
- **Check & consolidate** with a stronger model (Gemini by default, Claude on
  the paid tier) that keeps only claims actually supported by a linked source.
- **Verify citations** against **CanLII** (Canada) and **CourtListener** (US).

Users chat in a familiar Claude-style interface, toggle between a free and a
paid (Claude) tier, and can upload files directly into a conversation.

## Status

**Phases 0–1 are in place.** A runnable Next.js app with a Claude-style
streaming chat, the full answer pipeline (source gathering → free-model ensemble
→ checker consolidation), and **RAG over a Google Drive corpus** backed by a
provisioned Supabase pgvector database. Everything degrades gracefully where API
keys aren't set. Full architecture in **[PLAN.md](./PLAN.md)**.

Wired now: chat UI + tier toggle + streaming (OpenRouter), source registry /
confidence / escalation, Google Drive ingestion → Voyage embeddings → pgvector,
similarity retrieval, admin corpus page (`/admin`). Pending: citation
verification against CanLII/CourtListener (Phase 3), auth + deploy (Phase 4).

The Supabase project (`research-fact-base`, `us-east-1`, free tier) is already
provisioned with the schema and RLS applied.

## Getting started

```bash
cp .env.example .env.local     # then add at least OPENROUTER_API_KEY
npm install
npm run dev                    # http://localhost:3000
```

Without keys the app still runs and streams a message telling you what to
configure. To enable grounded answers set `OPENROUTER_API_KEY` (and optionally
`TAVILY_API_KEY` for the web-search source). Verify the model slugs in
`.env.example` against <https://openrouter.ai/models>.

### Enabling the Google Drive corpus (RAG)

`.env.local` already has the provisioned Supabase URL + anon key. To turn on
retrieval you still need three secrets:

1. **`SUPABASE_SERVICE_ROLE_KEY`** — Supabase dashboard → Project Settings →
   API → `service_role` (secret). Server-side only; bypasses RLS.
2. **`VOYAGE_API_KEY`** — from voyageai.com (default model `voyage-law-2`).
3. **Google Drive** — create a service account, download its JSON key into
   `GOOGLE_SERVICE_ACCOUNT_JSON` (stringified), and **share the corpus folder**
   with the service-account email (read-only). Put the folder id in
   `GDRIVE_CORPUS_FOLDER_ID`.

Then open **`/admin`** and click **“Sync Drive now”** to ingest. Supported
files: Markdown, text, DOCX, PDF, and Google Docs. Once documents show `ready`,
the chat answers are grounded in them with `[S#]` citations.

The database schema lives in `supabase/migrations/` and is already applied to
the provisioned project.

### Layout

```
src/app/                  Next.js App Router (chat page + /api/chat)
src/components/Chat.tsx    streaming chat UI
src/lib/pipeline/          the 5-stage pipeline (sources, generate, check)
src/lib/models/            OpenRouter gateway client
src/lib/retrieval/         pgvector similarity retriever (Voyage query embed)
src/lib/embeddings/        Voyage embeddings client
src/lib/drive/             Google Drive service-account client
src/lib/ingest/            parse + chunk + embed + upsert pipeline
src/lib/supabase/          server (service-role) client
src/lib/search/            web-search source provider (Tavily)
src/app/admin/             corpus admin page (Sync Drive, document list)
supabase/migrations/       pgvector schema + RLS
```

## Planned stack

Next.js (App Router) · Supabase (Postgres + pgvector + Storage + Auth) ·
Vercel · models via OpenRouter (Grok / Gemini / Llama / Claude) ·
Voyage embeddings · Google Drive corpus.

> This tool provides legal information, not legal advice.
