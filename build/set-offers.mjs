#!/usr/bin/env node
/**
 * node build/set-offers.mjs <slug> <offers.json>     (needs BLOB_READ_WRITE_TOKEN)
 *
 * Gives a page custom offers: { "<id>": { label, url, when, blurb } }. Jev picks the
 * one that fits each visitor (jev.pick_offer); "when" is what Jev reads. A preview
 * keeps its banner; this is for gallery pages we curate with the creator's own
 * products, and for owners editing their claimed page.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const store = require("../api/_store.js");

const [slug, file] = process.argv.slice(2);
if (!slug || !file) throw new Error("usage: node build/set-offers.mjs <slug> <offers.json>");
const offers = JSON.parse(fs.readFileSync(file, "utf8"));
const cfg = await store.getJSON(`creators/${slug}/config.json`);
if (!cfg) throw new Error(`no page for ${slug}`);

const watch = (cfg.jev.moves && cfg.jev.moves.watch) || { label: `Watch ${cfg.short_name} on YouTube`, url: cfg.channels[0] };
cfg.jev.moves = { ...offers, watch: { ...watch, when: watch.when || `They're curious or just exploring, not looking for a product yet.`, blurb: watch.blurb || "More free videos" } };
cfg.jev.pick_offer = true;
cfg.jev.default_move = "watch";
cfg.jev.routes = {};
const list = Object.values(offers).map((o) => `${o.label} (${o.url}): ${o.blurb || o.when}`);
cfg.known_facts = [`${cfg.short_name}'s own products and offers: ${list.join("; ")}.`];
if (cfg.preview) cfg.rules = [`This page was built from ${cfg.name}'s public videos and is not run by them. Never claim to represent ${cfg.name}. You may point to ${cfg.short_name}'s own products listed above, but never quote a price.`];
await store.putJSON(`creators/${slug}/config.json`, cfg);
console.log(`${slug}: ${Object.keys(cfg.jev.moves).join(", ")}`);
