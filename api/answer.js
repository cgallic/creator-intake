/**
 * POST /api/answer  { q: string }
 *
 * Answers a visitor's question from what the creator has actually said on the
 * record, and finds the moments where they say it themselves.
 *
 * The whole corpus (every caption line of the creator's own uploads,
 * data/corpus.json) sits in a cached system block, so the model chooses from
 * everything they have said rather than a keyword shortlist. It never writes a
 * quote: it cites a source id and copies a passage, and verifyMoment() keeps the
 * moment only if that passage appears word for word in one unbroken run of the
 * creator's own lines. A moment that fails is dropped and counted, never shown.
 *
 * Everything creator-specific comes from data/config.json (see
 * creators/_template/config.json).
 */
const config = require("../data/config.json");
const corpus = require("../data/corpus.json");

const MODEL = "claude-opus-5-5";
const WHO = config.short_name;
const LABEL = WHO.toUpperCase().replace(/[^A-Z0-9]+/g, "_");

/* ---------- corpus ---------- */
const mmss = (t) => `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
const SOURCES = new Map(corpus.clips.map((c) => [c.id, c]));

const CORPUS_TEXT = [
  `<clips note="${config.name}'s own YouTube uploads. Lines are captions; [m:ss] = seconds into the video. ${LABEL} lines are ${config.name}. OTHER lines are someone else (an interviewer, a guest): context only, never quote them.">`,
  ...corpus.clips.map((c) =>
    `<clip id="${c.id}" published="${c.published || ""}" title="${c.title.replace(/"/g, "'")}">\n${c.lines.map((l) => `[${mmss(l.t)}] ${l.who === "other" ? "OTHER" : LABEL}: ${l.text}`).join("\n")}\n</clip>`),
  `</clips>`,
].join("\n");

const fieldList = (config.intake.fields || []);
const bullets = (xs) => (xs || []).map((x) => `- ${x}`).join("\n");

const INSTRUCTIONS = `You are the guide on ${config.name}'s "ask me" page. ${config.about}

Who is asking: ${config.audience || "people who found " + WHO + "'s videos and want help with their own situation."}

What ${WHO} offers next: ${config.offer.name}. ${config.offer.description || ""}

Someone describes their situation or asks a question in their own words. You do three things:

1. ANSWER them plainly, using what ${WHO} says in the record below as your source of truth for advice, opinions, numbers and how-to. You are the guide, not ${WHO}: refer to ${WHO} in the third person ("${WHO}'s take is..."), never write as if you were ${WHO}. If the record does not cover what they asked, say ${WHO} hasn't covered that on the record yet and point them to ${config.offer.name} rather than filling the gap yourself.
2. FIND THE MOMENTS where ${WHO} speaks to their situation in their own words on video. For each, give the source id and copy a passage of 12-45 words EXACTLY as it appears in that source: same words, same order, from a single source, no ellipses, no edits, no stitching across non-adjacent lines. Only ${LABEL} lines may be quoted; a passage that touches an OTHER line is rejected. Bracketed timestamps and the line labels are not part of the passage. Best moment first; at most 3; only moments that genuinely address this person. If nothing fits, return an empty list.
3. NOTE THE FACTS they told you, only what they actually said. Never infer a detail they did not mention.

Things that are true about ${WHO} and the offer, which you may state even if the record doesn't:
${bullets(config.known_facts) || "- (none)"}

Rules:
- Speak to them as "you". Short sentences, plain English, direct. Mirror their own details back.
- Never invent a price, a result, a client, a guarantee or a statistic that is not in the record or the list above.
- In "paras" you may wrap the single most important phrase of each paragraph in <strong></strong>. No other markup.
- In "steps" you may wrap each step's lead clause in <b></b>. No other markup, and no markdown (no ** or #).
${bullets(config.rules)}
- If the question has nothing to do with what ${WHO} covers, answer briefly and say what ${WHO} does.`;

const factProps = { situation: { type: "string", description: "2-5 word label for their situation, in plain words." } };
for (const f of fieldList) {
  factProps[f.key] = f.list
    ? { type: "array", items: { type: "string" }, description: f.description || f.label }
    : { type: ["string", "null"], description: (f.description || f.label) + " Null if they did not say." };
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "paras", "steps", "moments", "facts", "followups"],
  properties: {
    title: { type: "string", description: "One direct headline that mirrors their situation." },
    paras: { type: "array", items: { type: "string" }, description: "Two short paragraphs: the straight answer, then the catch or the thing most people miss." },
    steps: { type: "array", items: { type: "string" }, description: "Three or four concrete next steps." },
    moments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["source_id", "passage", "why"],
        properties: {
          source_id: { type: "string" },
          passage: { type: "string", description: "12-45 words copied exactly from the source." },
          why: { type: "string", description: "Under 12 words: why this moment answers them." },
        },
      },
    },
    facts: { type: "object", additionalProperties: false, required: Object.keys(factProps), properties: factProps },
    followups: { type: "array", items: { type: "string" }, description: "Three short questions this person is likely to ask next, in their voice." },
  },
};

/* ---------- verification (api/_verify.js) ---------- */
const { verifyMoment: verifyIn } = require("./_verify");
const verifyMoment = (m) => verifyIn(m, SOURCES);

function shapeMoment(m, v) {
  const s = v.src;
  return {
    source_id: s.id, title: s.title, t: v.t, quote: m.passage.trim(), why: m.why,
    youtube_id: s.youtube_id, published: s.published, seconds: s.seconds, thumb: s.thumb, vertical: !!s.vertical,
    links: s.links || [], url: `https://www.youtube.com/watch?v=${s.youtube_id}&t=${v.t}s`,
  };
}

/* ---------- handler ---------- */
// Two backends, picked by which key is set. OpenRouter (default model: GPT-6 Luna,
// $0.10/M input, $0.01/M cached; measured ~$0.002 per cached question) is the cheap path; ANTHROPIC_API_KEY alone
// uses Opus directly. ANSWER_MODEL overrides the model on either.
const RECORD = `<record creator="${config.name}">
${CORPUS_TEXT}
</record>`;
const USER = (q) => `What they told us, in their words:
<said>${q}</said>`;
let client = null;

async function askOpenRouter(q) {
  const model = process.env.ANSWER_MODEL || "openai/gpt-6-luna";
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "content-type": "application/json",
      "http-referer": config.canonical_url || "https://github.com/cgallic/creator-intake",
      "x-title": `Ask ${WHO}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 4000,
      messages: [
        { role: "system", content: [
          { type: "text", text: INSTRUCTIONS },
          { type: "text", text: RECORD, cache_control: { type: "ephemeral" } },
        ] },
        { role: "user", content: USER(q) },
      ],
      response_format: { type: "json_schema", json_schema: { name: "answer", strict: true, schema: SCHEMA } },
      usage: { include: true },
      // ANSWER_IGNORE_PROVIDERS: comma-separated OpenRouter provider slugs a router
      // model must not route to (e.g. "google-vertex,google-ai-studio").
      ...(process.env.ANSWER_IGNORE_PROVIDERS ? { provider: { ignore: process.env.ANSWER_IGNORE_PROVIDERS.split(",").map((x) => x.trim()).filter(Boolean) } } : {}),
    }),
  });
  const d = await r.json();
  if (!r.ok || d.error) throw new Error(`openrouter ${r.status}: ${JSON.stringify(d.error || d).slice(0, 300)}`);
  const choice = d.choices?.[0];
  if (choice?.finish_reason === "content_filter") return { refusal: true };
  const text = String(choice?.message?.content || "").replace(/^```(?:json)?\s*|\s*```$/g, "");
  return { parsed: JSON.parse(text), usage: { cache_read_input_tokens: d.usage?.prompt_tokens_details?.cached_tokens ?? null, cost: d.usage?.cost ?? null }, model: d.model };
}

async function askAnthropic(q) {
  client = client || new (require("@anthropic-ai/sdk"))();
  const response = await client.beta.messages.create({
    model: process.env.ANSWER_MODEL || MODEL,
    max_tokens: 8000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    system: [
      { type: "text", text: INSTRUCTIONS },
      { type: "text", text: RECORD, cache_control: { type: "ephemeral", ttl: "1h" } },
    ],
    messages: [{ role: "user", content: USER(q) }],
  });
  if (response.stop_reason === "refusal") return { refusal: true };
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return { parsed: JSON.parse(text), usage: response.usage, model: response.model };
}

const ask = (q) => (process.env.OPENROUTER_API_KEY ? askOpenRouter(q) : askAnthropic(q));

const guard = require("./_guard");
const jev = require("./_jev");

/* Rail candidates: clips from the visitor's topic lane (tagged at build time by
   build/tag-lanes.mjs), not already quoted, pre-sorted by word overlap with what they
   said so Jev only judges ~16. Unknown lane: the whole corpus, same pre-sort. */
const STOP = new Set("the a an and or but to of in on for with is are was it i my me you your we our this that what how do does can should at by from be have has not just so if about".split(" "));
const words = (t) => new Set(String(t).toLowerCase().match(/[a-z0-9']{3,}/g)?.filter((w) => !STOP.has(w)) || []);
function railCandidates(said, lane, exclude, n = 16) {
  const want = words(said);
  return corpus.clips
    .filter((c) => !exclude.has(c.id) && (!lane || c.lane === lane))
    .map((c) => {
      const w = words(c.title + " " + c.lines.slice(0, 4).map((l) => l.text).join(" "));
      let o = 0;
      for (const x of want) if (w.has(x)) o++;
      return { c, o };
    })
    .sort((a, b) => b.o - a.o || String(b.c.published).localeCompare(String(a.c.published)))
    .slice(0, n)
    .map(({ c }) => c);
}
const railItem = (c) => ({ source_id: c.id, title: c.title, youtube_id: c.youtube_id, seconds: c.seconds, thumb: c.thumb, vertical: !!c.vertical, published: c.published, links: c.links || [], t: 0, url: c.url });

/* The response is a component list (A2UI-style). Jev's read decides the layout; the
   LLM's text fills it; config.cards are the creator's fixed cards. */
function compose(p, moments, rail, m) {
  const c = [{ type: "answer", column: "main", title: p.title, paras: p.paras }];
  c.push(moments[0] ? { type: "moment", column: "main", moment: moments[0] } : { type: "no_moment", column: "main" });
  if (moments.length > 1) c.push({ type: "more_moments", column: "main", moments: moments.slice(1) });
  if ((p.steps || []).length) c.push({ type: "steps", column: "main", steps: p.steps });
  if (rail.length) c.push({ type: "rail", column: "main", clips: rail });
  if (m.clarify) c.push({ type: "clarify", column: "side", ...m.clarify });
  c.push(m.show_facts ? { type: "facts", column: "side", facts: p.facts } : { type: "offer", column: "side" });
  for (const card of m.cards) c.push({ type: "card", column: "side", id: card.id, kicker: card.kicker, title: card.title, body: card.body, button: card.button, secondary: card.secondary });
  if ((p.followups || []).length) c.push({ type: "followups", column: "side", followups: p.followups });
  return c;
}

const fallback = () => `We couldn't answer that here. ${config.offer.fallback || ""}`.trim();
const jevOn = () => !!(process.env.OPENROUTER_API_KEY && process.env.JEV_OFF !== "1" && config.jev);

module.exports = async (req, res) => {
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
      read: { lane: m.lane, intent: m.intent, why: m.why, declined: m.declined, jev: r ? { model: r.model, ms: r.ms, cost: r.cost } : null, judge: judged ? { ms: judged.ms, cost: judged.cost } : null },
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

module.exports.verifyMoment = verifyMoment;
module.exports.SCHEMA = SCHEMA;
module.exports.INSTRUCTIONS = INSTRUCTIONS;
