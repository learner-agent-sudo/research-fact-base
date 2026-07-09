# Background ingestion (no browser needed)

The `.github/workflows/ingest.yml` GitHub Action runs the resumable
`/api/ingest/sync` endpoint in a loop, on GitHub's servers, until your whole
Google Drive corpus is embedded. It runs even with your computer off, and a
daily schedule keeps the index in sync as you add files to Drive.

## One-time setup (~5 minutes)

### 1. Add the Voyage payment method (free)
Ingestion speed is gated by Voyage's rate limit. Without a card you're throttled
to 3 requests/min. Add a card at **dashboard.voyageai.com → Billing** — you keep
the 200M free tokens (far more than your corpus needs); the card only lifts the
speed limit. Do this or the background job will crawl.

### 2. Turn on Vercel's automation bypass
The site is protected by Vercel login, so the job needs a key to get in.
- Vercel → your **research-fact-base** project → **Settings → Deployment Protection**.
- Enable **Protection Bypass for Automation**.
- **Copy the generated secret.**

### 3. Find your production URL
Vercel → project → **Domains** → copy the Production URL, e.g.
`https://research-fact-base.vercel.app`.

### 4. Add the secrets to GitHub
GitHub → `research-fact-base` repo → **Settings → Secrets and variables →
Actions → New repository secret**. Add:

| Secret name | Value |
|-------------|-------|
| `APP_URL` | your production URL from step 3 |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | the secret from step 2 |

(Optional: `ADMIN_TOKEN` — only if you also set `ADMIN_TOKEN` in Vercel env vars.)

## Run it

- **On demand:** GitHub → **Actions** tab → **Ingest Drive corpus** → **Run workflow**.
  Watch the log — it prints `remaining chunks = N` each round and ends with
  `✅ Ingestion complete.`
- **Automatically:** it also runs **daily at 06:00 UTC** to pick up any files you
  added to the Drive folder. (Edit the `cron` line in the workflow to change this.)

When it finishes, open the chat and ask a question — answers are grounded in your
documents. You can confirm progress any time on the `/admin` page (documents flip
to `ready`).

## Notes

- The job resumes automatically if a batch times out; progress is always saved.
- If a run hits the round cap without finishing (very large corpus), just run it
  again — it continues where it left off.
- The `/admin` "Sync Drive now" button still works too, if you ever want to run a
  sync from the browser.
