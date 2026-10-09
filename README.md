# research-fact-base

A legal research assistant that answers **only from your own documents** — and
checks its own work in code before you see anything.

1. **Search** your Google Drive corpus (semantic search over embedded passages).
2. **Draft** with an ensemble of models (free models via OpenRouter, or Claude
   on the paid tier), told to use only those passages.
3. **Check** with a stronger model that consolidates the drafts and drops
   unsupported claims.
4. **Verify in code** — deterministic checks remove any sentence that:
   - cites a case, case name or statute **not found in the retrieved passages**;
   - quotes text that **doesn't appear word-for-word** in a passage;
   - tags a source that wasn't retrieved.

   Every removal is shown to you with its reason, supporting quotes are marked
   ✓ verified / ⚠ wrong source / ✗ not found, and you can open the exact
   passages the AI was given. If nothing relevant is found, it says so instead
   of answering.

No unverified text is ever displayed: you see progress steps, then the checked
answer.

> This tool provides legal information, not legal advice.

## Architecture

| Piece | Where | What |
|---|---|---|
| Website | GitHub Pages | static Next.js export: sign-in, chat, corpus page |
| API | Supabase Edge Function `research-api` | holds the keys; search → draft → check → verify |
| Data | Supabase Postgres + pgvector | documents, embedded passages |
| Ingest | GitHub Actions (daily) | loads Drive files → embeddings |

The site is public by nature but useless without signing in: the API only
answers signed-in users whose email is on the `ALLOWED_EMAILS` list.

**Setup:** [docs/DEPLOY_GITHUB_PAGES.md](./docs/DEPLOY_GITHUB_PAGES.md) ·
**Loading documents:** [docs/BACKGROUND_INGEST.md](./docs/BACKGROUND_INGEST.md)

## Layout

```
src/app/                         pages: chat (/) and corpus status (/admin)
src/components/AuthGate.tsx      email sign-in (link or code) + access check
src/components/Chat.tsx          chat UI + source-check panels
src/lib/supabase.ts              Supabase client + API helper
supabase/functions/research-api/ the backend
  index.ts                         HTTP routes, auth, streaming
  pipeline.ts                      retrieval, model ensemble, checker
  grounding.ts                     deterministic citation / quote checks
  *.test.ts                        tests (npm run test:edge)
supabase/migrations/             database schema
scripts/ingest.mjs               Drive → embeddings loader (GitHub Actions)
scripts/smoke.mjs                live check of the deployed site + API (GitHub Actions)
e2e/                             browser tests of the built site (Playwright)
```

## Development

```bash
npm install
cp .env.example .env.local   # public Supabase values are prefilled
npm run dev                  # http://localhost:3000 — talks to the deployed API
npm run test:edge            # backend tests
npm run test:types           # type-check
npm run build                # static export to out/ (set the NEXT_PUBLIC_* values
                             #   from .github/workflows/deploy-pages.yml first)
npm run test:e2e             # browser tests of out/, desktop + phone
```

Every push runs all of these, and the site is only published if they pass.
After each publish, **Live smoke test** checks the real site and API; run it
by hand (Actions → Live smoke test → Run workflow) to also ask real questions
end to end. Its Summary page shows a table of every check.

To sign in locally, add `http://localhost:3000/` to Supabase → Authentication →
URL Configuration → Redirect URLs.
