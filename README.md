# Creator Intake — "Ask <creator>"

A page any creator can put in their bio. A visitor types (or says) what's going on
in their own words and gets three things:

1. **A straight answer**, grounded only in what the creator has actually said on video.
2. **The clip where the creator says it**, playing from that exact second, with the
   quote shown word for word. Every quote is checked against the creator's own captions
   before it reaches the page; interviewers' and guests' lines are never quoted as theirs.
3. **The creator's offer**: a call, a product or a consult, with a brief pre-filled
   from what the visitor said, so nobody repeats themselves.

Generalized from the Sutliff & Stout intake demo (Case-Engine-LLC/sutliff-ai-intake).
One repo, one folder per creator, one deploy per creator.

## Spin one up for a new creator

```bash
npm install
cp -r creators/_template creators/<slug>      # then edit creators/<slug>/config.json
node build/fetch.mjs <slug>                   # lists their channel(s), pulls captions (yt-dlp)
node build/index.mjs <slug>                   # builds creators/<slug>/corpus.json + featured.json
python build/contact_sheets.py creators/<slug>/unscreened.json /tmp/sheets   # QA: who is on camera?
node build/use.mjs <slug>                     # makes <slug> what this deploy serves (copies into data/)
npm test
npm run dev                                   # http://localhost:3000, reads .env
vercel deploy --prod                          # one Vercel project per creator
```

**Screen out voices that aren't the creator before going live.** A channel often mixes
on-camera takes with faceless ads, AI voiceovers, product demos and guests. Captions
from those would be quoted as the creator's words. `build/index.mjs` writes `unscreened.json`, and
`contact_sheets.py` renders those thumbnails on numbered sheets. Record the verdicts in
`creators/<slug>/screened.json`: `keep` for the creator on camera talking, `exclude` for
anything else. Then run index again. With `"require_screening": true` in config, clips
that haven't been screened never reach the corpus, so new uploads stay out until
someone screens them.

The only input is their YouTube channel URL. `fetch.mjs` reads the `/videos`, `/shorts`
and `/streams` tabs and is safe to re-run: it only downloads captions for new uploads.
For a refresh, run fetch, index and use again, then deploy.

### config.json

Everything creator-specific lives here. `creators/_template/config.json` documents
every field. The important ones are:

| Field | What it does |
|---|---|
| `about`, `audience` | Who the creator is and who's asking. The model reads both. |
| `channels` | YouTube channel URLs to build the corpus from. |
| `speaker` | `"solo"` means every caption line is the creator. `"interview"` (the default) uses YouTube's `>>` speaker markers and treats a segment ending in a question as someone else. That segment is shown as context but can never be quoted. |
| `known_facts` | True facts the guide may state even when no video does, such as prices and offer details. Everything else must come from the videos. |
| `rules` | Extra guardrails for this niche, for example "never promise results." |
| `offer` | The CTA: its URL, labels, the pop-up sheet and the lead form. |
| `intake.fields` | Facts the model pulls out of what the visitor said. They fill "What you've told us" and pre-fill the lead brief. |
| `theme` | Colors and fonts, applied as CSS variables. |
| `exclude_video_ids` | Leave out ads, AI voiceovers, or videos where someone else talks. |

## How it works

- **`creators/<slug>/corpus.json`** holds every caption line of the creator's own
  uploads, each with the second it starts at. Uploads are taken newest first, up to
  `corpus_token_budget` (150k tokens by default), so the whole corpus fits in one
  cached prompt.
- **`api/answer.js`** puts the corpus in a cached system block (1h TTL) and asks
  `claude-opus-5-5` (effort `low`, structured output) for an answer, moments, facts
  and follow-ups. Each moment is a source id plus a passage. **`api/_verify.js`**
  keeps it only if the passage appears word for word inside one unbroken run of the
  creator's lines, and takes the start second from there. Anything else is dropped.
- **`api/lead.js`** POSTs the brief as JSON to `LEAD_WEBHOOK_URL` (Zapier, Make, n8n
  or a CRM). Without that URL it reports `sent: false`, and the page says plainly
  that nothing was sent.
- **The page** (`index.html`, `script.js`, `styles.css`) has no build step. It paints
  itself from `data/config.json` and renders only what the endpoints return.

## Put it on the creator's own site

Each deploy works at its own `*.vercel.app` URL and under a sub-path of another site.
To serve it at `example.com/ask`, add a proxy rewrite on that site, for example in
Next.js `next.config.ts`:

```ts
async rewrites() {
  return [
    { source: "/ask", destination: "https://<project>.vercel.app/" },
    { source: "/ask/:path*", destination: "https://<project>.vercel.app/:path*" },
  ];
}
```

The page notices it is under `/ask` and resolves its assets and API calls there. Set
`canonical_url` in config to the public address.

## Env

| Var | |
|---|---|
| `ANTHROPIC_API_KEY` | required |
| `LEAD_WEBHOOK_URL` | where leads go; optional |
| `ANSWER_LIMIT_PER_HOUR` | questions per visitor per hour, per function instance (default 30) |
| `ANSWER_CAP_PER_HOUR` | questions across all visitors per hour, per function instance (default 300): the spend guard |

## Cost, speed, limits

Each question costs about $0.05 and takes 10–17 s: a cache read of the corpus plus
about 1.5k output tokens. The rate limits are best effort only. Before a big public
push, add a Vercel Firewall rate-limit rule on `/api/answer`.

YouTube captions are auto-generated, so a quote is exactly what the captions say,
including their mistakes.
