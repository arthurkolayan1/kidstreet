// Shared fetch-with-disk-cache helper.
// Every bulk source is downloaded ONCE and cached to pipeline/cache/<key>.json (or .txt).
// Re-running any script is then instant and offline-safe. Delete the cache file to refresh.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CACHE_DIR = path.join(__dirname, "..", "cache");

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

function cachePath(key, ext) {
  return path.join(CACHE_DIR, `${key}.${ext}`);
}

export async function cachedFetchJson(key, url, opts = {}) {
  const file = cachePath(key, "json");
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }
  console.log(`[fetch] ${key} <- ${url.slice(0, 140)}`);
  const res = await fetch(url, opts);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET ${url} failed: ${res.status} ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  fs.writeFileSync(file, JSON.stringify(json));
  return json;
}

export async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function cachedPostJson(key, url, body, opts = {}) {
  const file = cachePath(key, "json");
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }
  const maxRetries = opts.maxRetries ?? 5;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    console.log(`[post] ${key} <- ${url.slice(0, 140)}`);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
      ...opts,
    });
    if (res.status === 429) {
      let retryAfter = 5;
      try {
        const j = await res.json();
        if (j.retry_after) retryAfter = Number(j.retry_after);
      } catch {}
      console.log(
        `  [429] rate limited, waiting ${retryAfter}s (attempt ${attempt + 1}/${maxRetries})`,
      );
      await sleep((retryAfter + 1) * 1000);
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `POST ${url} failed: ${res.status} ${text.slice(0, 300)}`,
      );
    }
    const json = await res.json();
    fs.writeFileSync(file, JSON.stringify(json));
    return json;
  }
  throw new Error(`POST ${url} failed: exhausted retries on 429`);
}

export async function cachedFetchText(key, url, opts = {}) {
  const file = cachePath(key, "txt");
  if (fs.existsSync(file)) {
    return fs.readFileSync(file, "utf8");
  }
  console.log(`[fetch-text] ${key} <- ${url.slice(0, 140)}`);
  const res = await fetch(url, opts);
  if (!res.ok) {
    throw new Error(`GET ${url} failed: ${res.status}`);
  }
  const text = await res.text();
  fs.writeFileSync(file, text);
  return text;
}

// Some servers (observed: Overpass's Apache front-end) return 406 to Node's fetch
// despite accepting an otherwise-identical curl request (likely Accept-Encoding/header
// negotiation quirk). Shelling out to curl is a pragmatic, reliable workaround.
import { execFileSync } from "node:child_process";

export function cachedCurlPostJson(key, url, body, opts = {}) {
  const file = cachePath(key, "json");
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }
  const maxRetries = opts.maxRetries ?? 3;
  const maxTime = opts.maxTime ?? 180;
  const bodyFile = cachePath(key, "body.txt");
  fs.writeFileSync(bodyFile, body);
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(
      `[curl-post] ${key} <- ${url.slice(0, 140)} (attempt ${attempt}/${maxRetries})`,
    );
    try {
      const out = execFileSync(
        "curl",
        [
          "-s",
          "--max-time",
          String(maxTime),
          "-X",
          "POST",
          "--data-binary",
          `@${bodyFile}`,
          url,
        ],
        { maxBuffer: 1024 * 1024 * 200 },
      );
      const json = JSON.parse(out.toString("utf8"));
      fs.unlinkSync(bodyFile);
      fs.writeFileSync(file, JSON.stringify(json));
      return json;
    } catch (e) {
      lastErr = e;
      console.log(
        `  [retry] attempt ${attempt} failed (${e.message.slice(0, 100)}), waiting 5s...`,
      );
    }
  }
  fs.unlinkSync(bodyFile);
  throw new Error(
    `curl POST ${url} failed after ${maxRetries} attempts: ${lastErr?.message}`,
  );
}

export function readJsonOut(name) {
  const file = path.join(__dirname, "..", "out", name);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function writeJsonOut(name, data) {
  const file = path.join(__dirname, "..", "out", name);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`[write] ${file}`);
}
