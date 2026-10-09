// Jev (TypeSafe's System One decision model, via OpenRouter /api/v1/systemone)
// molds the page. It never writes text: it answers typed questions with calibrated
// probabilities in ~250-500 ms for ~$0.00003, and plain code acts on them.
//
// What one typed question really tells us is its TOPIC (lane) and its INTENT
// (a general question, their own problem, sizing up the product, or wanting the
// creator). That is all Jev decides from the text. Everything else about a stranger
// is unknown until they act: opening a clip, tapping a card, asking again, or
// answering the one-tap question we show only when Jev is unsure. Those actions
// re-mold the page with Jev alone, no LLM. Inferences change the LAYOUT, never the
// words: the answer text is never told what we guessed about the person.
//
// (Underscore file: Vercel does not route it.)

const JEV_MODEL = process.env.JEV_MODEL || "typesafe/jev-1.13";
// OPENROUTER_BASE lets the build worker go through the app's AI proxy (api/ai.js)
// instead of holding the OpenRouter key itself.
const ENDPOINT = `${process.env.OPENROUTER_BASE || "https://openrouter.ai/api/v1"}/systemone`;
const BAR = { lane: 0.6, intent: 0.6 }; // below this, we don't act on it and may ask
const MARGIN = 0.2; // ...and the top answer must beat the runner-up by this much (confidence ignores the runner-up)

const INTENTS = {
  asking: { label: "Just learning", when: "They are asking a general question or are curious about the topic." },
  own_problem: { label: "Fixing my own problem", when: "They describe a problem in their own business or project and want help with it." },
  evaluating: { label: "Sizing up the product", when: "They are checking out the creator's product or service: what it does, what it costs, whether it fits." },
  wants_creator: { label: "Talking to the creator", when: "They want to talk to, hire, or work with the creator directly." },
};

async function ask(state, questions, timeoutMs = 4000) {
  const started = Date.now();
  const r = await fetch(ENDPOINT, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: JEV_MODEL, state, questions }),
    signal: AbortSignal.timeout(+(process.env.JEV_TIMEOUT_MS || timeoutMs)),
  });
  const d = await r.json();
  if (!r.ok || !d.answers) throw new Error(`jev ${r.status}: ${JSON.stringify(d.error || d).slice(0, 200)}`);
  return { answers: d.answers, model: d.model, ms: Date.now() - started, cost: d.usage?.cost ?? null };
}

const laneCriteria = (config) => {
  const c = {};
  for (const [id, l] of Object.entries(config.jev.lanes)) c[id] = l.when;
  return { ...c, other: "None of these topics." };
};

/** The read: topic, intent, and one yes/no per creator card. Runs alongside the LLM. */
function readQuestions(config) {
  const q = {
    lane: { type: "choice", instructions: "Which topic is `said` about? Use `earlier_questions` and `did_on_page` only if `said` builds on them.", criteria: laneCriteria(config) },
    intent: { type: "choice", instructions: `What does the person who wrote \`said\` want from ${config.short_name}'s page right now? \`did_on_page\` is what they have done here since asking; it outweighs the wording of \`said\`.`, criteria: Object.fromEntries(Object.entries(INTENTS).map(([k, v]) => [k, v.when])) },
  };
  for (const card of config.cards || []) q[`card_${card.id}`] = { type: "noul", instructions: card.when };
  // Custom offers: with jev.pick_offer, Jev also chooses which of the creator's offers fits this person.
  const offers = offerList(config);
  if (offers.length > 1) q.offer = { type: "choice", instructions: `Which of ${config.short_name}'s offers fits the person who wrote \`said\` best? Use \`did_on_page\` too.`, criteria: Object.fromEntries(offers.map(([id, m]) => [id, m.when])) };
  return q;
}
const offerList = (config) => (config.jev && config.jev.pick_offer ? Object.entries(config.jev.moves || {}).filter(([, m]) => m.when) : []);

async function read(config, said, { history = [], did = [], cameFrom = "" } = {}) {
  const state = { said, earlier_questions: history.slice(-4), did_on_page: did.slice(-12), came_from: cameFrom || "unknown", creator: `${config.name}: ${config.about}` };
  return ask(state, readQuestions(config));
}

/** Plain code from probabilities (and anything the visitor told us) to the page. */
function mold(config, r, told = {}) {
  const j = config.jev;
  const a = r ? r.answers : {};
  const why = [], declined = [];

  const settle = (key, options, label) => {
    if (told[key] && options[told[key]]) { why.push({ q: label, answer: told[key], confidence: 1, by: "you told us" }); return told[key]; }
    const x = a[key];
    if (!x || !x.choice) { declined.push({ q: label, reason: "Jev unavailable" }); return null; }
    const entry = { q: label, answer: x.choice, confidence: x.confidence ?? 0, probabilities: x.probabilities, by: "Jev" };
    const sorted = Object.values(x.probabilities || {}).sort((p1, p2) => p2 - p1);
    const margin = sorted.length > 1 ? sorted[0] - sorted[1] : 1;
    if (entry.confidence >= BAR[key] && margin >= MARGIN && x.choice !== "other") { why.push(entry); return x.choice; }
    declined.push({ ...entry, reason: x.choice === "other" ? "doesn't fit any of the options, so the page doesn't act on it" : entry.confidence < BAR[key] ? `under ${Math.round(BAR[key] * 100)}% sure, so the page doesn't act on it` : "too close to the runner-up, so the page doesn't act on it" });
    return null;
  };
  const lane = settle("lane", j.lanes, "Topic");
  const intent = settle("intent", INTENTS, "What they want");

  // Primary next step: Jev's offer pick when it's clear -> routes[intent][lane] -> routes[intent]["*"] -> default.
  const route = (intent && (j.routes || {})[intent]) || {};
  let moveId = (lane && route[lane]) || route["*"] || j.default_move;
  let offerOdds = null;
  const o = a.offer;
  if (o && o.probabilities) {
    offerOdds = o.probabilities;
    const sorted = Object.values(o.probabilities).sort((x, y) => y - x);
    const clear = (o.confidence ?? 0) >= 0.5 && sorted[0] - (sorted[1] || 0) >= 0.15;
    if (clear && j.moves[o.choice]) { moveId = o.choice; why.push({ q: "Offer", answer: j.moves[o.choice].label, confidence: o.confidence, by: "Jev" }); }
    else declined.push({ q: "Offer", answer: o.choice, confidence: o.confidence ?? 0, reason: "no clear winner, so the page uses the default", by: "Jev" });
  }
  const m = j.moves[moveId] || j.moves[j.default_move];
  const primary = { id: moveId, label: m.label, url: m.url };

  const cards = (config.cards || [])
    .map((c) => ({ c, p: a[`card_${c.id}`] && typeof a[`card_${c.id}`].noul === "number" ? a[`card_${c.id}`].noul : null }))
    .map((x) => { if (x.p != null) why.push({ q: `Card: ${x.c.title}`, answer: x.p >= (x.c.threshold ?? 0.5) ? "show" : "hide", confidence: x.p, by: "Jev" }); return x; })
    .filter(({ c, p }) => p != null && p >= (c.threshold ?? 0.5))
    .sort((x, y) => y.p - x.p)
    .map(({ c }) => c);

  // Only ask when it matters and we don't know: topic first, then intent. After the answer, optional.
  let clarify = null;
  if (r && !lane && !told.lane) clarify = { key: "lane", question: j.ask_lane || "Which is this closest to?", options: Object.entries(j.lanes).map(([id, l]) => ({ id, label: l.label })) };
  else if (r && !intent && !told.intent) clarify = { key: "intent", question: j.ask_intent || "What would help next?", options: Object.entries(INTENTS).map(([id, i]) => ({ id, label: (j.intent_labels || {})[id] || i.label })) };

  return {
    decided: !!r,
    lane, intent, primary, cards, clarify,
    offers: offerOdds ? offerList(config).map(([id, m]) => ({ id, label: m.label, url: m.url, blurb: m.blurb || "", p: offerOdds[id] ?? 0 })) : null,
    show_facts: intent === "own_problem" || intent === "evaluating" || intent === "wants_creator",
    popup: !!intent && intent !== "asking",
    why, declined,
  };
}

/** After the LLM: is each verified quote really on point, and which clips go in the rail.
    Ranking quality drops when many items share one request (field reports: batching 40
    rows broke a passing ranking test), so items go in small parallel groups of 4. */
async function judge(config, said, moments, candidates) {
  const items = [
    ...moments.map((x, i) => ({ key: `m${i}`, kind: "passage", text: `${x.title}: "${x.quote}"`, q: "Does `item` speak directly to what `said` asks or describes?" })),
    ...candidates.map((x, i) => ({ key: `v${i}`, kind: "video", text: x.title, q: "Would the person who wrote `said` want to watch the video titled `item` next?" })),
  ];
  if (!items.length) return null;
  const groups = [];
  for (let i = 0; i < items.length; i += 4) groups.push(items.slice(i, i + 4));
  const started = Date.now();
  const results = await Promise.all(groups.map((g) => {
    const state = { said, items: Object.fromEntries(g.map((it) => [it.key, it.text])) };
    const questions = Object.fromEntries(g.map((it) => [it.key, { type: "noul", instructions: it.q.replace("`item`", `\`items.${it.key}\``) }]));
    return ask(state, questions, 3000).catch(() => null);
  }));
  const answers = {};
  let cost = 0;
  for (const r of results) if (r) { Object.assign(answers, r.answers); cost += r.cost || 0; }
  if (!Object.keys(answers).length) return null;
  return { answers, ms: Date.now() - started, cost, requests: groups.length };
}

/** Build time: tag clips with their lane, a batch per call. */
async function tagLanes(config, clips) {
  const state = { clips: {} };
  const questions = {};
  clips.forEach((c, i) => {
    state.clips[`c${i}`] = `${c.title}. ${c.lines.filter((l) => l.who !== "other").map((l) => l.text).join(" ").slice(0, 700)}`;
    questions[`c${i}`] = { type: "choice", instructions: `Which topic is the video \`clips.c${i}\` mainly about?`, criteria: laneCriteria(config) };
  });
  return ask(state, questions, 20000);
}

module.exports = { read, mold, judge, tagLanes, readQuestions, INTENTS, BAR, MARGIN, JEV_MODEL };
