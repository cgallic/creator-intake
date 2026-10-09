// Shared by the build scripts: where a creator lives and what their config says.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const creatorDir = (slug) => path.join(root, "creators", slug);

const REQUIRED = ["slug", "name", "short_name", "about", "channels", "hero", "offer", "intake"];

export function loadConfig(slug) {
  if (!slug) throw new Error("usage: node build/<script>.mjs <creator-slug>   (a folder under creators/)");
  const file = path.join(creatorDir(slug), "config.json");
  if (!fs.existsSync(file)) throw new Error(`no config at ${file} — copy creators/_template/config.json`);
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  const missing = REQUIRED.filter((k) => config[k] == null);
  if (missing.length) throw new Error(`${file} is missing: ${missing.join(", ")}`);
  if (config.slug !== slug) throw new Error(`${file}: slug "${config.slug}" does not match folder "${slug}"`);
  return config;
}
