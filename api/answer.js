/**
 * POST /api/answer  { q, history, did, told }      (?c=<slug> for a self-serve page)
 *
 * Answers a visitor's question from what the creator has actually said on the
 * record, and finds the moments where they say it themselves. Every quote is
 * verified word for word against the creator's captions (api/_verify.js); Jev
 * reads the question and judges the clips (api/_jev.js). The engine for each
 * creator lives in api/_engine.js; creators load via api/_creator.js.
 */
const { guard, jev } = require("./_engine");
const { engineFor } = require("./_creator");

module.exports = async (req, res) => {
  let E;
  try { E = await engineFor(req.query && req.query.c); } catch (e) { return res.status(404).json({ error: "No page here yet." }); }
  const { config, WHO, ask, fallback, verifyMoment, shapeMoment, railCandidates, railItem, compose, jevOn } = E;
  if (req.method !== "POST") return res.status(405).json({ error: "POST { q }" });
  const b = req.body || {};
  const q = String(b.q || "").trim().slice(0, 1200);
  if (!q) return res.status(400).json({ error: "Missing 'q'." });
  if (guard.limited(guard.visitorOf(req))) return res.status(429).json({ error: "That's a lot of questions for one hour. Try again a little later." });
  if (await guard.overCap()) {
    console.warn("answer: spend cap reached", JSON.stringify(guard.spend()));
    return res.status(429).json({ error: `${WHO} is taking a breather from answering here today. ${config.offer.fallback || ""}`.trim() });
  }
  const ctx = {
    history: (Array.isArray(b.history) ? b.history : []).map(String).slice(-4),
    did: (Array.isArray(b.did) ? b.did : []).map(String).slice(-12),
    cameFrom: String(b.came_from || "").slice(0, 200),
  };
  const told = b.told && typeof b.told === "object" ? b.told : {};

  try {
    // Jev reads the question (topic, intent, cards) while the LLM writes the answer.
    const reading = jevOn() ? jev.read(config, q, ctx).catch((e) => { console.warn("jev read:", e && e.message); return null; }) : Promise.resolve(null);
    const [out, r] = await Promise.all([ask(q), reading]);
    if (out.refusal) return res.status(200).json({ error: fallback() });
    const p = out.parsed;
    const m = jev.mold(config, r, told);

    let moments = [];
    const dropped = [];
    for (const x of p.moments || []) {
      const v = verifyMoment(x);
      if (v.ok && !moments.some((y) => y.source_id === x.source_id)) moments.push(shapeMoment(x, v));
      else if (!v.ok) dropped.push({ source_id: x.source_id, reason: v.reason });
    }
    if (dropped.length) console.warn("answer: dropped unverified moments", JSON.stringify(dropped));

    // Jev judges the videos: is each verified quote on point, and which clips go in the rail.
    const candidates = railCandidates(q, m.lane, new Set(moments.map((x) => x.source_id)));
    let rail = [], judged = null;
    if (jevOn()) judged = await jev.judge(config, q, moments, candidates).catch((e) => { console.warn("jev judge:", e && e.message); return null; });
    if (judged) {
      const pm = (i) => judged.answers[`m${i}`]?.noul ?? 1;
      const before = moments.length;
      moments = moments.map((x, i) => ({ x, p: pm(i) })).filter(({ p }) => p >= 0.35).sort((a, z) => z.p - a.p).map(({ x, p }) => ({ ...x, relevance: p }));
      if (moments.length < before) m.why.push({ q: "Clips", answer: `dropped ${before - moments.length} quote(s) judged off-topic`, by: "Jev" });
      rail = candidates.map((c, i) => ({ c, p: judged.answers[`v${i}`]?.noul ?? 0 })).filter(({ p }) => p >= 0.5).sort((a, z) => z.p - a.p).slice(0, 4).map(({ c, p }) => ({ ...railItem(c), relevance: p }));
      m.why.push({ q: "More videos", answer: `${rail.length} of ${candidates.length} ${m.lane ? `“${config.jev.lanes[m.lane].label}”` : "candidate"} clips judged worth watching next`, by: "Jev" });
    }

    return res.status(200).json({
      title: p.title,
      paras: p.paras,
      components: compose(p, moments, rail, m),
      ui: { primary: m.primary, popup: m.popup, popup_after_seconds: config.offer.popup_after_seconds || 14 },
      read: { lane: m.lane, intent: m.intent, offers: m.offers, why: m.why, declined: m.declined, jev: r ? { model: r.model, ms: r.ms, cost: r.cost } : null, judge: judged ? { ms: judged.ms, cost: judged.cost } : null },
      moments,
      facts: p.facts,
      dropped: dropped.length,
      model: out.model,
      cache_read_tokens: out.usage?.cache_read_input_tokens ?? null,
      cost: out.usage?.cost ?? null,
    });
  } catch (e) {
    console.error("answer error:", e && e.message);
    return res.status(502).json({ error: "The answer service is unavailable right now. " + (config.offer.fallback || "") });
  }
};


// For tests and tools: the default (bundled) creator's engine pieces.
Object.defineProperty(module.exports, "SCHEMA", { get: () => require("./_creator").bundledEngine().SCHEMA });
Object.defineProperty(module.exports, "INSTRUCTIONS", { get: () => require("./_creator").bundledEngine().INSTRUCTIONS });
