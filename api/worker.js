/**
 * The build worker's side door (build/worker.mjs polls it). Every call needs
 * `authorization: Bearer <WORKER_SECRET>`.
 *
 *   GET  ?a=next                      oldest queued job (claims it), or {}
 *   POST ?a=progress  {id, stage, detail}
 *   POST ?a=publish   {id, slug, files: {config, corpus, featured, stats}}
 *   POST ?a=verified  {id, name}          a claim's code was found in the channel description
 *   POST ?a=fail      {id, error}
 *   POST ?a=sales                     settle paid Lifetime Pro checkouts nobody confirmed (buyer closed the tab)
 *
 * A job picked up more than 30 minutes ago and not finished goes back in the queue.
 */
const store = require("./_store");
const { SLUG } = require("./_creator");
const sales = require("./_sales");

const authed = (req) => !!process.env.WORKER_SECRET && (req.headers.authorization || "") === `Bearer ${process.env.WORKER_SECRET}`;

const update = (id, patch) => store.updateJob(id, patch);

module.exports = async (req, res) => {
  if (!authed(req)) return res.status(401).json({ error: "unauthorized" });
  const a = String((req.query && req.query.a) || "");
  const b = req.body || {};
  try {
    if (a === "next" && req.method === "GET") {
      const days = [0, 1].map((d) => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10));
      for (const job of await store.jobsOn(days)) {
        const stale = (job.status === "working" || job.status === "building") && Date.now() - Date.parse(job.updated_at) > 30 * 60e3;
        if (job.status === "queued" || stale) return res.status(200).json(await update(job.id, { status: "working", stage: job.type === "claim" ? "checking" : "starting", detail: job.type === "claim" ? "Reading your channel description" : "A builder picked this up" }));
      }
      return res.status(200).json({});
    }
    if (a === "progress" && req.method === "POST") {
      const patch = { status: "building", stage: String(b.stage || "").slice(0, 40), detail: String(b.detail || "").slice(0, 200) };
      if (b.name) patch.name = String(b.name).slice(0, 120);
      await update(String(b.id), patch);
      return res.status(200).json({ ok: true });
    }
    if (a === "publish" && req.method === "POST") {
      const slug = String(b.slug || "");
      if (!SLUG.test(slug) || !b.files || !b.files.config || !b.files.corpus) return res.status(400).json({ error: "bad publish" });
      for (const name of ["config", "corpus", "featured", "stats"]) if (b.files[name]) await store.putJSON(`creators/${slug}/${name}.json`, b.files[name]);
      await update(String(b.id), { status: "done", stage: "done", detail: "Your page is ready", url: `/c/${slug}` });
      return res.status(200).json({ ok: true, url: `/c/${slug}` });
    }
    if (a === "verified" && req.method === "POST") {
      await update(String(b.id), { status: "verified", stage: "verified", detail: "The code checks out", name: b.name ? String(b.name).slice(0, 120) : undefined });
      return res.status(200).json({ ok: true });
    }
    if (a === "fail" && req.method === "POST") {
      await update(String(b.id), { status: "failed", stage: "failed", error: String(b.error || "The build failed.").slice(0, 300) });
      return res.status(200).json({ ok: true });
    }
    if (a === "sales" && req.method === "POST") {
      const origin = process.env.PUBLIC_URL || `https://${req.headers["x-forwarded-host"] || req.headers.host}`;
      return res.status(200).json(await sales.sweep(origin));
    }
    return res.status(400).json({ error: "unknown action" });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
