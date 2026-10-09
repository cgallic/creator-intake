/**
 * POST /api/quick { q }      (?c=<slug> for a self-serve page)
 *
 * Clips first. A word search over the creator's own caption lines finds candidate
 * moments in milliseconds; Jev keeps only the ones that speak to the question (about a
 * quarter second); each is verified word for word like any quote. The page plays the
 * best one while /api/answer is still writing.
 */
const { engineFor } = require("./_creator");
const guard = require("./_guard");
const jev = require("./_jev");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST" });
  const q = String((req.body && req.body.q) || "").trim().slice(0, 1200);
  if (!q) return res.status(400).json({ error: "Missing 'q'." });
  let E;
  try { E = await engineFor(req.query && req.query.c); } catch (_) { return res.status(404).json({ error: "No page here yet." }); }
  if (guard.limited(`${guard.visitorOf(req)}:quick`)) return res.status(429).json({ moments: [] });
  const started = Date.now();
  const cands = E.quickCandidates(q, 12);
  if (!cands.length || !process.env.OPENROUTER_API_KEY || process.env.JEV_OFF === "1" || await guard.overCap()) return res.status(200).json({ moments: [] });
  const judged = await jev.judge(E.config, q, cands, []).catch(() => null);
  if (!judged) return res.status(200).json({ moments: [] });
  const moments = cands
    .map((m, i) => ({ m, p: judged.answers[`m${i}`]?.noul ?? 0 }))
    .filter(({ p }) => p >= 0.6)
    .sort((a, b) => b.p - a.p)
    .slice(0, 2)
    .map(({ m, p }) => { const v = E.verifyMoment({ source_id: m.source_id, passage: m.quote }); return v.ok ? { ...E.shapeMoment({ passage: m.quote, why: "" }, v), relevance: p } : null; })
    .filter(Boolean);
  return res.status(200).json({ moments, ms: Date.now() - started, cost: judged.cost });
};
