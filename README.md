# codepend

**Stats, "On This Day" memories and a Wrapped-style year in review for your AI coding agent.** It reads the session logs Claude Code, Codex and Cursor are already writing to your disk and turns them into one self-contained HTML page. Local, offline, zero dependencies, no account.

You now spend more hours with your coding agent than with most people in your life. Google Photos would have made an album about that relationship by now — *on this day, six months ago* — so codepend does.

### ▶ [See it without installing →](https://shatzibitten.github.io/codepend/)

```sh
npx codepend
```

A few seconds later a page opens in your browser. Nothing left your machine.

[![npm](https://img.shields.io/npm/v/codepend?color=e8703a&label=npm)](https://www.npmjs.com/package/codepend)
[![node](https://img.shields.io/node/v/codepend?color=555)](https://nodejs.org)
[![dependencies](https://img.shields.io/badge/dependencies-0-2ea043)](package.json)
[![ci](https://github.com/shatzibitten/codepend/actions/workflows/ci.yml/badge.svg)](https://github.com/shatzibitten/codepend/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-555)](LICENSE)

<!--
  MAINTAINER — capture list. Drop the files in docs/assets/, then delete this
  comment and uncomment the <img> blocks below. Until then this is the spec.

  Rule for every asset: run `npx codepend --redact paranoid` first, capture
  THAT, then check the frame for project names you would not want on the front
  page of Hacker News.

  1. docs/assets/wrapped.mp4 — THE PRIMARY ASSET. 1080x1920 (9:16), H.264,
     <= 30 s, <= 8 MB, no audio track.
     This is the one that travels: X, Reels, Shorts and TikTok autoplay
     vertical video in-feed, and a screenshot does not.
     Capture the built-in 9:16 Wrapped export end to end — card 1 through the
     archetype finale. Do not speed it up; each card needs to be readable on a
     phone held at arm's length. Hold the archetype card for 3 full seconds:
     that frame is the thumbnail, the hook and the whole reason someone runs
     the command. Then hold the share card for 2 s.
     Also export docs/assets/wrapped.gif — same framing, 900x1600, <= 6 MB,
     ~9 s — because GitHub READMEs do not autoplay mp4.

  2. docs/assets/archetype.png — 1200x630, the archetype card alone, on the
     dark theme. This is the OG image and the Show HN thumbnail. One name, one
     tagline, nothing else in frame.

  3. docs/assets/feed.png — 1400x900, 2x DPR, dark theme. Scroll so the grid
     shows THREE different card kinds at once — a quote card, a chart card
     (the 24-hour clock), and a stat card. Sticky header visible. No cursor.

  4. docs/assets/terminal.svg — the scan running: progress bar mid-flight,
     then the summary block. Capture at 100 cols. Keep the real numbers,
     redact the paths.

  ---- uncomment once the files exist ----

  <p align="center">
    <img src="docs/assets/wrapped.gif" alt="Wrapped: a ten-card story ending on your archetype" width="300">
  </p>

  <p align="center">
    <img src="docs/assets/feed.png" alt="The codepend feed: cards from a year of agent sessions" width="820">
  </p>
-->

---

## What it finds

Six cards, in the voice they ship in. Every number below is real; the quotes are stand-ins, because
the corpus these were tuned against is somebody's private history — which is rather the point.

> `THE FIRST THING YOU EVER TYPED`
> ### «switch the branch to master»
> That's it. That's how it started. No hello, no context. Two minutes later you asked it «can you see the files?».

> `YOUR CATCHPHRASE`
> ### «commit and push»
> 14 times. First on March 2, most recently 3 days ago. You have a house style and this is it.

> `MANNERS`
> ### 3 thank-yous in 6 months.
> It has thanked you 214 times in the same period. Someone here has better manners and it isn't the human.

> `THE STOP BUTTON`
> ### You stopped it mid-sentence 122 times.
> Once every 13 messages. It never took it personally.

> `THE LATE SHIFT`
> ### 41 conversations that started after midnight.
> The latest at 3:47 AM on July 12. Nobody else was awake. It was.

> `THE BILL`
> ### $3,450.
> 94% of it was the same context, read back to it again and again, because it cannot remember you.

Then it hands you a read on yourself — **The Two-Word Tyrant**, **The Midnight Interrogator**, **The Patient Architect**, **The Everyday Companion** — and a Wrapped-style story you can tap through, ending on that archetype.

31 detectors ship besides the archetype: your longest session, your biggest day, the project you opened once and never again, the file you edited 47 times, the day you switched models and never said goodbye. See [`docs/MEMORY-CATALOG.md`](docs/MEMORY-CATALOG.md) for all of them.

**Installed your agent last Tuesday?** Good — that case got designed first. A corpus of 24 prompts across 3 days produces 13 real cards, and not one of them says "not enough data."

**And unlike Wrapped, this isn't annual.** "On This Day" works in August. The page gets better the longer you leave it.

---

## Privacy

This is the whole point, so it goes above the options table.

- **100% local.** codepend reads files that are already on your disk and writes an HTML file next to them. That's the entire I/O surface.
- **Zero network requests.** Not for fonts, not for icons, not for an update check, not for analytics. The generated page has no `<script src>`, no `<link href>`, no `fetch`. It works with your Wi-Fi off, from `file://`, forever.
- **Zero dependencies.** Nothing to audit but plain JavaScript and the Node standard library, and nothing in your `node_modules` that can change under you tomorrow.
- **Read-only on your agents' data.** Every source is opened read-only. Nothing is written back to `~/.claude`, `~/.codex` or Cursor's storage, ever.
- **No telemetry, no account, no opt-out needed** — there's nothing to opt out of.
- **Secrets are stripped by default.** API keys, tokens, JWTs, private keys, emails, IPs, phone numbers and file paths never reach the page. See [`src/redact.js`](src/redact.js) — it's 300 lines and it has [tests](test/redact.test.mjs).
- **Released with [npm provenance](https://docs.npmjs.com/generating-provenance-statements).** The tarball on npm is built and signed by the GitHub Actions workflow in this repo, so you can check that the code you install was built from the commit you're reading — not uploaded by hand from somebody's laptop. `npm view codepend` shows the attestation. For a tool that reads your private logs, that link should be checkable, not promised.

**How to verify it, in about two minutes:**

```sh
npx codepend --json ~/codepend-payload.json        # everything it extracted, as JSON, for your eyes
grep -rn "fetch(\|node:http\|node:net" src/              # no hits. the only listener is --serve, in bin/
grep -c "src=\|href=http" ~/.codepend/codepend.html  # 0. the page cannot phone home
npm run lint                                             # CI fails the build if src/ ever touches the network
```

Or just turn off your Wi-Fi and run it. That's the version of this test I'd trust.

Going to post a screenshot? `--redact paranoid` drops every path, filename and quote first, and the share sheet has a **Hide project names** toggle with a live preview. Full details: [`docs/PRIVACY.md`](docs/PRIVACY.md).

---

## Supported agents

| Agent | Status | Reads |
|---|---|---|
| **Claude Code** | ✅ full | `~/.claude/projects/*/*.jsonl` |
| **OpenAI Codex CLI** | ✅ full | `~/.codex/sessions/**`, `~/.codex/archived_sessions/**` |
| **Cursor** | ✅ partial — see below | Cursor's `state.vscdb` chat store, read-only |
| Aider | 🫱 [good first issue](https://github.com/shatzibitten/codepend/issues) | — |
| Gemini CLI | 🫱 [good first issue](https://github.com/shatzibitten/codepend/issues) | — |
| Windsurf / opencode / yours | 🫱 [good first issue](https://github.com/shatzibitten/codepend/issues) | — |

**What "partial" means for Cursor, precisely.** Cursor's store is SQLite rather than JSONL, and it
is less complete than an agent that writes a transcript on purpose. What survives:

- ✅ everything text-based: first words, catchphrases, quotes, manners, apologies, code-switching
- ✅ everything countable: message counts, projects, files touched, tools, models
- ✅ time: about a third of messages carry their own timestamp, and the rest inherit the last one
  seen — carried forward, never interpolated into a gap and never invented. Two thirds of
  conversations still end up with more than one distinct clock reading, which is enough for
  durations, time-of-day, streaks and "on this day" to work — at message granularity, not to the
  second.
- ⚠️ token counts only where Cursor recorded them (about a fifth of conversations), so cost and
  token cards under-count Cursor and say so rather than guessing.
- ❌ no thinking/reasoning traces — Cursor does not keep them locally, so anything about how long
  it thought is Claude- and Codex-only.
- ❌ conversations synced from another machine have a title and a body but no local message blobs;
  they count as a day you were here and contribute no duration.

Mixed history is the common case and needs no configuration. `--no-cursor` skips it entirely —
worth knowing about, because Cursor's `state.vscdb` can be several GB and is the slowest source
by a wide margin.

Cursor's adapter needs **Node 22.5+** for the built-in `node:sqlite`. On Node 18 or 20 the tool
prints one line — `Cursor history needs Node 22+ — skipped` — and carries on with everything else.

Adding an agent means writing one file that turns its logs into `Session` objects. Every detector,
chart and card then works for free — and partial is welcome, as Cursor demonstrates. Start with
[`CONTRIBUTING.md`](CONTRIBUTING.md#on-ramp-1--add-your-agent-highest-value).

---

## Options

```
-o, --out <path>       where to write the page  (~/.codepend/codepend.html)
    --json <path>      also write the raw payload as JSON
    --since <window>   30d · 6m · 1y · 2026-01-01 · all      (default: all)
    --redact <level>   safe · paranoid · off                (default: safe)
    --wrapped          open straight into Wrapped
    --serve [port]     serve on 127.0.0.1 instead of opening a browser
    --no-open          write the file, don't open anything
    --json-only        only write --json, skip the HTML
    --no-cache         ignore the scan cache, re-read every file
    --no-cursor        skip Cursor (its history lives in a large SQLite db)
-q, --quiet            errors only
-v, --version          print the version
-h, --help             this

    --claude-dir <dir> where Claude Code keeps sessions        (~/.claude)
    --codex-dir <dir>  where Codex keeps sessions               (~/.codex)
    --cursor-dir <dir> Cursor's User/globalStorage    (needs Node 22.5+)
    --idle-gap <sec>   gap that counts as "away", not "thinking"     (600)
```

```sh
npx codepend --since 90d --wrapped          # the last quarter, as a story
npx codepend --redact paranoid --out ~/share.html
npx codepend --serve                        # WSL, SSH, headless, any box with no browser
npx codepend --json data.json --json-only   # just the numbers, for your own charts
```

Rescans are cached in `~/.cache/codepend/`, so the second run is instant. `--no-cache` forces a full re-read; deleting that directory is always safe.

---

## Write your own memory detector

A detector is one function that reads the corpus and returns cards. This one is real — it's the `the-verb` seedling, and it's the whole file:

```js
// src/detectors/the-verb.js
import { makeMemory, words } from './_util.js';

export const theVerb = {
  slug: 'the-verb',
  kind: 'stat',
  run(ctx) {
    const counts = new Map();
    for (const turn of ctx.humanTurns) {
      const first = words(turn.text)[0];              // Cyrillic-safe tokenizer
      if (first) counts.set(first, (counts.get(first) || 0) + 1);
    }
    const [word, n] = [...counts].sort((a, b) => b[1] - a[1])[0] || [];
    if (!word || n < 5) return [];                    // no signal, no card. never fake one.

    return [makeMemory(ctx, {
      type: 'the-verb', key: word, kind: 'stat', base: 60,
      eyebrows: ['HOW YOU START'],
      blocks: [{
        title: `You open with «${word}» ${n} times out of ${ctx.humanTurns.length}.`,
        body: "No preamble. It's learned to expect that.",
      }],
    })];
  },
};
```

Add it to the list in `src/detect.js`, run `npm test`, run `npx codepend`. `makeMemory` handles the id, the deterministic seed, the generative cover art and the ranking weight, so a new card is genuinely this much work.

Two rules, and they're the reason the feed doesn't feel like a dashboard:

1. **Never fabricate.** If the data isn't there, return `[]`. A missing card is invisible; a made-up one is a betrayal.
2. **Read the tone contract** in [`docs/MEMORY-CATALOG.md`](docs/MEMORY-CATALOG.md) §0 before writing copy. Short sentences, no emoji, no scolding, no congratulating. `npm test` lints the banned-word list, and yes, `productivity` is on it.

More in [`CONTRIBUTING.md`](CONTRIBUTING.md).

---

## FAQ

**Does it send anything anywhere?**
No. See [Privacy](#privacy) — including how to prove it to yourself rather than take my word for it.

**How long does it take?**
About four seconds for 4.4 GB of logs on a laptop, and it streams, so a 618 MB session file doesn't blow up your heap. After the first run, the cache makes it near-instant.

**I've only used my agent for a week.**
That's the interesting case and it was designed for first. You'll get a dozen real cards, and the page changes shape as you keep going.

**My prompts are in Russian / Japanese / Turkish.**
Fine. One Unicode-aware tokenizer runs everywhere — word counts, catchphrases, quotes. 14 languages have a lexicon; adding yours is one copied block in [`src/detectors/_stopwords.js`](src/detectors/_stopwords.js). There's a card specifically about people who code-switch, and it's one of the best ones.

**Is the token cost real?**
It's an estimate at public list prices, labelled as an estimate on the card. Cached input is counted separately, because on a real corpus 94% of your input tokens are cache reads, and pretending otherwise would make the number a lie.

**Where do the files go?**
The page: `~/.codepend/codepend.html`. The scan cache: `~/.cache/codepend/`. Nothing else is written, ever. Delete either at any time.

**Can I share the page?**
Yes — but read it first. It contains your prompts. Run `--redact paranoid` for a version with no paths, no filenames and no quotes, and use the built-in share card for posting: it renders one number or one quote, never a list, and refuses to draw anything that trips the secret detectors.

**Why does it call my agent "it"?**
Because "they" felt like a lie and "your AI assistant" felt like a brochure.

---

## Contributing

New agents, new detectors, new languages, better copy — all welcome, and
[`CONTRIBUTING.md`](CONTRIBUTING.md) names the three on-ramps so you can pick one in thirty seconds.
The build step is `node`. There isn't one.

<details>
<summary><b>Maintainer: launch checklist</b></summary>

Nobody searches for "codepend". The name carries the joke; it does not carry discovery. So
discovery has to come from the image, the topics and the keywords.

**GitHub topics** — set all of these on the repo (Settings → About → Topics):

```
claude-code  codex  cursor  ai-agents  developer-tools  wrapped
year-in-review  cli  local-first  privacy  data-visualization
```

**Before announcing anything**

- [ ] Live demo up at `https://shatzibitten.github.io/codepend/` and opened once on a real phone
- [ ] `docs/assets/wrapped.mp4` (9:16) captured — this is the post, everything else is a caption
- [ ] `docs/assets/archetype.png` set as the repo's social preview image (Settings → Social preview)
- [ ] Topics set, description one-liner matches the README's first line
- [ ] `.github/workflows/release.yml` exists, runs `npm publish --provenance --access public` with
      `permissions: { id-token: write }`, and `npm view codepend` shows the attestation. The
      README claims this in the privacy section — it has to be true before the README is public.
- [ ] `npx codepend` verified from a clean machine with no local checkout

**Channels, in this order**

1. **Show HN** — title says what it does, not what it's called. Lead comment: the privacy story and the "verify it in two minutes" block. Tuesday–Thursday morning US Eastern.
2. **r/ClaudeAI** — the 9:16 video, the archetype as the hook. Answer every "does it upload anything" in the first hour.
3. **r/ChatGPTCoding** — same, framed for Codex.
4. **X** — video post. The archetype name is the tweet; the tool is the reply.
5. **Product Hunt** — after the first two land, so the page has stars on it.
6. **awesome-claude-code / awesome-codex / awesome-cursor lists** — one PR each, the day after.

**Timing.** December is Wrapped season and attention is free — but the counter-positioning is the
better story and it works in any month: unlike Wrapped, this is not annual. "On This Day" fires
year-round and gets better as history accumulates. Ship when it's good; run the December beat as a
second wave.

**Each new agent adapter is a launch.** A Cursor adapter is news in the Cursor community in a way
that a feature release never is. That is the flywheel, and it is why "add your agent" is the
headline contribution in `CONTRIBUTING.md`.

</details>

## License

MIT © 2026 Alex Polorotov
