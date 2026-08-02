// Local test harness: runs the Cloudflare worker (src/index.js) under Node so
// the site can be exercised without wrangler. Not used in production.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import worker from "../src/index.js";

const PUB = new URL("../public/", import.meta.url).pathname;
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".geojson": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".css": "text/css",
};

async function serveAsset(url) {
  let p = new URL(url).pathname;
  if (p === "/") p = "/index.html";
  try {
    const buf = await readFile(join(PUB, p));
    return new Response(buf, {
      headers: { "Content-Type": MIME[extname(p)] || "application/octet-stream" },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

const env = { ASSETS: { fetch: (req) => serveAsset(req.url) } };

http
  .createServer(async (req, res) => {
    const request = new Request("http://localhost:8787" + req.url, {
      method: req.method,
    });
    const r = await worker.fetch(request, env);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  })
  .listen(8787, () => console.log("up on 8787"));
