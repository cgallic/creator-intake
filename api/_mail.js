// Email through Resend, from the verified updates.connorgallic.com domain.
// (Underscore file: Vercel does not route it.)
const FROM = process.env.MAIL_FROM || "Connor Gallic <connor@updates.connorgallic.com>";
const OWNER = process.env.OWNER_EMAIL || "connor@kaicalls.com";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function send({ to, subject, text, idempotencyKey }) {
  if (!process.env.RESEND_API_KEY) throw new Error("RESEND_API_KEY not set");
  const html = text.split("\n\n").map((p) => `<p>${esc(p).replace(/\n/g, "<br>").replace(/(https:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')}</p>`).join("");
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json", ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) },
    body: JSON.stringify({ from: FROM, to: [to], ...(to === OWNER ? {} : { bcc: [OWNER] }), reply_to: OWNER, subject, text, html }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.message || `resend ${r.status}`);
  return d.id;
}

/** The welcome a Lifetime Pro buyer gets the moment their payment is confirmed. */
function lifetimeWelcome({ name, slug, origin }) {
  const first = String(name || "").trim().split(/\s+/)[0];
  const page = slug
    ? `Your page: ${origin}/c/${slug}`
    : `If you haven't built your page yet, paste your channel here and it's ready in a few minutes: ${origin}/new`;
  return {
    subject: "Your Lifetime Pro",
    text: `${first ? `Hi ${first},` : "Hi,"}

Thanks for grabbing Lifetime Pro. You're one of the first 100, and you won't pay a monthly fee for it, ever.

What it gets you, as each part ships: a weekly email of what your audience asked, your page on your own domain, and more offers for the page to choose between. I'll email you when each one is ready.

${page}

Reply to this email with where you want people to go next (your course, call or product) and I'll set it up with you.

Connor`,
  };
}

/** Connor's notice of a Lifetime Pro sale. */
function saleNotice({ name, email, amount, slug, origin, sold, cap, emailed, paymentIntent }) {
  const usd = `$${Math.round((amount || 0) / 100)}`;
  const who = [name, email && `<${email}>`].filter(Boolean).join(" ") || "Someone (no email on the checkout)";
  return {
    subject: `Lifetime Pro sold: ${usd}${email ? ` to ${email}` : ""}`,
    text: `${who} bought Lifetime Pro for ${usd}.

${slug ? `Their page: ${origin}/c/${slug}` : "They haven't built a page yet."}
Sold so far: ${sold} of ${cap}.
${paymentIntent ? `In Stripe: https://dashboard.stripe.com/payments/${paymentIntent}` : ""}

${emailed ? "Their welcome email went out (you were bcc'd). Replies come to you." : `Their welcome email did NOT go out${email ? `. Write to ${email} yourself.` : "."}`}`,
  };
}

module.exports = { send, lifetimeWelcome, saleNotice, OWNER };
