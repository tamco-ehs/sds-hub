# Production Blueprint: Serverless Digital SDS Hub

> **Internal guidance note**  
> **Purpose:** Operational guidance for deploying, managing, and maintaining a serverless Safety Data Sheet (SDS) station.  
> **Audience:** System administrators, facility safety managers, and developers.  
> **Last reviewed:** 20 June 2026.

## 1. Core operating principles

The hub's primary function is to give workers immediate access to the manufacturer's official SDS PDF. Search, filtering, QR routing, and optional AI assistance are secondary conveniences and must never obstruct access to the PDF.

- **Static core:** GitHub Pages serves HTML, CSS, JavaScript, data, and PDF files. There is no continuously running application server to restart or wake from an idle state.
- **Client-side search:** Each user's browser performs search, filtering, and routing, which keeps routine traffic away from a shared application server.
- **Low operational overhead:** Chemical metadata can be maintained in one version-controlled data file, preferably `data/sds-data.js` or `data/sds-data.json`.
- **Authoritative source:** The manufacturer's current SDS PDF is the legal and operational reference. AI output is supplemental and must be labelled as such.
- **Resilient, not infallible:** GitHub Pages and internet connections can fail. Do not describe the service as "always online," "unlimited," or guaranteed to deploy within a fixed number of seconds.

### Production security decision

**Do not put a Gemini API key in `index.html`, browser JavaScript, a public repository, or a QR code.** A referrer restriction reduces misuse but does not make a browser-delivered key secret. Google's current guidance says not to expose Gemini API keys client-side in production and recommends a backend proxy for client applications.

The SDS library may remain fully static. If AI assistance is required, add a small managed serverless proxy that stores the credential outside the browser. If no proxy is approved, omit the AI feature from production.

## 2. Reference architecture

```text
[ QR code or bookmark ]
           |
           v
[ GitHub Pages static site ] -----> [ Official SDS PDFs ]
           |
           +---- HTML / CSS / JavaScript / SDS metadata
           |
           +---- Optional question
                       |
                       v
              [ Managed serverless proxy ]
              - holds the API credential
              - validates origin and input
              - applies rate limits and timeouts
                       |
                       v
                   [ Gemini API ]
```

The static site must continue to provide SDS search and PDF access when the AI proxy is unavailable.

## 3. Recommended repository structure

```text
sds-station/
|-- index.html
|-- assets/
|   |-- app.js
|   `-- styles.css
|-- data/
|   `-- sds-data.js
|-- pdfs/
|   |-- acetone.pdf
|   |-- isopropyl-alcohol.pdf
|   `-- wd40-lubricant.pdf
`-- README.md
```

Keep application logic, metadata, and PDFs separate. This makes review easier and avoids editing a large `index.html` file for every chemical change.

### Metadata record

Use a stable, URL-safe identifier for routing. Do not use the display name as the permanent identifier because names may change.

```javascript
{
  id: "wd-40-lubricant",
  name: "WD-40 Lubricant",
  file: "wd40-lubricant.pdf",
  department: "Maintenance",
  revisionDate: "2026-04-15"
}
```

Recommended required fields are `id`, `name`, `file`, `department`, and `revisionDate`. Optional fields may include manufacturer, product code, language, location, and hazard tags.

## 4. Data onboarding: adding or replacing a chemical

When a new chemical arrives, the facility safety owner must complete the following workflow.

1. **Validate the source.** Obtain the SDS from the manufacturer or an approved supplier. Confirm the product name, product code, manufacturer, language, and revision date.
2. **Check for an existing record.** Determine whether this is a new product, a replacement revision, or an alternate trade name. Avoid duplicate records that point to different revisions without explanation.
3. **Standardize the filename.** Use lowercase ASCII letters, numbers, and hyphens, followed by `.pdf`. Include the SDS revision date so offline caches cannot confuse revisions; for example, `wd40-lubricant-2026-04-15.pdf`. Do not use spaces, `#`, `%`, query characters, or confidential information.
4. **Store the PDF.** Copy the approved file into `/pdfs/`. Open the repository copy and verify that it is readable, complete, and the expected product.
5. **Update the metadata.** Add or amend the corresponding record in `data/sds-data.js`. The `file` value is only the filename, not the `/pdfs/` prefix.
6. **Validate locally.** Confirm search, department filtering, direct PDF opening, keyboard navigation, and the chemical's QR route. Check for broken links and duplicate IDs.
7. **Review the change.** A second authorized person should compare the metadata and PDF against the source before release.
8. **Commit and deploy.** Use a descriptive commit message, push the approved change, and wait for the GitHub Pages deployment to complete.
9. **Verify production.** Open the live site on a phone without an administrator session, search for the product, open the PDF, and test its QR code.
10. **Update backups.** Refresh any managed offline copy or printed binder required by the site's emergency-access plan.

Never delete a superseded SDS until the organization's records-retention owner confirms the applicable retention requirement. Keep revision history in version control or an approved document-management system.

## 5. GitHub Pages deployment

1. Push the approved site and PDFs to the designated repository.
2. In **Repository settings > Pages**, select the approved deployment source, normally GitHub Actions or a protected branch.
3. Require review for changes to SDS metadata, PDF files, deployment configuration, and any serverless proxy.
4. Enable HTTPS and configure the custom domain, if used, according to the organization's domain policy.
5. Verify the reported deployment status before announcing the update.

GitHub Pages URLs normally take one of these forms:

```text
User or organization site: https://<owner>.github.io/
Project site:              https://<owner>.github.io/<repository>/
```

`https://github.io*` is not the deployment address and must not be used as a security restriction. Deployment duration varies; verify completion rather than promising a 30-to-60-second publication time.

## 6. Security governance

### 6.1 Static site

- Treat every file in a public Pages repository as public information.
- Store no API keys, passwords, tokens, personal data, internal emergency plans, or confidential location details in the repository.
- Use dependency versions from trusted sources and review third-party browser scripts before release.
- Prefer locally hosted, pinned application assets over unversioned CDN imports.
- Add a restrictive Content Security Policy where practical and avoid unsafe inline JavaScript.
- Display AI responses as untrusted text; never inject model output with `innerHTML`.
- Keep the official PDF button visible and usable without JavaScript where practical.

### 6.2 Optional AI proxy

The proxy must:

- store credentials in the platform's secret manager or encrypted environment configuration;
- accept requests only over HTTPS;
- allow only the production site origin through a narrowly configured CORS policy;
- validate the chemical ID against an approved allow-list;
- cap question length and reject unexpected fields;
- apply request-rate, concurrency, payload-size, and response-size limits;
- enforce short upstream and total timeouts;
- return a safe failure message without exposing stack traces, credentials, or provider responses;
- log operational metadata without storing employee questions longer than necessary; and
- keep AI failure independent from PDF access.

CORS and origin checks are abuse controls, not user authentication. If individual accountability is required, place the site and proxy behind the organization's identity provider.

### 6.3 Gemini credential handling

Follow the current [Gemini API key guidance](https://ai.google.dev/gemini-api/docs/api-key), because Google's key types and restriction workflow can change.

- Create a dedicated project and credential for this application.
- Use Google AI Studio's current Gemini-specific key restriction workflow where applicable.
- Do not rely on the obsolete instruction to expose a key in the browser and select the Generative Language API in a generic Cloud Console restriction.
- Monitor usage and rotate the credential immediately if it appears in source control, browser code, logs, screenshots, or support messages.
- Test credential rotation and proxy rollback before go-live.

## 7. Budget and quota controls

A billing budget is an alerting mechanism, not a guaranteed spending cap. Configure alerts at multiple thresholds - for example, 50%, 90%, and 100% of the approved monthly budget - and route them to an actively monitored mailbox.

Use layered controls:

1. **Provider limits:** Configure the supported project-level Gemini limits for the selected model and billing tier.
2. **Proxy limits:** Enforce the facility's per-client or per-session limit at the proxy, such as 5 to 10 questions per minute. A static site alone cannot reliably enforce this limit because client-side controls can be bypassed.
3. **Cost ceiling behavior:** When a configured internal threshold is reached, disable AI requests while keeping SDS PDFs available.
4. **Monitoring:** Alert on sudden request spikes, repeated errors, quota exhaustion, and unexpected origin patterns.
5. **Data minimization:** Do not send the PDF, employee identity, or sensitive facility information to the model unless an approved design explicitly requires it.

The facility owner must set the actual budget and limits from expected usage, model pricing, and organizational risk tolerance; `$5 USD` is an example, not a universal control value.

## 8. Emergency access and compliance

For United States workplaces, [OSHA 29 CFR 1910.1200(g)(8)](https://www.osha.gov/laws-regs/regulations/standardnumber/1910/1910.1200) permits electronic SDS access only when it creates no barrier to immediate employee access in each workplace during each work shift. GHS is a hazard-communication framework implemented differently by each jurisdiction; the facility safety manager must also verify local requirements.

### Required design behavior

- The official SDS link remains available when AI is disabled, times out, or returns an error.
- The interface clearly identifies AI content as supplemental and potentially incomplete.
- An AI failure must not be described as a failure of the official SDS unless the PDF itself is also unavailable.
- The site must never advise workers to wait for AI during an exposure, spill, fire, or other emergency.

Recommended AI failure message:

```text
AI assistance is unavailable. Open the official SDS PDF for authoritative
safety information. For an active emergency, follow the site emergency plan.
```

### Offline and outage plan

Opening or downloading a PDF once does **not** guarantee future offline access. Browser caches can be cleared or evicted, and behavior varies by device. Choose and test one or more deliberate fallback methods:

- controlled printed binders located where workers can reach them immediately;
- managed offline PDF copies on designated facility devices;
- a tested progressive web app or service worker that explicitly caches the approved SDS set; or
- a local emergency-access station independent of the normal internet connection.

At minimum, maintain a tested fallback for high-hazard chemicals and areas where a network or power outage would otherwise prevent immediate access. Printed binders are a practical option, but the compliance requirement is immediate, barrier-free access, not paper for its own sake.

Test the fallback on the same devices and networks employees use. Record the test date, tester, failure found, and corrective action.

## 9. QR-code routing

Use stable IDs and URL encoding. Example project-site routes are:

```text
Hub:        https://<owner>.github.io/<repository>/
Department: https://<owner>.github.io/<repository>/?dept=Maintenance
Chemical:   https://<owner>.github.io/<repository>/?chemical=wd-40-lubricant
```

- Never encode an API key, employee identifier, or confidential information in a QR code.
- Print a human-readable destination or chemical name beside the code.
- Add a short instruction telling workers how to reach the official SDS without AI.
- Test every new QR code from a non-administrator phone before posting it.
- Replace posted codes if the domain or routing scheme changes.

## 10. Operations and maintenance

### Roles

| Role | Minimum responsibility |
|---|---|
| Facility safety manager | Approves SDS content, departments, fallback method, and emergency wording |
| System administrator | Owns Pages configuration, domain, access control, monitoring, and recovery |
| Developer | Maintains accessible application code, validation, dependency security, and the optional proxy |
| Change reviewer | Independently checks metadata, PDF identity, revision, and production behavior |

One person may hold more than one role, but content approval and technical deployment should receive independent review whenever staffing permits.

### Maintenance cadence

- **For every chemical change:** Complete the onboarding and production-verification workflow.
- **Monthly:** Run an automated broken-link and missing-file check; review failed deployments and proxy anomalies.
- **Quarterly:** Test representative QR codes, AI failover, and the offline/outage procedure on actual worker devices.
- **Annually:** Review repository access, dependencies, credentials, model choice, privacy handling, retention rules, and jurisdiction-specific compliance.
- **After any incident or major provider change:** Reassess the design and document corrective actions.

## 11. Release acceptance checklist

A release is ready only when all applicable items pass.

- [ ] Every metadata record has a unique stable ID.
- [ ] Every PDF path resolves successfully over HTTPS.
- [ ] Each PDF matches the named product, manufacturer, language, and revision.
- [ ] Search, filtering, keyboard navigation, mobile layout, and QR routing work.
- [ ] The official SDS remains reachable when JavaScript AI calls are blocked.
- [ ] No secret appears in source, browser bundles, repository history, or QR codes.
- [ ] The AI proxy, if enabled, enforces validation, limits, timeouts, and safe errors.
- [ ] Budget alerts, usage monitoring, and credential-rotation ownership are configured.
- [ ] The emergency fallback provides immediate access and has a recorded successful test.
- [ ] A facility safety owner and technical reviewer approved the release.

## Authoritative references

- [Google AI for Developers: Using Gemini API keys](https://ai.google.dev/gemini-api/docs/api-key)
- [GitHub Docs: About GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/about-github-pages)
- [GitHub Docs: GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)
- [OSHA: Hazard Communication, 29 CFR 1910.1200](https://www.osha.gov/laws-regs/regulations/standardnumber/1910/1910.1200)

This blueprint is operational guidance, not legal advice. The facility safety manager is responsible for validating the final deployment against the laws, standards, emergency plans, and document-retention rules that apply at the site.
