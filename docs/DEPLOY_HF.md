# Hosting on Hugging Face Spaces (free, no credit card)

Vercel paused the account and only offers a paid upgrade; Render requires card
verification. Hugging Face Spaces needs **no payment card at all**, and a
**private** Space is visible only to your own HF account — which also gives the
site the login protection it otherwise lacks.

The app runs **as-is** in Docker (`Dockerfile`), so nothing was ported or
rewritten. A GitHub Action (`.github/workflows/deploy-hf.yml`) mirrors this repo
into the Space on every push, and the Space rebuilds automatically.

---

## What you need to do (~10 minutes, one time)

### 1. Create the Space
- Go to **huggingface.co/new-space** (sign up first at huggingface.co/join if needed — free, no card).
- **Space name:** `research-fact-base`
- **Select the SDK:** **Docker** → **Blank**
- **Visibility:** **Private** ← recommended, so only you can open it
- **Create Space**

Leave it empty; the GitHub Action fills it in.

### 2. Create a Hugging Face access token
- **huggingface.co/settings/tokens** → **Create new token**
- Token type: **Write**
- Copy it (you only see it once).

### 3. Add two secrets to GitHub
**github.com/learner-agent-sudo/research-fact-base/settings/secrets/actions** →
**New repository secret**:

| Secret | Value |
|---|---|
| `HF_TOKEN` | the Write token from step 2 |
| `HF_SPACE` | `your-hf-username/research-fact-base` |

### 4. Add the app's keys to the Space
Open your Space → **Settings** → **Variables and secrets** → **New secret**
(these are the app's runtime keys — the same ones Vercel had):

| Secret | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://zfzydmozafepouflrlxb.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `sb_publishable_d7HEcptiQQyJPtkWUNBTYA_Xur1u94m` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API → `service_role` |
| `OPENROUTER_API_KEY` | openrouter.ai → Keys |
| `GEMINI_API_KEY` | aistudio.google.com/app/apikey |

Optional: `TAVILY_API_KEY`, `CANLII_API_KEY`, `COURTLISTENER_API_TOKEN`.

### 5. Deploy
GitHub → **Actions** → **Deploy to Hugging Face Space** → **Run workflow**.

It mirrors the repo into the Space; the Space then builds the Docker image
(~3–5 min — watch the **Logs** tab on the Space) and starts the app.

After this, **every push deploys automatically**.

---

## Notes

- **Sleeping:** free Spaces pause after ~48h of inactivity and wake on your next
  visit. No data is lost — the corpus lives in Supabase.
- **Restarting / rebuilding:** Space → **Settings** → *Factory rebuild* forces a
  clean image build if a deploy ever looks stale.
- **Changing keys:** edit them under Variables and secrets, then **Restart** the
  Space. No redeploy needed (they are read at runtime).
- **Ingestion is unaffected.** Loading documents runs in GitHub Actions
  (`scripts/ingest.mjs`), never on the web host — that separation is what keeps
  the site inside any free tier's limits.
