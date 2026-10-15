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
                  ├─► Gemini               embeds the question; fast free drafting + checking
                  └─► OpenRouter           more drafting models; paid models

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

The two API keys can instead be entered on the site's **Settings** page, which
tests them, stores them encrypted in Supabase Vault and uses them in preference
to these secrets. `ALLOWED_EMAILS` can only be set here.

### 2. Point sign-in links at the site
Supabase → **Authentication** → **URL Configuration**:

- **Site URL:** `https://learner-agent-sudo.github.io/research-fact-base/`
- **Redirect URLs** → add `https://learner-agent-sudo.github.io/research-fact-base/**`

Without this, the sign-in email links back to `localhost:3000` and login fails.

**Sign-in codes (needs your own email service).** Supabase only lets you
edit email templates once custom SMTP is set up (Authentication → Emails →
SMTP Settings). If you do that, add `<p>Or enter this code: <strong>{{ .Token }}</strong></p>`
to the **Magic Link** template, and the code box on the sign-in page will work.

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
use a sign-in code (needs custom SMTP, see step 2).

## Updating the backend

The edge function lives in `supabase/functions/research-api/`. Run its tests
with `npm run test:edge` (they also run before every site deploy). Deploy
changes either by asking Claude (via the Supabase connector) or with the
Supabase CLI: `supabase functions deploy research-api --no-verify-jwt`.

`--no-verify-jwt` is intentional: the function does its own, stricter check
(valid session **and** allowlisted email), and the gateway's JWT check would
reject the browser's CORS preflight requests.

## The Settings page

Everyone on `ALLOWED_EMAILS` can change these; they apply to all users.

- **Appearance** — light, dark or match the device (saved per browser).
- **AI and answers** — default answer mode (Free / Paid), drafting models per
  question (1–3), passages searched per question, which free models to use
  (or automatic), and the paid model.
- **API keys** — OpenRouter and Gemini keys: tested before saving, stored in
  Supabase Vault, shown only by their last four characters.
- **Account and this device** — sign out (which also deletes the saved
  conversation from that browser) or clear the saved conversation.

Settings are stored in the `app_settings` table (migration
`0003_settings.sql`), readable only by the edge function.

## Tuning (optional secrets)

Settings saved on the Settings page take precedence over these.

| Secret | Default | Effect |
|---|---|---|
| `FREE_GENERATORS` | automatic | preferred drafting models, comma-separated |
| `FREE_CHECKER` | automatic | preferred checking models, tried in order |
| `PAID_GENERATORS` / `PAID_CHECKER` | Claude Sonnet 4.5 → 4 → 3.7 | the "Claude (paid)" tier |
| `FANOUT` | `3` | drafting models per question |
| `RETRIEVAL_TOP_K` | `8` | passages searched per question |
| `MIN_SIMILARITY` | `0` (off) | drop weak matches; the app abstains if none remain |

Free answers are drafted by one of Google's Gemini models plus OpenRouter's
largest free models, and checked by Gemini Flash. Gemini is called directly
with the Gemini key the app already uses for search; its free Flash models
answer in seconds, where free OpenRouter models often take a minute or more.
If a Gemini model's free daily allowance is used up, Google refuses at once
and the next model is tried: other Gemini models, then OpenRouter's.

Free models change often, so the function reads Google's and OpenRouter's
live model lists (cached for an hour) and picks from what is available:
newest Gemini Flash to check, Flash-Lite to draft (it has the largest free
allowance), and OpenRouter's free models by size. Models chosen on the
Settings page (or by `FREE_*`) are used first while they're still free. The
paid tier likewise falls back to the newest Claude Sonnet if a configured
slug disappears. Each question uses `FANOUT + 1` requests.

On Google's free tier, Google may use what is sent to Gemini to improve its
products — the same terms that already apply to your documents' text when the
loader sends it to Gemini to make them searchable. If you turn on billing for
that Google key, these calls are billed (Flash models cost a fraction of a
cent per question).

## Limits worth knowing

- **Supabase pauses free projects after ~7 days with no activity.** The daily
  ingest job counts as activity, but GitHub disables scheduled workflows in
  public repos after 60 days without commits. If the site stops answering,
  check the project isn't paused (Supabase dashboard → Restore).
- **150-second limit per server worker** on Supabase's free tier. A worker
  starts with the first request and serves every request that arrives while
  it runs, so a question asked just after opening a page may have well under
  150 seconds left; when the time is up the worker is stopped without a word.
  So every answer works to a deadline: 2 minutes (`TIME_LIMIT_MS`, default
  `120000`) or the worker's remaining time less 8 seconds, whichever is
  sooner. Drafting may use just over half of it (at most
  `GENERATOR_TIMEOUT_MS`, 50s); once one draft is in, the others get about as
  long again (5–15s, `DRAFT_GRACE_MS`), and the rest is kept for checking. If the models still aren't done, the
  user is told it took too long and can try again or use Paid. The page
  also gives up by itself if the service goes quiet for 45 seconds (it sends
  a keep-alive every 10) or an answer passes 3 minutes, and has a Stop button.
  Each answer's stage timings (never the question) are written to the
  function's logs.
