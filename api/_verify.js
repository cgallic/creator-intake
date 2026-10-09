// The guarantee behind every quote on the page: a passage is shown only if it
// appears word for word inside one unbroken run of the creator's own caption
// lines in the cited source, and it plays from the second that run says it.
// (Underscore file: Vercel does not route it.)
const norm = (s) => String(s).toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();

function verifyMoment(m, sources) {
  const src = sources.get(m.source_id);
  if (!src) return { ok: false, reason: "unknown source" };
  const q = norm(m.passage);
  if (q.split(" ").length < 8) return { ok: false, reason: "passage too short" };
  // Search each run of the creator's lines on its own, so a passage can never
  // span another speaker's line or be stitched across one.
  const runs = [];
  let run = null;
  for (const l of src.lines) {
    if (l.who === "other") { run = null; continue; }
    if (!run) { run = { joined: "", starts: [] }; runs.push(run); }
    run.starts.push({ at: run.joined.length, t: l.t });
    run.joined += norm(l.text) + " ";
  }
  for (const r of runs) {
    const at = r.joined.indexOf(q);
    if (at < 0) continue;
    let t = 0;
    for (const s of r.starts) { if (s.at <= at) t = s.t; else break; }
    return { ok: true, src, t };
  }
  const anywhere = src.lines.map((l) => norm(l.text)).join(" ").includes(q);
  return { ok: false, reason: anywhere ? "passage includes another speaker's words" : "passage not found verbatim" };
}

module.exports = { verifyMoment, norm };
