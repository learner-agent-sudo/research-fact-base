# Legal Research Website — Architecture & Build Plan

> Status: **Phases 0–1 built** (scaffold + streaming pipeline + Drive/RAG on
> provisioned Supabase). Phases 2–4 pending. Branch:
> `claude/legal-research-website-jyihm4`

A Claude‑style chat application for legal research. A user asks a legal
question; the system drafts an answer **only** from grounded sources (a
designated Google Drive corpus + live web search, always with links), then a
stronger "checker" model **consolidates and verifies** that answer, and case
citations are independently confirmed against **CanLII** (Canada) and
**CourtListener** (US). Users can also upload a file directly into a
conversation.

---

## 1. Confirmed decisions

| Area | Decision |
|------|----------|
| **Corpus source** | Documents live in a **Google Drive** folder the user manages; the app ingests from Drive into a vector index. |
| **Answer grounding** | Answers come **only** from the Drive corpus and/or **live web search**, always **with links**. Enforced app-side (see §7). |
| **Priority** | **Accuracy over latency.** Broader ensemble + thorough checking; added delay is acceptable. |
| **Model roles** | **Generator/verifier split.** Free models *draft*; a stronger model *checks*. |
| **Model gateway** | **OpenRouter** as a single gateway to all models (Grok, Gemini, Llama, Claude, …). |
| **Generation mode** | **Ensemble** — fan out to several (3+) free models in parallel, then consolidate. |
| **Checker model** | **Gemini by default**; Claude as checker only on the paid tier. |
| **Escalation** | **User-decided.** Show a confidence indicator + one-click "Re-run with Claude (paid)". No silent auto-escalation. |
| **Scope** | **Personal (single-user)** for now; the multi-user structure stays latent for later. |
| **Keys / cost** | **Owner-supplied keys** + a **tier toggle** (free vs. Claude paid). No per-user keys for now. |
| **Citation verify** | **CourtListener** (US, free) + **CanLII** (Canada, user key), routed by jurisdiction. |
| **Stack** | **Next.js** + **Supabase** (Postgres/pgvector/Storage/Auth) + **Vercel** + models via **OpenRouter**. |
| **This session** | Plan only. Build begins after review. |

---

## 2. Core answer pipeline

Two kinds of verification run together: the **checker model** verifies
*content* ("does the answer actually follow from its linked sources?"), and
**CanLII/CourtListener** verify *citations* ("is this case real and correctly
named?").

```
User question  (+ optional in-chat file upload)
      │
 ┌────▼─────────────────────────────────────────────────────────┐
 │ 1. GATHER SOURCES  Build a grounding set, each item tagged     │
 │    [S1],[S2]… with a link:                                     │
 │      a) Drive RAG — pgvector top-k chunks (+ Drive doc links)  │
 │      b) Live web search — results + fetched snippets (+ URLs)  │
 └────┬─────────────────────────────────────────────────────────┘
      │
 ┌────▼─────────────────────────────────────────────────────────┐
 │ 2. GENERATE (drafters)   Route by tier:                        │
 │      • Free tier (default): fan out the SAME question+sources  │
 │        to N free models via OpenRouter (e.g. Grok, Gemini-free,│
 │        Llama). Each answers ONLY from [S#] sources and cites   │
 │        every claim by tag.                                     │
 │      • Paid tier (user toggle): Claude drafts from the sources.│
 └────┬─────────────────────────────────────────────────────────┘
      │
 ┌────▼─────────────────────────────────────────────────────────┐
 │ 3. CHECK & CONSOLIDATE   Checker = Gemini (default) / Claude   │
 │    (paid). It receives the question, the [S#] source set, and  │
 │    all candidate drafts, then:                                 │
 │      • merges them into ONE answer,                            │
 │      • confirms each claim is supported by its cited source —  │
 │        drops or flags unsupported claims,                      │
 │      • enforces "every claim carries a valid [S#] link".       │
 │    (Optional escalation if confidence is low — see §6.)        │
 └────┬─────────────────────────────────────────────────────────┘
      │
 ┌────▼─────────────────────────────────────────────────────────┐
 │ 4. VERIFY CITATIONS   Deterministic APIs, routed by cite:      │
 │      • US  →  CourtListener  (verify + hallucination warning)  │
 │      • CA  →  CanLII         (metadata + citator)              │
 └────┬─────────────────────────────────────────────────────────┘
      │
 ┌────▼─────────────────────────────────────────────────────────┐
 │ 5. COMPOSE   Final answer + evidence panel (📄 your docs /     │
 │    🌐 web / ⚖️ citation-verified) + confidence + a footer      │
 │    noting which models generated and which checked.           │
 └──────────────────────────────────────────────────────────────┘
```

**Why this shape.** Free models are cheap and fast but uneven; a strong,
distinct checker turns an *ensemble of drafts* into one **grounded** answer and
is the natural place to enforce the "every claim has a link" invariant. This
generator→verifier / mixture‑of‑agents pattern is well established and keeps
cost on the free tier for drafting while spending only on one checker pass.

---

## 3. Tech stack & rationale

| Layer | Choice | Why |
|-------|--------|-----|
| Frontend / chat | **Next.js (App Router)** + **Vercel AI SDK** | Streaming chat UI, server actions, file upload. |
| Hosting | **Vercel** | One-command deploy; Vercel MCP available here. |
| Database + vectors | **Supabase Postgres** + **pgvector** | One store for app data *and* embeddings (`<=>` cosine). Supabase MCP available. |
| File storage | **Supabase Storage** | In-chat uploads + cached Drive files. |
| Auth | **Supabase Auth** (Google OAuth), **single-user** | Just the owner for now; schema stays multi-user-ready. |
| **Model gateway** | **OpenRouter** | One API key → Grok, Gemini, Llama, Claude, etc. Swap/add models by config, not code. |
| Generators (free tier) | Ensemble of free models via OpenRouter | Cheap drafting; resilience via diversity. |
| Checker | **Gemini** (default) / **Claude** (paid) via OpenRouter | Strong, distinct adjudicator. |
| Embeddings | **Voyage AI** (`voyage-3` family) | High-quality retrieval; independent of the chat gateway. |
| Doc parsing | `pdf` text extraction + OCR fallback, `mammoth` (DOCX), Markdown | Model-agnostic ingestion (no reliance on a single vendor's native PDF). |

**On grounding & citations.** Because generators can be any model, grounding is
**application-level**, not vendor-specific: sources are tagged `[S1..Sn]` with
links, models cite by tag, and the checker validates each tag→claim mapping.
Anthropic's native **Citations API** is kept as an *optional* enhancement only
when the paid tier runs Claude natively — never a hard dependency.

---

## 4. Model orchestration layer

A single `ModelRouter` module, driven by config (env), so models are swappable
without code changes.

```
config (env-driven):
  TIERS:
    free:  generators = [grok, gemini-free, llama-*]   # OpenRouter slugs, 3+
           checker    = gemini
    paid:  generators = [claude-opus]                  # or claude + ensemble
           checker    = claude   (fallback gemini)
  FANOUT:   N parallel drafts on free tier (default 3; accuracy > latency)

roles:
  generator(question, sources[])      -> draft citing [S#]
  checker(question, sources[], drafts[]) -> {answer, kept/dropped claims,
                                             per-claim source, confidence}
```

- **Tier toggle** in the UI picks `free` vs `paid`. Owner keys back both; the
  toggle just changes which models the router uses.
- **Ensemble**: generators run **in parallel** (Promise.all) so a wider
  fan-out costs latency once, not N times. The checker sees all drafts at once.
- **Accuracy-first checking**: because delay is acceptable, the checker does a
  thorough claim-by-claim pass and **abstains** rather than guessing when the
  sources don't support a claim; low-support answers are labelled, not padded.
- **Escalation is user-decided** (not automatic): every answer carries a
  **confidence indicator**, and low confidence surfaces a one-click
  **"Re-run with Claude (paid)"** action. The user chooses when to spend.
- **Cost control**: per-day quotas + the ensemble living on free models keep
  steady-state cost to essentially one checker pass per question.

---

## 5. Google Drive ingestion pipeline

The corpus is a **designated Drive folder**. Two access roles:

- **Development (me, now):** the `Google_Drive` MCP lets me inspect/test during
  the build.
- **Production (the app):** a **Google service account** (read-only) on the
  shared corpus folder. The app never depends on the dev MCP.

**Ingestion job** (Supabase Edge Function / Next.js route; manual + scheduled):

```
1. List folder → files + modifiedTime            (Drive API: files.list)
2. Diff vs documents.drive_modified_at            → new / changed files
3. Download changed files                         (files.get / export)
     • Google Docs → export text/markdown
     • PDF         → extract text (OCR fallback for scans)
     • DOCX        → mammoth → text
     • MD / TXT    → as-is
4. Chunk (heading-aware, ~500–800 tokens, overlap); record page/offset
5. Embed each chunk with Voyage
6. Upsert documents + chunks; mark status 'ready'
7. Remove chunks for files deleted from the folder
```

**Sync:** admin "Sync now" button + scheduled job (Vercel Cron / Supabase),
incremental via `modifiedTime`.

---

## 6. Retrieval + generation + checking (stages 1–3)

1. **Query rewrite + jurisdiction detect** (a cheap model): expand the query;
   guess US / CA / unclear.
2. **Source gathering**:
   - **Drive RAG**: embed query (Voyage), `ORDER BY embedding <=> q`, top-k
     (start k≈8) with a similarity floor; optional hybrid full-text for exact
     terms/citations.
   - **Web search**: `WebSearch` on authoritative domains + `WebFetch` the top
     hits for snippets. Every source becomes a tagged `[S#]` item with a link.
3. **Generate**: free-tier ensemble (or paid Claude) drafts strictly from the
   `[S#]` set, citing by tag; instructed to **abstain** where sources are
   silent ("Not addressed in the provided sources").
4. **Check & consolidate**: the checker merges drafts, validates every claim
   against its cited source text, drops/flags the unsupported, and returns a
   single answer with per-claim source mapping + confidence.

In‑chat uploads are parsed and embedded into a **conversation‑scoped**
namespace so they're retrievable for that thread without touching the shared
corpus.

---

## 7. Grounding invariant (how "every claim has a link" is enforced)

1. **Source registry**: each gathered source gets `{id: "S3", type: drive|web,
   title, url, text}`. Only registry links are allowed in output.
2. **Generator contract**: answer only from `[S#]`; attach `[S#]` to each
   claim; if unsupported, say so rather than invent.
3. **Checker contract** (the enforcement point): for each claim, confirm the
   cited `[S#]` text actually supports it. Unsupported → drop or mark
   `⚠️ unverified`. No naked claims survive.
4. **Render**: UI resolves `[S#]` to clickable source cards (Drive doc / web
   URL), grouped in the evidence panel.

This makes grounding independent of any one model's features and directly
implements "answers shall always come from Google Drive or web search, with
links, verified by the checker."

---

## 8. Citation verification (stage 4) — dual jurisdiction

Extract case citations from the checked answer, then **route each** to its
provider. Results cached in `verification_cache`.

### US → CourtListener  *(free; MCP available here)*
- `analyze_citations` — verifies citations, returns real case name/date, and a
  **hallucination warning** when the cited name doesn't match the reporter.
- `search` / `read_document` — pull the opinion to confirm a proposition.

### Canada → CanLII API  *(user key)*
Designed around a real constraint:

- CanLII's public API is **metadata + citator only** — no free-text case
  search. So it verifies/enriches citations rather than discovering cases.
- Endpoints: `caseBrowse/{lang}/{db}/{caseId}` (metadata) and
  `caseCitator/...` (cited/citing → a "still good law?" signal).
- **Citation → (db, caseId)**: clean for neutral cites (`2019 SCC 65` → `csc-scc`
  / `2019scc65`); for reporter-only cites, resolve the CanLII URL via a
  `site:canlii.org` search first, then confirm via the API.

Both sit behind one `CitationVerifier` interface so new jurisdictions are new
adapters. Each cite ends up **✅ verified**, **✏️ corrected**, or
**⚠️ unverified**.

---

## 9. Data model (Supabase)

```
documents        id, source('gdrive'|'upload'), drive_file_id, title,
                 mime_type, drive_modified_at, storage_path,
                 status('pending'|'ingesting'|'ready'|'error'), created_at

chunks           id, document_id→documents, chunk_index, content,
                 token_count, embedding vector(1024), metadata jsonb
                 -- hnsw/ivfflat index on embedding

conversations    id, user_id, title, tier('free'|'paid'), created_at

messages         id, conversation_id, role, content,
                 sources        jsonb   -- the [S#] registry used
                 verifications  jsonb   -- CanLII/CourtListener results
                 generator_models jsonb -- which models drafted
                 checker_model  text
                 confidence     numeric
                 created_at

model_runs       id, message_id, role('generator'|'checker'), model,
                 latency_ms, tokens, raw_output jsonb   -- observability

verification_cache  citation_key pk, provider, result jsonb, fetched_at
```

RLS on `conversations`/`messages`/`model_runs` (per user). Corpus
(`documents`/`chunks`) is shared, read-only to users.

---

## 10. Chat UI & file upload

- Claude-style streaming chat (Vercel AI SDK), conversation history sidebar,
  markdown + inline `[S#]` citation rendering.
- **Tier toggle** (Free ⇄ Claude) in the composer.
- **Confidence indicator** on every answer (high / medium / low), driven by the
  checker's support ratio. When it's not high, a one-click
  **"Re-run with Claude (paid)"** button lets the user escalate on demand — the
  decision to spend stays with the user.
- **Evidence panel** per answer: source cards grouped 📄 your docs / 🌐 web /
  ⚖️ citation-verified, plus a small footer: "Drafted by X, Y · Checked by
  Gemini · Confidence: high".
- **File upload**: drag-drop → Supabase Storage → parse → embed into the
  conversation namespace → immediately retrievable.
- **Admin view**: corpus list, ingestion status, "Sync Drive now".

---

## 11. API surface (Next.js route handlers)

```
POST /api/chat                run the 5-stage pipeline; stream the final answer
POST /api/upload              in-chat file → parse → embed (conversation scope)
POST /api/ingest/sync         (admin) pull changes from the Drive folder
GET  /api/documents           (admin) corpus + ingestion status
POST /api/verify/citation     verify one citation (internal + debug UI)
```

---

## 12. Security, secrets, compliance

- **Owner keys** (OpenRouter, Voyage, CanLII, CourtListener, Google service
  account, Supabase service-role) live in Vercel/Supabase env — never in the
  repo. `.env.example` documents names only.
- **Quotas / rate limits** (per day) to cap cost on owner-funded keys.
- **Single-user auth** now (owner only); **RLS** on user-scoped tables keeps
  the door open to multi-user later without a migration.
- **Least-privilege Drive** — service account scoped to the one folder,
  read-only.
- **Not legal advice** — persistent disclaimer; the product surfaces sources +
  verification status, not authoritative counsel.
- **Respect provider terms** — CanLII/CourtListener/OpenRouter rate limits &
  ToS; cache aggressively; no bulk scraping.

---

## 13. Phased roadmap

| Phase | Deliverable | Key tasks |
|-------|-------------|-----------|
| **0. Scaffold** | Running skeleton | Next.js app, Supabase (MCP), Google login, empty streaming chat. |
| **1. Ingest + RAG** | Ask → grounded draft | Drive ingestion, chunk/embed to pgvector, retrieval + web-search source gathering, `[S#]` registry (stages 1–2). |
| **2. Model orchestration** | Ensemble + checker | `ModelRouter` over OpenRouter, free-tier fan-out, Gemini checker, grounding-invariant enforcement, tier toggle (stage 3, §7). |
| **3. Citation verify** | Trust layer | `CitationVerifier` + CourtListener & CanLII adapters, jurisdiction routing, evidence badges (stage 4). |
| **4. Polish + deploy** | Shippable | In-chat uploads, chat history, admin Drive-sync UI, escalation, quotas, disclaimers, deploy to Vercel. |

---

## 14. Open questions

**Resolved:**
- *Priority* → **accuracy over latency** (broader ensemble, thorough checking).
- *Escalation* → **user-decided** (confidence indicator + one-click re-run on
  Claude); no silent auto-escalation.
- *Scope* → **personal / single-user** for now; schema kept multi-user-ready.

**Still open (fine to settle at build time):**
1. **Exact model picks** — which specific free OpenRouter models make up the
   3-model fan-out (I'll propose a diverse default set at Phase 2).
2. **Corpus size** — sets the pgvector index (`ivfflat` vs `hnsw`) and whether
   ingestion needs a queue. (Roughly how many documents?)
3. **Bilingual (EN/FR)** CanLII handling; exact **CanLII key limits** (to size
   caching/rate-limiting).

---

## 15. Cost sketch (order of magnitude, per question)

- **Generation**: free-tier models → ~free (bounded by OpenRouter free limits).
- **Checker**: the main recurring cost — a single Gemini pass (or Claude on the
  paid tier).
- **Embeddings**: fractions of a cent per query/upload.
- **CourtListener** free; **CanLII** per key terms; **web search** per call.
- **One-time**: corpus embedding, scaling with corpus size.
- Caching (`verification_cache`, embedded corpus, per-user quotas) keeps
  steady-state cheap.

---

*Next step: your review. On approval I'll start at Phase 0 (scaffold + Supabase
provisioning + Google login + streaming chat).*
