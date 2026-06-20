const GITHUB_API = "https://api.github.com";
const GITHUB_UPLOAD = "https://uploads.github.com";

type StoredAsset = { assetId: number; assetName: string; apiUrl: string; downloadUrl: string };

function config() {
  const token = Deno.env.get("GITHUB_TOKEN") || "";
  const repository = Deno.env.get("GITHUB_REPOSITORY") || "izzulwork1/sds-hub";
  if (!token) throw new Error("GitHub storage is not configured");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("GitHub repository configuration is invalid");
  return { token, repository };
}

export async function uploadOriginal(documentId: string, originalFilename: string, bytes: Uint8Array): Promise<StoredAsset> {
  const release = await ensureRelease(Deno.env.get("GITHUB_INTAKE_RELEASE_TAG") || "sds-intake-originals", true);
  const safeOriginal = originalFilename.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(-140) || "source.pdf";
  return uploadAsset(release.id, `${documentId}--${safeOriginal}`, originalFilename, bytes);
}

export async function uploadApproved(documentId: string, approvedFilename: string, bytes: Uint8Array): Promise<StoredAsset> {
  const release = await ensureRelease(Deno.env.get("GITHUB_APPROVED_RELEASE_TAG") || "sds-approved", false);
  return uploadAsset(release.id, approvedFilename, `Approved SDS ${documentId}`, bytes);
}

export async function downloadPrivateAsset(assetId: number) {
  const { token, repository } = config();
  const response = await fetch(`${GITHUB_API}/repos/${repository}/releases/assets/${assetId}`, {
    headers: githubHeaders(token, "application/octet-stream"),
    redirect: "follow"
  });
  if (!response.ok) throw new Error(`GitHub asset download failed (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

async function ensureRelease(tag: string, draft: boolean) {
  const { token, repository } = config();
  const listed = await githubJson(`${GITHUB_API}/repos/${repository}/releases?per_page=100`, token);
  const existing = Array.isArray(listed) ? listed.find((item) => item.tag_name === tag) : null;
  if (existing) return existing;
  return githubJson(`${GITHUB_API}/repos/${repository}/releases`, token, {
    method: "POST",
    body: JSON.stringify({
      tag_name: tag,
      target_commitish: "main",
      name: draft ? "Private SDS intake originals" : "Approved SDS documents",
      body: draft
        ? "Controlled original uploads. This draft release must remain private to repository maintainers."
        : "EHS-approved Safety Data Sheets used by the Digital SDS Hub.",
      draft,
      prerelease: false
    })
  });
}

async function uploadAsset(releaseId: number, name: string, label: string, bytes: Uint8Array): Promise<StoredAsset> {
  const { token, repository } = config();
  const query = new URLSearchParams({ name, label });
  const response = await fetch(`${GITHUB_UPLOAD}/repos/${repository}/releases/${releaseId}/assets?${query}`, {
    method: "POST",
    headers: { ...githubHeaders(token, "application/vnd.github+json"), "Content-Type": "application/pdf" },
    body: bytes
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`GitHub asset upload failed (${response.status}): ${String(payload?.message || "unknown error").slice(0, 200)}`);
  return { assetId: payload.id, assetName: payload.name, apiUrl: payload.url, downloadUrl: payload.browser_download_url };
}

async function githubJson(url: string, token: string, init: RequestInit = {}) {
  const response = await fetch(url, { ...init, headers: { ...githubHeaders(token, "application/vnd.github+json"), ...(init.headers || {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`GitHub API failed (${response.status}): ${String(payload?.message || "unknown error").slice(0, 200)}`);
  return payload;
}

function githubHeaders(token: string, accept: string) {
  return {
    Accept: accept,
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "serverless-digital-sds-hub"
  };
}
