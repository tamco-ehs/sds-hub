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

- `GEMINI_API_KEY`, `GITHUB_TOKEN`, and `ADMIN_API_TOKEN` are encrypted Supabase secrets. They must never be placed in HTML, JavaScript, Git commits, screenshots, or QR codes.
- The GitHub token is fine-grained, restricted to `izzulwork1/sds-hub`, and requires only Contents read/write access.
- All three database tables have Row Level Security enabled. Browser roles have no direct table access; the Edge Function uses the service role.
- Every extraction finishes in **Needs Review**, including results with very high confidence.
- Original filenames, SHA-256 hashes, private source assets, extraction logs, and review actions are retained.
- Existing approved assets are never overwritten. A filename collision must be resolved by EHS as corrected metadata or a duplicate.

## Deploy or update

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

Open `https://izzulwork1.github.io/sds-hub/admin.html` and enter:

- API URL: the production API base above (normally preconfigured).
- Reviewer name: the EHS reviewer responsible for the action.
- Admin token: `SDS Hub Admin Token` from the facility password manager.

The token is kept in browser session storage and disappears when that tab/session is closed.

## Acceptance test

1. Upload a text-based SDS PDF.
2. Confirm the final status is **Needs Review**.
3. Open the original and compare Section 1 product/trade labels with the extracted values.
4. Review SDS validity, OCR status, Gemini usage, confidence, missing fields, and duplicate warnings.
5. Save an edit and verify the audit timeline contains the reviewer and action.
6. Approve only after EHS verification.
7. Confirm the controlled filename and published GitHub Release PDF.
8. Confirm the approved item is merged with the existing static catalog on the public site.
9. Upload the same file again and confirm it is marked as a possible duplicate.
10. Confirm an approved record cannot be overwritten silently.

## Rotation and recovery

- Rotate the GitHub fine-grained token before its 90-day expiry and update `GITHUB_TOKEN` in Supabase.
- Rotate `ADMIN_API_TOKEN` immediately if it is shared outside authorized EHS staff.
- Delete and replace the Gemini API key if it is ever exposed.
- Supabase Free projects may pause after inactivity. This affects new intake/review work, not the existing GitHub Pages catalog or published GitHub Release PDFs.
- Maintain the physical SDS fallback required by the facility emergency plan.
