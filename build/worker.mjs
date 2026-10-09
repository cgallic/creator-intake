#!/usr/bin/env node
/**
 * The self-serve build worker. Runs anywhere yt-dlp runs (Vercel can't), polls the
 * app for queued channels, builds each page, and publishes it back.
 *
 *   APP_URL=https://your-app.vercel.app WORKER_SECRET=... node build/worker.mjs
 *
 * It never holds the OpenRouter key: every AI call (thumbnail screening, drafting
 * the page, topic tagging) goes through the app's narrow proxy at /api/ai.
 *
 * One build, start to finish (5-20 minutes):
 *   1. read the channel, and check the owner put the verification code in its
 *      description (owners only: nobody can build a page from someone else's channel)
 *   2. pull captions in rounds, newest first, until there are TARGET_WORDS (30,000)
 *      words of the creator talking, the channel runs out, or MAX_UPLOADS (200)
 *   3. keep only the creator: a vision check of each thumbnail against the avatar
 *      (skipped for faceless channels), AI-voice phrases, re-uploads
 *   4. draft the page (intro, topics, starter questions) from the channel itself
 *   5. tag every clip's topic with Jev, pick the featured clips, count the stats
 *   6. publish to /c/<slug>, with the owner's own next-step link
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { captionLines } from "./lib.mjs";

const APP = (process.env.APP_URL || "").replace(/\/+$/, "");
const SECRET = process.env.WORKER_SECRET || "";
if (!APP || !SECRET) { console.error("APP_URL and WORKER_SECRET are required"); process.exit(1); }
process.env.OPENROUTER_BASE = `${APP}/api/ai`;
process.env.OPENROUTER_API_KEY = SECRET; // the proxy's bearer, not an OpenRouter key
const require = createRequire(import.meta.url);
const { tagLanes } = require("../api/_jev.js");

const TARGET_WORDS = +(process.env.TARGET_WORDS || 30000);
const MAX_UPLOADS = +(process.env.MAX_UPLOADS || 200);
const ROUND = 60;
const MODEL = process.env.WORKER_MODEL || "openai/gpt-6-luna";
const POLL_MS = +(process.env.POLL_MS || 15000);
const BUDGET = 150000;

const api = async (pathAndQuery, body) => {
  const r = await fetch(`${APP}${pathAndQuery}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${pathAndQuery}: ${r.status} ${JSON.stringify(d).slice(0, 200)}`);
  return d;
};
const progress = (id, stage, detail, extra = {}) => api("/api/worker?a=progress", { id, stage, detail, ...extra }).catch(() => {});

async function llm(content, schema, name, maxTokens = 3000) {
  const r = await fetch(`${APP}/api/ai/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL, max_tokens: maxTokens,
      messages: [{ role: "user", content }],
      response_format: { type: "json_schema", json_schema: { name, strict: true, schema } },
    }),
  });
  const d = await r.json();
  if (!r.ok || d.error) throw new Error(`llm ${r.status}: ${JSON.stringify(d.error || d).slice(0, 200)}`);
  return JSON.parse(String(d.choices?.[0]?.message?.content || "{}").replace(/^```(?:json)?\s*|\s*```$/g, ""));
}

const yt = (args) => execFileSync("yt-dlp", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });

/* ---------- 1. the channel ---------- */
function readChannel(url) {
  let d;
  try { d = JSON.parse(yt(["--flat-playlist", "--playlist-items", "1", "-J", url])); }
  catch (_) { throw new Error("We couldn't find that channel on YouTube. Check the link or @handle and try again."); }
  const thumbs = d.thumbnails || [];
  const avatar = (thumbs.find((t) => t.id === "avatar_uncropped") || thumbs.find((t) => /avatar/.test(t.id || "")) || {}).url || null;
  return { name: d.channel || d.uploader || d.title, handle: d.uploader_id || null, channel_url: d.channel_url || url, description: (d.description || "").slice(0, 1500), description_full: d.description || "", avatar, followers: d.channel_follower_count || null };
}

function listTab(url, tab, n) {
  let out = "";
  try { out = yt(["--flat-playlist", "--playlist-end", String(n), "--print", "%(id)s\t%(title)s\t%(duration)s", `${url}/${tab}`]); } catch (e) { out = e.stdout || ""; }
  return out.split("\n").map((r) => r.split("\t")).filter(([id]) => /^[A-Za-z0-9_-]{11}$/.test(id || ""))
    .map(([id, title, duration]) => ({ id, title, duration: +duration || null, tab, url: tab === "shorts" ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}` }));
}

/* ---------- 2. captions, in parallel ---------- */
async function fetchCaptions(jobId, videos, dir, wordsSoFar = 0) {
  const jobs = Math.min(6, videos.length);
  let done = -1;
  const timer = setInterval(() => {
    const have = new Set(fs.readdirSync(dir).filter((f) => f.endsWith(".json3")).map((f) => f.split(".")[0])).size;
    if (have !== done) { done = have; progress(jobId, "captions", `Pulling your captions: about ${wordsSoFar.toLocaleString("en-US")} of ${TARGET_WORDS.toLocaleString("en-US")} words so far, ${have} of ${videos.length} videos in this round`); }
  }, 5000);
  await Promise.all(Array.from({ length: jobs }, (_, j) => new Promise((resolve) => {
    const mine = videos.filter((_, i) => i % jobs === j);
    fs.writeFileSync(path.join(dir, `todo.${j}.txt`), mine.map((v) => v.url).join("\n"));
    const p = spawn("yt-dlp", ["--skip-download", "--write-auto-subs", "--write-subs", "--sub-langs", "en-orig,en", "--sub-format", "json3",
      "--sleep-requests", "1", "--ignore-errors", "--no-progress", "-o", "%(id)s",
      "--print-to-file", "%(id)s\t%(upload_date)s", `meta.${j}.tsv`, "-a", `todo.${j}.txt`], { cwd: dir, stdio: "ignore" });
    p.on("close", resolve);
  })));
  clearInterval(timer);
  const dates = new Map();
  for (const f of fs.readdirSync(dir).filter((f) => /^meta\.\d+\.tsv$/.test(f))) for (const r of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) { const [id, d] = r.split("\t"); if (id) dates.set(id, d); }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json3"));
  const out = [];
  for (const v of videos) {
    const cand = files.filter((f) => f.startsWith(v.id + ".")).sort((a, b) => a.length - b.length);
    if (!cand.length) continue;
    const lines = captionLines(JSON.parse(fs.readFileSync(path.join(dir, cand[0]), "utf8")), false);
    if (!lines.length) continue;
    const d = dates.get(v.id);
    out.push({ ...v, published: d && /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null, lines });
  }
  return out;
}

/* ---------- 3. keep only the creator ---------- */
const AI_VOICE = [/thanks? (you )?for calling/i, /how (can|may) i (help|assist) you( today)?\?/i, /you('ve| have) reached/i, /please leave (a|your) message/i];

async function screen(jobId, channel, clips, notes, seen) {
  const kept = new Set(clips.map((c) => c.id));
  if (channel.avatar && !notes.faceless) {
    progress(jobId, "screening", "Checking it's you on camera in each video");
    const onCam = new Set();
    for (let i = 0; i < clips.length; i += 15) {
      const batch = clips.slice(i, i + 15);
      const content = [
        { type: "text", text: `Image 0 is ${channel.name}'s profile photo. Images 1 to ${batch.length} are thumbnails of their videos. List the numbers of the thumbnails where ${channel.name} (the same person as in image 0) is visibly on camera as the main person, for example talking to the camera. Leave out thumbnails with no person, a different person, only text or graphics, or a screen recording without them. If image 0 is a logo rather than a person, list every thumbnail that shows one consistent main presenter.` },
        { type: "image_url", image_url: { url: channel.avatar, detail: "low" } },
        ...batch.map((c) => ({ type: "image_url", image_url: { url: `https://i.ytimg.com/vi/${c.id}/mqdefault.jpg`, detail: "low" } })),
      ];
      try {
        const r = await llm(content, { type: "object", additionalProperties: false, required: ["on_camera"], properties: { on_camera: { type: "array", items: { type: "integer" } } } }, "screen", 400);
        for (const n of r.on_camera || []) if (batch[n - 1]) onCam.add(batch[n - 1].id);
      } catch (e) { for (const c of batch) onCam.add(c.id); } // can't check: keep, don't punish the creator for our error
    }
    // Voiceover channel (decided on the first round): the voice is still theirs.
    if (notes.rounds === 0 && onCam.size < clips.length * 0.3) notes.faceless = true;
    else for (const c of clips) if (!onCam.has(c.id)) { kept.delete(c.id); notes.not_on_camera++; }
  }
  notes.rounds++;
  for (const c of clips) {
    if (!kept.has(c.id)) continue;
    if (c.lines.some((l) => AI_VOICE.some((re) => re.test(l.text)))) { kept.delete(c.id); notes.ai_voice++; continue; }
    const key = c.lines.map((l) => l.text).join(" ").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (seen.has(key)) { kept.delete(c.id); notes.duplicates++; continue; }
    seen.add(key);
  }
  return clips.filter((c) => kept.has(c.id));
}

/* ---------- 4. draft the page from the channel itself ---------- */
const PALETTES = [
  { accent: "#2343e8", accent_deep: "#1a32b8", accent_wash: "#e3e8ff", secondary: "#10132a", secondary_soft: "#33374f", paper: "#f6f6f2", card: "#ffffff", ink: "#10132a" },
  { accent: "#c2410c", accent_deep: "#9a3412", accent_wash: "#ffedd5", secondary: "#1c1917", secondary_soft: "#44403c", paper: "#fafaf9", card: "#ffffff", ink: "#1c1917" },
  { accent: "#0f766e", accent_deep: "#115e59", accent_wash: "#ccfbf1", secondary: "#0f172a", secondary_soft: "#334155", paper: "#f8fafc", card: "#ffffff", ink: "#0f172a" },
  { accent: "#be185d", accent_deep: "#9d174d", accent_wash: "#fce7f3", secondary: "#18181b", secondary_soft: "#3f3f46", paper: "#fafafa", card: "#ffffff", ink: "#18181b" },
  { accent: "#6d28d9", accent_deep: "#5b21b6", accent_wash: "#ede9fe", secondary: "#111827", secondary_soft: "#374151", paper: "#f9fafb", card: "#ffffff", ink: "#111827" },
];

async function draft(channel, clips) {
  const titles = clips.slice(0, 80).map((c) => `- ${c.title}`).join("\n");
  const schema = {
    type: "object", additionalProperties: false,
    required: ["short_name", "about", "audience", "tagline", "headline", "prompt", "placeholder", "chips", "lanes"],
    properties: {
      short_name: { type: "string", description: "What people call them: a first name, or the channel name if it's a brand." },
      about: { type: "string", description: "2-3 plain sentences: who they are and what their videos are about. Only what the description and titles show." },
      audience: { type: "string", description: "One sentence: who watches and what they want help with." },
      tagline: { type: "string", description: "Under 8 words, what they do. No hype." },
      headline: { type: "string", description: "Page headline in the form 'Ask <short_name> anything.' or a close plain variant." },
      prompt: { type: "string", description: "One sentence telling the visitor what they get: a straight answer from the creator's videos and the moment they said it." },
      placeholder: { type: "string", description: "A realistic question a viewer would type, in the viewer's own words." },
      chips: { type: "array", minItems: 4, maxItems: 5, items: { type: "object", additionalProperties: false, required: ["label", "query"], properties: { label: { type: "string", description: "2-4 words" }, query: { type: "string", description: "The full question, in a viewer's words, that these videos clearly answer." } } } },
      lanes: { type: "array", minItems: 3, maxItems: 5, items: { type: "object", additionalProperties: false, required: ["id", "label", "when"], properties: { id: { type: "string", description: "snake_case" }, label: { type: "string", description: "Topic name, 2-5 words" }, when: { type: "string", description: "One sentence describing what belongs in this topic" } } } },
    },
  };
  return llm([{ type: "text", text: `You are setting up an "ask me" page for a YouTube creator, built only from their own videos. Write in plain, specific English: no hype, no buzzwords.\n\nChannel: ${channel.name} (${channel.handle || ""})\nDescription:\n${channel.description || "(none)"}\n\nRecent video titles:\n${titles}\n\nThe topics (lanes) must cover what these videos are actually about, so each video fits one.` }], schema, "page", 2500);
}

function assembleConfig(job, channel, d, notes) {
  const slug = job.slug;
  const hash = [...slug].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const lanes = {};
  for (const l of d.lanes) { const id = String(l.id).toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 30) || `topic_${Object.keys(lanes).length}`; lanes[id] = { label: l.label, when: l.when }; }
  const watch = { label: `Watch ${d.short_name} on YouTube`, url: channel.channel_url };
  const offer = null; // previews never link anywhere but the creator's own channel
  const main = watch;
  return {
    slug, name: channel.name, short_name: d.short_name, brand: `Ask ${d.short_name}`, tagline: d.tagline,
    about: d.about, audience: d.audience, channels: [channel.channel_url], speaker: "interview",
    // A build is a preview until the owner claims it (api/claim.js swaps in their offer).
    preview: { unofficial: true, channel_url: channel.channel_url, faceless: notes.faceless },
    known_facts: [],
    rules: [`This page was built from ${channel.name}'s public videos and is not run by them yet. Never claim to represent ${channel.name}, never offer their products or services, and never quote a price.`],
    hero: { eyebrow: d.tagline, headline: `${d.headline}`, prompt: d.prompt, placeholder: d.placeholder, button: "Get my answer" },
    chips: d.chips,
    proof: [],
    featured_heading: `${d.short_name} already answered most of this, out loud.`,
    featured_blurb: `Real videos from ${channel.name}. Ask a question above and we'll take you to the second they talk about your situation.`,
    offer: { name: main.label, description: offer ? `${d.short_name}'s next step for visitors.` : `${d.short_name}'s YouTube channel.`, url: main.url, cta_label: main.label, header_label: main.label, sticky_label: main.label, brief_cta: main.label, note: "", sheet_heading: `Want more from ${d.short_name}?`, no_moment: offer ? `${main.label} is the next step.` : `Their channel has more.`, fallback: `${main.label}.`, popup_after_seconds: 30, form: { submit_label: "Save", success: "Saved." } },
    cards: [],
    jev: { lanes, moves: offer ? { offer, watch } : { watch }, default_move: offer ? "offer" : "watch",
      routes: offer ? { asking: { "*": "watch" }, own_problem: { "*": "offer" }, evaluating: { "*": "offer" }, wants_creator: { "*": "offer" } } : {}, ask_lane: "Which is this closest to?", ask_intent: "What would help next?", intent_labels: { asking: "Just learning", own_problem: "Fixing my own problem", evaluating: "Comparing options", wants_creator: `Hearing from ${d.short_name}` } },
    intake: { fields: [
      { key: "goal", label: "Goal", description: "What they want to happen, in their words." },
      { key: "stuck_on", label: "Stuck on", description: "The problem or blocker they described." },
      { key: "already_tried", label: "Already tried", description: "Things they said they already tried.", list: true, each: true },
    ] },
    disclaimer: `Unofficial preview built from ${channel.name}'s public YouTube videos; not affiliated with or endorsed by them. Answers are written by an AI; quotes are shown exactly as captioned and play from the second they were said.`,
    footer: `Built from public videos. Is this your channel? Claim this page.`,
    powered_by: { label: `Is this ${channel.name}'s channel? Claim this page`, url: `/claim?c=${slug}`, book_url: "/new" },
    theme: PALETTES[hash % PALETTES.length],
    built_at: new Date().toISOString(),
  };
}

/* ---------- 5. corpus, topics, featured, stats ---------- */
const tokens = (s) => Math.ceil(s.split(/\s+/).length * 1.35);
function corpusOf(config, clips) {
  const sorted = [...clips].sort((a, b) => String(b.published || "").localeCompare(String(a.published || "")));
  const out = [];
  let used = 0;
  for (const c of sorted) {
    const cost = tokens(c.lines.map((l) => l.text).join(" ")) + 40;
    if (used + cost > BUDGET) continue;
    used += cost;
    out.push({ id: "c" + String(out.length + 1).padStart(3, "0"), youtube_id: c.id, title: c.title, seconds: c.duration, published: c.published, vertical: c.tab === "shorts", thumb: `https://i.ytimg.com/vi/${c.id}/hqdefault.jpg`, url: c.url, links: [{ network: "youtube", url: c.url }], lines: c.lines });
  }
  return { creator: config.name, slug: config.slug, channels: config.channels, built_at: config.built_at, clips: out };
}

/* ---------- one build ---------- */
async function build(job) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-"));
  try {
    await progress(job.id, "channel", "Reading your channel");
    const channel = readChannel(job.channel);
    if (job.code && !channel.description_full.includes(job.code)) {
      throw new Error(`We couldn't find ${job.code} in ${channel.name}'s channel description yet. Add it, save, wait a minute for YouTube to update, then try again.`);
    }
    await progress(job.id, "channel", `Found ${channel.name}, and the code checks out`, { name: channel.name });

    // Newest first, about one long video for every three shorts.
    const shorts = listTab(job.channel, "shorts", Math.ceil(MAX_UPLOADS * 0.7));
    const longs = listTab(job.channel, "videos", Math.ceil(MAX_UPLOADS * 0.5));
    const videos = [];
    for (let i = 0, j = 0; videos.length < MAX_UPLOADS && (i < shorts.length || j < longs.length);) {
      if (j < longs.length && (videos.length % 4 === 0 || i >= shorts.length)) videos.push(longs[j++]);
      else if (i < shorts.length) videos.push(shorts[i++]);
    }
    if (!videos.length) throw new Error("This channel has no public videos we can read.");

    const notes = { not_on_camera: 0, ai_voice: 0, duplicates: 0, faceless: false, rounds: 0 };
    const seen = new Set();
    const yours = [];
    let captioned = 0, looked = 0, words = 0;
    const wordsOf = (c) => c.lines.filter((l) => l.who !== "other").reduce((a, l) => a + l.text.split(/\s+/).length, 0);
    for (let i = 0; i < videos.length && words < TARGET_WORDS; i += ROUND) {
      const round = videos.slice(i, i + ROUND);
      looked += round.length;
      const roundDir = fs.mkdtempSync(path.join(dir, "r-"));
      const clips = await fetchCaptions(job.id, round, roundDir, words);
      captioned += clips.length;
      if (clips.length) await progress(job.id, "screening", `Checking it's you on camera in ${clips.length} more videos`);
      for (const c of await screen(job.id, channel, clips, notes, seen)) { yours.push(c); words += wordsOf(c); }
      await progress(job.id, "captions", `Pulling your captions: ${words.toLocaleString("en-US")} of ${TARGET_WORDS.toLocaleString("en-US")} words from ${yours.length} videos`);
    }
    if (captioned < 5) throw new Error(`Only ${captioned} of ${looked} videos have English captions, which isn't enough to build a page yet.`);
    if (yours.length < 5) throw new Error("We couldn't find enough videos where you're the one talking.");

    await progress(job.id, "drafting", "Writing your page's intro and topics");
    const d = await draft(channel, yours);
    const config = assembleConfig(job, channel, d, notes);
    const corpus = corpusOf(config, yours);

    await progress(job.id, "topics", `Sorting ${corpus.clips.length} clips by topic`);
    for (let i = 0; i < corpus.clips.length; i += 40) {
      const batch = corpus.clips.slice(i, i + 40);
      try {
        const r = await tagLanes(config, batch);
        batch.forEach((c, k) => { c.lane = r.answers[`c${k}`]?.choice || "other"; c.lane_p = r.answers[`c${k}`]?.confidence ?? null; });
      } catch (_) { batch.forEach((c) => { c.lane = "other"; }); }
    }

    const featured = { clips: corpus.clips.filter((c, i, a) => c.title.length > 12 && c.title.length < 110 && a.findIndex((x) => x.title === c.title) === i).slice(0, 6)
      .map((c) => ({ title: c.title, seconds: c.seconds, thumb: c.thumb, published: c.published, ask: c.title })) };
    const lanes = {};
    for (const c of corpus.clips) lanes[c.lane || "other"] = (lanes[c.lane || "other"] || 0) + 1;
    const stats = {
      creator: config.name, uploads_on_channel: null, uploads_looked_at: looked, with_captions: captioned,
      cut_not_on_camera: notes.not_on_camera, cut_ai_voice: notes.ai_voice, cut_duplicates: notes.duplicates, faceless: notes.faceless,
      clips: corpus.clips.length,
      words: corpus.clips.reduce((a, c) => a + c.lines.filter((l) => l.who !== "other").reduce((b, l) => b + l.text.split(/\s+/).length, 0), 0),
      hours: +(corpus.clips.reduce((a, c) => a + (c.seconds || 0), 0) / 3600).toFixed(1),
      lanes: Object.entries(lanes).sort((a, b) => b[1] - a[1]).map(([id, n]) => ({ id, label: config.jev.lanes[id]?.label || "Everything else", n })),
    };

    await progress(job.id, "publishing", "Putting your page online");
    const r = await api("/api/worker?a=publish", { id: job.id, slug: job.slug, files: { config, corpus, featured, stats } });
    console.log(`built ${job.slug}: ${corpus.clips.length} clips -> ${r.url}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ---------- claim: does the code sit in the channel description? ---------- */
async function verifyClaim(job) {
  await progress(job.id, "checking", "Reading your channel description");
  const channel = readChannel(job.channel);
  if (!channel.description_full.includes(job.code)) {
    throw new Error(`We couldn't find ${job.code} in ${channel.name}'s channel description. Add it anywhere in the description, save, wait a minute for YouTube to update, then try again.`);
  }
  await api("/api/worker?a=verified", { id: job.id, name: channel.name });
  console.log(`verified claim for ${job.slug}`);
}

/* ---------- the loop ---------- */
const once = process.argv.includes("--once");
for (;;) {
  let job = null;
  try { job = await api("/api/worker?a=next"); } catch (e) { console.warn("poll:", e.message); }
  if (job && job.id) {
    console.log(`building ${job.channel} (${job.id})`);
    try { await (job.type === "claim" ? verifyClaim(job) : build(job)); } catch (e) { console.warn(`failed ${job.id}:`, e.message); await api("/api/worker?a=fail", { id: job.id, error: e.message }).catch(() => {}); }
    continue;
  }
  if (once) break;
  await new Promise((r) => setTimeout(r, POLL_MS));
}
