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

/* Jobs are append-only: every status change is a new file (jobs/<day>/<hex>/<time>.json)
   and the newest file is the job's state. Overwriting one file in place loses updates,
   because a read right after an overwrite can still return the old version; a new
   file has a new URL and is never served stale. */
const stamp = () => `${String(Date.now()).padStart(15, "0")}-${Math.random().toString(16).slice(2, 6)}`;

async function putJob(id, data) {
  return blob().put(`jobs/${id}/${stamp()}.json`, JSON.stringify(data), {
    access: "public", addRandomSuffix: false, contentType: "application/json", cacheControlMaxAge: 31536000,
  });
}

async function getJob(id) {
  const files = await list(`jobs/${id}/`);
  if (!files.length) return null;
  files.sort((a, b) => a.pathname.localeCompare(b.pathname));
  const r = await fetch(files[files.length - 1].url, { cache: "no-store" });
  return r.ok ? r.json() : null;
}

async function updateJob(id, patch) {
  const job = await getJob(id);
  if (!job) throw new Error("no such job");
  const next = { ...job, ...patch, updated_at: new Date().toISOString() };
  await putJob(id, next);
  return next;
}

/** The newest state of every job created on these days, oldest job first. */
async function jobsOn(days) {
  const files = (await Promise.all(days.map((d) => list(`jobs/${d}/`)))).flat();
  const latest = new Map();
  for (const f of files) {
    const m = f.pathname.match(/^jobs\/(\d{4}-\d{2}-\d{2}\/[a-f0-9]{16})\/(.+)\.json$/);
    if (!m) continue;
    const cur = latest.get(m[1]);
    if (!cur || f.pathname > cur.pathname) latest.set(m[1], f);
  }
  const jobs = await Promise.all([...latest.values()].map(async (f) => { const r = await fetch(f.url, { cache: "no-store" }); return r.ok ? r.json() : null; }));
  return jobs.filter(Boolean).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

module.exports.putJob = putJob;
module.exports.getJob = getJob;
module.exports.updateJob = updateJob;
module.exports.jobsOn = jobsOn;
