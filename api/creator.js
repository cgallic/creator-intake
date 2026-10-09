/**
 * GET /api/creator?c=<slug>&f=config|featured|stats|demo
 * A self-serve page's data, for the static page at /c/<slug> (vercel.json rewrites
 * /c/<slug>/data/<f>.json here). The corpus is never served to the browser.
 */
const { file, SLUG } = require("./_creator");

module.exports = async (req, res) => {
  const c = String((req.query && req.query.c) || "");
  const f = String((req.query && req.query.f) || "").replace(/\.json$/, "");
  if (!SLUG.test(c) || !["config", "featured", "stats", "demo"].includes(f)) return res.status(404).json({ error: "not found" });
  try {
    const data = await file(c, f);
    if (data == null) return res.status(404).json({ error: "not found" });
    res.setHeader("cache-control", "public, max-age=60");
    return res.status(200).json(data);
  } catch (_) {
    return res.status(404).json({ error: "not found" });
  }
};
