// Shared by build/index.mjs and build/worker.mjs.

/**
 * YouTube json3 captions -> lines of { t (seconds), who ("creator" | "other"), text }.
 * YouTube marks a change of speaker with ">>". In a clip with markers, a segment
 * whose last sentence is a question is someone else (interviewer, guest): kept as
 * context, never quotable. Everything else is the creator. soloOnly skips the
 * heuristic (every line is the creator).
 */
export function captionLines(json3, soloOnly) {
  const events = (json3.events || []).filter((e) => e.segs && e.segs.some((s) => (s.utf8 || "").trim()));
  const segments = [];
  let seg = null;
  for (const e of events) {
    const t = Math.floor((e.tStartMs || 0) / 1000);
    const parts = e.segs.map((s) => s.utf8 || "").join("").replace(/\s+/g, " ").split(">>");
    parts.forEach((part, i) => {
      if (i > 0 || !seg) { seg = { pieces: [] }; segments.push(seg); }
      const text = part.trim();
      if (text) seg.pieces.push({ t, text });
    });
  }
  const lines = [];
  for (const sg of segments.filter((x) => x.pieces.length)) {
    const whole = sg.pieces.map((p) => p.text).join(" ").trim();
    const who = !soloOnly && segments.length > 1 && /\?["”']?$/.test(whole) ? "other" : "creator";
    let cur = null;
    for (const p of sg.pieces) {
      if (!cur || p.t - cur.t >= 8 || (/[.?!]$/.test(cur.text) && p.t - cur.t >= 4)) { cur = { t: p.t, who, text: p.text }; lines.push(cur); }
      else cur.text += " " + p.text;
    }
  }
  // Drop non-speech annotations like [Music], [Applause] or [cough and clears throat].
  return lines.map((l) => ({ ...l, text: l.text.replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim() })).filter((l) => l.text);
}
