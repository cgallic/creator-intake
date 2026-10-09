/**
 * POST /api/lead  { name, contact, when, comments, said, facts, clip }
 *
 * Hands the pre-filled brief to wherever the creator takes leads: LEAD_WEBHOOK_URL
 * (Zapier, Make, n8n, a CRM, KaiCalls...) receives the JSON below. Without it the
 * endpoint answers { sent: false } and the page says plainly that nothing was sent.
 */
const { configFor } = require("./_creator");

const clip = (s, n) => String(s ?? "").trim().slice(0, n);

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST" });
  let config;
  try { config = await configFor(req.query && req.query.c); } catch (_) { return res.status(404).json({ error: "No page here yet." }); }
  const b = req.body || {};
  const lead = {
    creator: config.slug,
    offer: config.offer.name,
    name: clip(b.name, 120),
    contact: clip(b.contact, 200),
    when: clip(b.when, 60),
    comments: clip(b.comments, 2000),
    said: clip(b.said, 1200),
    facts: b.facts && typeof b.facts === "object" ? b.facts : {},
    clip: clip(b.clip, 300),
    page: clip(req.headers.referer, 300),
    at: new Date().toISOString(),
  };
  if (!lead.contact) return res.status(400).json({ error: "Add an email or phone so we can reach you." });

  const url = process.env.LEAD_WEBHOOK_URL;
  if (!url) { console.warn("lead: LEAD_WEBHOOK_URL not set, not sent", lead.creator); return res.status(200).json({ sent: false }); }
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(lead) });
    if (!r.ok) throw new Error(`webhook ${r.status}`);
    return res.status(200).json({ sent: true });
  } catch (e) {
    console.error("lead error:", e && e.message);
    return res.status(502).json({ error: "We couldn't send that just now." });
  }
};
