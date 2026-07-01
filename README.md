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

Early planning. The full architecture and phased build plan is in
**[PLAN.md](./PLAN.md)** — under review before implementation begins.

## Planned stack

Next.js (App Router) · Supabase (Postgres + pgvector + Storage + Auth) ·
Vercel · models via OpenRouter (Grok / Gemini / Llama / Claude) ·
Voyage embeddings · Google Drive corpus.

> This tool provides legal information, not legal advice.
