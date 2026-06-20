const MAX_REQUEST_BYTES = 4096;
const MAX_QUESTION_LENGTH = 500;
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 25000;
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FILE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*\.pdf$/;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const corsHeaders = getCorsHeaders(origin, env.ALLOWED_ORIGIN);

    if (request.method === "OPTIONS") {
      if (!corsHeaders) return json({ error: "Origin is not allowed." }, 403);
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    if (url.pathname !== "/v1/ask") return json({ error: "Not found." }, 404, corsHeaders);
    if (request.method !== "POST") return json({ error: "Method not allowed." }, 405, corsHeaders);
    if (!corsHeaders) return json({ error: "Origin is not allowed." }, 403);

    if (!env.GEMINI_API_KEY || !env.SDS_CATALOG_URL || !env.AI_RATE_LIMITER || !env.RATE_LIMIT_SALT) {
      return json({ error: "AI assistance is not configured." }, 503, corsHeaders);
    }

    const contentLength = Number(request.headers.get("Content-Length") || 0);
    if (contentLength > MAX_REQUEST_BYTES) return json({ error: "Request is too large." }, 413, corsHeaders);

    const rateLimitKey = await createRateLimitKey(request, env.RATE_LIMIT_SALT);
    const rateLimitResult = await env.AI_RATE_LIMITER.limit({ key: rateLimitKey });
    if (!rateLimitResult.success) {
      return json({ error: "Question limit reached. Open the official SDS and try again later." }, 429, {
        ...corsHeaders,
        "Retry-After": "60"
      });
    }

    let input;
    try {
      const rawBody = await request.text();
      if (new TextEncoder().encode(rawBody).byteLength > MAX_REQUEST_BYTES) throw new Error("Request is too large");
      input = JSON.parse(rawBody);
    } catch {
      return json({ error: "Request body must be valid JSON." }, 400, corsHeaders);
    }

    const chemicalId = typeof input.chemicalId === "string" ? input.chemicalId.trim() : "";
    const question = typeof input.question === "string" ? input.question.trim() : "";
    if (!ID_PATTERN.test(chemicalId) || question.length < 3 || question.length > MAX_QUESTION_LENGTH) {
      return json({ error: "Chemical ID or question is invalid." }, 400, corsHeaders);
    }

    try {
      const catalogDocument = await findApprovedDocument(env.SDS_CATALOG_URL, chemicalId);
      const pdfBytes = await fetchApprovedPdf(env.SDS_CATALOG_URL, catalogDocument.file);
      const answer = await askGemini(env, catalogDocument, question, pdfBytes);
      return json({
        answer: `Supplemental AI summary - verify against the official SDS:\n\n${answer}`,
        chemicalId,
        revisionDate: catalogDocument.revisionDate
      }, 200, corsHeaders);
    } catch (error) {
      console.error("AI request failed", safeErrorForLog(error));
      const status = error instanceof PublicError ? error.status : 502;
      const message = error instanceof PublicError
        ? error.message
        : "AI assistance is unavailable. Open the official SDS for authoritative information.";
      return json({ error: message }, status, corsHeaders);
    }
  }
};

class PublicError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "PublicError";
    this.status = status;
  }
}

function getCorsHeaders(origin, allowedOrigin) {
  if (!origin || !allowedOrigin) return null;

  const allowedOrigins = allowedOrigin.split(",").map((item) => item.trim()).filter(Boolean);
  if (!allowedOrigins.includes(origin)) return null;

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
}

async function createRateLimitKey(request, salt) {
  const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${clientIp}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function findApprovedDocument(catalogUrlValue, chemicalId) {
  const catalogUrl = requireHttpsUrl(catalogUrlValue, "SDS catalog");
  const response = await fetch(catalogUrl, {
    headers: { Accept: "application/json" },
    cf: { cacheEverything: true, cacheTtl: 60 }
  });
  if (!response.ok) throw new PublicError("The approved SDS catalog is unavailable.", 503);

  const payload = await response.json().catch(() => null);
  const documents = payload?.schemaVersion === 1 && Array.isArray(payload.documents) ? payload.documents : [];
  const document = documents.find((item) => item?.id === chemicalId);

  if (!document || !FILE_PATTERN.test(document.file || "") || typeof document.name !== "string" || typeof document.revisionDate !== "string") {
    throw new PublicError("The selected chemical is not in the approved SDS catalog.", 404);
  }
  if ((document.documentType || "SDS") !== "SDS") {
    throw new PublicError("AI assistance is available only for confirmed SDS documents.", 400);
  }

  return {
    id: document.id,
    name: document.name.slice(0, 200),
    file: document.file,
    department: typeof document.department === "string" ? document.department.slice(0, 100) : "",
    revisionDate: document.revisionDate.slice(0, 10)
  };
}

async function fetchApprovedPdf(catalogUrlValue, filename) {
  const catalogUrl = requireHttpsUrl(catalogUrlValue, "SDS catalog");
  const pdfUrl = new URL(`../pdfs/${filename}`, catalogUrl);
  if (pdfUrl.origin !== catalogUrl.origin) throw new PublicError("The SDS document address is invalid.", 500);

  const response = await fetch(pdfUrl, {
    headers: { Accept: "application/pdf" },
    cf: { cacheEverything: true, cacheTtl: 300 }
  });
  if (!response.ok) throw new PublicError("The official SDS PDF is unavailable.", 503);

  const contentLength = Number(response.headers.get("Content-Length") || 0);
  if (contentLength > MAX_PDF_BYTES) throw new PublicError("The SDS PDF exceeds the AI processing limit.", 413);

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_PDF_BYTES) throw new PublicError("The SDS PDF exceeds the AI processing limit.", 413);
  if (new TextDecoder("ascii").decode(bytes.slice(0, 5)) !== "%PDF-") {
    throw new PublicError("The approved SDS file is not a valid PDF.", 502);
  }

  return bytes;
}

async function askGemini(env, document, question, pdfBytes) {
  const model = env.GEMINI_MODEL || "gemini-2.5-flash";
  if (!/^[a-zA-Z0-9._-]+$/.test(model)) throw new PublicError("The AI model configuration is invalid.", 500);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY
      },
      body: JSON.stringify({
        system_instruction: {
          parts: [{
            text: "You are a document-grounded workplace safety assistant. Answer only from the attached official Safety Data Sheet. If the answer is absent, ambiguous, or product-specific beyond the document, say that you cannot determine it and direct the worker to the relevant SDS section and site safety manager. Never override the SDS, site emergency plan, emergency services, poison control, or medical professionals. Do not invent exposure limits, PPE, first-aid steps, incompatibilities, or disposal instructions. Use concise plain text with short bullets and name the SDS section numbers used."
          }]
        },
        contents: [{
          role: "user",
          parts: [
            {
              inline_data: {
                mime_type: "application/pdf",
                data: bytesToBase64(pdfBytes)
              }
            },
            {
              text: `Product: ${document.name}\nDepartment: ${document.department || "Not specified"}\nSDS revision: ${document.revisionDate || "Not stated"}\nWorker question: ${question}`
            }
          ]
        }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 700
        }
      }),
      signal: controller.signal
    });

    if (!response.ok) throw new Error(`Gemini returned HTTP ${response.status}`);
    const payload = await response.json();
    const answer = payload?.candidates?.[0]?.content?.parts
      ?.map((part) => part.text)
      .filter((text) => typeof text === "string")
      .join("\n")
      .trim();
    if (!answer) throw new Error("Gemini returned no text");
    return answer;
  } finally {
    clearTimeout(timeout);
  }
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function requireHttpsUrl(value, label) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") throw new Error("HTTPS required");
    return url;
  } catch {
    throw new PublicError(`${label} configuration is invalid.`, 500);
  }
}

function safeErrorForLog(error) {
  return {
    name: error?.name || "Error",
    message: String(error?.message || "Unknown error").slice(0, 300),
    status: error?.status || undefined
  };
}

function json(payload, status, additionalHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      ...additionalHeaders
    }
  });
}
