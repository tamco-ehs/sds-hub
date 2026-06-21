# SDS Intake and EHS Review Deployment

The production intake workflow uses:

- GitHub Pages for the public catalog and administrator interface.
- Supabase Edge Functions for server-side PDF parsing and Gemini requests.
- Supabase Postgres for controlled metadata and audit history.
- A private draft GitHub Release for original uploads.
- A published GitHub Release for EHS-approved PDFs.

The existing reviewed GitHub Pages catalog remains the emergency-safe fallback if the intake service is unavailable.

## Production resources

- Supabase project: `sds-intake-hub`
- Region: Singapore (`ap-southeast-1`)
- Project reference: `jxvsxwsmfycvewxeyxmp`
- Edge Function: `sds-api`
- API base: `https://jxvsxwsmfycvewxeyxmp.supabase.co/functions/v1/sds-api`
- GitHub repository: `izzulwork1/sds-hub`
- Private intake release tag: `sds-intake-originals`
- Approved release tag: `sds-approved`

## Security model

- `GEMINI_API_KEY`, `GITHUB_TOKEN`, and the emergency-only `ADMIN_API_TOKEN` are encrypted Supabase secrets. They must never be placed in HTML, JavaScript, Git commits, screenshots, or QR codes.
- The GitHub token is fine-grained, restricted to `izzulwork1/sds-hub`, and requires only Contents read/write access.
- All controlled tables have Row Level Security enabled. Browser roles have no direct table access; the Edge Function validates the Supabase access token, loads `admin_users`, and uses the server-side service role for data access.
- Every extraction finishes in **Needs Review**, including results with very high confidence.
- Original filenames, SHA-256 hashes, private source assets, extraction logs, and review actions are retained.
- Existing approved assets are never overwritten. A filename collision must be resolved by EHS as corrected metadata or a duplicate.

## Enable Auth and create the first administrator

1. Enable Email/Password in Supabase **Authentication > Providers**.
2. Invite the first user in **Authentication > Users** and redirect to `https://izzulwork1.github.io/sds-hub/admin.html`. The invite flow opens a required password-creation dialog before the workspace.
3. Apply migrations, then add that Auth UUID in the SQL editor:

```sql
insert into public.admin_users (id, display_name, role, is_active)
values ('AUTH-USER-UUID', 'EHS Administrator', 'EHS_ADMIN', true);
```

`EHS_REVIEWER` may view/review/edit and request re-extraction. `EHS_ADMIN` additionally controls upload, approval/rejection, date correction, duplicate decisions, archive/delete, and restore.

`assets/config.js` contains only the project URL, publishable/anon key, and Edge Function URL. It must never contain a service-role key or emergency token.

## Deploy or update

Database migration must complete before the function, followed by the static frontend:

```powershell
cd "D:\AI Project\SDS Database"
npm.cmd install
npm.cmd test
npx.cmd supabase link --project-ref jxvsxwsmfycvewxeyxmp
npx.cmd supabase db push --linked
npx.cmd supabase functions deploy sds-api --project-ref jxvsxwsmfycvewxeyxmp --no-verify-jwt
npm.cmd run build
git push
```

The required function secrets are:

- `ADMIN_API_TOKEN`
- `ALLOWED_ORIGIN=https://izzulwork1.github.io`
- `GEMINI_API_KEY`
- `GEMINI_MODEL=gemini-2.5-flash`
- `GITHUB_TOKEN`
- `GITHUB_REPOSITORY=izzulwork1/sds-hub`
- `GITHUB_INTAKE_RELEASE_TAG=sds-intake-originals`
- `GITHUB_APPROVED_RELEASE_TAG=sds-approved`

Use `npx.cmd supabase secrets list --project-ref jxvsxwsmfycvewxeyxmp` to verify names and hashes without revealing secret values.

## Administrator workflow

Open `https://izzulwork1.github.io/sds-hub/admin.html` and sign in using the authorized user's email and password. The workspace remains hidden until the Edge Function confirms an active `admin_users` row. The displayed reviewer identity and audit actor come from that row, not from browser input.

The `ADMIN_API_TOKEN` is retained only for emergency API recovery and is not used or exposed by the normal browser workflow.

## ZIP intake limits

- Individual PDF: 15 MB.
- ZIP: 100 PDFs maximum; unsupported files are reported and skipped.
- Unsafe `../`, absolute, backslash traversal, or drive-letter paths reject the ZIP.
- The workflow design supports a 100 MB ceiling, but this Supabase Edge deployment safely rejects ZIP requests above 20 MB because larger synchronous decompression is not reliable in the hosted runtime. Split large collections into smaller ZIP batches.
- ZIP extraction is regex/text-first and leaves every accepted PDF in **Needs Review**. EHS can request Gemini re-extraction for an individual record.

## Acceptance test

1. Test successful login, unlisted-user blocking, inactive-user blocking, expired-session handling, and reviewer role blocking.
2. Upload a text-based SDS PDF and confirm the final status is **Needs Review**.
3. Upload a small ZIP containing PDFs, an unsupported file, and a duplicate; verify the per-file report.
4. Open the original and compare Section 1 product/trade labels with the extracted values.
5. Review every detected SDS date, validity basis/source/confidence, print-date/conflict warnings, 16-section completeness, OCR state, confidence, missing fields, and duplicate warnings.
6. Save an edit/date correction and verify the audit actor UUID, display name, role, reason, before value, and after value.
7. Approve only after EHS verification; verify reviewer-role approval is rejected.
8. Confirm the controlled filename and published GitHub Release PDF.
9. Confirm the approved item appears in the public catalog and existing static fallback/QR routes still work.
10. Bulk archive and soft-delete test records using typed confirmation/reason; confirm public removal, audit visibility, and restore.

## Rotation and recovery

- Rotate the GitHub fine-grained token before its 90-day expiry and update `GITHUB_TOKEN` in Supabase.
- Rotate `ADMIN_API_TOKEN` immediately if emergency access is used or disclosed; normal administrators do not need it.
- Delete and replace the Gemini API key if it is ever exposed.
- Supabase Free projects may pause after inactivity. This affects new intake/review work, not the existing GitHub Pages catalog or published GitHub Release PDFs.
- Maintain the physical SDS fallback required by the facility emergency plan.
