const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

export async function selectRows(table: string, query = "") {
  return request(table + (query ? `?${query}` : ""), { method: "GET" });
}

export async function insertRows(table: string, rows: Record<string, unknown> | Record<string, unknown>[], returning = true) {
  return request(table, {
    method: "POST",
    headers: { Prefer: returning ? "return=representation" : "return=minimal" },
    body: JSON.stringify(rows)
  });
}

export async function updateRows(table: string, query: string, changes: Record<string, unknown>, returning = true) {
  return request(`${table}?${query}`, {
    method: "PATCH",
    headers: { Prefer: returning ? "return=representation" : "return=minimal" },
    body: JSON.stringify(changes)
  });
}

async function request(path: string, init: RequestInit & { headers?: Record<string, string> }) {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error("Supabase service configuration is unavailable");
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init.headers || {})
    }
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Database request failed (${response.status}): ${detail.slice(0, 500)}`);
  }
  if (response.status === 204) return [];
  const text = await response.text();
  return text ? JSON.parse(text) : [];
}

export function eq(field: string, value: unknown) {
  return `${encodeURIComponent(field)}=eq.${encodeURIComponent(String(value))}`;
}

export function nowIso() { return new Date().toISOString(); }
