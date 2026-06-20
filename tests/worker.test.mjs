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
