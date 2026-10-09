# Launch copy

## Show HN

**Title:** Show HN: An AI that can only quote you – answers from a YouTube channel, verified to the second

**URL:** https://github.com/cgallic/creator-intake

**First comment:**

I built this for my own channel (548 shorts about building with AI agents and running
a small business), and then for anyone's.

You paste a YouTube channel. About ten minutes later there's a page where someone types
what they're dealing with. They get an answer built only from that creator's videos,
plus the clip, playing from the second the creator said it.

The part I care about: the model never writes a quote. It cites a clip and copies a
passage, and plain code then checks that the passage appears word for word in one
unbroken run of the creator's own caption lines. That check also gives the second to
play from. If any word is off, or the words belong to a guest or interviewer, the
quote is dropped before anyone sees it.

Who's talking is screened twice:

- YouTube marks speaker changes in captions with `>>`, and a turn that ends in a
  question is treated as the interviewer.
- A vision model compares every thumbnail against the channel avatar.

On my channel that second check caught product demos where my own AI receptionist was
talking. It would otherwise have quoted it as me.

Two models do two jobs:

- **The writer** (GPT-6 Luna on OpenRouter) gets every caption line in one cached
  prompt. That's about $0.002 a question.
- **The decider** is TypeSafe's Jev, a "System One" decision model that returns typed
  answers with calibrated odds in about 200 ms. It decides the topic and what the
  person wants, and only acts when it's at least 60% sure *and* 20 points clear of its
  second choice. Otherwise the page asks one quick question.

The clip shows up in about a second, from a caption word search plus a Jev relevance
check, while the written answer is still coming.

It's MIT licensed: a static page, Vercel functions, and a yt-dlp worker you run on any
box. Anyone can build an unofficial, noindexed preview of any channel. If it's yours,
you prove that with a code in your channel description, and the page gets your link.

Live: https://www.connorgallic.com/ask (mine) · build one: https://www.connorgallic.com/ask/new

I'd especially like feedback on the quote verification and the speaker heuristics.
That's where it can go wrong.

## Product Hunt

- **Name:** working name; pick before launch
- **Tagline (60 chars):** Your videos answer your DMs and book the call
- **Description:** Paste your YouTube channel. Your page answers every question with the
  exact clip where you already said it, verified word for word, then sends people to
  your link. It never talks as you. Free to try and free to claim. Lifetime Pro is $99 once for the first 100 creators. Open source.
- **Gallery:**
  1. A question typed, and the clip playing from the second, with the quote.
  2. "Why this page?", showing what it decided and how sure it was.
  3. The four-visitors comparison from /for-creators.
  4. Pricing.
- **Maker comment:** the story of building it on my own channel, the AI-receptionist
  clip it caught, and the price (free at launch, no monthly fee, no revenue share).

## Before launch

- [ ] Name and domain
- [x] Launch in free-claim mode (no `STRIPE_SECRET_KEY`; set it later to charge)
- [ ] 4+ gallery pages built and spot-checked
- [ ] Set `LEAD_WEBHOOK_URL` for Connor's own page, so there's an outcome number
- [ ] 40-second screen recording: a question, then the clip, then "Why this page?"
