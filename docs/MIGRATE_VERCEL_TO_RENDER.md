# Migrating all projects from Vercel to Render

Vercel paused the **whole account** (`learner-agent-sudos-projects`) after the
monthly "Fluid Active CPU" allowance was exceeded. Every project reports
`live: false` and serves `402 DEPLOYMENT_DISABLED`, and the pause did **not**
lift when usage reset — Vercel's only offered path is a paid upgrade. So all
projects need a new home.

## Your paused projects

Verified via the Vercel API — all seven are down:

| Vercel project | Framework | Render service type |
|---|---|---|
| `research-fact-base` | Next.js | Web Service |
| `imm-channel` | Next.js | Web Service |
| `etf-analysis` | (none detected — likely static) | **Static Site** |
| `match-reg` | Next.js | Web Service |
| `legal-research` | Next.js | Web Service |
| `playbook` | Next.js | Web Service |
| `learning-mn-a` | Next.js | Web Service |

## Step 0 — Create the Render account (once)

Go to **render.com → Get Started → Sign in with GitHub**. Free, no credit card.
Signing in with GitHub also authorizes Render to see your repos, so every
project below can be connected without extra setup. Grant access to **all
repositories** (or at least the seven above) when prompted.

## Step 1 — `research-fact-base` (config already prepared)

A `render.yaml` blueprint is already committed, so this one is near-automatic:

1. Render → **New → Blueprint** → select `learner-agent-sudo/research-fact-base`
2. **Apply** — it reads `render.yaml` (free plan, Node 22, correct commands)
3. Fill in the prompted env vars (see `docs/DEPLOY_RENDER.md` for the list)

## Step 2 — the other six (dashboard only, no code changes needed)

**You do not need a `render.yaml`, and you do not need a separate Claude session
per project.** Render can deploy any repo straight from its dashboard:

1. Render → **New → Web Service** (or **Static Site** for `etf-analysis`)
2. Pick the repository
3. **Set the branch** ⚠️ — see the warning below
4. Settings:
   - **Build command:** `npm ci && npm run build`
   - **Start command:** `npm start`
   - **Plan:** Free
   - **Environment variable:** add `NODE_VERSION` = `22`
5. Add that project's environment variables (copy them from the Vercel project's
   Settings → Environment Variables while you still can — or from your own notes;
   Vercel hides secret values once saved, so secrets may need re-fetching from
   their source)
6. **Create Web Service** → wait for the build

Repeat per project. Roughly 5 minutes each.

### ⚠️ Set the branch — this will bite you otherwise

Every one of these projects was deployed from a `claude/…` feature branch, not
`main`. Render defaults to the repo's **default branch**. If the default branch
is empty or stale, you'll deploy the wrong thing (or nothing).

For each project, either:
- set **Branch** to the `claude/…` branch the Vercel deployment used, **or**
- merge that branch into `main` first and deploy `main`.

You can find the branch in the Vercel project's git-branch domain, e.g.
`match-reg-git-claude-focuse-…` → the branch starts with `claude/focuse…`.

## What to expect on Render's free tier

- **Web Services sleep** after ~15 minutes of inactivity; the next request takes
  ~30–60 seconds to wake, then runs at normal speed. 750 instance-hours/month.
- **Static Sites do not sleep** and are genuinely free/instant — so if any of
  these projects is purely static, prefer Static Site.
- Pushes to the configured branch auto-deploy, same as Vercel.

## Don't delete anything on Vercel yet

Keep the Vercel projects until each Render service is confirmed working — the
dashboards still hold your environment-variable *names* (and non-secret values),
which is a useful checklist while migrating.
