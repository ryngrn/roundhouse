import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const MAX_REMOTE_ASSETS = 8;
export const MAX_REMOTE_ASSET_BYTES = 20 * 1024 * 1024;
export const MAX_REMOTE_ASSET_TOTAL_BYTES = 50 * 1024 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const createdAttachment = Symbol("createdAttachment");
const signatures = new Map([
  ["image/png", (data) => data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))],
  ["image/jpeg", (data) => data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff],
  ["image/gif", (data) => ["GIF87a", "GIF89a"].includes(data.subarray(0, 6).toString("ascii"))],
  ["image/webp", (data) => data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP"],
  ["image/avif", (data) => data.subarray(4, 8).toString("ascii") === "ftyp" && ["avif", "avis"].includes(data.subarray(8, 12).toString("ascii"))],
  ["application/pdf", (data) => data.subarray(0, 5).toString("ascii") === "%PDF-"],
]);

function validateBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Remote asset base URL is invalid."); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Remote asset base URL must be HTTPS and contain no credentials, query, or fragment.");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function validateDescriptor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Remote asset descriptor must be an object.");
  const allowed = new Set(["id", "filename", "mime_type", "size", "sha256"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unsupported remote asset field: ${key}.`);
  if (typeof value.id !== "string" || !UUID.test(value.id)) throw new Error("Remote asset id must be a canonical UUID.");
  if (typeof value.filename !== "string" || !value.filename || value.filename !== value.filename.trim() ||
      Buffer.byteLength(value.filename) > 180 || /[\x00-\x1f\x7f]/.test(value.filename) ||
      path.posix.basename(value.filename) !== value.filename || path.win32.basename(value.filename) !== value.filename ||
      value.filename === "." || value.filename === "..") throw new Error("Remote asset filename is unsafe.");
  if (typeof value.mime_type !== "string" || !signatures.has(value.mime_type.toLowerCase()) || value.mime_type !== value.mime_type.toLowerCase()) {
    throw new Error("Remote asset MIME type is unsupported.");
  }
  if (!Number.isSafeInteger(value.size) || value.size < 1 || value.size > MAX_REMOTE_ASSET_BYTES) throw new Error("Remote asset size is invalid or exceeds the limit.");
  if (value.sha256 !== undefined && (typeof value.sha256 !== "string" || !SHA256.test(value.sha256))) throw new Error("Remote asset SHA-256 is invalid.");
  return { id: value.id, filename: value.filename, mime_type: value.mime_type, size: value.size, ...(value.sha256 ? { sha256: value.sha256 } : {}) };
}

function assetUrls(baseUrl, id) {
  const download = new URL(encodeURIComponent(id), baseUrl);
  const thumbnail = new URL(`${encodeURIComponent(id)}/thumbnail`, baseUrl);
  if (download.origin !== baseUrl.origin || thumbnail.origin !== baseUrl.origin) throw new Error("Remote asset URL escaped its configured origin.");
  return { download, thumbnail };
}

async function boundedBody(response, expectedSize) {
  if (!response.body) throw new Error("Remote asset response has no body.");
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > expectedSize || received > MAX_REMOTE_ASSET_BYTES) throw new Error("Remote asset response exceeds its declared size.");
      chunks.push(Buffer.from(value));
    }
  } finally {
    if (received > expectedSize) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (received !== expectedSize) throw new Error("Remote asset response size does not match its descriptor.");
  return Buffer.concat(chunks, received);
}

function existingFileMatches(filename, size, sha256) {
  if (!fs.existsSync(filename)) return false;
  const stat = fs.statSync(filename);
  if (!stat.isFile() || stat.size !== size) return false;
  return createHash("sha256").update(fs.readFileSync(filename)).digest("hex") === sha256;
}

export async function downloadRemoteAssets({
  descriptors,
  stateDirectory,
  fetchImpl = globalThis.fetch,
  baseUrl = process.env.ROUNDHOUSE_RELAY_ASSET_BASE_URL,
  bearerToken = process.env.ROUNDHOUSE_RELAY_ASSET_BEARER_TOKEN,
} = {}) {
  if (descriptors === undefined) return [];
  if (!Array.isArray(descriptors) || descriptors.length > MAX_REMOTE_ASSETS) throw new Error(`Remote assets must be an array of at most ${MAX_REMOTE_ASSETS} descriptors.`);
  if (!descriptors.length) return [];
  if (typeof baseUrl !== "string" || !baseUrl) throw new Error("ROUNDHOUSE_RELAY_ASSET_BASE_URL is not configured.");
  if (typeof bearerToken !== "string" || !bearerToken.trim()) throw new Error("ROUNDHOUSE_RELAY_ASSET_BEARER_TOKEN is not configured.");
  if (typeof fetchImpl !== "function") throw new Error("Remote asset fetch is unavailable.");
  const base = validateBaseUrl(baseUrl);
  const assets = descriptors.map(validateDescriptor);
  if (new Set(assets.map((asset) => asset.id)).size !== assets.length) throw new Error("Remote asset ids must be unique.");
  if (assets.reduce((total, asset) => total + asset.size, 0) > MAX_REMOTE_ASSET_TOTAL_BYTES) throw new Error("Remote assets exceed the total size limit.");

  const directory = path.join(path.resolve(stateDirectory), "assets");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const created = [];
  try {
    const attachments = [];
    for (const asset of assets) {
      const { download, thumbnail } = assetUrls(base, asset.id);
      let response;
      try {
        response = await fetchImpl(download, {
          method: "GET",
          redirect: "manual",
          headers: { authorization: `Bearer ${bearerToken}`, accept: asset.mime_type },
        });
      } catch {
        throw new Error(`Remote asset download failed for ${asset.id}.`);
      }
      if (response.redirected || (response.status >= 300 && response.status < 400)) throw new Error(`Remote asset redirect denied for ${asset.id}.`);
      if (!response.ok) throw new Error(`Remote asset download failed for ${asset.id} (${response.status}).`);
      if (response.url && response.url !== download.href) throw new Error(`Remote asset response URL mismatch for ${asset.id}.`);
      const responseType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
      if (responseType !== asset.mime_type) throw new Error(`Remote asset MIME mismatch for ${asset.id}.`);
      const contentLength = response.headers.get("content-length");
      if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) !== asset.size)) throw new Error(`Remote asset size mismatch for ${asset.id}.`);
      const data = await boundedBody(response, asset.size);
      if (!signatures.get(asset.mime_type)(data)) throw new Error(`Remote asset signature mismatch for ${asset.id}.`);
      const sha256 = createHash("sha256").update(data).digest("hex");
      if (asset.sha256 && sha256 !== asset.sha256) throw new Error(`Remote asset SHA-256 mismatch for ${asset.id}.`);
      const localPath = path.join(directory, `${asset.id}-${asset.filename}`);
      if (!existingFileMatches(localPath, asset.size, sha256)) {
        if (fs.existsSync(localPath)) throw new Error(`Remote asset local path collision for ${asset.id}.`);
        const temporary = path.join(directory, `.${asset.id}.${randomUUID()}.tmp`);
        try {
          fs.writeFileSync(temporary, data, { flag: "wx", mode: 0o600 });
          fs.renameSync(temporary, localPath);
          fs.chmodSync(localPath, 0o600);
        } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
        created.push(localPath);
      }
      const attachment = { ...asset, sha256, path: localPath, thumbnail_url: thumbnail.href };
      if (created.includes(localPath)) attachment[createdAttachment] = true;
      attachments.push(attachment);
    }
    return attachments;
  } catch (error) {
    for (const filename of created) if (fs.existsSync(filename)) fs.unlinkSync(filename);
    throw error;
  }
}

export function cleanupDownloadedAssets(attachments) {
  for (const attachment of attachments) {
    if (attachment[createdAttachment] && fs.existsSync(attachment.path)) fs.unlinkSync(attachment.path);
  }
}

function safeThumbnailUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function projectedAttachments(attachments) {
  if (!Array.isArray(attachments)) return [];
  return attachments.map(({ id, filename, mime_type, size, sha256, thumbnail_url }) => {
    const safeThumbnail = safeThumbnailUrl(thumbnail_url);
    return { id, filename, mime_type, size, sha256, ...(safeThumbnail ? { thumbnail_url: safeThumbnail } : {}) };
  });
}
