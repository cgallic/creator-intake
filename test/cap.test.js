// The spend cap: once the OpenRouter key's daily or monthly spend reaches the cap,
// /api/answer refuses before calling a model. If the spend can't be read, it refuses too.
const test = require("node:test");
const assert = require("node:assert");

process.env.OPENROUTER_API_KEY = "test-key";
process.env.ANSWER_DAILY_CAP_USD = "5";
process.env.ANSWER_MONTHLY_CAP_USD = "30";

function run(usage, { failSpend = false } = {}) {
  delete require.cache[require.resolve("../api/answer.js")];
  delete require.cache[require.resolve("../api/_guard.js")];
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/api/v1/key")) {
      if (failSpend) throw new Error("network down");
      return { ok: true, json: async () => ({ data: usage }) };
    }
    return { ok: false, status: 500, json: async () => ({ error: "model should not be called in this test" }) };
  };
  const handler = require("../api/answer.js");
  const res = { status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; } };
  return handler({ method: "POST", body: { q: "test" }, headers: { "x-visitor": "t" + Math.random() } }, res).then(() => ({ res, calls }));
}

test("over the daily cap: refuses and never calls a model", async () => {
  const { res, calls } = await run({ usage_daily: 5.01, usage_monthly: 6 });
  assert.strictEqual(res.code, 429);
  assert.ok(!calls.some((u) => u.includes("chat/completions")));
});

test("over the monthly cap: refuses", async () => {
  const { res } = await run({ usage_daily: 0.1, usage_monthly: 30 });
  assert.strictEqual(res.code, 429);
});

test("under both caps: goes on to the model", async () => {
  const { calls } = await run({ usage_daily: 0.5, usage_monthly: 3 });
  assert.ok(calls.some((u) => u.includes("chat/completions")));
});

test("spend unreadable: fails closed", async () => {
  const { res, calls } = await run({}, { failSpend: true });
  assert.strictEqual(res.code, 429);
  assert.ok(!calls.some((u) => u.includes("chat/completions")));
});
