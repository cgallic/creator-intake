// Which components come back is decided by Jev (TypeSafe's System One decision
// model), not by the LLM. Jev answers a typed questionnaire about what the visitor
// said: one yes/no ("noul") question per optional component, each returned as a
// calibrated probability in ~100-500 ms. Code turns the probabilities into a
// component list with fixed thresholds, so the LLM only writes the words inside
// whichever components Jev picked. Served by OpenRouter (/api/v1/systemone) with
// the same OPENROUTER_API_KEY. (Underscore file: Vercel does not route it.)

const JEV_MODEL = process.env.JEV_MODEL || "typesafe/jev-1.13";

// Built-in components every creator gets. `when` is asked of `said` (the visitor's
// words); `default` is used when Jev can't be reached. The answer itself and the
// verified video moments are not optional: the answer always shows, and a moment
// shows whenever one passed the word-for-word check.
const BUILT_IN = {
  steps: { when: "Does the person who wrote `said` need concrete next steps to act on, rather than an explanation or an opinion?", threshold: 0.4, default: true },
  facts: { when: "Does `said` describe the writer's own situation (their business, project, problem or goal) in enough detail that it is worth noting back to them?", threshold: 0.5, default: true },
  followups: { when: "Is the person who wrote `said` likely to have follow-up questions about this topic?", threshold: 0.4, default: true },
  talk_now: { when: "Does the person who wrote `said` have a live, specific problem in their own business or project that a 30-minute call would help with, as opposed to general curiosity?", threshold: 0.6, default: false },
};

function questionsFor(config) {
  const q = {};
  for (const [id, b] of Object.entries(BUILT_IN)) q[id] = { type: "noul", instructions: b.when };
  for (const card of config.cards || []) q[`card_${card.id}`] = { type: "noul", instructions: card.when };
  return q;
}

async function decide(config, said) {
  const state = { said, about: `${config.name}: ${config.about}` };
  const body = { model: JEV_MODEL, state, questions: questionsFor(config) };
  const started = Date.now();
  const r = await fetch("https://openrouter.ai/api/v1/systemone", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(+(process.env.JEV_TIMEOUT_MS || 4000)),
  });
  const d = await r.json();
  if (!r.ok || !d.answers) throw new Error(`jev ${r.status}: ${JSON.stringify(d.error || d).slice(0, 200)}`);
  const p = {};
  for (const [id, a] of Object.entries(d.answers)) p[id] = typeof a.noul === "number" ? a.noul : null;
  return { p, model: d.model, ms: Date.now() - started, cost: d.usage?.cost ?? null };
}

/** Probabilities -> on/off per component. Missing or failed answers fall back to defaults. */
function pick(config, p) {
  const on = {};
  for (const [id, b] of Object.entries(BUILT_IN)) on[id] = p && typeof p[id] === "number" ? p[id] >= b.threshold : b.default;
  const cards = (config.cards || [])
    .map((c) => ({ c, prob: p ? p[`card_${c.id}`] : null }))
    .filter(({ c, prob }) => typeof prob === "number" && prob >= (c.threshold ?? 0.5))
    .sort((a, b) => b.prob - a.prob)
    .map(({ c }) => c);
  return { on, cards };
}

module.exports = { decide, pick, questionsFor, BUILT_IN, JEV_MODEL };
