// Jev reads topic + intent; code molds the page. Unknown stays unknown; the visitor's
// own one-tap answers beat inference; only confident, clear-winner reads change anything.
const test = require("node:test");
const assert = require("node:assert");
const { mold, readQuestions, INTENTS } = require("../api/_jev.js");

const config = {
  name: "Creator", short_name: "C", about: "makes videos",
  offer: { cta_label: "Book a call", url: "https://book" },
  jev: {
    lanes: { phones: { label: "Phones", when: "phone stuff" }, agents: { label: "Agents", when: "agent stuff" } },
    moves: { book: { label: "Book", url: "https://book" }, demo: { label: "Call the demo", url: "tel:1" }, watch: { label: "Watch more", url: "https://yt" } },
    default_move: "book",
    routes: { own_problem: { phones: "demo", "*": "book" }, asking: { "*": "watch" } },
  },
  cards: [{ id: "pricing", when: "price?", title: "Pricing" }, { id: "demo", when: "phones?", title: "Demo" }],
};
const choice = (c, probs, confidence) => ({ type: "choice", choice: c, confidence, probabilities: probs });
const read = (answers) => ({ answers, model: "jev-test", ms: 1, cost: 0 });

test("questions: lane + intent choices and one noul per card", () => {
  const q = readQuestions(config);
  assert.deepStrictEqual(Object.keys(q).sort(), ["card_demo", "card_pricing", "intent", "lane"]);
  assert.deepStrictEqual(Object.keys(q.lane.criteria).sort(), ["agents", "other", "phones"]);
  assert.deepStrictEqual(Object.keys(q.intent.criteria).sort(), Object.keys(INTENTS).sort());
});

test("confident topic + intent pick the route's next step and the cards", () => {
  const m = mold(config, read({
    lane: choice("phones", { phones: 0.9, agents: 0.1 }, 0.9),
    intent: choice("own_problem", { own_problem: 0.85, asking: 0.15 }, 0.85),
    card_pricing: { type: "noul", noul: 0.2 },
    card_demo: { type: "noul", noul: 0.8 },
  }));
  assert.strictEqual(m.primary.id, "demo");
  assert.deepStrictEqual(m.cards.map((c) => c.id), ["demo"]);
  assert.strictEqual(m.clarify, null);
  assert.strictEqual(m.show_facts, true);
  assert.strictEqual(m.popup, true);
});

test("a near-tie is not knowledge: the page asks instead of guessing", () => {
  const m = mold(config, read({
    lane: choice("phones", { phones: 0.55, agents: 0.45 }, 0.7),
    intent: choice("asking", { asking: 0.9, own_problem: 0.1 }, 0.9),
  }));
  assert.strictEqual(m.lane, null);
  assert.strictEqual(m.clarify.key, "lane");
  assert.ok(m.declined.some((d) => d.q === "Topic"));
});

test("what the visitor told us beats inference", () => {
  const m = mold(config, read({
    lane: choice("agents", { agents: 0.9, phones: 0.1 }, 0.9),
    intent: choice("asking", { asking: 0.9 }, 0.9),
  }), { lane: "phones", intent: "own_problem" });
  assert.strictEqual(m.lane, "phones");
  assert.strictEqual(m.primary.id, "demo");
  assert.ok(m.why.some((w) => w.by === "you told us"));
});

test("someone just asking gets no pop-up and no facts card", () => {
  const m = mold(config, read({
    lane: choice("agents", { agents: 0.95, phones: 0.05 }, 0.95),
    intent: choice("asking", { asking: 0.9, own_problem: 0.1 }, 0.9),
  }));
  assert.strictEqual(m.popup, false);
  assert.strictEqual(m.show_facts, false);
  assert.strictEqual(m.primary.id, "watch");
});

test("Jev unavailable: default next step, nothing asked, nothing guessed", () => {
  const m = mold(config, null);
  assert.strictEqual(m.primary.id, "book");
  assert.strictEqual(m.clarify, null);
  assert.strictEqual(m.cards.length, 0);
  assert.strictEqual(m.popup, false);
});

test("the answer endpoint: Jev read + judged videos come back as components", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  for (const k of Object.keys(require.cache)) if (/[\\/]api[\\/]/.test(k)) delete require.cache[k];
  const corpus = require("../data/corpus.json");
  const quoted = corpus.clips[0];
  const passage = quoted.lines.filter((l) => l.who !== "other").map((l) => l.text).join(" ").split(/\s+/).slice(0, 12).join(" ");
  const llm = { title: "T", paras: ["p"], steps: ["s"], moments: [{ source_id: quoted.id, passage, why: "w" }], facts: { situation: "x" }, followups: ["f"] };
  global.fetch = async (url, opts) => {
    url = String(url);
    if (url.endsWith("/api/v1/key")) return { ok: true, json: async () => ({ data: { usage_daily: 0, usage_monthly: 0 } }) };
    if (url.endsWith("/systemone")) {
      const body = JSON.parse(opts.body);
      const answers = {};
      for (const k of Object.keys(body.questions)) {
        if (k === "lane") answers.lane = choice("missed_calls", { missed_calls: 0.9, agents: 0.1 }, 0.9);
        else if (k === "intent") answers.intent = choice("own_problem", { own_problem: 0.9, asking: 0.1 }, 0.9);
        else answers[k] = { type: "noul", noul: k.startsWith("v") ? 0.8 : k.startsWith("m") ? 0.9 : 0.1 };
      }
      return { ok: true, json: async () => ({ model: "jev-test", answers, usage: { cost: 0.00001 } }) };
    }
    return { ok: true, json: async () => ({ model: "llm-test", choices: [{ message: { content: JSON.stringify(llm) } }], usage: {} }) };
  };
  const handler = require("../api/answer.js");
  const res = { status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; } };
  await handler({ method: "POST", body: { q: "I miss calls on jobs" }, headers: { "x-visitor": "comp-test" } }, res);
  assert.strictEqual(res.code, 200, JSON.stringify(res.body));
  const types = res.body.components.map((c) => c.type);
  assert.ok(types.includes("moment"), "verified + on-point quote shows");
  assert.ok(types.includes("rail"), "Jev-judged rail shows");
  assert.ok(types.includes("facts"), "own problem shows the facts card");
  assert.strictEqual(res.body.read.lane, "missed_calls");
  assert.strictEqual(res.body.ui.primary.id, "call_demo");
  const rail = res.body.components.find((c) => c.type === "rail");
  assert.ok(rail.clips.length <= 4 && rail.clips.every((c) => c.source_id !== quoted.id));
});

test("custom offers: Jev's clear pick becomes the next step; a close call keeps the default", () => {
  const cfg = { ...config, jev: { ...config.jev, pick_offer: true, moves: {
    book: { label: "Book", url: "https://book", when: "wants to talk" },
    course: { label: "The course", url: "https://course", when: "wants to learn it" },
    watch: { label: "Watch more", url: "https://yt", when: "just curious" },
  } } };
  const q = readQuestions(cfg);
  assert.deepStrictEqual(Object.keys(q.offer.criteria).sort(), ["book", "course", "watch"]);
  const clear = mold(cfg, read({ offer: choice("course", { course: 0.8, book: 0.15, watch: 0.05 }, 0.8) }));
  assert.strictEqual(clear.primary.id, "course");
  assert.strictEqual(clear.offers.find((o) => o.id === "course").p, 0.8);
  const close = mold(cfg, read({ offer: choice("course", { course: 0.45, book: 0.4, watch: 0.15 }, 0.45) }));
  assert.strictEqual(close.primary.id, "course", "the leader, never a lower-rated default");
  assert.strictEqual(close.alternate.id, "book");
  const lead = mold(cfg, read({ offer: choice("course", { course: 0.52, book: 0.34, watch: 0.14 }, 0.4) }));
  assert.strictEqual(lead.primary.id, "course", "52% vs 34% is a clear lead even at modest confidence");
  assert.strictEqual(lead.alternate, null);
  const spread = mold(cfg, read({ offer: choice("course", { course: 0.34, book: 0.33, watch: 0.33 }, 0.2) }));
  assert.strictEqual(spread.primary.id, "course", "spread odds still lead with the best fit");
  assert.strictEqual(spread.alternate.id, "book", "and keep the default beside it");
  assert.ok(spread.declined.some((d) => d.q === "Offer"));
  const loose = mold(cfg, read({ offer: choice("course", { course: 0.42, watch: 0.29, book: 0.28 }, 0.3) }));
  assert.strictEqual(loose.primary.id, "course", "42% vs a 28% default: the leader leads, never the lower default");
  assert.strictEqual(loose.alternate.id, "book", "the default stays beside it");
  const near = mold(cfg, read({ offer: choice("watch", { watch: 0.38, book: 0.35, course: 0.27 }, 0.3) }));
  assert.strictEqual(near.primary.id, "watch", "a 3-point lead still leads; the hero is never below a row");
  assert.strictEqual(near.alternate.id, "book");
});
