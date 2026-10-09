/**
 * POST /api/new  { channel }      -> { id }           queue a page build
 * GET  /api/new?id=<id>           -> the job's status  (polled by new.html)
 *
 * Anyone can paste any channel, so a self-serve page is an UNOFFICIAL PREVIEW:
 * built from public videos, marked as such on the page, kept out of search, and
 * its only next step is the creator's own channel until the owner claims it.
 * Limits: NEW_BUILDS_PER_DAY across everyone (default 40), 3 per visitor per day.
 * A channel built in the last 7 days returns the existing page instead of rebuilding.
 */
const crypto = require("node:crypto");
const store = require("./_store");
const guard = require("./_guard");

const today = () => new Date().toISOString().slice(0, 10);
const perVisitor = new Map();

function parseChannel(raw) {
  const s = String(raw || "").trim();
  const handle = s.match(/^@([A-Za-z0-9._-]{3,40})$/) || s.match(/youtube\.com\/@([A-Za-z0-9._-]{3,40})/i);
  if (handle) return { url: `https://www.youtube.com/@${handle[1]}`, key: handle[1].toLowerCase() };
  const id = s.match(/youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})/);
  if (id) return { url: `https://www.youtube.com/channel/${id[1]}`, key: id[1].toLowerCase() };
  return null;
}
const slugOf = (key) => key.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "creator";

module.exports = async (req, res) => {
  if (req.method === "GET") {
    const id = String((req.query && req.query.id) || "");
    if (!/^\d{4}-\d{2}-\d{2}\/[a-f0-9]{16}$/.test(id)) return res.status(404).json({ error: "not found" });
    const job = await store.getJSON(`jobs/${id}.json`);
    if (!job) return res.status(404).json({ error: "not found" });
    const { channel, status, stage, detail, url, error, created_at, updated_at, name } = job;
    return res.status(200).json({ id, channel, status, stage, detail, url, error, created_at, updated_at, name });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "GET or POST" });

  const ch = parseChannel(req.body && req.body.channel);
  if (!ch) return res.status(400).json({ error: "Paste a YouTube channel link, like youtube.com/@yourname, or just @yourname." });
  const slug = slugOf(ch.key);

  // Built recently? Hand back the page.
  const existing = await store.getJSON(`creators/${slug}/config.json`).catch(() => null);
  if (existing && existing.built_at && Date.now() - Date.parse(existing.built_at) < 7 * 864e5) {
    return res.status(200).json({ ready: true, url: `/c/${slug}` });
  }

  const visitor = guard.visitorOf(req), day = today();
  const vk = `${day}:${visitor}`;
  if ((perVisitor.get(vk) || 0) >= 3) return res.status(429).json({ error: "That's three builds today. Try again tomorrow." });
  const todays = await store.list(`jobs/${day}/`);
  if (todays.length >= +(process.env.NEW_BUILDS_PER_DAY || 40)) return res.status(429).json({ error: "We've hit today's build limit. Try again tomorrow." });
  if (await guard.overCap()) return res.status(429).json({ error: "We've hit today's limit. Try again tomorrow." });
  perVisitor.set(vk, (perVisitor.get(vk) || 0) + 1);

  const id = `${day}/${crypto.randomBytes(8).toString("hex")}`;
  const now = new Date().toISOString();
  await store.putJSON(`jobs/${id}.json`, { id, channel: ch.url, slug, status: "queued", stage: "queued", detail: "Waiting for a builder", created_at: now, updated_at: now });
  return res.status(200).json({ id });
};

module.exports.parseChannel = parseChannel;
module.exports.slugOf = slugOf;
