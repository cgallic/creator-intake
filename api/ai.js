/**
 * POST /api/ai/<path>   (vercel.json rewrites to /api/ai?path=<path>)
 *
 * A narrow OpenRouter proxy for the build worker, so the OpenRouter key stays in
 * this app. Bearer <WORKER_SECRET> required; only chat/completions and systemone;
 * only the models in WORKER_AI_MODELS; max_tokens clamped. Counts against the
 * same spend cap as the pages.
 */
const guard = require("./_guard");

const PATHS = new Set(["chat/completions", "systemone"]);
const MODELS = new Set((process.env.WORKER_AI_MODELS || "openai/gpt-6-luna,typesafe/jev-1.13,anthropic/claude-haiku-5.5").split(",").map((x) => x.trim()));

module.exports = async (req, res) => {
  if (!process.env.WORKER_SECRET || (req.headers.authorization || "") !== `Bearer ${process.env.WORKER_SECRET}`) return res.status(401).json({ error: "unauthorized" });
  if (req.method !== "POST") return res.status(405).json({ error: "POST" });
  const path = String((req.query && req.query.path) || "").replace(/^\/+/, "");
  if (!PATHS.has(path)) return res.status(404).json({ error: "not allowed" });
  const body = req.body || {};
  if (!MODELS.has(body.model)) return res.status(400).json({ error: `model not allowed: ${body.model}` });
  if (body.max_tokens) body.max_tokens = Math.min(+body.max_tokens || 0, 6000);
  if (await guard.overCap()) return res.status(429).json({ error: "spend cap reached" });
  const r = await fetch(`https://openrouter.ai/api/v1/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "content-type": "application/json", "x-title": "creator-intake build worker" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  res.status(r.status);
  res.setHeader("content-type", "application/json");
  return res.send(text);
};
