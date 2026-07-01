# research-fact-base

A Claude-style legal research assistant. Ask a legal question and get an answer
that is **grounded** in a designated document corpus (stored in Google Drive),
then independently **verified**:

- **Retrieve** relevant passages from your designated documents (RAG).
- **Verify citations** against **CanLII** (Canada) and **CourtListener** (US).
- **Verify the law is current** with a live web search.

Users chat in a familiar Claude-style interface and can upload files directly
into a conversation.

## Status

Early planning. The full architecture and phased build plan is in
**[PLAN.md](./PLAN.md)** — under review before implementation begins.

## Planned stack

Next.js (App Router) · Supabase (Postgres + pgvector + Storage + Auth) ·
Vercel · Claude (Anthropic API) · Voyage embeddings · Google Drive corpus.

> This tool provides legal information, not legal advice.
