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

test("sale notice tells Connor who bought, the count, and whether the welcome went out", () => {
  const { saleNotice } = require("../api/_mail");
  const n = saleNotice({ name: "Ali Abdaal", email: "ali@x.co", amount: 9900, slug: "ali-abdaal", origin: "https://connorgallic.com/ask", sold: 3, cap: 100, emailed: false, paymentIntent: "pi_1" });
  assert.match(n.subject, /\$99 to ali@x\.co/);
  assert.match(n.text, /Sold so far: 3 of 100/);
  assert.match(n.text, /connorgallic\.com\/ask\/c\/ali-abdaal/);
  assert.match(n.text, /did NOT go out\. Write to ali@x\.co yourself/);
});
