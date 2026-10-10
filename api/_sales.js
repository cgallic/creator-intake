// Lifetime Pro sales: confirm each one once, welcome the buyer, and tell Connor.
// Runs when the buyer lands back on the claim page AND from the build worker's sweep
// (api/worker.js ?a=sales, every minute), so a buyer who closes the tab after paying
// still gets their welcome and Connor still hears about the sale.
// (Underscore file: Vercel does not route it.)
const store = require("./_store");
const mail = require("./_mail");
const { SLUG } = require("./_creator");

const CAP = +(process.env.LIFETIME_CAP || 100);

async function stripeGet(path) {
  const r = await fetch(`https://api.stripe.com/v1/${path}`, { headers: { authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` } });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || `stripe ${r.status}`);
  return d;
}

/** A paid Lifetime Pro checkout session -> recorded, buyer welcomed, Connor told. Idempotent. */
async function settle(s, origin) {
  const sid = s.id;
  const slug = SLUG.test(s.metadata?.slug || "") ? s.metadata.slug : null;
  if (await store.getJSON(`lifetime/${sid}.json`)) return { slug, fresh: false };
  const to = s.customer_details?.email;
  let emailed = false;
  if (to) {
    try {
      await mail.send({ to, ...mail.lifetimeWelcome({ name: s.customer_details?.name, slug, origin }), idempotencyKey: `lifetime-${sid}` });
      emailed = true;
    } catch (e) { console.error("lifetime email:", e.message); }
  }
  const at = new Date().toISOString();
  await store.putJSON(`lifetime/${sid}.json`, { session: sid, slug, amount: s.amount_total, email: to || null, emailed, at });
  if (slug) {
    const priv = (await store.getJSON(`creators/${slug}/private.json`)) || {};
    await store.putJSON(`creators/${slug}/private.json`, { ...priv, lifetime: { session: sid, at } });
  }
  const sold = (await store.list("lifetime/").catch(() => [])).length;
  try {
    await mail.send({ to: mail.OWNER, idempotencyKey: `sale-${sid}`, ...mail.saleNotice({ name: s.customer_details?.name, email: to, amount: s.amount_total, slug, origin, sold, cap: CAP, emailed, paymentIntent: s.payment_intent }) });
  } catch (e) { console.error("sale notice:", e.message); }
  return { slug, fresh: true };
}

/** Settle every paid Lifetime Pro checkout from the last 3 days that isn't recorded yet. */
async function sweep(origin) {
  if (!process.env.STRIPE_SECRET_KEY) return { settled: 0 };
  const since = Math.floor(Date.now() / 1000) - 3 * 86400;
  const d = await stripeGet(`checkout/sessions?${new URLSearchParams({ status: "complete", limit: "100", "created[gte]": String(since) })}`);
  let settled = 0;
  for (const s of d.data || []) {
    if (s.metadata?.kind !== "lifetime" || s.payment_status !== "paid") continue;
    if ((await settle(s, origin)).fresh) settled++;
  }
  return { settled };
}

module.exports = { settle, sweep };
