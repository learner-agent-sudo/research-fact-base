# Hosting on Render (free)

Vercel's Hobby plan paused this project after the ingestion work exceeded the
4h/month "Fluid Active CPU" allowance, and the pause did not lift when usage
reset — Vercel only offers "Upgrade to resume service." Render is the
closest free equivalent: connect the GitHub repo, it builds and runs.

Render runs the app as a plain Node server (`next start`), so **no code changes
or platform adapters are needed**. Ingestion does not run here (it lives in
`scripts/ingest.mjs` via GitHub Actions), so this service stays light.

## Setup (~10 minutes)

1. Go to **render.com** → sign in with GitHub.
2. **New → Blueprint** → pick `learner-agent-sudo/research-fact-base`.
   Render reads `render.yaml` and proposes a free web service. Click **Apply**.
   *(If you'd rather not use the blueprint: **New → Web Service**, pick the repo,
   set Build = `npm ci && npm run build`, Start = `npm start`, Plan = Free.)*
3. Render prompts for the environment variables. Fill in at minimum:

   | Variable | Value |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | `https://zfzydmozafepouflrlxb.supabase.co` |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the publishable key |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API → `service_role` |
   | `OPENROUTER_API_KEY` | openrouter.ai → Keys |
   | `GEMINI_API_KEY` | aistudio.google.com/app/apikey |

   Optional: `TAVILY_API_KEY` (web search), `CANLII_API_KEY`,
   `COURTLISTENER_API_TOKEN`, `ADMIN_TOKEN`.

4. Wait for the first build (~3–5 min). You get a URL like
   `https://research-fact-base.onrender.com`.

## What to expect on the free plan

- **Cold starts.** The service sleeps after ~15 minutes of inactivity; the next
  visit takes ~30–60 seconds to wake, then it's normal speed. For a personal
  research tool this is usually an acceptable trade for $0.
- **750 instance-hours/month**, which is ample for one user.
- Pushing to the branch redeploys automatically, same as Vercel did.

## Note on `NEXT_PUBLIC_*`

Those two are baked in at build time. If you change them later, trigger a
**Manual Deploy → Clear build cache & deploy** so the new values are compiled in.
