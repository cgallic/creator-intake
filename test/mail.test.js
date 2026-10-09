const test = require("node:test");
const assert = require("node:assert");
const { lifetimeWelcome, send } = require("../api/_mail");

test("lifetime welcome names the buyer and links their page", () => {
  const e = lifetimeWelcome({ name: "Ali Abdaal", slug: "ali-abdaal", origin: "https://connorgallic.com/ask" });
  assert.match(e.text, /^Hi Ali,/);
  assert.match(e.text, /https:\/\/connorgallic\.com\/ask\/c\/ali-abdaal/);
});

test("lifetime welcome without a page points at the builder", () => {
  const e = lifetimeWelcome({ name: "", slug: null, origin: "https://connorgallic.com/ask" });
  assert.match(e.text, /^Hi,/);
  assert.match(e.text, /https:\/\/connorgallic\.com\/ask\/new/);
});

test("send refuses without a Resend key", async () => {
  const k = process.env.RESEND_API_KEY; delete process.env.RESEND_API_KEY;
  await assert.rejects(send({ to: "a@b.co", subject: "x", text: "y" }), /RESEND_API_KEY/);
  if (k) process.env.RESEND_API_KEY = k;
});
