// Vercel Blob as a tiny JSON store: build jobs (jobs/<date>/<id>.json) and
// self-serve pages (creators/<slug>/<file>.json). Reads add the upload time as a
// query string so an overwritten file is never served stale from the CDN.
// (Underscore file: Vercel does not route it.)
const blob = () => require("@vercel/blob");

async function putJSON(pathname, data) {
  return blob().put(pathname, JSON.stringify(data), {
    access: "public", addRandomSuffix: false, allowOverwrite: true, contentType: "application/json", cacheControlMaxAge: 60,
  });
}

async function getJSON(pathname) {
  let meta;
  try { meta = await blob().head(pathname); } catch (_) { return null; }
  const r = await fetch(`${meta.url}?v=${new Date(meta.uploadedAt).getTime()}`, { cache: "no-store" });
  return r.ok ? r.json() : null;
}

async function list(prefix) {
  const out = [];
  let cursor;
  do {
    const page = await blob().list({ prefix, cursor, limit: 1000 });
    out.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : null;
  } while (cursor);
  return out;
}

module.exports = { putJSON, getJSON, list };
