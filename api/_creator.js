/**
 * Where a creator's page data comes from.
 *  - No slug: the bundled creator in data/ (the deploy's own page, e.g. Connor's).
 *  - A slug: a self-serve page built by the worker, stored in Vercel Blob under
 *    creators/<slug>/{config,corpus,featured,stats}.json.
 * Cached per function instance for 5 minutes.
 * (Underscore file: Vercel does not route it.)
 */
const { build } = require("./_engine");

const SLUG = /^[a-z0-9][a-z0-9-]{1,59}$/;
const FILES = ["config", "corpus", "featured", "stats", "demo"];
const cache = new Map();

let bundled = null, bundledE = null;
function bundledData() {
  if (!bundled) bundled = { config: require("../data/config.json"), corpus: require("../data/corpus.json") };
  return bundled;
}
function bundledEngine() {
  if (!bundledE) { const d = bundledData(); bundledE = build(d.config, d.corpus); }
  return bundledE;
}

async function blobJSON(pathname) {
  const data = await require("./_store").getJSON(pathname);
  if (data == null) throw new Error(`not found: ${pathname}`);
  return data;
}

/** One file of a creator's page (config | corpus | featured | stats | demo). */
async function file(slug, name) {
  if (!FILES.includes(name)) throw new Error("unknown file");
  if (!slug) {
    try { return require(`../data/${name}.json`); } catch (_) { return null; }
  }
  if (!SLUG.test(slug)) throw new Error("bad slug");
  const key = `${slug}/${name}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 300e3) return hit.data;
  const data = await blobJSON(`creators/${slug}/${name}.json`);
  cache.set(key, { at: Date.now(), data });
  return data;
}

async function engineFor(slug) {
  if (!slug) return bundledEngine();
  const key = `${slug}/engine`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 300e3) return hit.data;
  const [config, corpus] = await Promise.all([file(slug, "config"), file(slug, "corpus")]);
  const E = build(config, corpus);
  cache.set(key, { at: Date.now(), data: E });
  return E;
}

async function configFor(slug) {
  return slug ? file(slug, "config") : bundledData().config;
}

module.exports = { file, engineFor, configFor, bundledEngine, SLUG };
