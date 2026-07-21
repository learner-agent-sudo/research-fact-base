# Loading your documents (the "Librarian")

Ingestion runs **outside the website**, as a standalone job (`scripts/ingest.mjs`).
It reads your Google Drive folder (recursively), extracts text, chunks, embeds
with Gemini, and writes vectors to Supabase — talking to Drive and the database
**directly**. It never calls the Vercel site, so it can't affect the website's
uptime or usage. Run it two ways:

- **In the background (laptop can be off):** a GitHub Action.
- **On your own computer:** `npm run ingest`.

Either way it can run for hours, backs off when a free API rate-limits it, skips
files it can't read, and prints a **report** of what loaded / was skipped / failed.

## What it loads (curation)

It loads everything under the folder in `GDRIVE_CORPUS_FOLDER_ID`, **including
subfolders**. To control what's in the library, point that at a dedicated folder
(e.g. an **"Approved"** subfolder) and only put documents you want searchable
there. Supported: Markdown, text, PDF (text-based), DOCX, Google Docs.
**Scanned/image-only PDFs** (no extractable text) are automatically **skipped and
listed in the report** so you can decide whether to OCR them.

---

## Option A — GitHub Action (background, unattended)

### 1. Get a free Gemini key
**aistudio.google.com/app/apikey** → Create API key (no payment card needed).

### 2. Add repository secrets
GitHub → `research-fact-base` → **Settings → Secrets and variables → Actions →
New repository secret**. Add all five:

| Secret | Value |
|--------|-------|
| `SUPABASE_URL` | `https://zfzydmozafepouflrlxb.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API → `service_role` |
| `GEMINI_API_KEY` | the key from step 1 |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | the whole service-account JSON file |
| `GDRIVE_CORPUS_FOLDER_ID` | the Drive folder id to load |

*(No Vercel bypass secret is needed anymore — the job doesn't touch Vercel.)*

### 3. Run it
GitHub → **Actions → Ingest Drive corpus → Run workflow.** Watch the log: it prints
each file as it embeds and ends with an **INGEST REPORT**. Files flip to `ready`
in the app's `/admin` page as they finish.

*(A weekly schedule is included but commented out in the workflow — safe to enable
whenever you like, since it never touches Vercel.)*

---

## Option B — Run locally

```bash
# in the project folder, with the same values in .env.local:
#   SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY,
#   GEMINI_API_KEY, GOOGLE_SERVICE_ACCOUNT_JSON, GDRIVE_CORPUS_FOLDER_ID
npm install
node --env-file=.env.local scripts/ingest.mjs    # Node 20+
```

Your computer must stay on while it runs, but there are no cloud limits.

---

## Notes

- **Re-runs are cheap:** unchanged files (same Drive modified-time, already
  `ready`) are skipped, so running again only processes new/changed files.
- **Switching embedding provider** invalidates old vectors (different math). If
  you ever switch, reset first in the Supabase SQL editor:
  `UPDATE chunks SET embedding = NULL;` then re-run ingest.
- The website (`/admin` "Sync") still does small top-ups, but bulk loading should
  go through this job so the site stays light.
