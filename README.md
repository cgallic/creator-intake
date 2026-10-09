# creator-intake: an AI that can only quote you

Point it at a YouTube channel and it builds a page where people type what's going
on in their own words and get:

1. **A straight answer**, grounded only in what the creator has said on video.
2. **The clip where they said it**, playing from that exact second. Every quote is
   checked word for word against the creator's own captions before it shows.
   Interviewers, guests and AI voices are screened out, so it never puts words in
   the creator's mouth.
3. **The creator's next step**: a call, a product, a course. A decision model picks
   the one that fits what this visitor asked and did, and asks them one quick
   question when it can't tell, instead of guessing.

It answers *about* what the creator said and shows the receipt. It never talks as them.

- Live example: **https://www.connorgallic.com/ask**
- How it works, with real numbers: **https://www.connorgallic.com/ask/for-creators**
- Build a preview from any channel: **https://ask-connor.vercel.app/new**

About $0.002 a question with GPT-6 Luna on OpenRouter, and about $0.00004 per decision.

## How it works

```
 visitor types ──► Jev reads it (topic, intent, which cards)      0.2 s ┐
               └─► the writer drafts the answer from every clip   ~7 s  ├─► page built for them
                    └─► code checks each quote word for word             │
                        └─► Jev checks each clip is on point      0.3 s ┘
 visitor taps / opens a clip ──► Jev re-reads, page reshapes (no new answer)
```

- **The writer** (any OpenRouter model, GPT-6 Luna by default) gets every caption
  line of the creator's videos in one cached prompt and drafts the answer, quoting
  clips by id.
- **`api/_verify.js`** keeps a quote only if those exact words appear in one
  unbroken run of the creator's own caption lines. That run also gives the second
  to play from.
- **Jev** ([TypeSafe's](https://typesafe.ai) "System One" decision model, served by
  OpenRouter at `/api/v1/systemone`) never writes text. It answers typed questions
  with calibrated odds. The page acts on a topic or intent only when Jev is at least
  60% sure and at least 20 points ahead of its second choice. Otherwise it asks the
  visitor. What it infers changes the layout, never the wording of the answer.
- **The page** is a static HTML file that renders a component list from the API
  (A2UI-style). "Why this page?" on every answer shows what was decided and how sure
  it was.

## Self-serve: paste a channel, get a page

```
 /new  ──POST /api/new──►  job (Vercel Blob)  ◄──poll──  build/worker.mjs (any box with yt-dlp)
                                                           1. read the channel
                                                           2. captions for the newest 60 uploads
                                                           3. keep only the creator: a vision check of each thumbnail
                                                              against the avatar, AI-voice phrases, re-uploads
                                                           4. draft the page (intro, topics, starter questions)
                                                           5. Jev tags each clip's topic
 /c/<slug>  ◄──────────────────  creators/<slug>/*.json  ◄──  6. publish
```

The worker never holds the OpenRouter key. Every AI call goes through the app's
narrow proxy (`api/ai.js`), which is locked to a shared `WORKER_SECRET`, to two
endpoints, and to an allowlist of models.

**Anyone can paste anyone's channel, so a self-serve page is an unofficial
preview.** It's labelled as one, it's kept out of search engines, and its only next
step is the creator's own channel until the owner claims the page.

## Run your own

1. Deploy this repo to Vercel. In the dashboard, add a Blob store to the project:
   Storage → Blob, which sets `BLOB_READ_WRITE_TOKEN`.
2. Set the env vars:

| Var | |
|---|---|
| `OPENROUTER_API_KEY` | required |
| `WORKER_SECRET` | any long random string, shared with the worker |
| `ANSWER_MODEL` | text model (default `openai/gpt-6-luna`) |
| `JEV_MODEL` | decision model (default `typesafe/jev-1.13`). `JEV_OFF=1` disables it |
| `ANSWER_DAILY_CAP_USD` / `ANSWER_MONTHLY_CAP_USD` | stop answering past this spend on the key (default 5 / 30) |
| `NEW_BUILDS_PER_DAY` | self-serve builds per day across everyone (default 40) |
| `LEAD_WEBHOOK_URL` | where the pre-filled lead brief is POSTed |

3. Run the worker anywhere that has Node 20 and `yt-dlp`:

```bash
APP_URL=https://your-app.vercel.app WORKER_SECRET=... node build/worker.mjs
```

### Or build one page by hand, with full control

```bash
cp -r creators/_template creators/<slug>          # edit config.json: offer, cards, topics, routes
node build/fetch.mjs <slug>                        # captions (yt-dlp)
node build/index.mjs <slug>                        # corpus.json + featured.json
python build/contact_sheets.py creators/<slug>/unscreened.json /tmp/sheets   # screen who's on camera
OPENROUTER_API_KEY=... node build/tag-lanes.mjs <slug>   # Jev tags each clip's topic
node build/stats.mjs <slug>
node build/use.mjs <slug>                          # serve it from data/
npm test && vercel deploy --prod
```

`creators/connor/` is a complete worked example: 548 screened clips, cards, topics,
routes and demo snapshots. `creators/_template/config.json` documents every field.

To serve the page under another site's path, add a proxy rewrite, for example in
Next.js: `{ source: "/ask/:path*", destination: "https://<app>.vercel.app/:path*" }`.
The page detects the sub-path by itself.

## Files

| | |
|---|---|
| `index.html`, `script.js`, `styles.css` | the page (no build step) |
| `for-creators.html`, `new.html` | the explainer and the self-serve build page |
| `api/answer.js`, `api/_engine.js` | answer + verified moments + Jev read + component list |
| `api/_verify.js` | the word-for-word quote check |
| `api/_jev.js`, `api/mold.js` | Jev questionnaires; re-molding from what the visitor does |
| `api/new.js`, `api/worker.js`, `api/ai.js` | self-serve queue, worker channel, AI proxy |
| `api/_creator.js`, `api/_store.js` | per-creator data (bundled or Blob) |
| `build/worker.mjs` | the self-serve builder |
| `build/*.mjs`, `build/contact_sheets.py` | the hand-built pipeline |

## Tests

```bash
npm test
```

These cover the quote guarantee, the spend cap, Jev's thresholds, routing and
fallbacks, and channel parsing.

## License

MIT
