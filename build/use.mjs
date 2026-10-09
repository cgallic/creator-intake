#!/usr/bin/env node
// node build/use.mjs <slug> — makes <slug> the creator this deploy serves:
// copies creators/<slug>/{config,corpus,featured}.json into data/.
import fs from "node:fs";
import path from "node:path";
import { creatorDir, loadConfig, root } from "./config.mjs";

const slug = process.argv[2];
loadConfig(slug);
fs.mkdirSync(path.join(root, "data"), { recursive: true });
for (const f of ["config.json", "corpus.json", "featured.json", "demo.json"]) {
  const src = path.join(creatorDir(slug), f);
  if (f === "demo.json" && !fs.existsSync(src)) continue; // optional: the for-creators page examples
  if (!fs.existsSync(src)) throw new Error(`${src} missing — run build/fetch.mjs and build/index.mjs ${slug} first`);
  fs.copyFileSync(src, path.join(root, "data", f));
}
console.log(`data/ now serves ${slug}`);
