import assert from "node:assert/strict";
import test from "node:test";
import worker from "../worker/src/index.js";

const origin = "https://example.github.io";
const allowedEnv = { ALLOWED_ORIGIN: origin };

test("proxy answers allowed CORS preflight without exposing a wildcard origin", async () => {
  const request = new Request("https://proxy.example/v1/ask", {
    method: "OPTIONS",
    headers: { Origin: origin }
  });
  const response = await worker.fetch(request, allowedEnv);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin);
  assert.equal(response.headers.get("Vary"), "Origin");
});

test("proxy rejects an unapproved browser origin", async () => {
  const request = new Request("https://proxy.example/v1/ask", {
    method: "POST",
    headers: { Origin: "https://attacker.example", "Content-Type": "application/json" },
    body: JSON.stringify({ chemicalId: "acetone", question: "What PPE is listed?" })
  });
  const response = await worker.fetch(request, allowedEnv);
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
});

test("proxy fails closed when credentials and controls are not configured", async () => {
  const request = new Request("https://proxy.example/v1/ask", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ chemicalId: "acetone", question: "What PPE is listed?" })
  });
  const response = await worker.fetch(request, allowedEnv);
  const payload = await response.json();
  assert.equal(response.status, 503);
  assert.match(payload.error, /not configured/i);
});

test("proxy exposes only the intended endpoint", async () => {
  const request = new Request("https://proxy.example/", {
    method: "POST",
    headers: { Origin: origin }
  });
  const response = await worker.fetch(request, allowedEnv);
  assert.equal(response.status, 404);
});

test("proxy grounds questions in an approved D1 and R2 intake record", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url) => {
    assert.match(String(url), /generativelanguage\.googleapis\.com/);
    return Response.json({ candidates:[{ content:{ parts:[{ text:"Use the PPE stated in Section 8." }] } }] });
  };

  const pdfBytes = new TextEncoder().encode("%PDF-1.7 approved SDS");
  const documentRow = {
    id:"approved-record",
    product_name:null,
    trade_name:"Approved Product",
    approved_filename:"SDS_Approved_Product_Supplier_2026-06-20_EN.pdf",
    approved_storage_key:"approved/approved-record/file.pdf",
    revision_date:"2026-06-20"
  };
  const env = {
    ALLOWED_ORIGIN:origin,
    GEMINI_API_KEY:"server-only-test-key",
    GEMINI_MODEL:"gemini-2.5-flash",
    RATE_LIMIT_SALT:"test-salt",
    AI_RATE_LIMITER:{ limit:async () => ({ success:true }) },
    DB:{ prepare:() => ({ bind:() => ({ first:async () => documentRow }) }) },
    SDS_FILES:{ get:async () => ({ size:pdfBytes.byteLength, arrayBuffer:async () => pdfBytes.buffer }) }
  };
  const request = new Request("https://proxy.example/v1/ask", {
    method:"POST",
    headers:{ Origin:origin, "Content-Type":"application/json" },
    body:JSON.stringify({ chemicalId:"approved-record", question:"What PPE is required?" })
  });
  const response = await worker.fetch(request, env);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.match(payload.answer, /Section 8/);
  assert.equal(payload.chemicalId, "approved-record");
});
