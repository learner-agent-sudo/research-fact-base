# Deploying to Vercel

The app is a standard Next.js project and deploys cleanly on Vercel. The build
succeeds without any keys (the app just shows a "configure keys" message until
env vars are set), so you can deploy first and add keys after.

## Option A — Git integration (recommended, ~3 min)

1. **Vercel dashboard → Add New → Project → Import Git Repository.**
   Select **`learner-agent-sudo/research-fact-base`**.
   (Create a *new* project — don't reuse the existing `legal-research` project,
   which is wired to a different repo/branch.)
2. **Framework**: Next.js (auto-detected). Leave build settings default.
3. **Production branch**: set to `claude/legal-research-website-jyihm4`
   (Project → Settings → Git), or merge that branch into `main` first.
4. **Add the environment variables** below (Project → Settings → Environment
   Variables), then **Deploy**.
5. After it deploys, set `APP_URL` to the assigned domain and redeploy.

Thereafter every push to the production branch auto-deploys.

## Option B — CLI deploy

If you'd rather I (or you) deploy via CLI, create a token at
<https://vercel.com/account/tokens> and run:

```bash
npm i -g vercel
vercel link          # pick the team, create a new project
vercel env add ...   # or set them in the dashboard
vercel deploy --prod
```

## Environment variables

Non-secret values for the provisioned Supabase project are filled in. Replace
every `‹set your …›` with your key. `NEXT_PUBLIC_*` are read at build time; the
rest at runtime.

| Variable | Value | Notes |
|----------|-------|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://zfzydmozafepouflrlxb.supabase.co` | provisioned |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `sb_publishable_d7HEcptiQQyJPtkWUNBTYA_Xur1u94m` | publishable, safe |
| `SUPABASE_SERVICE_ROLE_KEY` | ‹set your service_role secret› | Supabase → Settings → API |
| `OPENROUTER_API_KEY` | ‹set your key› | required for answers |
| `FREE_GENERATORS` | `meta-llama/llama-3.3-70b-instruct,google/gemini-2.0-flash-exp:free,mistralai/mistral-small-3.1-24b-instruct` | verify at openrouter.ai/models |
| `FREE_CHECKER` | `google/gemini-2.5-flash` | verify slug |
| `PAID_GENERATORS` | `anthropic/claude-3.7-sonnet` | verify slug |
| `PAID_CHECKER` | `anthropic/claude-3.7-sonnet` | verify slug |
| `FANOUT` | `3` | ensemble size |
| `VOYAGE_API_KEY` | ‹set your key› | for RAG |
| `VOYAGE_MODEL` | `voyage-law-2` | 1024-dim, matches schema |
| `TAVILY_API_KEY` | ‹set your key› | optional web-search source |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | ‹set stringified JSON› | Drive read access |
| `GDRIVE_CORPUS_FOLDER_ID` | ‹set folder id› | corpus folder |
| `CANLII_API_KEY` | ‹set your key› | Canada citation checks |
| `COURTLISTENER_API_TOKEN` | ‹set your key› | US citation checks |
| `COURTLISTENER_API_BASE` | `https://www.courtlistener.com/api/rest/v4` | default |
| `ADMIN_TOKEN` | ‹set a random secret› | **see security note** |
| `APP_URL` | ‹your vercel domain› | set after first deploy |

## Production security notes

- **Set `ADMIN_TOKEN`.** On a public URL, `/api/ingest/sync` is open unless
  `ADMIN_TOKEN` is set (it then requires header `x-admin-token`). Set it so
  strangers can't trigger ingestion.
- **`/admin` is not auth-gated yet.** The page is viewable on a public URL
  (though *syncing* needs the token). Full single-user login is Phase 4 —
  until then, treat the deployed URL as semi-private or add Vercel password
  protection (Project → Settings → Deployment Protection).
- The app shows a persistent "legal information, not legal advice" disclaimer.

## Large first ingest

`/api/ingest/sync` is capped at 60s on Vercel (Hobby). For a big first ingest of
multi-MB files, run the sync locally (`npm run dev` → `/admin` → Sync) against
the same Supabase project; Vercel then handles incremental syncs fine.
