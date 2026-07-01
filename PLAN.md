# Legal Research Website — Architecture & Build Plan

> Status: **Plan for review** (no application code written yet).
> Branch: `claude/legal-research-website-jyihm4`

A Claude‑style chat application for legal research. A user asks a legal
question; the system answers **only** from a designated document corpus, then
independently **verifies** the answer against authoritative case‑law APIs
(CanLII for Canada, CourtListener for the US) and a **live web search**. Users
can also upload a file directly into a conversation.

---

## 1. Confirmed decisions

| Area | Decision |
|------|----------|
| **Corpus source** | Documents live in a **Google Drive** folder the user manages; the app ingests from Drive into a vector index. |
| **Verification** | **Dual‑jurisdiction.** US citations → **CourtListener** (free API, already available here). Canadian citations → **CanLII API** (user has a key). |
| **Live search** | Web search (`WebSearch` / `WebFetch`) as the third grounding layer. |
| **Stack** | **Next.js** (App Router) + **Supabase** (Postgres/pgvector/Storage/Auth) + **Vercel** (hosting) + **Claude** (Anthropic API). |
| **This session** | Plan only — this document. Build begins after review. |

---

## 2. Core answer pipeline

Every question flows through five stages. Each stage attaches evidence, and the
final answer is only as strong as what the stages could ground.

```
User question  (+ optional in-chat file upload)
      │
 ┌────▼─────────────────────────────────────────────────────────┐
 │ 1. RETRIEVE   pgvector similarity search over the designated  │
 │               corpus  ──►  top-k relevant chunks              │
 └────┬─────────────────────────────────────────────────────────┘
      │
 ┌────▼─────────────────────────────────────────────────────────┐
 │ 2. DRAFT      Claude answers using ONLY the retrieved chunks,  │
 │               via the Anthropic **Citations API** ──► answer   │
 │               with exact source spans back to each document.   │
 └────┬─────────────────────────────────────────────────────────┘
      │
 ┌────▼─────────────────────────────────────────────────────────┐
 │ 3. VERIFY CITATIONS   Extract every case citation from the     │
 │               draft. Route by jurisdiction:                    │
 │                 • US  →  CourtListener  (verify + enrich)      │
 │                 • CA  →  CanLII API     (metadata + citator)   │
 │               Flag: ✅ real · ⚠️ not found · ✏️ corrected       │
 └────┬─────────────────────────────────────────────────────────┘
      │
 ┌────▼─────────────────────────────────────────────────────────┐
 │ 4. VERIFY LAW   Live web search of the answer's key            │
 │               propositions (e.g. site:canlii.org,             │
 │               site:courtlistener.com, official statutes) to    │
 │               confirm they are current and not overruled.      │
 └────┬─────────────────────────────────────────────────────────┘
      │
 ┌────▼─────────────────────────────────────────────────────────┐
 │ 5. COMPOSE   Final answer + a per-claim evidence panel:        │
 │               [📄 in your docs] [⚖️ citation-verified]         │
 │               [🌐 web-confirmed]  with source links.           │
 └──────────────────────────────────────────────────────────────┘
```

**Why this order.** Retrieval-first keeps the model grounded in *your*
documents (reduces hallucination). Citation verification is a cheap, high-value
guardrail — it catches the single most damaging failure in legal AI: a
fabricated or misquoted case. Web verification is the freshness check.

---

## 3. Tech stack & rationale

| Layer | Choice | Why |
|-------|--------|-----|
| Frontend / chat | **Next.js (App Router)** + **Vercel AI SDK** | Streaming chat UI, server actions, file upload. First-class on Vercel. |
| Hosting | **Vercel** | One-command deploy; a Vercel MCP is available in this environment. |
| Database + vectors | **Supabase Postgres** + **pgvector** | One store for app data *and* embeddings; `<=>` cosine search. Supabase MCP available for provisioning. |
| File storage | **Supabase Storage** | Holds in-chat uploads and cached copies of Drive files. |
| Auth | **Supabase Auth** (Google OAuth) | Same Google identity the user already uses for Drive. |
| LLM | **Claude** (Anthropic API) | Synthesis, citation extraction, jurisdiction routing. |
| Embeddings | **Voyage AI** (`voyage-3` family) | Anthropic's recommended embeddings; strong retrieval quality. |
| Doc parsing | Claude **native PDF** + `mammoth` (DOCX) + Markdown parser | Claude reads PDFs directly; lighter parsers for the rest. |

**Claude features we lean on:**
- **Citations API** — returns exact source spans, so stage 2 produces
  document-grounded citations automatically (not just a free-text answer).
- **Native PDF input** — simplifies ingestion of scanned/complex PDFs.
- Model split: **Claude Opus 4.8** for final synthesis; **Claude Sonnet 5**
  for cheaper steps (jurisdiction routing, citation extraction, query
  rewriting). Exact API model IDs to be pulled from Anthropic's current model
  docs at implementation time.

---

## 4. Data model (Supabase)

```
documents            one row per source file (Drive or upload)
  id                 uuid pk
  source             'gdrive' | 'upload'
  drive_file_id      text null          -- Google Drive fileId
  title              text
  mime_type          text
  drive_modified_at  timestamptz null   -- for change detection / re-sync
  storage_path       text null          -- cached copy in Supabase Storage
  status             'pending'|'ingesting'|'ready'|'error'
  created_at         timestamptz

chunks               retrievable units
  id                 uuid pk
  document_id        uuid fk -> documents
  chunk_index        int
  content            text
  token_count        int
  embedding          vector(1024)       -- Voyage embedding
  metadata           jsonb              -- page, heading, char offsets
  -- ivfflat / hnsw index on embedding for cosine search

conversations
  id, user_id, title, created_at

messages
  id, conversation_id, role, content,
  citations          jsonb              -- doc spans from Citations API
  verifications      jsonb              -- CanLII/CourtListener/web results
  created_at

verification_cache   avoid re-hitting APIs for the same citation
  citation_key       text pk            -- normalized citation string
  provider           'canlii'|'courtlistener'
  result             jsonb
  fetched_at         timestamptz
```

Row-Level Security on `conversations`/`messages` (per user). The corpus
(`documents`/`chunks`) is shared/curated and read-only to users.

---

## 5. Google Drive ingestion pipeline

The corpus is a **designated Drive folder**. Two access roles:

- **Development (me, now):** the `Google_Drive` MCP lets me inspect and test
  against your Drive during the build.
- **Production (the app):** a **Google service account** (or the app's OAuth
  client) with read access to the shared corpus folder. The app never depends
  on the dev MCP.

**Ingestion job** (Supabase Edge Function or Next.js route, triggerable
manually and on a schedule):

```
1. List folder → files + modifiedTime         (Drive API: files.list)
2. Diff against `documents.drive_modified_at`  → new / changed files
3. Download changed files                      (files.get / export)
     • Google Docs  → export as text/markdown
     • PDF          → bytes (Claude native read or text extraction)
     • DOCX         → mammoth → text
     • MD / TXT     → as-is
4. Chunk (heading-aware, ~500–800 tokens, overlap) and record page/offset
5. Embed each chunk with Voyage
6. Upsert into documents + chunks; mark status 'ready'
7. Delete chunks for files removed from the folder
```

**Sync strategy:** a "Sync now" button for the admin plus a scheduled job
(Vercel Cron or Supabase scheduled function) using `modifiedTime` for
incremental updates so re-ingestion is cheap.

---

## 6. Retrieval + grounded answering (stages 1–2)

1. **Query rewrite** (Sonnet): expand the user's question into a retrieval
   query; detect likely jurisdiction (US / CA / unclear).
2. **Vector search**: embed the query (Voyage), `ORDER BY embedding <=> q`,
   take top-k (start k≈8) with a similarity floor. Optional hybrid search
   (pgvector + Postgres full-text) for exact term/citation matches.
3. **Answer with Citations API**: pass the retrieved chunks as documents;
   instruct Claude to answer **only** from them and abstain when the corpus is
   silent ("Not addressed in the provided documents"). The Citations API
   returns which chunk/paragraph supports each sentence — this is the
   `[📄 in your docs]` evidence, with no extra parsing.

In‑chat uploads: a file dropped into a conversation is parsed and embedded into
a **conversation-scoped** namespace so it's retrievable for that thread without
polluting the shared corpus.

---

## 7. Citation verification (stage 3) — dual jurisdiction

Extract case citations from the draft (Claude + a citation regex pass), then
**route each citation** to the right provider:

### US → CourtListener  *(free; MCP already available here)*
- `analyze_citations` — extracts and verifies citations against CourtListener,
  returning case name, date, and a **hallucination warning** when the cited
  name doesn't match the reporter. This is close to turnkey for the US side.
- `search` / `read_document` — pull the real opinion to confirm a proposition.

### Canada → CanLII API  *(user-provided key)*
Important constraint, designed around honestly:

- The public **CanLII API is metadata + citator only** — it lists databases and
  returns case metadata (name, citation, court, date) and "cited by / cites"
  relationships. **It has no free-text case-search endpoint.**
- Endpoints used:
  - `caseBrowse/{lang}/{databaseId}/{caseId}` → case metadata (confirm the case
    exists and get its canonical name/court/date).
  - `caseCitator/{lang}/{databaseId}/{caseId}/...` → citing/cited relationships
    (useful as a "still good law?" signal).
- **Resolving a citation → (databaseId, caseId):** clean for **neutral
  citations** (e.g. `2019 SCC 65` → db `csc-scc`, case `2019scc65`). For
  reporter-only citations we first resolve the CanLII URL via a
  `site:canlii.org` web search (the URL contains db/caseId), then confirm via
  the API.

**Provider abstraction:** both sit behind one `CitationVerifier` interface
(`verify(citation) → {status, canonicalName, court, date, url, source}`) so
adding jurisdictions later is a new adapter, not a rewrite. Results are cached
in `verification_cache`.

Each citation ends up labelled: **✅ verified**, **✏️ corrected** (real case,
wrong pincite/name — show the correction), or **⚠️ unverified** (surfaced
prominently as a caution).

---

## 8. Live-law verification (stage 4)

For the answer's key legal propositions (not every sentence):
- `WebSearch` scoped to authoritative domains (`canlii.org`,
  `courtlistener.com`, `laws-lois.justice.gc.ca`, official court/legislature
  sites) to confirm the rule is current and check for later treatment.
- `WebFetch` the top source to extract a confirming/contradicting snippet.
- Attach `[🌐 web-confirmed]` or a **⚠️ possibly outdated** flag with the link.

---

## 9. Chat UI & file upload

- Claude-style streaming conversation (Vercel AI SDK `useChat`), conversation
  history in the sidebar, markdown + citation rendering.
- **Evidence panel** per assistant message: collapsible source cards grouped by
  layer (your docs / citation-verified / web) with links (Drive doc, CanLII /
  CourtListener URL, web source).
- **File upload**: drag-and-drop into the composer → Supabase Storage → parse →
  embed into the conversation namespace → immediately retrievable.
- **Admin view**: list corpus documents, ingestion status, "Sync Drive now".

---

## 10. API surface (Next.js route handlers / server actions)

```
POST /api/chat                stream an answer through the 5-stage pipeline
POST /api/upload              accept an in-chat file → parse → embed
POST /api/ingest/sync         (admin) pull changes from the Drive folder
GET  /api/documents           (admin) list corpus + ingestion status
POST /api/verify/citation     verify one citation (used internally + debug UI)
```

---

## 11. Security, secrets, compliance

- **Secrets** (Anthropic, Voyage, CanLII, CourtListener tokens, Google service
  account, Supabase service-role) live in Vercel/Supabase env vars — never in
  the repo. A `.env.example` documents the names only.
- **RLS** on all user-scoped tables; corpus is read-only to end users.
- **Least-privilege Drive access** — service account scoped to the one corpus
  folder, read-only.
- **Not legal advice.** Persistent disclaimer; the product surfaces sources and
  verification status rather than presenting itself as authoritative counsel.
- **Respect provider terms** — CanLII/CourtListener rate limits and ToS; cache
  aggressively; no bulk scraping.

---

## 12. Phased roadmap

| Phase | Deliverable | Key tasks |
|-------|-------------|-----------|
| **0. Scaffold** | Running skeleton | Next.js app, Supabase project (MCP), Google-OAuth login, empty streaming chat. |
| **1. Ingest + RAG** | Ask → grounded answer | Drive ingestion job, chunk/embed to pgvector, retrieval + Claude Citations answering (layers 1–2). |
| **2. Citation verify** | Trust layer | `CitationVerifier` interface + CourtListener & CanLII adapters, jurisdiction routing, evidence badges (layer 3). |
| **3. Web verify** | Freshness layer | Web-search verification of propositions + sources panel (layer 4). |
| **4. Polish + deploy** | Shippable | In-chat uploads, chat history, admin Drive-sync UI, disclaimers, deploy to Vercel. |

---

## 13. Open questions (for after this review)

1. **Multi-user or personal?** Affects auth/RLS depth and whether the corpus is
   truly shared. (Assumed: shared curated corpus, per-user chats.)
2. **Corpus size** (dozens vs thousands of docs) — sets the pgvector index type
   (`ivfflat` vs `hnsw`) and whether ingestion needs a queue.
3. **Latency vs thoroughness** — verify *every* citation inline (slower) or
   draft fast then verify asynchronously and annotate? (Assumed: inline for
   citations, async-friendly for web.)
4. **Bilingual (EN/FR) CanLII** content handling.
5. Exact **CanLII key scope/limits**, to size the cache and rate-limiting.

---

## 14. Cost sketch (order of magnitude, per question)

- Embeddings: fractions of a cent (query + any new upload).
- Draft + synthesis (Opus/Sonnet split): the dominant cost; controlled by
  top-k size and answer length.
- CourtListener: free. CanLII: per user's key terms. Web search: per-call.
- Caching (`verification_cache`, embedded corpus) keeps steady-state cheap; the
  one-time corpus embedding is the main upfront cost and scales with corpus size.

---

*Next step: your review. On approval I'll start at Phase 0 (scaffold + Supabase
provisioning + Google login + streaming chat).*
