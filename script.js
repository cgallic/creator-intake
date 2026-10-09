/* Creator Intake — "Ask <creator>"
   Ask in your own words → a straight answer, the real moment the creator says it
   on video (a YouTube clip that plays from that second), and the creator's offer
   pre-filled from what you said.

   Everything on screen comes from data/config.json (the creator) and
   /api/answer, which only returns quotes it has checked word for word against
   the creator's own captions in data/corpus.json. */

let C = null;          // data/config.json
let WHO = "";          // config.short_name

/* ---------- helpers ---------- */
const $ = (s) => document.querySelector(s);
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
/* model text may carry <strong>/<b> and nothing else */
function rich(s) { return esc(s).replace(/&lt;(\/?)(strong|b|em)&gt;/g, "<$1$2>").replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>").replace(/\*\*/g, ""); }
function stripTags(s) { return String(s || "").replace(/<[^>]+>/g, ""); }
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function mmss(t) { t = Math.max(0, Math.floor(t || 0)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; }
const NETWORK = { youtube: "YouTube", facebook: "Facebook", instagram: "Instagram", tiktok: "TikTok", linkedin: "LinkedIn", x: "X" };
function sourceLinks(m) {
  const links = (m.links && m.links.length ? m.links : [{ network: "youtube", url: m.url }]);
  return links.map((l) => {
    const href = l.network === "youtube" ? `https://www.youtube.com/watch?v=${encodeURIComponent(m.youtube_id)}&t=${Math.max(0, m.t)}s` : l.url;
    return `<a class="src-link src-${esc(l.network)}" href="${esc(href)}" target="_blank" rel="noopener">${esc(NETWORK[l.network] || l.network)} ↗</a>`;
  }).join("");
}
const PLAY = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const ARROW = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>';

/* ---------- DOM ---------- */
const askForm = $("#ask-form"), askInput = $("#ask-input"), answer = $("#answer");
const micBtn = $("#mic-btn"), micStatus = $("#mic-status"), resetBtn = $("#reset-btn");
const sheet = $("#sheet"), sheetScrim = $("#sheet-scrim"), sheetBody = $("#sheet-body"), sheetClose = $("#sheet-close");
const vidScrim = $("#vid-scrim"), vidStage = $("#vid-stage"), vidClose = $("#vid-close");
const stickyCall = $("#sticky-call");

let current = null;      // { raw, data } for the answer on screen
const VISITOR = (() => { try { let v = localStorage.getItem("ask-visitor"); if (!v) { v = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem("ask-visitor", v); } return v; } catch (_) { return ""; } })();
let askSeq = 0;          // ignore a slow answer once a newer question was asked
let surveyState = {};

/* What we know about this visitor is only what they told us or did here. Kept in
   their own browser (localStorage), sent with each request so Jev can read it. */
const EVIDENCE_KEY = "ask-evidence";
const ev = (() => { try { return JSON.parse(localStorage.getItem(EVIDENCE_KEY)) || {}; } catch (_) { return {}; } })();
ev.told = ev.told || {}; ev.did = ev.did || []; ev.history = ev.history || [];
function saveEv() { try { localStorage.setItem(EVIDENCE_KEY, JSON.stringify({ told: ev.told, did: ev.did.slice(-12), history: ev.history.slice(-4) })); } catch (_) {} }
const cameFrom = (() => { const u = new URLSearchParams(location.search); const r = document.referrer ? new URL(document.referrer).hostname : ""; return [u.get("utm_source"), r && !r.endsWith(location.hostname) ? r : ""].filter(Boolean).join(" via ") || ""; })();
let primary = null; // the next step Jev's read points to, applied to every CTA on the page
let alternate = null; // a close second offer, shown under the main button

/* ---------- boot: paint the page from the creator's config ---------- */
function applyConfig() {
  const t = C.theme || {};
  const root = document.documentElement.style;
  const vars = { paper: "--paper", paper_2: "--paper-2", card: "--card", ink: "--ink", ink_soft: "--ink-soft", ink_faint: "--ink-faint", line: "--line", line_strong: "--line-strong",
    accent: "--accent", accent_deep: "--accent-deep", accent_wash: "--accent-wash", secondary: "--secondary", secondary_soft: "--secondary-soft", highlight: "--highlight" };
  for (const [k, v] of Object.entries(vars)) if (t[k]) root.setProperty(v, t[k]);
  if (t.serif) root.setProperty("--serif", t.serif);
  if (t.sans) root.setProperty("--sans", t.sans);
  if (t.fonts_href) $("#font-link").href = t.fonts_href;

  const letter = encodeURIComponent((C.favicon_letter || WHO[0] || "?").slice(0, 2));
  const accent = encodeURIComponent(t.accent || "#a23a2d"), paper = encodeURIComponent(t.paper || "#f4efe5");
  $("#favicon").href = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='${accent}'/%3E%3Ctext x='16' y='23' font-family='Georgia,serif' font-size='19' fill='${paper}' text-anchor='middle'%3E${letter}%3C/text%3E%3C/svg%3E`;

  document.title = C.page_title || `Ask ${WHO}`;
  if (C.canonical_url) { const l = document.createElement("link"); l.rel = "canonical"; l.href = C.canonical_url; document.head.appendChild(l); }
  document.querySelector('meta[name="description"]').content = C.hero.prompt || "";
  $("#brand-name").textContent = C.brand || C.name;
  $("#brand-sub").textContent = C.tagline || "";
  $("#wordmark").setAttribute("aria-label", `${C.brand || C.name} home`);

  const o = C.offer;
  for (const [a, l] of [["#header-cta", "#header-cta-label"], ["#sticky-call", "#sticky-label"]]) {
    $(a).href = o.url; $(l).textContent = a === "#header-cta" ? (o.header_label || o.cta_label) : (o.sticky_label || o.cta_label);
  }

  $("#eyebrow").textContent = C.hero.eyebrow || "";
  $("#hero-line").innerHTML = rich(C.hero.headline || `Ask ${WHO} <em>anything.</em>`).replace(/\n/g, "<br />");
  $("#hero-prompt").textContent = C.hero.prompt || "";
  askInput.placeholder = C.hero.placeholder || "";
  if (C.hero.button) $("#ask-go-label").textContent = C.hero.button;

  $("#chips").insertAdjacentHTML("beforeend", (C.chips || []).map((c) => `<button class="chip" data-query="${esc(c.query)}">${esc(c.label)}</button>`).join(""));
  if ((C.proof || []).length) $("#proof").innerHTML = C.proof.map((p) => `<li><strong>${esc(p.value)}</strong><span>${esc(p.label)}</span></li>`).join("");
  else $("#proof").hidden = true;

  $("#featured-h").textContent = C.featured_heading || `${WHO} already answered most of this — out loud.`;
  $("#featured-p").textContent = C.featured_blurb || `Real videos from ${C.name}. Ask a question above and we'll take you to the moment ${WHO} talks about your situation.`;
  $("#disclaimer").textContent = C.disclaimer || `Answers on this page are written by an AI from ${C.name}'s published videos; quotes are shown exactly as captioned and play from the second they are said. Not professional advice.`;
  $("#footer-line").textContent = C.footer || `© ${new Date().getFullYear()} ${C.name}`;
  // Under /c/<slug> (a self-serve page) links to the app's own pages resolve from the app root.
  const appRoot = location.pathname.replace(/\/c\/[a-z0-9-]+\/?.*$/, "/").replace(/[^/]*$/, "");
  const appLink = (u) => (u && u.startsWith("/") ? appRoot + u.slice(1) : u);
  if (C.powered_by) { const u = appLink(C.powered_by.url); $("#powered").innerHTML = `<a href="${esc(u)}" ${/^https?:/.test(u) ? 'target="_blank" rel="noopener"' : ""}>${esc(C.powered_by.label)}</a>`; $("#powered").hidden = false; }
  if (C.preview && C.preview.unofficial) {
    const b = document.createElement("div");
    b.className = "preview-banner";
    b.innerHTML = `Unofficial preview built from ${esc(C.name)}'s public videos. Not affiliated with ${esc(C.name)}. <a href="${esc(appLink(`/claim?c=${C.slug}`))}">Is this your channel? Claim it</a>`;
    document.body.prepend(b);
  }
  document.body.classList.remove("booting");
}

/* ---------- ask ---------- */
askForm.addEventListener("submit", (e) => { e.preventDefault(); const v = askInput.value.trim(); if (v) runAsk(v); });
$("#chips").addEventListener("click", (e) => { const c = e.target.closest(".chip"); if (c) { askInput.value = c.dataset.query; runAsk(c.dataset.query); } });
resetBtn.addEventListener("click", resetAll);
$("#wordmark").addEventListener("click", (e) => { e.preventDefault(); if (document.body.classList.contains("answering")) resetAll(); else window.scrollTo({ top: 0, behavior: "smooth" }); });
window.addEventListener("scroll", () => { $("#masthead").classList.toggle("scrolled", window.scrollY > 10); });

function resetAll() {
  askSeq++;
  document.body.classList.remove("answering");
  answer.hidden = true; answer.innerHTML = "";
  resetBtn.hidden = true; stickyCall.hidden = true;
  closeSheet(); closeVideo(); stopAudio();
  askInput.value = ""; current = null;
  resetPrimary();
  window.scrollTo({ top: 0, behavior: "smooth" });
}
/* Back to the creator's default next step (a previous answer may have swapped it). */
function resetPrimary() {
  primary = null; alternate = null;
  const o = C.offer;
  $("#header-cta").href = o.url; $("#header-cta-label").textContent = o.header_label || o.cta_label;
  $("#sticky-call").href = o.url; $("#sticky-label").textContent = o.sticky_label || o.cta_label;
  for (const a of ["#header-cta", "#sticky-call"]) /^https?:/.test(o.url) ? $(a).setAttribute("target", "_blank") : $(a).removeAttribute("target");
}

function thinking() {
  return C.thinking || [
    "Okay — give me a second. Reading what you said…",
    `Looking through everything ${WHO} has said on video…`,
    `Finding the moment ${WHO} talks about your situation…`,
  ];
}

async function runAsk(raw) {
  const seq = ++askSeq;
  clearTimeout(window.__sheetTimer);
  closeSheet(); stopAudio();
  document.body.classList.add("answering");
  resetBtn.hidden = false; answer.hidden = false;
  window.scrollTo({ top: 0 });
  const THINKING = thinking();

  answer.innerHTML = `
    ${echo(raw)}
    <div class="thinking"><span class="orb"></span><span id="think-text">${esc(THINKING[0])}</span></div>
    <div class="answer-grid">
      <div class="col">
        <div class="panel d1"><div class="panel-pad">
          <div class="sk" style="height:14px;width:40%;margin-bottom:14px"></div>
          <div class="sk" style="height:12px;width:96%;margin-bottom:8px"></div>
          <div class="sk" style="height:12px;width:88%;margin-bottom:8px"></div>
          <div class="sk" style="height:12px;width:74%"></div>
        </div></div>
        <div class="panel d2"><div class="sk" style="height:220px;width:100%"></div></div>
      </div>
      <div class="col">
        <div class="panel d2"><div class="panel-pad">
          <div class="sk" style="height:12px;width:50%;margin-bottom:14px"></div>
          <div class="sk" style="height:12px;width:90%;margin-bottom:8px"></div>
          <div class="sk" style="height:12px;width:80%"></div>
        </div></div>
      </div>
    </div>`;

  let i = 0;
  const ticker = setInterval(() => { const el = $("#think-text"); if (el && i < THINKING.length - 1) el.textContent = THINKING[++i]; }, 2600);

  // Clips first: the matching clip usually lands in about a second; show it while the answer is written.
  let early = [];
  fetch("./api/quick", { method: "POST", headers: { "content-type": "application/json", "x-visitor": VISITOR }, body: JSON.stringify({ q: raw }) })
    .then((r) => r.json()).then((d) => {
      early = (d && d.moments) || [];
      if (seq === askSeq && !current && early.length) renderEarly(raw, early[0]);
    }).catch(() => {});

  let data = null, error = null;
  try {
    const r = await fetch("./api/answer", { method: "POST", headers: { "content-type": "application/json", "x-visitor": VISITOR }, body: JSON.stringify({ q: raw, history: ev.history, did: ev.did, told: ev.told, came_from: cameFrom }) });
    data = await r.json();
    if (!r.ok || data.error) { error = data.error || `Something went wrong (${r.status}).`; data = null; }
  } catch (_) {
    error = "We couldn't reach the answer service. Try again in a moment.";
  }
  clearInterval(ticker);
  if (seq !== askSeq) return;

  if (error) return renderError(raw, error);
  // If the writer found no quote but the quick search did, keep the clip already on screen.
  if (!(data.moments || []).length && early.length) {
    data.moments = early.slice(0, 1);
    data.components = (data.components || []).map((c) => (c.type === "no_moment" ? { type: "moment", column: "main", moment: early[0] } : c));
  }
  current = { raw, data };
  ev.history.push(raw); ev.did = []; saveEv();
  renderAnswer(raw, data);
}

/* The clip, on screen before the written answer: the thinking line stays, the clip card replaces its skeleton. */
function renderEarly(raw, m) {
  const slot = answer.querySelector(".answer-grid .col .panel.d2");
  if (!slot) return;
  slot.outerHTML = leadMoment(m);
  const card = answer.querySelector("[data-moment='0']");
  if (card) {
    const open = () => { openVideo(m); did(`opened clip: ${m.title}`); };
    card.addEventListener("click", (e) => { if (!e.target.closest("a")) open(); });
    card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  }
  const t = $("#think-text");
  if (t) t.textContent = `Here's where ${WHO} talks about it. Writing the full answer…`;
}

function echo(raw) {
  return `<div class="answer-echo"><span class="echo-tag">You said</span><span class="you-said">“${esc(raw)}”</span></div>`;
}

function offerButton(cls = "call-big", extra = "") {
  const o = primary || { label: C.offer.cta_label, url: C.offer.url };
  return `<a class="${cls}" data-primary href="${esc(o.url)}" ${/^https?:/.test(o.url) ? 'target="_blank" rel="noopener"' : ""} ${extra}>${esc(o.label)} ${ARROW}</a>`;
}
function applyPrimary(o) {
  if (!o) return;
  primary = o;
  const ext = /^https?:/.test(o.url);
  for (const [a, l] of [["#header-cta", "#header-cta-label"], ["#sticky-call", "#sticky-label"]]) { $(a).href = o.url; $(l).textContent = o.label; ext ? $(a).setAttribute("target", "_blank") : $(a).removeAttribute("target"); }
  document.querySelectorAll("[data-primary]").forEach((a) => { a.href = o.url; a.innerHTML = `${esc(o.label)} ${ARROW}`; });
}

function renderError(raw, msg) {
  answer.innerHTML = `
    ${echo(raw)}
    <div class="panel d1" style="max-width:640px"><div class="panel-pad">
      <span class="panel-tag"><span class="dot"></span>We couldn't answer that just now</span>
      <p class="answer-sub" style="margin:10px 0 18px">${esc(msg)}</p>
      ${offerButton()}
      <button class="fu" id="retry" style="margin-top:12px">Try again</button>
    </div></div>`;
  $("#retry").addEventListener("click", () => runAsk(raw));
  stickyCall.hidden = false;
}

/* ---------- the answer environment ----------
   /api/answer returns `components`: an ordered list, each with a type and a column.
   Which optional ones are present was decided by Jev on the server; this page only
   renders them from the catalog below (A2UI-style: the agent picks, the client draws). */
const CATALOG = {
  answer: (c) => `
    <div class="panel d1"><div class="panel-pad">
      <span class="panel-tag"><span class="dot"></span>Straight answer</span>
      <div class="synth-body" id="synth-body"></div>
      <div class="audio-row" id="audio-row" ${canSpeak ? "" : "hidden"}>
        <button class="audio-play" id="audio-play" aria-label="Play audio answer">${PLAY}</button>
        <div class="audio-meta"><span class="t">Rather just listen?</span><span class="s">Tap to hear this read out loud</span></div>
        <div class="audio-wave"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
      </div>
    </div></div>`,
  moment: (c) => leadMoment(c.moment),
  no_moment: () => noMoment(),
  more_moments: (c) => `
    <div class="panel d3"><div class="panel-pad">
      <span class="panel-tag"><span class="dot"></span>${esc(WHO)} talks about this too</span>
      <div class="clip-list" id="clip-list">${c.moments.map(momentRow).join("")}</div>
    </div></div>`,
  steps: (c) => `
    <div class="panel d4"><div class="panel-pad">
      <span class="panel-tag"><span class="dot"></span>What to do now</span>
      <ol class="steps">${c.steps.map((x) => `<li><span class="st">${rich(x)}</span></li>`).join("")}</ol>
    </div></div>`,
  facts: (c) => `
    <div class="panel d2"><div class="panel-pad">
      <span class="panel-tag live"><span class="dot"></span>What you've told us</span>
      <div class="facts-list">${factRows(c.facts)}</div>
      <button class="brief-cta" data-open-sheet>${esc(C.offer.brief_cta || C.offer.cta_label)}</button>
      <p class="brief-note">${esc(C.offer.note || "")}</p>
    </div></div>`,
  offer: () => {
    // The heading and note describe the configured offer only when it IS the next step shown.
    const isOffer = !primary || primary.url === C.offer.url;
    return `
    <div class="panel d2"><div class="panel-pad">
      <span class="panel-tag"><span class="dot"></span>${esc(isOffer ? C.offer.name : "Your next step")}</span>
      <div style="margin-top:12px">${offerButton()}</div>
      ${alternate ? `<p class="brief-note" style="margin-top:10px">Or: <a href="${esc(alternate.url)}" ${/^https?:/.test(alternate.url) ? 'target="_blank" rel="noopener"' : ""}>${esc(alternate.label)}</a></p>` : ""}
      ${isOffer && C.offer.note ? `<p class="brief-note">${esc(C.offer.note)}</p>` : ""}
    </div></div>`;
  },
  offers: (c) => offerStack(c.offers, c.pick, c.alt, true),
  card: (c) => `
    <div class="panel d3 card-x card-${esc(c.id)}"><div class="panel-pad">
      <span class="panel-tag"><span class="dot"></span>${esc(c.kicker || "")}</span>
      <h3 class="card-title">${esc(c.title)}</h3>
      ${c.body ? `<p class="card-body">${rich(c.body)}</p>` : ""}
      ${c.button ? `<a class="brief-cta card-btn" href="${esc(c.button.url)}" ${/^https?:/.test(c.button.url) ? 'target="_blank" rel="noopener"' : ""}>${esc(c.button.label)}</a>` : ""}
      ${c.secondary ? `<a class="card-secondary" href="${esc(c.secondary.url)}" target="_blank" rel="noopener">${esc(c.secondary.label)} ↗</a>` : ""}
    </div></div>`,
  clarify: (c) => `
    <div class="panel d2 clarify" data-clarify="${esc(c.key)}"><div class="panel-pad">
      <span class="panel-tag"><span class="dot"></span>Help us point you right</span>
      <p class="clarify-q">${esc(c.question)}</p>
      <div class="followups">${c.options.map((o) => `<button class="fu" data-tell="${esc(o.id)}">${esc(o.label)}</button>`).join("")}</div>
      <p class="brief-note" style="text-align:left">One tap, optional. It only changes what this page shows you.</p>
    </div></div>`,
  rail: (c) => `
    <div class="panel d4"><div class="panel-pad">
      <span class="panel-tag"><span class="dot"></span>Watch next</span>
      <div class="rail">${c.clips.map((m, i) => `
        <div class="rail-item" data-rail="${i}" role="button" tabindex="0">
          <div class="rail-thumb"><img src="${esc(m.thumb)}" alt="" loading="lazy" onerror="this.style.display='none'"/>${PLAY}${m.seconds ? `<span>${mmss(m.seconds)}</span>` : ""}</div>
          <div class="rail-title">${esc(m.title)}</div>
        </div>`).join("")}</div>
    </div></div>`,
  followups: (c) => `
    <div class="panel d3"><div class="panel-pad">
      <span class="panel-tag"><span class="dot"></span>People in your spot also ask</span>
      <div class="followups" id="followups">${c.followups.map((q) => `<button class="fu" data-q="${esc(q)}">${esc(q)}</button>`).join("")}</div>
    </div></div>`,
};

/* The creator's offers, after an answer: Jev's pick as the hero card, a close second if
   there is one, the rest as compact rows with their fit. Deals in once per answer. */
function offerStack(offers, pickId, altId, deal) {
  if (!offers || !offers.length) return "";
  const byFit = [...offers].sort((a, b) => b.p - a.p);
  const pick = offers.find((o) => o.id === pickId) || byFit[0];
  const alt = altId ? offers.find((o) => o.id === altId) : null;
  const rest = byFit.filter((o) => o !== pick && o !== alt);
  const ext = (u) => (/^https?:/.test(u) ? 'target="_blank" rel="noopener"' : "");
  const fit = (o) => Math.round((o.p || 0) * 100);
  const d = (i) => (deal ? ` deal" style="animation-delay:${i * 110}ms` : "");
  return `
    <div class="offers-stack panel" data-offers>
      <div class="o-hero${d(0)}">
        <span class="o-kicker">Best next step for you</span>
        <div class="o-head"><h3 class="o-name">${esc(pick.label)}</h3>${pick.price ? `<span class="o-price">${esc(pick.price)}</span>` : ""}</div>
        ${pick.blurb ? `<p class="o-blurb">${esc(pick.blurb)}</p>` : ""}
        ${(pick.points || []).length ? `<ul class="o-points">${pick.points.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
        <a class="o-cta" href="${esc(pick.url)}" ${ext(pick.url)} data-offer="${esc(pick.label)}">${esc(pick.label)} <span aria-hidden="true">→</span></a>
        <div class="o-fit"><span class="o-meter"><i data-w="${fit(pick)}"></i></span><span>${fit(pick)}% fit for what you asked</span></div>
      </div>
      ${alt ? `
      <div class="o-alt${d(1)}">
        <span class="o-kicker">Also a good fit</span>
        <div class="o-head"><h4 class="o-name sm">${esc(alt.label)}</h4>${alt.price ? `<span class="o-price ghost">${esc(alt.price)}</span>` : ""}</div>
        ${alt.blurb ? `<p class="o-blurb">${esc(alt.blurb)}</p>` : ""}
        <a class="o-cta ghost" href="${esc(alt.url)}" ${ext(alt.url)} data-offer="${esc(alt.label)}">${esc(alt.label)} <span aria-hidden="true">→</span></a>
        <div class="o-fit"><span class="o-meter"><i data-w="${fit(alt)}"></i></span><span>${fit(alt)}% fit</span></div>
      </div>` : ""}
      ${rest.length ? `
      <div class="o-more${d(alt ? 2 : 1)}">
        <span class="o-kicker">Other ways to work with ${esc(WHO)}</span>
        ${rest.map((o) => `<a class="o-row" href="${esc(o.url)}" ${ext(o.url)} data-offer="${esc(o.label)}">
          <span class="o-row-name">${esc(o.label)}${o.price ? ` <small>${esc(o.price)}</small>` : ""}</span>
          <span class="o-meter mini"><i data-w="${fit(o)}"></i></span><span class="o-row-fit">${fit(o)}%</span></a>`).join("")}
      </div>` : ""}
    </div>`;
}
function fillMeters(root) {
  const go = () => root.querySelectorAll(".o-meter i[data-w]").forEach((i) => { i.style.width = `${i.dataset.w}%`; });
  requestAnimationFrame(() => requestAnimationFrame(go));
  setTimeout(go, 400); // lands even if animation frames are paused
}

function renderAnswer(raw, d) {
  if (d.ui && d.ui.primary) primary = d.ui.primary; // before drawing, so every card agrees on the next step
  alternate = (d.ui && d.ui.alternate) || null;
  const moments = d.moments || [];
  const comps = d.components || [];
  const col = (name) => comps.filter((c) => c.column === name && CATALOG[c.type]).map((c) => CATALOG[c.type](c)).join("");

  answer.innerHTML = `
    ${echo(raw)}
    <h2 class="answer-h">${esc(d.title)}</h2>
    <p class="answer-sub">${moments[0] ? `A straight answer — and the moment ${esc(WHO)} talks about it on video.` : "A straight answer for what you're dealing with."} ${d.read ? `<button class="why-btn" id="why-btn" type="button">Why this page?</button>` : ""}</p>
    <div class="why" id="why" hidden></div>
    <div class="answer-grid">
      <div class="col">${col("main")}</div>
      <div class="col">${col("side")}</div>
    </div>`;

  applyPrimary(d.ui && d.ui.primary);
  fillMeters(answer);
  streamParas("#synth-body", d.paras || []);
  stickyCall.hidden = false;
  wireAnswerEvents(moments, (comps.find((c) => c.type === "rail") || {}).clips || []);
  renderWhy(d.read);

  clearTimeout(window.__sheetTimer);
  if (!d.ui || d.ui.popup !== false) window.__sheetTimer = setTimeout(() => {
    if (document.body.classList.contains("answering") && !sheet.classList.contains("show") && vidScrim.hidden) openSheet();
  }, ((d.ui && d.ui.popup_after_seconds) || C.offer.popup_after_seconds || 14) * 1000);
}

/* "Why this page?": what Jev decided, how sure it was, and what it declined to decide. */
function renderWhy(read) {
  const box = $("#why"), btn = $("#why-btn");
  if (!box || !btn || !read) return;
  const pct = (x) => (x == null ? "" : ` · ${Math.round(x * 100)}%`);
  const label = (q, a) => (q === "Topic" && C.jev?.lanes?.[a] ? C.jev.lanes[a].label : q === "What they want" && C.jev?.intent_labels?.[a] ? C.jev.intent_labels[a] : a);
  box.innerHTML = `
    <div class="why-h">How this page was shaped</div>
    <ul>${(read.why || []).map((w) => `<li><b>${esc(w.q)}:</b> ${esc(label(w.q, w.answer))}<span class="why-c">${w.by === "you told us" ? " · you told us" : pct(w.confidence)}</span></li>`).join("")}
    ${(read.declined || []).map((w) => `<li class="why-no"><b>${esc(w.q)}:</b> ${w.answer === "other" ? "didn't fit any of the options" : `not sure (best guess ${esc(label(w.q, w.answer || "?"))}${pct(w.confidence)})`}, so the page doesn't act on it</li>`).join("")}</ul>
    <p class="why-foot">Decided by Jev, a decision model that only answers typed questions with calibrated odds${read.jev ? ` · ${read.jev.ms} ms · $${(read.jev.cost || 0).toFixed(5)}` : ""}. Nothing about you is stored anywhere but this browser. <a href="./for-creators">How this works</a></p>`;
  btn.onclick = () => { box.hidden = !box.hidden; };
}

function leadMoment(m) {
  return `
    <div class="panel d2 video-card" data-moment="0" role="button" tabindex="0" aria-label="Play the clip where ${esc(WHO)} answers this">
      <div class="video-poster">
        <img src="${esc(m.thumb)}" alt="" onerror="this.style.display='none'"/>
        <div class="video-overlay-top">
          <span class="match-pill">▶ ${esc(WHO)} answers this · ${m.t < 3 ? "right from the start" : `starts at ${mmss(m.t)}`}</span>
          ${m.seconds ? `<span class="dur-pill">${mmss(m.seconds)}</span>` : ""}
        </div>
        <div class="play-btn">${PLAY.replace(/16/g, "26")}</div>
        <div class="video-overlay-bot">
          <div class="video-chapter-label">${m.published ? esc(new Date(m.published + "T12:00:00").toLocaleDateString(undefined, { month: "short", year: "numeric" })) : ""}</div>
          <div class="video-chapter-title">${esc(m.title)}</div>
        </div>
      </div>
      <div class="video-foot quote-foot">
        <div class="tlabel">In ${esc(WHO)}'s words, ${m.t < 3 ? "as the clip opens" : `at ${mmss(m.t)}`}</div>
        <blockquote class="moment-quote">“${esc(m.quote)}”</blockquote>
        <div class="video-links">
          <span class="video-ep">${esc(m.why)}</span>
          <span class="src-links"><span class="src-label">Watch on</span>${sourceLinks(m)}</span>
        </div>
      </div>
    </div>`;
}

function noMoment() {
  return `
    <div class="panel d2"><div class="panel-pad">
      <span class="panel-tag"><span class="dot"></span>On the record</span>
      <p class="answer-sub" style="margin:8px 0 0">${esc(WHO)} hasn't covered this exact situation on video yet. ${esc(C.offer.no_moment || "")}</p>
    </div></div>`;
}

function momentRow(m, i) {
  return `<div class="clip-row" data-moment="${i + 1}" role="button" tabindex="0">
    <div class="clip-thumb"><img src="${esc(m.thumb)}" alt="" onerror="this.style.display='none'"/>${PLAY}</div>
    <div class="clip-meta"><div class="ct">${esc(m.title)}</div><div class="cs">from ${mmss(m.t)}</div><div class="cq">“${esc(m.quote)}”</div><div class="src-links small">${sourceLinks(m)}</div></div>
  </div>`;
}

function factPairs(f) {
  if (!f) return [];
  const rows = [];
  if (f.situation) rows.push(["Situation", f.situation]);
  for (const field of C.intake.fields || []) {
    const v = f[field.key];
    if (Array.isArray(v)) { if (field.each) v.forEach((x) => rows.push([field.label, cap(x)])); else if (v.length) rows.push([field.label, cap(v.join(", "))]); }
    else if (v) rows.push([field.label, cap(v)]);
  }
  return rows;
}

function factRows(f) {
  const rows = factPairs(f);
  if (!rows.length) return `<p class="brief-note" style="text-align:left">Tell us a little more and we'll keep track of it here.</p>`;
  return rows.map(([k, v]) => `<div class="fact-chip"><span class="fk">${esc(k)}</span><span class="fv">${esc(v)}</span></div>`).join("");
}

/* ---------- streaming text ---------- */
async function streamParas(sel, paras) {
  const box = $(sel); if (!box) return;
  box.innerHTML = "";
  for (const html of paras) {
    const p = document.createElement("p");
    box.appendChild(p);
    await typeHtml(p, rich(html));
  }
}
function typeHtml(el, html) {
  return new Promise((resolve) => {
    const tokens = html.match(/<[^>]+>|[^<]+/g) || [];
    let i = 0; const caret = document.createElement("span"); caret.className = "caret"; el.appendChild(caret);
    function step() {
      if (!caret.isConnected) return resolve();
      if (i >= tokens.length) { caret.remove(); return resolve(); }
      const tok = tokens[i++];
      if (tok.startsWith("<")) { caret.insertAdjacentHTML("beforebegin", tok); step(); return; }
      const tmp = document.createElement("span"); tmp.innerHTML = tok; const text = tmp.textContent;
      let j = 0; const node = document.createTextNode(""); caret.before(node);
      const iv = setInterval(() => { node.textContent += text.slice(j, j + 2); j += 2; if (j >= text.length) { clearInterval(iv); step(); } }, 8);
    }
    step();
  });
}

/* ---------- answer interactions ---------- */
function wireAnswerEvents(moments, rail = []) {
  const open = (el) => { const m = moments[+el.dataset.moment]; if (m) { openVideo(m); did(`opened clip: ${m.title}`); } };
  answer.querySelectorAll("[data-rail]").forEach((el) => {
    const go = () => { const m = rail[+el.dataset.rail]; if (m) { openVideo(m); did(`opened clip: ${m.title}`); } };
    el.addEventListener("click", go);
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  });
  answer.addEventListener("click", (e) => {
    const t = e.target.closest("[data-tell]");
    if (t) { const key = t.closest("[data-clarify]").dataset.clarify; ev.told[key] = t.dataset.tell; did(`told us ${key}: ${t.textContent}`); t.closest(".clarify").remove(); return; }
    const a = e.target.closest("a");
    if (a && a.dataset.offer) did(`tapped offer: ${a.dataset.offer}`);
    else if (a && a.closest(".card-x")) did(`tapped card: ${a.closest(".card-x").querySelector(".card-title")?.textContent || ""} (${a.textContent.trim()})`);
    else if (a && a.matches("[data-primary]")) did(`tapped next step: ${a.textContent.trim()}`);
  });
  answer.querySelectorAll("[data-moment]").forEach((el) => {
    el.addEventListener("click", (e) => { if (e.target.closest("a")) return; open(el); });
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(el); } });
  });
  answer.querySelectorAll("[data-open-sheet]").forEach((b) => b.addEventListener("click", openSheet));
  const fu = $("#followups");
  if (fu) fu.addEventListener("click", (e) => { const b = e.target.closest(".fu"); if (b) { askInput.value = b.dataset.q; runAsk(b.dataset.q); } });
  const ap = $("#audio-play"); if (ap) ap.addEventListener("click", toggleAudio);
}

let moldTimer = null;
function did(what) {
  ev.did.push(what); saveEv();
  clearTimeout(moldTimer);
  moldTimer = setTimeout(remold, 400);
}
async function remold() {
  if (!current) return;
  try {
    const r = await fetch("./api/mold", { method: "POST", headers: { "content-type": "application/json", "x-visitor": VISITOR }, body: JSON.stringify({ q: current.raw, history: ev.history.slice(0, -1), did: ev.did, told: ev.told }) });
    const m = await r.json();
    if (!r.ok || m.skipped || m.error) return;
    applyPrimary(m.primary);
    const side = answer.querySelectorAll(".answer-grid .col")[1];
    const stack = side && side.querySelector("[data-offers]");
    if (stack && m.offers) { stack.outerHTML = offerStack(m.offers, m.primary.id, m.alternate ? m.alternate.id : null, true); fillMeters(side); }
    if (side) {
      side.querySelectorAll(".card-x").forEach((x) => x.remove());
      const anchor = side.querySelector(".brief-cta, [data-primary]")?.closest(".panel");
      const html = m.cards.map((c) => CATALOG.card(c)).join("");
      if (anchor) anchor.insertAdjacentHTML("afterend", html); else side.insertAdjacentHTML("afterbegin", html);
      const old = side.querySelector(".clarify");
      if (old) old.remove();
      if (m.clarify) side.insertAdjacentHTML("afterbegin", CATALOG.clarify(m.clarify));
    }
    current.data.read = m.read;
    renderWhy(m.read);
  } catch (_) { /* the page simply stays as it is */ }
}

/* ---------- audio: the browser reads the answer aloud (no key, no server) ---------- */
const canSpeak = "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
let audioOn = false;
function toggleAudio() {
  if (audioOn) { stopAudio(); return; }
  if (!current || !canSpeak) return;
  const u = new SpeechSynthesisUtterance(stripTags((current.data.paras || []).join(" ")));
  u.lang = C.lang || "en-US"; u.rate = 1;
  u.onend = stopAudio; u.onerror = stopAudio;
  speechSynthesis.cancel(); speechSynthesis.speak(u);
  audioOn = true; $("#audio-row").classList.add("playing"); setPlayIcon(true);
}
function stopAudio() { if (audioOn && canSpeak) speechSynthesis.cancel(); audioOn = false; const row = $("#audio-row"); if (row) row.classList.remove("playing"); setPlayIcon(false); }
function setPlayIcon(playing) { const b = $("#audio-play"); if (b) b.innerHTML = playing ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>' : PLAY; }

/* ---------- video modal: the real clip, from the quoted second ---------- */
function openVideo(m) {
  clearTimeout(window.__sheetTimer);
  stopAudio();
  const src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(m.youtube_id)}?start=${Math.max(0, m.t)}&autoplay=1&rel=0&modestbranding=1&playsinline=1`;
  vidStage.innerHTML = `
    <div class="vid-screen ${m.vertical ? "vertical" : ""}">
      <iframe src="${src}" title="${esc(m.title)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>
    </div>
    <div class="vid-info">
      <div class="vi-ch">${esc(C.name)} · from ${mmss(m.t)}</div>
      <div class="vi-title">${esc(m.title)}</div>
      ${m.quote ? `<div class="vid-transcript"><div class="tlabel">What ${esc(WHO)} says at ${mmss(m.t)} (captions)</div>“${esc(m.quote)}”</div>` : ""}
      <div class="src-links dark"><span class="src-label">Also posted on</span>${sourceLinks(m)}</div>
    </div>`;
  vidScrim.hidden = false; requestAnimationFrame(() => vidScrim.classList.add("show"));
}
function closeVideo() { vidScrim.classList.remove("show"); setTimeout(() => { vidScrim.hidden = true; vidStage.innerHTML = ""; }, 300); }
vidClose.addEventListener("click", closeVideo);
vidScrim.addEventListener("click", (e) => { if (e.target === vidScrim) closeVideo(); });

/* ---------- the offer sheet, pre-filled from what they said ---------- */
function openSheet() {
  if (!current) return;
  const f = current.data.facts || {};
  surveyState = { when: null, comments: current.raw.length < 220 ? current.raw : "" };
  renderSheet(f);
  sheetScrim.hidden = false; sheet.hidden = false;
  requestAnimationFrame(() => { sheetScrim.classList.add("show"); sheet.classList.add("show"); });
}
function closeSheet() { sheet.classList.remove("show"); sheetScrim.classList.remove("show"); setTimeout(() => { sheet.hidden = true; sheetScrim.hidden = true; }, 420); }
sheetClose.addEventListener("click", closeSheet);
sheetScrim.addEventListener("click", closeSheet);

function renderSheet(f) {
  const o = C.offer, form = o.form || {};
  const n = factPairs(f).slice(0, 4).map(([, v]) => v);
  const timing = form.timing || { label: "How soon do you want to hear back?", options: ["Today", "This week", "No rush"] };
  // When Jev picked a different offer than the creator's default, the sheet leads with that offer.
  const stack = ((current && current.data.components) || []).find((c) => c.type === "offers");
  const picked = primary && primary.url !== o.url ? { ...primary, ...((stack && stack.offers.find((x) => x.id === primary.id)) || {}) } : null;
  const noted = `<p class="sheet-p">${n.length ? `We've already noted <b>${esc(n.join(" · "))}</b> from what you told us — no need to repeat it.` : "We'll start from what you already told us."}</p>`;
  sheetBody.innerHTML = `
    <span class="sheet-kicker">● ${esc(picked ? "Best next step for you" : o.name)}</span>
    <h2 class="sheet-h">${esc(picked ? picked.label : o.sheet_heading || `Want ${WHO} to look at this?`)}</h2>
    ${picked ? `${picked.blurb ? `<p class="sheet-p">${esc(picked.blurb)}</p>` : ""}${(picked.points || []).length ? `<ul class="o-points sheet-points">${picked.points.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}` : noted}

    ${offerButton("call-big", 'data-track="sheet-offer"')}
    <p class="call-sub">${esc(picked ? picked.price || "" : o.note || "")}</p>

    <div class="or-rule">${esc(form.or_label || `or have ${WHO}'s team reach out`)}</div>
    ${picked ? noted : ""}

    <div class="survey-q">
      <span class="ql">${esc(timing.label)}</span>
      <div class="opt-row" data-key="when">${timing.options.map((v) => `<button class="opt" data-val="${esc(v)}">${esc(v)}</button>`).join("")}</div>
    </div>

    <div class="survey-q">
      <span class="ql">Anything else ${esc(WHO)} should know? <span style="color:var(--ink-faint);font-weight:400">(optional)</span></span>
      <textarea class="field" id="comments" placeholder="${esc(form.comments_placeholder || "A detail that matters…")}">${esc(surveyState.comments)}</textarea>
    </div>

    <div class="survey-q">
      <span class="ql">Where should we reach you?</span>
      <div class="field-grid">
        <input class="field" id="s-name" type="text" placeholder="First name" autocomplete="given-name" />
        <input class="field" id="s-contact" type="text" placeholder="Email or phone" autocomplete="email" />
      </div>
    </div>

    <button class="submit-review" id="submit-review">${esc(form.submit_label || `Send this to ${WHO}`)}</button>
    <p class="privacy" id="sheet-error"></p>`;

  sheetBody.querySelectorAll(".opt-row").forEach((row) => {
    row.addEventListener("click", (e) => { const op = e.target.closest(".opt"); if (!op) return; row.querySelectorAll(".opt").forEach((x) => x.classList.remove("sel")); op.classList.add("sel"); surveyState[row.dataset.key] = op.dataset.val; });
  });
  $("#comments").addEventListener("input", (e) => { surveyState.comments = e.target.value; });
  $("#submit-review").addEventListener("click", () => submitLead(f));
}

async function submitLead(f) {
  const name = ($("#s-name").value || "").trim(), contact = ($("#s-contact").value || "").trim();
  if (!contact) { $("#sheet-error").textContent = "Add an email or phone so we can reach you."; $("#s-contact").focus(); return; }
  const btn = $("#submit-review"); btn.disabled = true; btn.textContent = "Sending…";
  const clip = (current.data.moments || [])[0];
  let sent = false, err = null;
  try {
    const r = await fetch("./api/lead", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, contact, when: surveyState.when, comments: surveyState.comments !== current.raw ? surveyState.comments : "", said: current.raw, facts: f, clip: clip ? clip.title : "" }) });
    const d = await r.json(); sent = !!d.sent; if (!r.ok) err = d.error;
  } catch (_) { err = "We couldn't send that just now."; }
  if (err) { btn.disabled = false; btn.textContent = C.offer.form?.submit_label || `Send this to ${WHO}`; $("#sheet-error").textContent = err; return; }

  const lines = [["In their words", current.raw], ...factPairs(f),
    surveyState.comments && surveyState.comments !== current.raw ? ["They added", surveyState.comments] : null,
    ["Wants to hear back", surveyState.when || "Not chosen"],
    clip ? ["Clip they watched", clip.title] : null].filter(Boolean);
  sheetBody.innerHTML = `
    <div class="sheet-success">
      <span class="sheet-kicker">● ${sent ? "Sent" : "Not sent — this page isn't connected yet"}</span>
      <h2 class="sheet-h">${name ? "Thanks, " + esc(name.split(" ")[0]) + "." : "Thanks."}</h2>
      <p class="sheet-p">${sent ? esc(C.offer.form?.success || `${WHO}'s team has this now, so nobody asks you to repeat yourself.`) : `This is the brief ${esc(WHO)} would get. Nothing was sent; use the button below instead.`}</p>
      <div class="brief-readout">${lines.map(([k, v]) => `<div class="br-line"><span class="bk">${esc(k)}</span><span class="bv">${esc(v)}</span></div>`).join("")}</div>
      <div style="margin-top:20px">${offerButton()}</div>
    </div>`;
}

/* ---------- voice ---------- */
let recog = null, listening = false;
function setupVoice() {
  if (!("webkitSpeechRecognition" in window || "SpeechRecognition" in window)) return;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  recog = new SR(); recog.continuous = false; recog.interimResults = true; recog.lang = C.lang || "en-US";
  recog.onstart = () => { listening = true; micBtn.classList.add("listening"); micStatus.textContent = "Listening… just say it."; };
  recog.onresult = (e) => {
    let txt = ""; for (const r of e.results) txt += r[0].transcript;
    askInput.value = txt;
    if (e.results[e.results.length - 1].isFinal) { micStatus.textContent = "Got it."; stopVoice(); runAsk(txt.trim()); }
  };
  recog.onerror = stopVoice; recog.onend = stopVoice;
}
function stopVoice() { listening = false; micBtn.classList.remove("listening"); try { recog && recog.stop(); } catch (_) {} }
micBtn.addEventListener("click", () => {
  if (!recog) { micStatus.textContent = "Voice isn't supported in this browser — go ahead and type."; askInput.focus(); return; }
  if (listening) stopVoice(); else try { recog.start(); } catch (_) {}
});

document.addEventListener("keydown", (e) => { if (e.key === "Escape") { if (vidScrim.classList.contains("show")) closeVideo(); else if (sheet.classList.contains("show")) closeSheet(); } });

/* ---------- homepage: real clips from the library ---------- */
async function buildClipGrid() {
  const grid = $("#ep-grid");
  try {
    const r = await fetch("./data/featured.json");
    if (!r.ok) throw new Error(String(r.status));
    const { clips } = await r.json();
    if (!clips.length) throw new Error("empty");
    grid.innerHTML = clips.map((c) => `
      <div class="ep-card" data-q="${esc(c.ask)}" role="button" tabindex="0">
        <div class="ep-thumb"><img src="${esc(c.thumb)}" alt="" loading="lazy" onerror="this.style.display='none'"/>${c.seconds ? `<span class="ep-num">${mmss(c.seconds)}</span>` : ""}<span class="play-mini">${PLAY.replace(/16/g, "18")}</span></div>
        <div class="ep-info">
          <div class="ep-topic">${c.published ? esc(new Date(c.published + "T12:00:00").toLocaleDateString(undefined, { month: "short", year: "numeric" })) : ""}</div>
          <div class="ep-title">${esc(c.title)}</div>
        </div>
      </div>`).join("");
    const go = (card) => { askInput.value = card.dataset.q; runAsk(card.dataset.q); };
    grid.addEventListener("click", (e) => { const card = e.target.closest(".ep-card"); if (card) go(card); });
    grid.addEventListener("keydown", (e) => { const card = e.target.closest(".ep-card"); if (card && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); go(card); } });
  } catch (_) {
    grid.closest(".band").hidden = true;
  }
}

(async function boot() {
  C = await (await fetch("./data/config.json")).json();
  WHO = C.short_name;
  applyConfig();
  setupVoice();
  buildClipGrid();
  const deep = new URLSearchParams(location.search).get("q");
  if (deep) { askInput.value = deep; runAsk(deep); }
})();
