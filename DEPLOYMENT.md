# Deployment Guide — from local to live (with AI)

> The production upload, extraction, EHS review, Supabase, and GitHub Release workflow is documented in `SDS-INTAKE-DEPLOYMENT.md`. That guide supersedes the legacy Cloudflare proxy instructions below.

This walks you all the way from the project on your PC to a public SDS site with
the optional Gemini assistant. Follow the parts **in order**. The site works fully
without AI, so Parts 1–2 already give your company a usable SDS library; Parts 3–5
add the assistant.

> **Golden security rule:** the Gemini API key must **never** appear in
> `index.html`, `assets/`, the GitHub repository, a QR code, or a screenshot. It
> lives only inside the Cloudflare proxy as an encrypted secret. If it is ever
> exposed, delete it in Google AI Studio and create a new one.

---

## Order of operations

```
Part 1: Publish the static site to GitHub Pages   (required)
Part 2: Verify it works on a phone                 (required)
Part 3: Create a Gemini API key                    (AI only)
Part 4: Deploy the Cloudflare proxy                (AI only)
Part 5: Turn AI on in the site + test             (AI only)
```

The AI proxy reads the official PDFs **from your live site**, so the site must be
public (Part 1) before the proxy can work.

---

## Part 1 — Publish the site to GitHub Pages

You need a free GitHub account: https://github.com/signup

### 1.1 Create the repository (web, easiest)

1. Go to https://github.com/new
2. Repository name: e.g. `sds-hub`. Choose **Private** or **Public** (Pages works
   on both for normal accounts).
3. Do **not** add a README/.gitignore (this project already has them).
4. Click **Create repository** and copy the URL it shows, e.g.
   `https://github.com/YOURNAME/sds-hub.git`.

### 1.2 Push this project (run in PowerShell, from the project folder)

```powershell
cd "D:\AI Project\SDS Database"
git init
git branch -M main
git add .
git commit -m "Initial SDS Hub release"
git remote add origin https://github.com/YOURNAME/sds-hub.git
git push -u origin main
```

The first `git push` opens a browser sign-in to GitHub — approve it.

> The `.gitignore` already excludes `node_modules/`, `dist/`, the review reports,
> and `worker/wrangler.toml`, so nothing sensitive or bulky is pushed.

### 1.3 Enable Pages

1. In your repo on GitHub: **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. Open the **Actions** tab and watch the **"Validate and deploy SDS Hub"**
   workflow run. It runs the tests, builds `dist/`, and publishes it.
4. When it finishes, your site URL appears in **Settings → Pages**, normally:
   `https://YOURNAME.github.io/sds-hub/`

**Write that URL down — you need it in Parts 4 and 5.**

Every future `git push` to `main` re-runs the tests and redeploys automatically.

---

## Part 2 — Verify

On a phone (not signed in to GitHub), open the site URL and check:

- Search finds a product (try "nitrogen" or "thinner").
- A product opens its official **SDS PDF**.
- A QR/deep link works: `…/sds-hub/?chemical=wd-40-aerosol-asia`.

This is your compliance-critical path. It must work even if you never add AI.

---

## Part 3 — Create a Gemini API key

1. Go to **Google AI Studio**: https://aistudio.google.com/app/apikey
2. Sign in with a Google account (ideally a dedicated company account).
3. Click **Create API key**. Copy it somewhere safe **temporarily** — you paste it
   once into Cloudflare in Part 4, then you don't need the copy.
4. Review free-tier limits and, if you expect heavy use, set up billing + budget
   alerts: https://ai.google.dev/gemini-api/docs/rate-limits

The default model in this project is `gemini-2.5-flash` (fast and low-cost).

---

## Part 4 — Deploy the Cloudflare proxy

You need a free Cloudflare account: https://dash.cloudflare.com/sign-up

### 4.1 Create your worker config

In PowerShell:

```powershell
cd "D:\AI Project\SDS Database\worker"
Copy-Item wrangler.example.toml wrangler.toml
```

Open `worker/wrangler.toml` and set the two URLs to **your** Part 1 site
(replace `YOURNAME`/`sds-hub`). Keep them exact — no trailing slash on the origin:

```toml
[vars]
ALLOWED_ORIGIN  = "https://YOURNAME.github.io"
SDS_CATALOG_URL = "https://YOURNAME.github.io/sds-hub/data/sds-data.json"
GEMINI_MODEL    = "gemini-2.5-flash"
```

> `SDS_CATALOG_URL` must end in `/data/sds-data.json`; the proxy derives the PDF
> location from it (`../pdfs/<file>`), so the path matters.

`wrangler.toml` is git-ignored on purpose — it stays on your machine.

### 4.2 Log in and add secrets

```powershell
cd "D:\AI Project\SDS Database\worker"
npx wrangler login                       # opens a browser; approve access
npx wrangler secret put GEMINI_API_KEY   # paste your Part 3 key when prompted
npx wrangler secret put RATE_LIMIT_SALT  # paste a long random string (see below)
```

Generate a random salt to paste:

```powershell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Max 256 }))
```

### 4.3 Deploy

```powershell
npm run deploy
```

Wrangler prints the deployed URL, e.g.
`https://sds-ai-proxy.YOURSUBDOMAIN.workers.dev`.
**Your assistant endpoint is that URL + `/v1/ask`.** Write it down.

---

## Part 5 — Turn AI on in the site

Two small edits in the project root, then push.

### 5.1 `assets/config.js`

```javascript
window.SDS_CONFIG = Object.freeze({
  siteName: "Digital SDS Hub",
  facilityName: "Facility safety library",
  emergencyLabel: "",
  emergencyHref: "",
  aiEnabled: true,
  aiProxyUrl: "https://sds-ai-proxy.YOURSUBDOMAIN.workers.dev/v1/ask",
  maxQuestionLength: 500
});
```

### 5.2 `index.html` — Content-Security-Policy

Find the `connect-src 'self'` part of the `Content-Security-Policy` meta tag and add
your **worker origin** (scheme + host only, no `/v1/ask`):

```text
connect-src 'self' https://sds-ai-proxy.YOURSUBDOMAIN.workers.dev
```

### 5.3 Redeploy

```powershell
cd "D:\AI Project\SDS Database"
npm test
git add assets/config.js index.html
git commit -m "Enable Gemini assistant via deployed proxy"
git push
```

### 5.4 Test the assistant (on the live site)

Open a product → the **Supplemental safety assistant** panel now appears (SDS docs
only). Verify each path:

| Test | Expected |
|---|---|
| Ask "What PPE is required?" | A grounded answer citing SDS sections |
| Ask on a product, then spam questions | Rate limit message after ~10/min |
| Block the worker (e.g. offline) | Fail-safe message; **PDF link still works** |
| Open a TDS document | No AI panel (AI is SDS-only) |

If the assistant fails, the official PDF must still open — that's by design.

---

## Cost & safety controls (do before wide rollout)

- **Google:** set a billing budget + alerts (50/90/100%); the proxy default model is
  `gemini-2.5-flash`.
- **Cloudflare:** the rate limit is in `wrangler.toml` (`limit = 10, period = 60`).
  Lower it if needed.
- **Kill switch:** to disable AI instantly, set `aiEnabled: false` in `config.js`
  and push. PDFs keep working.
- **Key rotation:** rehearse deleting the Gemini key + `npx wrangler secret put
  GEMINI_API_KEY` with a new one.

See `Production Blueprint Serverless SDS.md` §6–§8 and the release checklist (§11)
before directing workers to the system.
