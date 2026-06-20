# Approved SDS PDFs

Place only verified manufacturer SDS documents in this directory.

- Use lowercase letters, numbers, and hyphens.
- Include the revision date in the filename to prevent stale offline copies, for example `wd40-lubricant-2026-04-15.pdf`.
- Add the matching record to `data/sds-data.json`.
- Run `npm test` before deployment.
- Do not add sample, generated, redacted, or unofficial PDFs to production.

The build publishes registered `.pdf` files only. Validation fails when a PDF is missing, invalid, duplicated, or unregistered.

For batch uploads, use the review-first onboarding command from the repository root:

```powershell
npm.cmd run onboard:scan
npm.cmd run onboard:apply -- --department "Unassigned"
```

The website itself cannot rename files or write catalog metadata because GitHub Pages is static.
