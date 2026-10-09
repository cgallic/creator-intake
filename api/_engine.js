/**
 * The answer engine for one creator: their instructions, schema, cached record of
 * every caption line, quote verification, the rail, and the component layout.
 * Built once per creator per instance (build() is cached by api/_creator.js).
 * (Underscore file: Vercel does not route it.)
 */
const guard = require("./_guard");
const jev = require("./_jev");
const { verifyMoment: verifyIn } = require("./_verify");

let client = null;

function build(config, corpus) {
  // Non-speech caption annotations ([Music], [cough]) are never part of what the creator said.
  for (const c of corpus.clips) c.lines = c.lines.map((l) => ({ ...l, text: l.text.replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim() })).filter((l) => l.text);
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


  /* Rail candidates: clips from the visitor's topic lane (tagged at build time by
     build/tag-lanes.mjs), not already quoted, pre-sorted by word overlap with what they
     said so Jev only judges ~16. Unknown lane: the whole corpus, same pre-sort. */
  const STOP = new Set("the a an and or but to of in on for with is are was it i my me you your we our this that what how do does can should at by from be have has not just so if about".split(" "));
  const words = (t) => new Set(String(t).toLowerCase().match(/[a-z0-9']{3,}/g)?.filter((w) => !STOP.has(w)) || []);
  function railCandidates(said, lane, exclude, n = 16) {
    const want = words(said);
    return corpus.clips
      .filter((c) => !exclude.has(c.id) && (!lane || c.lane === lane))
    .filter((c, i, a) => { const k = c.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); return a.findIndex((x) => x.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() === k) === i; })
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

  /* Clips first: a word search over the creator's own caption lines, so the right clip
     can play in about a second while the writer drafts the answer. Each window is one
     or two consecutive lines of the creator talking, so its text is a verbatim quote. */
  const stem = (w) => w.replace(/(ing|ed|es|s)$/, "");
  const terms = (t) => (String(t).toLowerCase().match(/[a-z0-9']{3,}/g) || []).filter((w) => !STOP.has(w)).map(stem);
  let WINDOWS = null;
  const DF = new Map();
  function windows() {
    if (WINDOWS) return WINDOWS;
    WINDOWS = [];
    for (const c of corpus.clips) {
      const titleT = new Set(terms(c.title));
      for (let i = 0; i < c.lines.length; i++) {
        const a = c.lines[i], b = c.lines[i + 1];
        if (a.who === "other") continue;
        const text = b && b.who !== "other" ? `${a.text} ${b.text}` : a.text;
        if (text.split(/\s+/).length < 10) continue;
        const set = new Set(terms(text));
        WINDOWS.push({ clip: c, t: a.t, text, set, titleT });
        for (const w of set) DF.set(w, (DF.get(w) || 0) + 1);
      }
    }
    return WINDOWS;
  }
  function quickCandidates(q, n = 12) {
    const W = windows(), N = W.length || 1, want = [...new Set(terms(q))];
    const idf = (w) => Math.log(1 + N / (1 + (DF.get(w) || 0)));
    const scored = [];
    for (const w of W) {
      let sc = 0;
      for (const x of want) { if (w.set.has(x)) sc += idf(x); if (w.titleT.has(x)) sc += 0.5 * idf(x); }
      if (sc > 0) scored.push({ w, sc });
    }
    scored.sort((a, b) => b.sc - a.sc);
    const out = [], seen = new Set();
    for (const { w } of scored) {
      if (seen.has(w.clip.id)) continue;
      seen.add(w.clip.id);
      out.push({ source_id: w.clip.id, title: w.clip.title, quote: w.text.split(/\s+/).slice(0, 45).join(" ") });
      if (out.length >= n) break;
    }
    return out;
  }

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

  return { config, corpus, WHO, SCHEMA, INSTRUCTIONS, ask, verifyMoment, shapeMoment, railCandidates, railItem, quickCandidates, compose, fallback, jevOn };
}

module.exports = { build, guard, jev };
