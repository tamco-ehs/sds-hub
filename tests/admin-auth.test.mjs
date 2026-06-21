import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [html, script, config, edge] = await Promise.all([
  readFile(new URL("../admin.html", import.meta.url), "utf8"),
  readFile(new URL("../assets/admin.js", import.meta.url), "utf8"),
  readFile(new URL("../assets/config.js", import.meta.url), "utf8"),
  readFile(new URL("../supabase/functions/sds-api/index.ts", import.meta.url), "utf8")
]);

test("admin page uses Supabase email/password login without manual token identity fields", () => {
  assert.match(html, /id="emailInput"/);
  assert.match(html, /id="passwordInput"/);
  assert.match(html, /id="logoutButton"/);
  assert.doesNotMatch(html, /id="adminTokenInput"/);
  assert.doesNotMatch(html, /id="reviewerInput"/);
  assert.doesNotMatch(html, /id="apiUrlInput"/);
  assert.match(script, /signInWithPassword/);
  assert.match(script, /Authorization:`Bearer \$\{token\}`/);
  assert.doesNotMatch(script, /sds-admin-token|sds-reviewer/);
});

test("public config contains only publishable Supabase Auth configuration", () => {
  assert.match(config, /supabaseUrl:/);
  assert.match(config, /supabaseAnonKey:\s*"sb_publishable_/);
  assert.doesNotMatch(config, /service_role|ADMIN_API_TOKEN|GEMINI_API_KEY|GITHUB_TOKEN/);
});

test("Edge Function enforces roles and hides deleted or archived records publicly", () => {
  assert.match(edge, /authenticate\(request\)/);
  assert.match(edge, /requireRole\(actor, "EHS_ADMIN"\)/);
  assert.match(edge, /User not authorized for EHS admin/);
  assert.match(edge, /Account inactive/);
  assert.match(edge, /Role does not allow this action/);
  assert.match(edge, /status=eq\.Approved&deleted_at=is\.null&archived_at=is\.null/);
  assert.match(edge, /BULK_ARCHIVE/);
  assert.match(edge, /BULK_DELETE/);
});
