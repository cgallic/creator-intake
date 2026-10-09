# Ask the Course — PRD

*Draft 1, 2026-10-09. Owner: Connor Gallic. Status: proposed. Working name.*

## The idea

**Your course answers student questions at 2am, from the exact second of the lesson.**

A course creator uploads their lessons. Students get a private "Ask the course" page,
which can be linked from or embedded in Kajabi, Skool, Teachable or Circle. A student
types what they're stuck on. They get a straight answer, built only from the creator's
own lessons. The lesson plays from the second the creator explains it, and the quote is
checked word for word against the transcript. They also get the next lesson to watch.

When the course doesn't cover the question, the page says so and sends the student to
the instructor. The creator gets a weekly list of what students asked that no lesson
answers.

It answers *about* what the instructor taught, and it never makes up course content.

## Problem

- Course students ask the same questions over and over, in the community, in DMs and
  on support email. The answer usually already exists in a lesson; the student just
  can't find the minute it's in.
- A student who gets stuck stops. Stopped students don't finish, don't buy the next
  product, and ask for refunds.
- Creators and their assistants spend hours a week re-answering, or they don't, and
  students churn.
- A generic AI chatbot on the course makes things up, can't point to the lesson, and
  answers in a voice that isn't the creator's. Creators don't trust it with their
  students.

## Who it's for

| | |
|---|---|
| **Buyer** | Solo or small-team course creators: 20+ video lessons, 100 to 5,000 students, sold on Kajabi, Skool, Teachable, Thinkific, Podia or Circle, often with a paid community or cohort |
| **Also** | Coaches with recorded group calls or office hours (the recordings become the course); agencies running courses for clients |
| **Users** | Students (ask); the creator (sets up the course, reads the weekly report, answers escalations) |
| **Not for** | Universities and enterprise L&D (procurement, SSO), and courses that are mostly text |

## Why us, why now

- **It's already built.** The creator-intake engine (github.com/cgallic/creator-intake,
  MIT) already handles transcripts with second-level timestamps, quotes verified word
  for word, answers from a cached corpus at about $0.002 a question, and the Jev
  decision layer that routes visitors and asks them when it's unsure.
- **Transcription is nearly free for us.** Whisper runs on our own GPU (the agent box's
  3090).
- **The anti-chatbot position is open.** Creators resent AI that speaks as them or
  invents things. "Only answers from your lessons, and shows the second" is a promise
  a generic bot can't make.

## Outcomes and success metrics

| Metric | Target for the first 10 courses |
|---|---|
| Questions answered with a verified lesson clip | 70% or more |
| Time from upload to a working page | under 30 minutes for 5 hours of video |
| Creator-reported drop in repeat questions | "noticeably fewer" from 7 of 10 creators by week 4 |
| Weekly report open rate | 60% or more |
| Paid conversion from trial | 30% or more |

## Scope: v1

### 1. Creator onboarding

1. Sign in with a magic link.
2. Name the course and add lessons, by uploading files (mp4, mov, m4a, mp3) or pasting
   links (Google Drive, Dropbox, Vimeo, Loom, or an unlisted YouTube video they own).
   Lessons can be dragged into order and grouped into modules.
3. Transcription runs on our GPU with second-level timestamps. Long lessons are split
   into chapters by topic.
4. Optional: the instructor's escalation link (office hours booking, a community thread,
   or email) and the "next step" link (the upsell, the next course).
5. The creator gets a private link and an embed snippet. A free preview covers the
   first 3 lessons.

### 2. The student's "Ask the course" page

- A question box, three starter questions drawn from the lessons, and the course's
  module list.
- The answer shows:
  - a short, plain answer;
  - the lesson clip playing from the exact second, with the quote, checked word for word;
  - up to two more moments;
  - the next lesson to watch.
- The page is private: reached by a tokenized link or an embed, kept out of search, and
  it needs no student login. The creator's platform does the gating.

### 3. Jev routing

Each question gets one decision, in about 0.2 seconds, alongside the answer:

| Route | When | What the student sees |
|---|---|---|
| **Covered** | a lesson answers it | the answer plus the clip |
| **Prerequisite** | they're missing an earlier step | "Watch Module 2, Lesson 3 first", plus the clip |
| **Not covered** | no lesson answers it | "This course doesn't cover that yet", with an "Ask the instructor" button and the question pre-filled |
| **Stuck or frustrated** | they sound blocked or upset | the answer, plus a quiet flag to the creator |

The page acts on a route only when Jev is confident and the route clearly beats the
runner-up. Otherwise it defaults to the plain answer.

### 4. Creator's weekly report (email plus a simple page)

- Questions asked, and the share answered with a clip
- **Questions no lesson covers**, grouped. This is the next lessons to record.
- The lessons students get stuck on most
- Students flagged as stuck. The creator gets the question, but no personal data
  unless the student added an email to an escalation.

### 5. Billing

- **$29/mo per course**, or $49/mo for up to 3 courses. Includes a fixed number of
  lesson-hours and unlimited questions.
- 14-day trial, and a free preview of 3 lessons.

### Not in v1

Native Kajabi, Teachable or Skool API integrations; student accounts or SSO;
quizzes, grading or progress tracking; auto-posting answers into communities;
languages other than English; a mobile app.

## How it works

```
creator ─► upload / links ─► Blob storage ─► transcription worker (Whisper, our GPU)
                                               └─► lesson corpus: lines with the second
                                                   each was said, chapters, modules

student ─► question ─► Jev reads the route (covered / prerequisite / not covered / stuck)  0.2 s
                    └─► the writer drafts the answer from the whole course, quoting lessons by id
                         └─► code checks each quote word for word ─► clip plays from that second
                              └─► "not covered" ─► escalation link + the weekly report
```

### What's reused and what's new

| Reused from creator-intake | New |
|---|---|
| Answer engine with the cached corpus | File upload, using Vercel Blob multipart uploads |
| Word-for-word verification and the playback second | Transcription worker (faster-whisper on the 3090), replacing yt-dlp |
| Jev read, mold and judge | Course routes (covered / prerequisite / not covered / stuck) in place of lanes |
| Component-list page and theme | A lesson player (HTML5 video from Blob, or a link out with a time offset) |
| Per-tenant data in Blob, worker queue, spend cap, rate limits | Creator magic-link sign-in, course dashboard, weekly report email |
| | Stripe checkout and per-course limits |

### Unit economics

At about 400 questions a month, a course costs us:

- **Answers:** about $1 (400 × $0.002–0.003).
- **Transcription:** nothing on our own GPU (about $0.006/min if we fall back to an API).
- **Storage:** a few GB of video, a small fraction of the price.

At $29/mo the gross margin is above 90%.

## Go to market

- **Demo course:** Connor's long-form videos plus the 14 chapters of *Money Walking Out
  the Door*, as a "learn to stop missing calls" course with a live Ask page.
- **Show HN:** "My course answers student questions with the exact second of the lesson
  (MIT, verified quotes)". The open-source verifier is the story.
- **Product Hunt** a week later, with the first creators' numbers.
- **Design partners:** 10 course creators, found through Skool communities and creator
  X. Each uploads one module; we build it with them. No scraping: they own the videos.
- **Positioning against chatbots and AI clones:** "It only answers from your lessons,
  and it shows the second."

## Risks

| Risk | Mitigation |
|---|---|
| Kajabi, Skool or Teachable ship native AI Q&A | Win on the verified clip at the second, the "not covered" report and multi-platform support; move fast |
| Getting video out of platforms is painful (Kajabi hosts on Wistia) | Accept links and uploads, and publish a 2-minute export guide per platform |
| Wrong answers in front of paying students | Quotes are checked word for word; "not covered" is honest; the creator sees every question |
| Transcription errors on jargon | A creator glossary used at transcription time; the creator can fix lines |
| Jev misroutes | Act only on confident, clear reads; default to the plain answer |
| Student privacy | No student accounts; questions stored without personal data unless a student escalates |

## Milestones

| When | What |
|---|---|
| Days 1-2 | Upload and links, transcription worker, private Ask page with the four routes, the demo course |
| Days 3-5 | Creator sign-in and dashboard, the weekly report, Stripe, the embed snippet |
| Week 2 | 10 design partners onboarded; Show HN |
| Week 3 | Product Hunt; Skool and Kajabi export guides |
| Week 4 | Review the metrics; decide on pricing and the first platform integration |

## Open decisions

1. **Name.** Working name "Ask the Course"; candidates include Rewind, Lesson Receipts and Timestamp.
2. **Price.** $29/mo per course versus $49/mo for 3.
3. **Hosting.** Store the creator's video files for playback, or link back to their platform with a time offset.
4. **First 10 design partners.** Who to approach first.
5. **Repo.** Ship from creator-intake (same engine; recommended) or a separate repo.
