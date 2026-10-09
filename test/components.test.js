// Jev decides which components come back; code applies the thresholds.
const test = require("node:test");
const assert = require("node:assert");
const { pick, questionsFor, BUILT_IN } = require("../api/_jev.js");

const config = {
  cards: [
    { id: "demo", when: "Is `said` about phone calls?", threshold: 0.5, title: "Demo" },
    { id: "pricing", when: "Does `said` ask about price?", threshold: 0.5, title: "Pricing" },
    { id: "talk", when: "Do they want to talk?", title: "Talk" },
  ],
};

test("one noul question per built-in and per card, asked about `said`", () => {
  const q = questionsFor(config);
  assert.deepStrictEqual(Object.keys(q).sort(), [...Object.keys(BUILT_IN), "card_demo", "card_pricing", "card_talk"].sort());
  for (const v of Object.values(q)) assert.strictEqual(v.type, "noul");
});

test("cards at or over threshold show, highest probability first", () => {
  const { cards } = pick(config, { card_demo: 0.62, card_pricing: 0.91, card_talk: 0.3 });
  assert.deepStrictEqual(cards.map((c) => c.id), ["pricing", "demo"]);
});

test("built-ins follow their thresholds", () => {
  const { on } = pick(config, { steps: 0.1, facts: 0.9, followups: 0.4, talk_now: 0.7 });
  assert.deepStrictEqual(on, { steps: false, facts: true, followups: true, talk_now: true });
});

test("Jev unavailable: built-in defaults, no cards", () => {
  const { on, cards } = pick(config, null);
  assert.deepStrictEqual(on, { steps: true, facts: true, followups: true, talk_now: false });
  assert.strictEqual(cards.length, 0);
});

test("the answer endpoint returns Jev's components alongside the LLM's words", async () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  delete require.cache[require.resolve("../api/answer.js")];
  const llm = { title: "T", paras: ["p"], steps: ["s"], moments: [], facts: { situation: "x" }, followups: ["f"] };
  global.fetch = async (url) => {
    url = String(url);
    if (url.endsWith("/api/v1/key")) return { ok: true, json: async () => ({ data: { usage_daily: 0, usage_monthly: 0 } }) };
    if (url.endsWith("/systemone")) return { ok: true, json: async () => ({ model: "jev-test", answers: { steps: { noul: 0.1 }, facts: { noul: 0.8 }, followups: { noul: 0.9 }, talk_now: { noul: 0.2 } } }) };
    return { ok: true, json: async () => ({ model: "llm-test", choices: [{ message: { content: JSON.stringify(llm) } }], usage: {} }) };
  };
  const handler = require("../api/answer.js");
  const res = { status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; } };
  await handler({ method: "POST", body: { q: "hello there" }, headers: { "x-visitor": "comp-test" } }, res);
  assert.strictEqual(res.code, 200, JSON.stringify(res.body));
  const types = res.body.components.map((c) => c.type);
  assert.ok(types.includes("answer") && types.includes("facts") && types.includes("followups"));
  assert.ok(!types.includes("steps"), "Jev said no steps");
  assert.strictEqual(res.body.decided_by.model, "jev-test");
});
