/**
 * POST /api/mold  { q, history, did, told }
 *
 * Re-molds the page from what the visitor DID, with Jev alone (no LLM, ~300 ms,
 * ~$0.00003): opened a clip, tapped a card, answered the one-tap question, asked a
 * follow-up. Returns the new primary next step, which cards show, and what Jev now
 * reads. `told` (their own one-tap answers) beats anything Jev infers.
 */
const { configFor } = require("./_creator");
const guard = require("./_guard");
const jev = require("./_jev");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST" });
  let config;
  try { config = await configFor(req.query && req.query.c); } catch (_) { return res.status(404).json({ error: "No page here yet." }); }
  if (!process.env.OPENROUTER_API_KEY || process.env.JEV_OFF === "1" || !config.jev) return res.status(200).json({ skipped: true });
  const b = req.body || {};
  const q = String(b.q || "").trim().slice(0, 1200);
  if (!q) return res.status(400).json({ error: "Missing 'q'." });
  if (guard.limited(guard.visitorOf(req))) return res.status(429).json({ error: "rate limited" });
  if (await guard.overCap()) return res.status(429).json({ error: "cap" });
  const ctx = {
    history: (Array.isArray(b.history) ? b.history : []).map(String).slice(-4),
    did: (Array.isArray(b.did) ? b.did : []).map(String).slice(-12),
  };
  const told = b.told && typeof b.told === "object" ? b.told : {};
  try {
    const r = await jev.read(config, q, ctx);
    const m = jev.mold(config, r, told);
    return res.status(200).json({
      primary: m.primary,
      alternate: m.alternate,
      popup: m.popup,
      clarify: m.clarify,
      show_facts: m.show_facts,
      offers: m.offers,
      cards: m.cards.map((c) => ({ type: "card", column: "side", id: c.id, kicker: c.kicker, title: c.title, body: c.body, button: c.button, secondary: c.secondary })),
      read: { lane: m.lane, intent: m.intent, why: m.why, declined: m.declined, jev: { model: r.model, ms: r.ms, cost: r.cost } },
    });
  } catch (e) {
    console.warn("mold:", e && e.message);
    return res.status(200).json({ skipped: true });
  }
};
