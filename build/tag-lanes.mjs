#!/usr/bin/env node
/**
 * node build/tag-lanes.mjs <slug>   (needs OPENROUTER_API_KEY)
 *
 * Tags every clip in creators/<slug>/corpus.json with its topic lane from
 * config.jev.lanes, using Jev at build time (40 clips per call, ~$0.0005 per
 * call). At runtime the "more videos" rail draws from the visitor's lane, so Jev
 * only ever ranks a small pool it can see. Writes lane + lane_p into corpus.json.
 * Re-run after build/index.mjs.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { creatorDir, loadConfig } from "./config.mjs";

const require = createRequire(import.meta.url);
const { tagLanes } = require("../api/_jev.js");
const slug = process.argv[2];
const config = loadConfig(slug);
if (!config.jev?.lanes) throw new Error("config.jev.lanes missing");
if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY not set");

const file = path.join(creatorDir(slug), "corpus.json");
const corpus = JSON.parse(fs.readFileSync(file, "utf8"));
let cost = 0;
const counts = {};
for (let i = 0; i < corpus.clips.length; i += 40) {
  const batch = corpus.clips.slice(i, i + 40);
  let r;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { r = await tagLanes(config, batch); break; } catch (e) { console.warn(`batch ${i}: ${e.message}`); await new Promise((s) => setTimeout(s, 2000 * (attempt + 1))); }
  }
  if (!r) throw new Error(`batch ${i} failed 3 times`);
  cost += r.cost || 0;
  batch.forEach((c, k) => {
    const a = r.answers[`c${k}`];
    c.lane = a?.choice || "other";
    c.lane_p = a?.confidence ?? null;
    counts[c.lane] = (counts[c.lane] || 0) + 1;
  });
  process.stdout.write(`${Math.min(i + 40, corpus.clips.length)}/${corpus.clips.length} `);
}
corpus.lanes_tagged = { model: (await Promise.resolve(null)) || process.env.JEV_MODEL || "typesafe/jev-1.13", at: new Date().toISOString() };
fs.writeFileSync(file, JSON.stringify(corpus));
console.log("\n" + JSON.stringify({ counts, cost_usd: +cost.toFixed(5) }));
