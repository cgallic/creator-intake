/**
 * Claim a preview page: the channel's owner makes it theirs.
 *
 *   GET  /api/claim?c=<slug>                         -> { name, channel, code, claimed, price, paid }
 *   GET  /api/claim?a=price                          -> { price, paid }  (so pages state the real price)
 *   POST /api/claim?a=start    { c, offer_url, offer_label, webhook_url }  -> { id }
 *        queues a claim job; the build worker checks the code is in the channel
 *        description (only the owner can put it there) and marks the job "verified"
 *   POST /api/claim?a=checkout { id }                 -> { url } (Stripe Checkout) or { free: true }
 *   POST /api/claim?a=complete { id, session_id }     -> { url }  checks payment, then
 *        swaps the preview for the owner's page: their next-step link, no "unofficial"
 *        banner, and their lead webhook (kept out of the public config).
 *   POST /api/claim?a=lifetime { c }                  -> { url } Stripe Checkout for Lifetime Pro
 *   POST /api/claim?a=lifetime_done { session_id }    -> { ok, slug } checks payment, records it
 *
 * Claiming is free unless CLAIM_PRICE_CENTS is set above 0 (and STRIPE_SECRET_KEY is set).
 * Lifetime Pro: LIFETIME_PRICE_CENTS (default 9900) once, first LIFETIME_CAP (default 100)
 * buyers, on sale whenever STRIPE_SECRET_KEY is set. Stripe is the count of record.
 */
const crypto = require("node:crypto");
const store = require("./_store");
const { SLUG } = require("./_creator");
const { verifyCode, cleanUrl } = require("./new");

const PRICE = +(process.env.CLAIM_PRICE_CENTS || 0);
const paid = () => PRICE > 0 && !!process.env.STRIPE_SECRET_KEY;
const LIFETIME = +(process.env.LIFETIME_PRICE_CENTS || 9900);
const CAP = +(process.env.LIFETIME_CAP || 100);
const origin = (req) => process.env.PUBLIC_URL || `https://${req.headers["x-forwarded-host"] || req.headers.host}`;

async function stripe(path, form) {
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: form ? "POST" : "GET",
    headers: { authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || `stripe ${r.status}`);
  return d;
}

/** Lifetime deals sold so far, from Stripe itself (cached a minute per instance). */
let soldCache = { n: 0, at: 0 };
async function lifetimeSold() {
  if (Date.now() - soldCache.at < 60000) return soldCache.n;
  let n = 0, page;
  do {
    const d = await stripe(`payment_intents/search?${new URLSearchParams({ query: "metadata['kind']:'lifetime' AND status:'succeeded'", limit: "100", ...(page ? { page } : {}) })}`);
    n += d.data.length;
    page = d.has_more ? d.next_page : null;
  } while (page && n < CAP);
  soldCache = { n, at: Date.now() };
  return n;
}

async function lifetimeInfo() {
  if (!process.env.STRIPE_SECRET_KEY) return { on: false };
  const sold = await lifetimeSold().catch((e) => { console.error("lifetime count:", e.message); return null; });
  if (sold === null) return { on: false };
  return { on: sold < CAP, price: LIFETIME, cap: CAP, left: Math.max(0, CAP - sold) };
}

/** The owner's page: their offer as the next step, no preview banner. */
function ownerConfig(cfg, claim) {
  const watch = (cfg.jev && cfg.jev.moves && cfg.jev.moves.watch) || { label: `Watch ${cfg.short_name} on YouTube`, url: cfg.channels[0] };
  const offer = claim.offer ? { label: claim.offer.label || `See what ${cfg.short_name} offers`, url: claim.offer.url } : null;
  const main = offer || watch;
  const out = { ...cfg };
  delete out.preview;
  out.claimed = { at: new Date().toISOString(), by: "channel description code", paid: !!claim.paid };
  out.rules = ["Never quote a price, a result or a guarantee that isn't in the record."];
  out.known_facts = offer ? [`${cfg.short_name}'s next step for visitors is "${main.label}" (${main.url}).`] : [];
  out.offer = { ...cfg.offer, name: main.label, description: offer ? `${cfg.short_name}'s next step for visitors.` : `${cfg.short_name}'s YouTube channel.`, url: main.url, cta_label: main.label, header_label: main.label, sticky_label: main.label, brief_cta: `Send this to ${cfg.short_name}`, note: "", no_moment: `${main.label} is the next step.`, fallback: `${main.label}.` };
  out.jev = { ...cfg.jev, moves: offer ? { offer, watch } : { watch }, default_move: offer ? "offer" : "watch",
    routes: offer ? { asking: { "*": "watch" }, own_problem: { "*": "offer" }, evaluating: { "*": "offer" }, wants_creator: { "*": "offer" } } : {} };
  out.disclaimer = `Answers on this page are written by an AI from ${cfg.name}'s own videos. Quotes are shown exactly as captioned and play from the second they were said.`;
  out.footer = `© ${new Date().getFullYear()} ${cfg.name}`;
  out.powered_by = { label: "Want one built from your channel?", url: "/new", book_url: "/new" };
  return out;
}

module.exports = async (req, res) => {
  const q = req.query || {}, b = req.body || {};
  try {
    if (req.method === "GET") {
      if (q.a === "price") return res.status(200).json({ price: PRICE, paid: paid(), lifetime: await lifetimeInfo() });
      const c = String(q.c || "");
      if (!SLUG.test(c)) return res.status(404).json({ error: "not found" });
      const cfg = await store.getJSON(`creators/${c}/config.json`);
      if (!cfg) return res.status(404).json({ error: "There's no page for that channel yet." });
      return res.status(200).json({ slug: c, name: cfg.name, short_name: cfg.short_name, channel: cfg.channels[0], code: verifyCode(c), claimed: !!cfg.claimed, price: PRICE, paid: paid() });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "GET or POST" });

    if (q.a === "start") {
      const c = String(b.c || "");
      if (!SLUG.test(c)) return res.status(404).json({ error: "not found" });
      const cfg = await store.getJSON(`creators/${c}/config.json`);
      if (!cfg) return res.status(404).json({ error: "There's no page for that channel yet." });
      if (cfg.claimed) return res.status(409).json({ error: "This page has already been claimed." });
      const offerUrl = b.offer_url ? cleanUrl(b.offer_url) : null;
      if (b.offer_url && !offerUrl) return res.status(400).json({ error: "Your next-step link should be a full web address, starting with https://" });
      const hook = b.webhook_url ? cleanUrl(b.webhook_url) : null;
      if (b.webhook_url && !hook) return res.status(400).json({ error: "The lead webhook should be a full web address, starting with https://" });
      const day = new Date().toISOString().slice(0, 10);
      const id = `${day}/${crypto.randomBytes(8).toString("hex")}`;
      const now = new Date().toISOString();
      await store.putJob(id, {
        id, type: "claim", slug: c, channel: cfg.channels[0], code: verifyCode(c),
        offer: offerUrl ? { url: offerUrl, label: String(b.offer_label || "").trim().slice(0, 40) || null } : null,
        webhook: hook, status: "queued", stage: "queued", detail: "Waiting to check your channel", created_at: now, updated_at: now,
      });
      return res.status(200).json({ id });
    }

    if (q.a === "lifetime") {
      const c = String(b.c || "");
      if (c && !SLUG.test(c)) return res.status(404).json({ error: "not found" });
      const lt = await lifetimeInfo();
      if (!lt.on) return res.status(409).json({ error: "The lifetime deal is sold out." });
      const back = `${origin(req)}/claim?${c ? `c=${c}&` : ""}`;
      const meta = { kind: "lifetime", slug: c || "" };
      const s = await stripe("checkout/sessions", {
        mode: "payment",
        "line_items[0][quantity]": "1",
        "line_items[0][price_data][currency]": "usd",
        "line_items[0][price_data][unit_amount]": String(LIFETIME),
        "line_items[0][price_data][product_data][name]": "Lifetime Pro",
        "line_items[0][price_data][product_data][description]": `One payment, no monthly fee. First ${CAP} creators only.`,
        "metadata[kind]": meta.kind, "metadata[slug]": meta.slug,
        "payment_intent_data[metadata][kind]": meta.kind, "payment_intent_data[metadata][slug]": meta.slug,
        success_url: `${back}lifetime={CHECKOUT_SESSION_ID}`,
        cancel_url: c ? `${origin(req)}/claim?c=${c}` : `${origin(req)}/for-creators`,
      });
      return res.status(200).json({ url: s.url });
    }

    if (q.a === "lifetime_done") {
      const sid = String(b.session_id || "");
      if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sid) || !process.env.STRIPE_SECRET_KEY) return res.status(404).json({ error: "not found" });
      const s = await stripe(`checkout/sessions/${sid}`);
      if (s.metadata?.kind !== "lifetime" || s.payment_status !== "paid") return res.status(402).json({ error: "We couldn't confirm the payment yet. If you paid, refresh in a minute." });
      const slug = SLUG.test(s.metadata.slug || "") ? s.metadata.slug : null;
      await store.putJSON(`lifetime/${sid}.json`, { session: sid, slug, amount: s.amount_total, at: new Date().toISOString() });
      if (slug) {
        const priv = (await store.getJSON(`creators/${slug}/private.json`)) || {};
        await store.putJSON(`creators/${slug}/private.json`, { ...priv, lifetime: { session: sid, at: new Date().toISOString() } });
      }
      soldCache.at = 0;
      return res.status(200).json({ ok: true, slug });
    }

    const id = String(b.id || "");
    if (!/^\d{4}-\d{2}-\d{2}\/[a-f0-9]{16}$/.test(id)) return res.status(404).json({ error: "not found" });
    const job = await store.getJob(id);
    if (!job || job.type !== "claim") return res.status(404).json({ error: "not found" });
    if (job.status !== "verified" && job.status !== "claimed") return res.status(409).json({ error: "We haven't confirmed the code in your channel description yet." });

    if (q.a === "checkout") {
      if (!paid()) return res.status(200).json({ free: true });
      const back = `${origin(req)}/claim?c=${job.slug}&job=${encodeURIComponent(id)}`;
      const s = await stripe("checkout/sessions", {
        mode: "payment",
        "line_items[0][quantity]": "1",
        "line_items[0][price_data][currency]": "usd",
        "line_items[0][price_data][unit_amount]": String(PRICE),
        "line_items[0][price_data][product_data][name]": `Your page: ${job.name || job.slug}`,
        "metadata[job]": id, "metadata[slug]": job.slug,
        success_url: `${back}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: back,
      });
      return res.status(200).json({ url: s.url });
    }

    if (q.a === "complete") {
      if (job.status === "claimed") return res.status(200).json({ url: `/c/${job.slug}` });
      let paidOk = false;
      if (paid()) {
        const s = await stripe(`checkout/sessions/${encodeURIComponent(String(b.session_id || ""))}`);
        if (s.payment_status !== "paid" || s.metadata?.job !== id) return res.status(402).json({ error: "We couldn't confirm the payment yet. If you paid, refresh in a minute." });
        paidOk = true;
      }
      const cfg = await store.getJSON(`creators/${job.slug}/config.json`);
      if (!cfg) return res.status(404).json({ error: "not found" });
      await store.putJSON(`creators/${job.slug}/config.json`, ownerConfig(cfg, { offer: job.offer, paid: paidOk }));
      await store.putJSON(`creators/${job.slug}/private.json`, { webhook: job.webhook || null, claimed_job: id, paid: paidOk, at: new Date().toISOString() });
      await store.updateJob(id, { status: "claimed", stage: "claimed", detail: "It's yours", url: `/c/${job.slug}` });
      return res.status(200).json({ url: `/c/${job.slug}` });
    }
    return res.status(400).json({ error: "unknown action" });
  } catch (e) {
    console.error("claim:", e && e.message);
    return res.status(500).json({ error: "Something went wrong claiming the page. Try again in a minute." });
  }
};

module.exports.ownerConfig = ownerConfig;
