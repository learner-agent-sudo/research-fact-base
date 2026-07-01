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

**Phase 0 scaffold is in place** — a runnable Next.js app with a Claude-style
streaming chat and the full answer pipeline wired end to end (source gathering →
free-model ensemble → checker consolidation), degrading gracefully where API
keys aren't set yet. The full architecture and phased build plan is in
**[PLAN.md](./PLAN.md)**.

Wired now: chat UI, tier toggle (free ensemble ⇄ Claude paid), streaming answers
via OpenRouter, source registry + confidence + escalation button, Supabase
schema. Stubbed for later phases: Drive/RAG retrieval (Phase 1), citation
verification (Phase 3).

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

Database schema lives in `supabase/migrations/0001_init.sql` — apply it once
Supabase is provisioned (Phase 1).

### Layout

```
src/app/                  Next.js App Router (chat page + /api/chat)
src/components/Chat.tsx    streaming chat UI
src/lib/pipeline/          the 5-stage pipeline (sources, generate, check)
src/lib/models/            OpenRouter gateway client
src/lib/retrieval/         Drive RAG retriever (Phase 1 stub)
src/lib/search/            web-search source provider (Tavily)
supabase/migrations/       pgvector schema
```

## Planned stack

Next.js (App Router) · Supabase (Postgres + pgvector + Storage + Auth) ·
Vercel · models via OpenRouter (Grok / Gemini / Llama / Claude) ·
Voyage embeddings · Google Drive corpus.

> This tool provides legal information, not legal advice.
