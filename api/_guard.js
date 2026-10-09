// Shared by /api/answer and /api/mold: the spend cap and the per-visitor rate limit.
// (Underscore file: Vercel does not route it.)

/* Spend cap. OpenRouter keeps a running total per key (usage_daily / usage_monthly,
   in USD). Before each question we read it (cached 30s per instance) and stop
   answering once either cap is hit. The counter is per key, so if the key is
   shared with another app, that app's spend counts too and the cap trips early;
   a key of its own makes the cap exact. Fails closed: if the counter can't be
   read, we don't answer. */
const DAILY_CAP = +(process.env.ANSWER_DAILY_CAP_USD || 5);
const MONTHLY_CAP = +(process.env.ANSWER_MONTHLY_CAP_USD || 30);
let spend = { at: 0, daily: 0, monthly: 0 };
async function overCap() {
  if (!process.env.OPENROUTER_API_KEY) return false;
  if (Date.now() - spend.at > 30e3) {
    try {
      const r = await fetch("https://openrouter.ai/api/v1/key", { headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` } });
      const d = (await r.json()).data || {};
      spend = { at: Date.now(), daily: +d.usage_daily || 0, monthly: +d.usage_monthly || 0 };
    } catch (e) {
      console.error("spend check failed:", e && e.message);
      return true;
    }
  }
  return spend.daily >= DAILY_CAP || spend.monthly >= MONTHLY_CAP;
}

// Best-effort, per function instance. A visitor is the page's random visitor id
// (x-visitor), falling back to IP: behind a proxy rewrite (e.g. connorgallic.com/ask)
// every request arrives from the proxy's IP. ANSWER_CAP_PER_HOUR is the spend guard
// across all visitors. Real protection for a big public push is a Vercel Firewall
// rate limit on /api/answer (see README).
const hits = new Map();
const PER_VISITOR = +(process.env.ANSWER_LIMIT_PER_HOUR || 30);
const PER_INSTANCE = +(process.env.ANSWER_CAP_PER_HOUR || 300);
function limited(who) {
  const now = Date.now(), fresh = (k) => (hits.get(k) || []).filter((t) => now - t < 3600e3);
  const mine = fresh(who), all = fresh("*");
  mine.push(now); all.push(now); hits.set(who, mine); hits.set("*", all);
  return mine.length > PER_VISITOR || all.length > PER_INSTANCE;
}

function visitorOf(req) {
  return String(req.headers["x-visitor"] || "").slice(0, 64) || String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
}

module.exports = { overCap, limited, visitorOf, spend: () => spend, DAILY_CAP, MONTHLY_CAP };
