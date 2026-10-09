# Hosting: GitHub Pages + Supabase

No paid plan, no credit card, no custom domain.

```
  Browser ──► GitHub Pages                 static site: login, chat, corpus page
     │        learner-agent-sudo.github.io/research-fact-base/
     │
     └─────► Supabase Edge Function        holds the API keys; runs search → AI → checks
             research-api                  requires a signed-in user on ALLOWED_EMAILS
                  │
                  ├─► Supabase Postgres    your documents + embeddings (pgvector)
                  ├─► Gemini               embeds the question
                  └─► OpenRouter           drafting + checker models

  GitHub Actions ──► "Ingest Drive corpus" (daily) loads Drive files into Postgres
```

The website holds **no secrets** — only the Supabase URL and publishable key,
which are public by design. Every key that costs money or can read your data
lives in the edge function, and every request must come from a signed-in user
whose email is on your allowlist.

## One-time setup

### 1. Add the edge function's secrets
Supabase dashboard → project **research-fact-base** → **Edge Functions** →
**Secrets** → add:

| Name | Value |
|---|---|
| `OPENROUTER_API_KEY` | openrouter.ai → Keys |
| `GEMINI_API_KEY` | aistudio.google.com/app/apikey (same key the ingest job uses) |
| `ALLOWED_EMAILS` | the email(s) allowed to use the app, comma-separated |

`SUPABASE_URL` and the service-role key are provided to the function
automatically — don't add them.

### 2. Point sign-in links at the site
Supabase → **Authentication** → **URL Configuration**:

- **Site URL:** `https://learner-agent-sudo.github.io/research-fact-base/`
- **Redirect URLs** → add `https://learner-agent-sudo.github.io/research-fact-base/**`

Without this, the sign-in email links back to `localhost:3000` and login fails.

**Optional — sign in with a code too.** Handy when you read email on your
phone but use the app on a computer. Supabase → **Authentication** →
**Emails** → **Magic Link** template → add this line, then **Save**:

```html
<p>Or enter this code: <strong>{{ .Token }}</strong></p>
```

The sign-in page has a box for the code.

### 3. Turn on GitHub Pages
GitHub → repo **Settings** → **Pages** → **Build and deployment** →
**Source: GitHub Actions**.

### 4. Deploy the site
GitHub → **Actions** → **Deploy site to GitHub Pages** → **Run workflow**
(it also runs automatically on every push). When it finishes, open
`https://learner-agent-sudo.github.io/research-fact-base/`, enter your email,
and click the link in the email.

### 5. (Recommended) Stop strangers creating accounts
After you've signed in once: Supabase → **Authentication** → **Sign In /
Providers** → **Email** → turn off **Allow new users to sign up**. The
allowlist already blocks everyone else from the API; this also stops them
creating empty accounts.

## Checking it's healthy

GitHub → **Actions** → **Live smoke test** → **Run workflow**. It checks the
live site, sign-in service and API (secrets set, corpus loaded, strangers
refused) and asks two real questions, then shows a table of results on the
run's **Summary** page. It sends no email and changes no data. A quick version
runs automatically after every publish.

`https://zfzydmozafepouflrlxb.supabase.co/functions/v1/research-api/health`
returns which secrets are set (true/false only), e.g.
`{"ok":true,"configured":{"supabase":true,"openrouter":true,"gemini":true,"allowedEmails":true}}`.

## Sign-in troubleshooting

| What you see | Cause | Fix |
|---|---|---|
| The email link opens `localhost:3000` | Site URL not set | Step 2 above, then request a **new** link |
| "link is invalid or has expired" | Each link works once, and only the newest email's link works | Request a new link and click it once |
| "Too many sign-in emails" | Supabase's free email service sends only a few per hour | Use the newest email you have, or wait |
| "…is not on the allowed list" | The email you signed in with isn't in `ALLOWED_EMAILS` | Add it (step 1) and press **Try again** |

The link signs you in on the device where you open it. To use the app on a
computer while reading email on a phone, open the email on the computer, or
use the code (optional part of step 2).

## Updating the backend

The edge function lives in `supabase/functions/research-api/`. Run its tests
with `npm run test:edge` (they also run before every site deploy). Deploy
changes either by asking Claude (via the Supabase connector) or with the
Supabase CLI: `supabase functions deploy research-api --no-verify-jwt`.

`--no-verify-jwt` is intentional: the function does its own, stricter check
(valid session **and** allowlisted email), and the gateway's JWT check would
reject the browser's CORS preflight requests.

## Tuning (optional secrets)

| Secret | Default | Effect |
|---|---|---|
| `FREE_GENERATORS` | llama-3.3-70b, deepseek-v3, qwen-2.5-72b (`:free`) | drafting ensemble |
| `FREE_CHECKER` | llama-3.3-70b, deepseek-v3 (`:free`) | tried in order |
| `PAID_GENERATORS` / `PAID_CHECKER` | Claude Sonnet 4.5 → 4 → 3.7 | the "Claude (paid)" tier |
| `FANOUT` | `3` | drafting models per question |
| `RETRIEVAL_TOP_K` | `8` | passages searched per question |
| `MIN_SIMILARITY` | `0` (off) | drop weak matches; the app abstains if none remain |

Free OpenRouter models change often. If answers fail with a model error, check
<https://openrouter.ai/models?max_price=0> and update `FREE_*`. Note that free
OpenRouter accounts have a small daily request cap, and each question uses
`FANOUT + 1` requests.

## Limits worth knowing

- **Supabase pauses free projects after ~7 days with no activity.** The daily
  ingest job counts as activity, but GitHub disables scheduled workflows in
  public repos after 60 days without commits. If the site stops answering,
  check the project isn't paused (Supabase dashboard → Restore).
- **150-second limit per request** on Supabase's free tier. The function's
  timeouts (50s drafting, 80s checking) are set to fit inside it.
