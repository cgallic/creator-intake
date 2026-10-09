#!/usr/bin/env node
/**
 * node build/stats.mjs <slug>
 *
 * The real numbers behind the for-creators page infographics: how many uploads were
 * looked at, how many had captions, how many were cut and why, what's left, how much
 * of it there is, and how it splits by topic. Also the caption lines around the
 * first demo quote, so the page can show the word-for-word check on real captions.
 * Writes creators/<slug>/stats.json (build/use.mjs copies it into data/).
 */
import fs from "node:fs";
import path from "node:path";
import { creatorDir, loadConfig } from "./config.mjs";

const slug = process.argv[2];
const config = loadConfig(slug);
const dir = creatorDir(slug);
const read = (f, d) => (fs.existsSync(path.join(dir, f)) ? JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) : d);
const corpus = read("corpus.json", { clips: [] });
const screened = read("screened.json", { keep: [], exclude: [] });
const patternOut = read("pattern-excluded.json", []);
const demo = read("demo.json", { visitors: [] });

const capDir = path.join(dir, "captions");
const listed = fs.existsSync(path.join(capDir, "listing.tsv")) ? fs.readFileSync(path.join(capDir, "listing.tsv"), "utf8").split("\n").filter(Boolean).length : null;
const metaRows = new Set();
if (fs.existsSync(capDir)) for (const f of fs.readdirSync(capDir).filter((f) => /^meta(\.\d+)?\.tsv$/.test(f))) for (const r of fs.readFileSync(path.join(capDir, f), "utf8").split("\n")) if (r) metaRows.add(r.split("\t")[0]);
const captioned = fs.existsSync(capDir) ? new Set(fs.readdirSync(capDir).filter((f) => f.endsWith(".json3")).map((f) => f.split(".")[0])).size : null;

const clips = corpus.clips;
const words = clips.reduce((a, c) => a + c.lines.filter((l) => l.who !== "other").reduce((b, l) => b + l.text.split(/\s+/).length, 0), 0);
const seconds = clips.reduce((a, c) => a + (c.seconds || 0), 0);
const lanes = {};
for (const c of clips) lanes[c.lane || "other"] = (lanes[c.lane || "other"] || 0) + 1;

const notOnCamera = screened.exclude.length;
const aiVoice = patternOut.length;
const duplicates = captioned != null ? Math.max(0, captioned - notOnCamera - aiVoice - clips.length) : null;

// Real caption lines around the first demo quote, for the word-for-word check graphic.
let check = null;
const lead = demo.visitors.map((v) => v.components.find((c) => c.type === "moment")).find(Boolean);
if (lead) {
  const clip = clips.find((c) => c.title === lead.title);
  if (clip) {
    const i = Math.max(0, clip.lines.findIndex((l) => l.t >= lead.t) - 0);
    check = { title: clip.title, quote: lead.quote, t: lead.t, lines: clip.lines.slice(i, i + 5).map((l) => ({ t: l.t, text: l.text, who: l.who })) };
  }
}

const stats = {
  creator: config.name,
  uploads_on_channel: listed,
  uploads_looked_at: metaRows.size || null,
  with_captions: captioned,
  cut_not_on_camera: notOnCamera,
  cut_ai_voice: aiVoice,
  cut_duplicates: duplicates,
  clips: clips.length,
  words,
  hours: +(seconds / 3600).toFixed(1),
  lanes: Object.entries(lanes).sort((a, b) => b[1] - a[1]).map(([id, n]) => ({ id, label: config.jev?.lanes?.[id]?.label || "Everything else", n })),
  check,
};
fs.writeFileSync(path.join(dir, "stats.json"), JSON.stringify(stats, null, 1));
console.log(JSON.stringify({ ...stats, check: check ? `${check.lines.length} lines` : null }, null, 1));
