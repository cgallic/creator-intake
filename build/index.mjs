#!/usr/bin/env node
/**
 * node build/index.mjs <slug>
 *
 * Builds creators/<slug>/corpus.json: everything the creator has said on their
 * own YouTube channels that the intake may quote, line by line, each line with
 * the second it starts at. Nothing in it is written by us or by a model.
 *
 * Speaker attribution: YouTube captions mark a change of speaker with ">>". In a
 * clip with markers, a segment whose last sentence is a question is someone else
 * asking (an interviewer or a guest) and is kept as context but never quotable;
 * every other segment is the creator. A clip with no markers is the creator
 * alone. config.speaker = "solo" skips the heuristic entirely (every line is the
 * creator), for channels where nobody else ever speaks.
 *
 * The corpus is capped at config.corpus_token_budget (default 150k tokens),
 * newest videos first, so the whole thing fits one cached prompt.
 */
import fs from "node:fs";
import path from "node:path";
import { creatorDir, loadConfig } from "./config.mjs";
import { captionLines } from "./lib.mjs";

const slug = process.argv[2];
const config = loadConfig(slug);
const dir = creatorDir(slug);
const capDir = path.join(dir, "captions");
const BUDGET = config.corpus_token_budget || 150000;
const tokens = (s) => Math.ceil(s.split(/\s+/).length * 1.35);

function readTsv(file, cols) {
  if (!fs.existsSync(file)) return new Map();
  const m = new Map();
  for (const row of fs.readFileSync(file, "utf8").split("\n")) {
    const parts = row.split("\t");
    if (parts[0]) m.set(parts[0], Object.fromEntries(cols.map((c, i) => [c, parts[i]])));
  }
  return m;
}

/* Optional creators/<slug>/crosspost.json: { "<youtube id>": [{ "network": "instagram", "url": "..." }] }
   for clips also posted elsewhere. No entry = YouTube only, never a guess. */
const crosspost = fs.existsSync(path.join(dir, "crosspost.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "crosspost.json"), "utf8")) : {};
/* Optional creators/<slug>/screened.json: { keep: [ids], exclude: [{ youtube_id, why }] } from the
   thumbnail screen (build/contact_sheets.py). With config.require_screening, only "keep" clips go in. */
const screened = fs.existsSync(path.join(dir, "screened.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "screened.json"), "utf8")) : { keep: [], exclude: [] };
const exclude = new Set([...(config.exclude_video_ids || []), ...screened.exclude.map((e) => e.youtube_id)]);
const keep = new Set(screened.keep);
const unscreened = [];
// config.exclude_caption_patterns: a clip whose captions match any of these (case-insensitive)
// is left out whole, e.g. an AI receptionist's greeting audible in a product demo.
const capPatterns = (config.exclude_caption_patterns || []).map((p) => new RegExp(p, "i"));
const patternHits = [];

const listing = readTsv(path.join(capDir, "listing.tsv"), ["id", "title", "duration", "url", "tab"]);
const meta = new Map();
for (const f of fs.existsSync(capDir) ? fs.readdirSync(capDir).filter((f) => /^meta(\.\d+)?\.tsv$/.test(f)) : []) {
  for (const [k, v] of readTsv(path.join(capDir, f), ["id", "title", "duration", "date", "url"])) meta.set(k, v);
}
const files = fs.existsSync(capDir) ? fs.readdirSync(capDir).filter((f) => f.endsWith(".json3")) : [];

const videos = [], missing = [];
for (const [id, l] of listing) {
  if (exclude.has(id)) continue;
  const m = meta.get(id) || {};
  if (!keep.has(id) && files.some((f) => f.startsWith(id + "."))) { unscreened.push(id); if (config.require_screening) continue; }
  // Prefer a human caption track ("en") over auto-captions ("en-orig", "en-en", ...).
  const cand = files.filter((f) => f.startsWith(id + ".")).sort((a, b) => a.length - b.length);
  const lines = cand.length ? captionLines(JSON.parse(fs.readFileSync(path.join(capDir, cand[0]), "utf8")), config.speaker === "solo") : [];
  const title = String(m.title || l.title || "").replace(/(\s#\w+)+\s*$/, "").trim();
  const hit = lines.find((x) => capPatterns.some((re) => re.test(x.text)));
  if (hit) { patternHits.push({ id, title, line: hit.text }); continue; }
  if (!lines.length || !title) { missing.push(id); continue; }
  const date = m.date && /^\d{8}$/.test(m.date) ? `${m.date.slice(0, 4)}-${m.date.slice(4, 6)}-${m.date.slice(6, 8)}` : null;
  videos.push({
    youtube_id: id,
    title,
    seconds: +(m.duration || l.duration) || null,
    published: date,
    vertical: l.tab === "shorts",
    thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    url: l.url,
    links: [{ network: "youtube", url: l.url }, ...(crosspost[id] || [])],
    lines,
  });
}

// Newest first, then fill the token budget.
videos.sort((a, b) => String(b.published || "").localeCompare(String(a.published || "")));
const clips = [], overBudget = [], seenText = new Set();
let dupes = 0, used = 0;
for (const v of videos) {
  // The same clip re-uploaded (identical captions) goes in once, newest copy.
  const key = v.lines.map((l) => l.text).join(" ").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (seenText.has(key)) { dupes++; continue; }
  seenText.add(key);
  const cost = tokens(v.lines.map((l) => l.text).join(" ")) + 40;
  if (used + cost > BUDGET) { overBudget.push(v.youtube_id); continue; }
  used += cost;
  clips.push({ id: "c" + String(clips.length + 1).padStart(3, "0"), ...v });
}

const corpus = {
  creator: config.name,
  slug,
  channels: config.channels,
  built_at: new Date().toISOString(),
  sources: "YouTube captions of the creator's own public uploads (yt-dlp), newest first within the token budget",
  clips,
};
// Keep topic tags from a previous build/tag-lanes.mjs run (new clips get tagged on the next run).
const prev = fs.existsSync(path.join(dir, "corpus.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "corpus.json"), "utf8")) : null;
if (prev) {
  const tags = new Map(prev.clips.filter((c) => c.lane).map((c) => [c.youtube_id, c]));
  for (const c of clips) { const t = tags.get(c.youtube_id); if (t) { c.lane = t.lane; c.lane_p = t.lane_p; } }
  if (prev.lanes_tagged) corpus.lanes_tagged = prev.lanes_tagged;
}
fs.writeFileSync(path.join(dir, "corpus.json"), JSON.stringify(corpus));
fs.writeFileSync(path.join(dir, "pattern-excluded.json"), JSON.stringify(patternHits, null, 1));
fs.writeFileSync(path.join(dir, "unscreened.json"), JSON.stringify(unscreened.map((id) => ({ youtube_id: id, title: (meta.get(id) || listing.get(id) || {}).title }))));

// Homepage grid: config.featured_ids if set, otherwise the newest clips with a usable title.
const pick = config.featured_ids?.length
  ? config.featured_ids.map((id) => clips.find((c) => c.youtube_id === id)).filter(Boolean)
  : clips.filter((c, i, a) => c.title.length > 12 && c.title.length < 110 && a.findIndex((x) => x.title === c.title) === i).slice(0, 6);
fs.writeFileSync(path.join(dir, "featured.json"), JSON.stringify({
  clips: pick.slice(0, 6).map((c) => ({ title: c.title, seconds: c.seconds, thumb: c.thumb, published: c.published, ask: c.title })),
}));

const words = (s) => s.split(/\s+/).length;
console.log(JSON.stringify({
  creator: config.name,
  videos_listed: listing.size,
  clips: clips.length,
  est_tokens: used,
  budget: BUDGET,
  dropped_over_budget: overBudget.length,
  duplicate_uploads: dupes,
  missing_captions: missing.length,
  excluded_by_caption_pattern: patternHits.length,
  unscreened: unscreened.length + (config.require_screening ? " (left out: require_screening)" : " (included)"),
  words_creator: clips.reduce((a, c) => a + c.lines.filter((l) => l.who === "creator").reduce((b, l) => b + words(l.text), 0), 0),
  clips_with_other_speakers: clips.filter((c) => c.lines.some((l) => l.who === "other")).length,
  newest: clips[0]?.published, oldest: clips.at(-1)?.published,
}, null, 1));
