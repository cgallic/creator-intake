// Local dev: serves the static page and runs api/*.js the way Vercel does
// (req.body parsed, res.status().json()). `npm run dev` → http://localhost:3000
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.dirname(fileURLToPath(import.meta.url));
for (const line of fs.existsSync(path.join(root, ".env")) ? fs.readFileSync(path.join(root, ".env"), "utf8").split("\n") : []) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".jpg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml" };
const PORT = +process.env.PORT || 3000;

// The same /c/<slug> and /api/ai rewrites as vercel.json, for local runs.
function rewrite(url) {
  let m;
  if ((m = url.pathname.match(/^\/api\/ai\/(.+)$/))) { url.pathname = "/api/ai"; url.searchParams.set("path", m[1]); }
  else if ((m = url.pathname.match(/^\/c\/([a-z0-9-]+)\/api\/([a-z]+)$/))) { url.pathname = `/api/${m[2]}`; url.searchParams.set("c", m[1]); }
  else if ((m = url.pathname.match(/^\/c\/([a-z0-9-]+)\/data\/([a-z]+)(\.json)?$/))) { url.pathname = "/api/creator"; url.searchParams.set("c", m[1]); url.searchParams.set("f", m[2]); }
  else if ((m = url.pathname.match(/^\/c\/[a-z0-9-]+\/(styles\.css|script\.js)$/))) url.pathname = `/${m[1]}`;
  else if ((m = url.pathname.match(/^\/c\/[a-z0-9-]+\/(for-creators|new)$/))) url.pathname = `/${m[1]}.html`;
  else if (/^\/c\/[a-z0-9-]+$/.test(url.pathname)) url.pathname = "/index.html";
  else if (/^\/(for-creators|new)$/.test(url.pathname)) url.pathname += ".html";
  return url;
}

http.createServer(async (req, res) => {
  const url = rewrite(new URL(req.url, "http://x"));
  if (url.pathname.startsWith("/api/")) {
    const file = path.join(root, url.pathname + ".js");
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    let body = ""; for await (const c of req) body += c;
    req.body = body && /json/.test(req.headers["content-type"] || "") ? JSON.parse(body) : {};
    req.query = Object.fromEntries(url.searchParams);
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); return res; };
    res.send = (b) => { res.end(b); return res; };
    return require(file)(req, res);
  }
  const rel = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = path.join(root, path.normalize(rel));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory() || /\/(build|node_modules|\.env)/.test(rel)) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
