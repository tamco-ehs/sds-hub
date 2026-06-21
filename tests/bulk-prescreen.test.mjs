import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [workflow, scanner, classifier, edge, migration, admin, publicApp] = await Promise.all([
  readFile(new URL("../.github/workflows/bulk-sds-prescreen.yml", import.meta.url), "utf8"),
  readFile(new URL("../scripts/bulk_prescreen.py", import.meta.url), "utf8"),
  readFile(new URL("../supabase/functions/_shared/review-classification.ts", import.meta.url), "utf8"),
  readFile(new URL("../supabase/functions/sds-api/index.ts", import.meta.url), "utf8"),
  readFile(new URL("../supabase/migrations/20260621150000_sds_risk_review_categories.sql", import.meta.url), "utf8"),
  readFile(new URL("../assets/admin.js", import.meta.url), "utf8"),
  readFile(new URL("../assets/app.js", import.meta.url), "utf8")
]);

test("bulk workflow is manual, read-only, selective by default, and keeps Gemini in Actions secrets", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /default: selective/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /GEMINI_API_KEY: \$\{\{ secrets\.GEMINI_API_KEY \}\}/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  for (const report of ["bulk-prescreen-report.json", "bulk-review-queue.json", "bulk-ai-verification-log.json", "bulk-scan-summary.json"]) {
    assert.match(workflow, new RegExp(report.replaceAll(".", "\\.")));
  }
});

test("scanner is hash-cached, OCR bounded, and never applies catalog enrichment", () => {
  assert.match(scanner, /sha256/);
  assert.match(scanner, /resultsBySha256/);
  assert.match(scanner, /OCR_MAX_PAGES/);
  assert.match(scanner, /AI_MAX_CALLS/);
  assert.match(scanner, /proposedCatalogPatches/);
  assert.doesNotMatch(scanner, /write_text\([^\n]*sds-data\.json/);
});

test("Supabase classification is additive and retains the controlled approval gate", () => {
  assert.match(migration, /add column if not exists review_decision/);
  assert.match(migration, /add column if not exists risk_level/);
  assert.match(classifier, /auto_prescreen_pass/);
  assert.match(classifier, /full_review_required/);
  assert.match(classifier, /ocr_review_required/);
  assert.match(edge, /classifySdsReview/);
  assert.match(edge, /status: "Needs Review"/);
  assert.doesNotMatch(classifier, /status\s*[:=]\s*["']Approved/);
});

test("admin queue groups review categories while public QR routing remains present", () => {
  assert.match(admin, /REVIEW_DECISION_ORDER/);
  assert.match(admin, /review-group-/);
  assert.match(admin, /evidence_snippets/);
  assert.match(publicApp, /chemical/);
  assert.match(publicApp, /function applyRoute/);
});
