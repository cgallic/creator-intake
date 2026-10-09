// The guarantee: a quote reaches the page only if it is in the cited source,
// word for word, spoken by the creator, and it plays from the second it is said.
const test = require("node:test");
const assert = require("node:assert");
const { verifyMoment } = require("../api/_verify.js");

const clip = {
  id: "c001",
  lines: [
    { t: 0, who: "creator", text: "If you miss a call while you're on a job, that customer calls the next name on Google." },
    { t: 6, who: "creator", text: "Most owners never see it happen because nobody tells you about the call you didn't take." },
    { t: 12, who: "creator", text: "So the first thing I'd fix is making sure every single call gets answered by somebody." },
    { t: 19, who: "creator", text: "It doesn't have to be expensive, it just has to happen every time the phone rings." },
  ],
};
const interview = {
  id: "c002",
  lines: [
    { t: 0, who: "other", text: "So what would you tell somebody who is just starting out with AI agents today?" },
    { t: 5, who: "creator", text: "Start with one boring task you do every day and hand exactly that to the agent first." },
    { t: 11, who: "creator", text: "Watch it do the job for a week before you give it anything that touches customers." },
  ],
};
const sources = new Map([[clip.id, clip], [interview.id, interview]]);
const words = (s) => s.split(/\s+/);

test("a passage from the middle of a clip verifies and starts at its line", () => {
  const passage = words(clip.lines[1].text + " " + clip.lines[2].text).slice(0, 14).join(" ");
  const v = verifyMoment({ source_id: "c001", passage }, sources);
  assert.ok(v.ok, v.reason);
  assert.strictEqual(v.t, 6);
});

test("a passage that starts mid-line takes that line's second", () => {
  const passage = words(clip.lines[2].text).slice(5).join(" ") + " " + words(clip.lines[3].text).slice(0, 4).join(" ");
  const v = verifyMoment({ source_id: "c001", passage }, sources);
  assert.ok(v.ok, v.reason);
  assert.strictEqual(v.t, 12);
});

test("case, punctuation and curly quotes do not matter; words do", () => {
  const passage = clip.lines[0].text.toUpperCase().replace(/'/g, "’") + "!";
  assert.ok(verifyMoment({ source_id: "c001", passage }, sources).ok);
});

test("one changed word fails", () => {
  const w = words(clip.lines[0].text); w[3] = "answer";
  assert.strictEqual(verifyMoment({ source_id: "c001", passage: w.join(" ") }, sources).ok, false);
});

test("a real passage cited to the wrong source fails", () => {
  assert.strictEqual(verifyMoment({ source_id: "c002", passage: clip.lines[0].text }, sources).ok, false);
});

test("passages stitched from non-adjacent lines fail", () => {
  const passage = words(clip.lines[0].text).slice(0, 6).concat(words(clip.lines[3].text).slice(0, 6)).join(" ");
  assert.strictEqual(verifyMoment({ source_id: "c001", passage }, sources).ok, false);
});

test("unknown sources and too-short passages fail", () => {
  assert.strictEqual(verifyMoment({ source_id: "c999", passage: clip.lines[0].text }, sources).ok, false);
  assert.strictEqual(verifyMoment({ source_id: "c001", passage: "if you miss a call" }, sources).ok, false);
});

test("another speaker's words are never quotable as the creator's", () => {
  const v = verifyMoment({ source_id: "c002", passage: interview.lines[0].text }, sources);
  assert.strictEqual(v.ok, false);
  assert.match(v.reason, /another speaker/);
});

test("a passage running from the interviewer into the creator's answer fails", () => {
  const passage = words(interview.lines[0].text).slice(-5).concat(words(interview.lines[1].text).slice(0, 8)).join(" ");
  assert.strictEqual(verifyMoment({ source_id: "c002", passage }, sources).ok, false);
});

test("the creator's answer after an interviewer line verifies at its own second", () => {
  const v = verifyMoment({ source_id: "c002", passage: interview.lines[1].text }, sources);
  assert.ok(v.ok, v.reason);
  assert.strictEqual(v.t, 5);
});
