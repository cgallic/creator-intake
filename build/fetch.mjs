#!/usr/bin/env node
/**
 * node build/fetch.mjs <slug>
 *
 * Lists every public video on the creator's YouTube channels (config.channels:
 * the /videos, /shorts and /streams tabs) and downloads captions for any we
 * don't have yet. Writes creators/<slug>/captions/<id>.<lang>.json3 and
 * creators/<slug>/captions/meta*.tsv (id, title, duration, upload date, url).
 * Then run build/index.mjs <slug>. Needs yt-dlp on PATH. Safe to re-run: it
 * only fetches what is new.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { creatorDir, loadConfig } from "./config.mjs";

const slug = process.argv[2];
const config = loadConfig(slug);
const capDir = path.join(creatorDir(slug), "captions");
fs.mkdirSync(capDir, { recursive: true });

const ytdlp = (args, opts = {}) => execFileSync("yt-dlp", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });

/* 1. the channel listing (cheap: --flat-playlist reads the tab pages only) */
const listed = new Map();
for (const channel of config.channels) {
  const base = channel.replace(/\/+$/, "").replace(/\/(videos|shorts|streams|featured)$/, "");
  for (const tab of ["videos", "shorts", "streams"]) {
    let out = "";
    try {
      out = ytdlp(["--flat-playlist", "--ignore-errors", "--print", "%(id)s\t%(title)s\t%(duration)s\t%(url)s", `${base}/${tab}`], { stdio: ["ignore", "pipe", "ignore"] });
    } catch (e) { out = e.stdout || ""; } // a channel without that tab exits non-zero
    for (const row of out.split("\n")) {
      const [id, title, duration, url] = row.split("\t");
      if (!/^[A-Za-z0-9_-]{11}$/.test(id || "")) continue;
      if (!listed.has(id)) listed.set(id, { id, title, duration, url: tab === "shorts" ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`, tab });
    }
    console.log(`${base}/${tab}: ${[...listed.values()].filter((v) => v.tab === tab).length} so far`);
  }
}
fs.writeFileSync(path.join(capDir, "listing.tsv"), [...listed.values()].map((v) => [v.id, v.title, v.duration, v.url, v.tab].join("\t")).join("\n"));

/* 2. captions + upload date for anything new (newest first, capped by config.max_videos) */
const have = new Set(fs.readdirSync(capDir).filter((f) => f.endsWith(".json3")).map((f) => f.split(".")[0]));
const tried = new Set(fs.readdirSync(capDir).filter((f) => /^meta(\.\d+)?\.tsv$/.test(f))
  .flatMap((f) => fs.readFileSync(path.join(capDir, f), "utf8").split("\n").map((r) => r.split("\t")[0])));
const todo = [...listed.keys()].slice(0, config.max_videos || 400).filter((id) => !have.has(id) && !tried.has(id));
console.log(`videos: ${listed.size} listed, ${have.size} have captions, fetching ${todo.length}`);
if (!todo.length) process.exit(0);

// Split across parallel yt-dlp workers (FETCH_JOBS, default 4); each writes its own meta.<n>.tsv.
const jobs = Math.max(1, Math.min(+(process.env.FETCH_JOBS || 4), todo.length));
const runs = [];
for (let j = 0; j < jobs; j++) {
  const mine = todo.filter((_, i) => i % jobs === j);
  fs.writeFileSync(path.join(capDir, `todo.${j}.txt`), mine.map((id) => listed.get(id).url).join("\n"));
  runs.push(new Promise((resolve) => {
    const p = spawn("yt-dlp", [
      "--skip-download", "--write-auto-subs", "--write-subs", "--sub-langs", config.caption_langs || "en-orig,en", "--sub-format", "json3",
      "--sleep-requests", "1", "--ignore-errors", "--no-progress", "-o", "%(id)s",
      "--print-to-file", "%(id)s\t%(title)s\t%(duration)s\t%(upload_date)s\t%(webpage_url)s", `meta.${j}.tsv`,
      "-a", `todo.${j}.txt`,
    ], { cwd: capDir, stdio: ["ignore", "ignore", "pipe"] });
    p.stderr.on("data", (d) => { const s = String(d); if (/ERROR/.test(s)) process.stderr.write(`[w${j}] ${s}`); });
    p.on("close", resolve); // --ignore-errors still exits 1 when any video failed; the rest are on disk
  }));
}
await Promise.all(runs);
console.log(`now have captions for ${new Set(fs.readdirSync(capDir).filter((f) => f.endsWith(".json3")).map((f) => f.split(".")[0])).size} videos`);
