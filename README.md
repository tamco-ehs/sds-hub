# Digital SDS Hub

A production-oriented Safety Data Sheet catalog for GitHub Pages. The static application keeps the manufacturer's approved PDF as the primary source, works on phones and desktops, supports stable QR-code routes, and can store verified PDFs for deliberate offline use. Supabase provides the controlled upload, extraction, EHS review, audit, and approval API; GitHub Releases retain original and approved PDFs without exposing Gemini credentials to browsers.

## What is included

- Accessible, responsive SDS search and department filtering
- Stable `?chemical=<id>` and `?dept=<department>` QR routes
- Defensive catalog validation and safe DOM rendering
- Explicit, signature-checked offline PDF storage
- Network-first service worker behavior for safety-critical data and PDFs
- Content Security Policy with AI disabled by default
- Supabase Edge Function for server-side intake and structured Gemini extraction
- Supabase Auth email/password admin intake at `admin.html`, with `EHS_ADMIN` / `EHS_REVIEWER` authorization
- Actor-based Postgres audit history, soft archive/delete/restore, and GitHub Release asset storage
- Single-PDF and controlled ZIP batch intake (up to 100 PDFs; every publication still requires controlled approval)
- Rule-first PDF extraction with risk-based review categories and selective Gemini JSON verification
- EHS approval, duplicate handling, and controlled approved filename generation
- Automated tests, catalog/PDF validation, production build, and GitHub Pages deployment workflow

## Local verification

Node.js 20 or newer is required for validation and tests. The public catalog has no runtime package dependency; the admin page loads the pinned official Supabase JavaScript client for Auth.

```powershell
npm test
npm run build
python -m http.server 4173 -d dist
```

Then open `http://localhost:4173/`. Do not test through `file://`; service workers, JSON loading, and offline storage require HTTP or HTTPS.

## Add an approved SDS

1. Obtain the current SDS from the manufacturer or approved supplier.
2. Verify product identity, language, revision date, and completeness.
3. Save it under `/pdfs/` with a versioned filename such as `wd40-lubricant-2026-04-15.pdf`.
4. Add a record to `data/sds-data.json`:

```json
{
  "id": "wd-40-lubricant",
  "name": "WD-40 Lubricant",
  "file": "wd40-lubricant-2026-04-15.pdf",
  "department": "Maintenance",
  "revisionDate": "2026-04-15",
  "manufacturer": "Manufacturer name from SDS",
  "productCode": "Product identifier from SDS",
  "location": "Approved work area",
  "language": "English",
  "hazards": ["Hazard tag verified from SDS"]
}
```

5. Update the catalog-level `updatedAt` date.
6. Run `npm test` and `npm run validate:release`.
7. Complete a second-person content review before merging.

## Batch onboarding without Codex

The public website does not parse or rename uploads. GitHub Pages is static and cannot write files back to the repository. Instead, the included administrator command performs local, reviewable onboarding.

Install its PDF-reading dependencies once:

```powershell
python -m pip install -r scripts/requirements-admin.txt
```

For scanned or image-only PDFs, also install the Tesseract OCR application and ensure the `tesseract` executable is available on `PATH`. Text-based PDFs work without Tesseract. The scanner prioritizes labelled Section 1 fields such as `Product name`, `Trade Name`, `Product identifier`, and `Material name`; filenames are only a fallback.

Copy new PDFs into `/pdfs/`, then scan without changing anything:

```powershell
npm.cmd run onboard:scan
```

Review `data/onboarding-report.json`. It contains the proposed product names, safe filenames, extracted revision dates, document types, and duplicate list. When the proposals are acceptable, apply them:

```powershell
npm.cmd run onboard:apply -- --department "Unassigned"
npm.cmd test
npm.cmd run validate:release
npm.cmd run build
```

The onboarding command never deletes PDFs. Exact duplicate copies are moved to `pdfs/archive/duplicates/`. Documents that cannot be named are moved to `pdfs/incoming-review/`. Filename-derived names, missing revision dates, `Unassigned` departments, TDS files, and documents labelled `Unverified` require human review before facility release.

Validation rejects unsafe IDs and paths, duplicate IDs/files, unknown fields, missing PDFs, non-PDF file signatures, and unregistered PDF files.

## Enrich missing metadata from existing PDFs

`onboard:scan` only inspects new files. To recover missing revision dates and
manufacturers from already-registered documents (using the PDF text layer and,
for scanned pages, OCR), run the enrichment scanner:

```powershell
npm.cmd run enrich:scan
```

Review `data/enrichment-report.json`. Each date proposal records the exact source
text and a confidence level. `enrich:apply` fills **only empty fields** and **only
high-confidence proposals** (revision dates from a clear revision/issue label, plus
manufacturers). It never overwrites a value a person already set, never auto-applies
an ambiguous `DD/MM` date, and never edits hazards or product names.

```powershell
npm.cmd run enrich:apply
npm.cmd test
```

Low-confidence date proposals (ambiguous `DD/MM` ordering, month-only dates) remain
in the report for a person to confirm and enter manually. The OCR fallback requires
the Tesseract application; the scanner locates it automatically in the standard
Windows install path, so no `PATH` change is needed after installing it.

## GitHub Actions bulk SDS pre-screen

The **Bulk SDS pre-screen** workflow scans root-level `/pdfs/*.pdf` files on a GitHub-hosted Ubuntu runner, so the full scan does not depend on an administrator's PC. It is rule-first: native PDF text, bounded Tesseract OCR, labelled-field regex, section detection, hashing, duplicate checks, date checks, confidence scoring, and risk rules all run before Gemini is considered.

Run it manually:

1. Open the repository's **Actions** tab.
2. Select **Bulk SDS pre-screen**.
3. Choose **Run workflow**.
4. Keep `selective` for normal use. Use `off` for rules/OCR only, and reserve `all` for deliberate troubleshooting.
5. Leave the default AI call ceiling at 25 unless a controlled batch needs a different limit. Enable **force rescan** only when scanner rules changed or a cached result must be rebuilt.

The completed run uploads a 30-day artifact named `bulk-sds-prescreen-<run number>` containing:

- `bulk-prescreen-report.json` — per-file fields, confidence, risk, sources, and short evidence
- `bulk-review-queue.json` — records grouped by review decision
- `bulk-ai-verification-log.json` — advisory AI usage/results without prompts or secrets
- `bulk-scan-summary.json` — scanned, cached, OCR, AI, review-category, and error totals

No full extracted SDS text is written to these reports. The cache is keyed by SHA-256, so unchanged files reuse their prior rule/AI result. OCR defaults to three pages, evidence sent to Gemini is capped, Gemini output is small structured JSON, and `AI_MAX_CALLS` defaults to 25. Missing keys, quota errors, timeouts, and provider failures do not fail the scan.

To enable selective verification, create the secret in **Repository Settings > Secrets and variables > Actions > New repository secret** with the exact name `GEMINI_API_KEY`. Never add it to `assets/config.js`, workflow YAML, JSON reports, screenshots, or a commit. The workflow's repository permission is read-only and it never edits the approved catalog or PDFs.

Review routing is advisory and never approves a document:

- **Existing Unchanged** — same approved/hash-backed record with no new conflict; no repeat metadata review
- **Prescreen Passed** — confidence at least 85, strong native text, identity/company plus Sections 2 and 8 present, low/medium risk, no conflict; approval-only confirmation
- **Quick Check Required** — moderate confidence or a limited ambiguity with critical fields present
- **Full Review Required** — high risk, confidence below 70, missing identity/company/Section 2/Section 8, revision/duplicate/AI conflict, or unclear type
- **OCR Review Required** — scanned/image-only content needs visual confirmation against the manufacturer PDF
- **Not SDS / Replace File** and **Error - Needs Review** — wrong/unreadable/corrupt material

The scanner may propose enrichment for an empty manufacturer, revision date, or product code on an existing approved catalog row when evidence is clear and confidence is high. It never applies that proposal, overwrites manually verified data, changes hazards/department/location/name/status, renames approved files, deletes PDFs, or adds a new PDF to the public catalog. The manufacturer SDS remains the source of truth.

Limits: OCR is intentionally page-bounded for runner cost, handwriting and poor scans can remain uncertain, the Actions cache may be evicted, and hash reuse proves unchanged bytes—not that an older SDS is still current. EHS must still review high-risk, OCR, changed, unclear, duplicate, conflicting, and incomplete documents. All public publication continues through the existing authenticated approval route.

## Configure the public site

Edit `assets/config.js`. This file is public and must never contain credentials.

```javascript
window.SDS_CONFIG = Object.freeze({
  siteName: "Digital SDS Hub",
  facilityName: "Example Facility",
  emergencyLabel: "Open emergency guidance",
  emergencyHref: "https://example.org/emergency",
  aiEnabled: false,
  aiProxyUrl: "",
  supabaseUrl: "https://your-project.supabase.co",
  supabaseAnonKey: "sb_publishable_...",
  adminApiUrl: "",
  catalogApiUrl: "",
  maxQuestionLength: 500
});
```

For the production intake backend, follow [SDS-INTAKE-DEPLOYMENT.md](SDS-INTAKE-DEPLOYMENT.md). The legacy local onboarding commands remain available for an offline administrator workflow.

Only the Supabase publishable/anon key belongs in `assets/config.js`; it is intentionally public and is limited by Auth/RLS. Never place a service-role key, `ADMIN_API_TOKEN`, Gemini key, or GitHub token in frontend files.

## Supabase Auth and EHS roles

1. In Supabase **Authentication > Providers**, enable Email/Password.
2. Apply the database migrations before deploying the updated function.
3. Invite the first user in **Authentication > Users** with the redirect URL set to `https://tamco-ehs.github.io/sds-hub/admin.html`. The admin page will ask the invited user to create a password of at least 12 characters.
4. Copy that user's UUID and register the first active administrator in the SQL editor:

```sql
insert into public.admin_users (id, display_name, role, is_active)
values ('AUTH-USER-UUID', 'EHS Administrator', 'EHS_ADMIN', true);
```

Use `EHS_REVIEWER` for staff who may review/edit/request re-extraction but must not upload, approve, reject, archive, delete, restore, mark duplicates, or correct validity dates. Deactivating `admin_users.is_active` blocks the account without deleting its audit identity.

The browser sends the user's short-lived Supabase access token to the Edge Function. The backend validates the token and reloads the role for every request. Reviewer identity is never accepted from free-text browser input.

## Controlled intake and deletion

- A single PDF is limited to 15 MB.
- ZIP intake processes PDF entries only, rejects unsafe paths and oversized entries, hashes every PDF, and creates review-queue records without auto-approval.
- The logical design ceiling is 100 MB / 100 PDFs, but the current Supabase Edge runtime is deliberately capped at **20 MB per ZIP request** to avoid gateway/memory failures. Split larger batches.
- Bulk archive/delete is `EHS_ADMIN` only and requires a typed confirmation plus reason. Delete is soft-delete: original and approved release assets are not physically purged.
- Deleted/archived records are removed from the dynamic public catalog, search, and QR resolution. Administrators can filter them in Master Register and restore them for audit recovery.

## Deployment order

Deploy in this order so the function never references missing role/audit columns:

```powershell
npx.cmd supabase db push --linked
npx.cmd supabase functions deploy sds-api --project-ref jxvsxwsmfycvewxeyxmp --no-verify-jwt
npm.cmd test
npm.cmd run build
git push
```

Then test: authorized login, unlisted/inactive/role blocking, single PDF, ZIP batch, review/edit/re-extraction, approval, public catalog/QR link, bulk archive/delete, and restore.

If `emergencyHref` contains internal or sensitive information, do not publish it through a public GitHub Pages repository.

## Deploy the static site

1. Create a GitHub repository and use `main` as the protected release branch.
2. In **Settings > Pages**, set **Source** to **GitHub Actions**.
3. Push the reviewed change to `main`.
4. Confirm the **Validate and deploy SDS Hub** workflow succeeds.
5. Test the live site, each changed PDF, representative QR routes, and the offline procedure on a worker device.

The workflow publishes only `dist/`; development scripts, the blueprint, and the optional proxy source are excluded from the public Pages artifact.

## Optional Gemini proxy

AI is deliberately disabled in the static application. A production browser must never receive the Gemini credential.

The reference proxy under `worker/`:

- allows only configured site origins;
- validates the chemical ID against the live approved catalog;
- fetches and verifies the selected official PDF itself;
- supplies that PDF to Gemini as the only safety source;
- applies Cloudflare's rate-limit binding;
- hashes the client IP before using it as a rate-limit key;
- limits request and PDF size, model output, and upstream duration; and
- returns safe, non-cached errors without exposing credentials or provider responses.

### Proxy deployment

1. Copy `worker/wrangler.example.toml` to `worker/wrangler.toml`.
2. Set the exact `ALLOWED_ORIGIN` and `SDS_CATALOG_URL` values.
3. From `worker/`, install the pinned project dependencies and add secrets:

```powershell
npm install
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put RATE_LIMIT_SALT
npm run deploy
```

Use a long random value for `RATE_LIMIT_SALT`. Never store either secret in a file or repository.

4. Set `aiEnabled: true` and `aiProxyUrl` to the deployed `https://.../v1/ask` endpoint in `assets/config.js`.
5. In `index.html`, add only the proxy's exact origin to the `connect-src` directive. For example:

```text
connect-src 'self' https://sds-ai-proxy.example.workers.dev
```

6. Re-run the full test/build/deploy process. Test success, quota rejection, timeout, invalid chemical ID, invalid PDF, and upstream failure.

AI responses remain supplemental. The user interface always retains the official SDS link and shows a fail-safe message when AI is unavailable.

## Release gate

Before posting QR codes or directing workers to the system:

```powershell
npm run validate:release
```

Then complete the acceptance checklist in `Production Blueprint Serverless SDS.md`. A successful software build does not replace the facility safety manager's content approval or the tested emergency-access fallback.
