# codepend

### Your coding agent has been keeping a diary about you. This reads it back.

Claude Code, Codex and Cursor write down every session you have with them and never mention it again. Somewhere on your disk is a more complete record of your working life than you could reconstruct from memory.

`codepend` turns it into a photo album.

```sh
npx codepend
```

One command, one HTML page, nothing uploaded. **[See it without installing →](https://shatzibitten.github.io/codepend/)**

[![npm](https://img.shields.io/npm/v/codepend?color=e8703a&label=npm)](https://www.npmjs.com/package/codepend)
[![node](https://img.shields.io/node/v/codepend?color=555)](https://nodejs.org)
[![dependencies](https://img.shields.io/badge/dependencies-0-2ea043)](package.json)
[![license](https://img.shields.io/badge/license-MIT-555)](LICENSE)

<!--
  MAINTAINER — capture list. Drop the files in docs/assets/, then delete this
  comment and uncomment the <img> blocks below. Until then this is the spec.

  Rule for every asset: run `npx codepend --redact paranoid` first, capture
  THAT, then check the frame for project names you would not want on the front
  page of Hacker News.

  1. docs/assets/wrapped.mp4 — THE PRIMARY ASSET. 1080x1920 (9:16), H.264,
     <= 60 s, no audio track. Capture the built-in Save video export end to
     end. Hold the final archetype frame: that frame is the thumbnail, the
     hook, and the whole reason someone runs the command.
     Also export docs/assets/wrapped.gif — 900x1600, <= 6 MB, ~9 s — because
     GitHub READMEs do not autoplay mp4.

  2. docs/assets/feed.png — 1400x900, 2x DPR, dark theme. Scroll so the grid
     shows THREE different card kinds at once — a quote, a chart (the 24-hour
     clock), and a stat. No cursor in frame.

  ---- uncomment once the files exist ----

  <p align="center">
    <img src="docs/assets/wrapped.gif" alt="Wrapped: a story ending on your archetype" width="300">
  </p>
-->

---

## What comes back

Real cards, in the voice they ship in. The numbers are real; the quotes are stand-ins, because the history these were built against belongs to somebody — which is rather the point.

> `THE FIRST THING YOU EVER TYPED`
> ### «switch the branch to master»
> That's it. That's how it started. No hello, no context.

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

Thirty-one more of these, then a Wrapped-style story you can tap through, then a 9:16 clip you can post.

It ends by telling you which of twelve people you are. Find out on your own machine.

**Used your agent for a week?** That case was designed first. Three days of history still makes thirteen real cards, and not one of them says "not enough data".

**Unlike Wrapped, this isn't annual.** "On This Day" works in August, and the page gets better the longer you leave it running.

---

## Privacy

The threat here isn't us — nothing is uploaded. It's the screenshot you post thirty seconds later.

- **Nothing leaves the machine.** No network requests, no telemetry, no account. The generated page has no `<script src>`, no `<link href>`, no `fetch`. Turn off your Wi-Fi and run it; that's the version of the test worth trusting.
- **Read-only on your agents' data.** Nothing is ever written back to `~/.claude`, `~/.codex` or Cursor's storage.
- **Secrets stripped by default.** API keys, tokens, private keys, emails, IPs and file paths never reach the page. Real prompts contain pasted credentials — this isn't hypothetical.
- **Zero dependencies.** Nothing to audit but plain JavaScript and the Node standard library.

Posting a screenshot? `--redact paranoid` drops every path, filename and quote first. Details: [`docs/PRIVACY.md`](docs/PRIVACY.md).

---

## Agents

| | | |
|---|---|---|
| **Claude Code** | full | `~/.claude/projects/` |
| **Codex CLI** | full | `~/.codex/sessions/` |
| **Cursor** | full | `state.vscdb`, read-only · needs Node 22.5+ |
| Aider, Cline, Windsurf, Gemini CLI, yours | [good first issue](https://github.com/shatzibitten/codepend/issues) | |

Adding an agent is one file that turns its logs into `Session` objects. Every detector, chart and card then works for free — see [`CONTRIBUTING.md`](CONTRIBUTING.md).

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

Rescans are cached in `~/.cache/codepend/`, so the second run is instant.

---

## Contributing

Three ways in, easiest first:

- **A language.** Copy one block in [`src/detectors/_stopwords.js`](src/detectors/_stopwords.js). Fourteen ship; the miner already handles scripts without spaces between words.
- **A detector.** Fifteen lines and a new card exists. [`docs/MEMORY-CATALOG.md`](docs/MEMORY-CATALOG.md) has all thirty-one.
- **An agent.** One adapter, and everything else works for free.

Full guide in [`CONTRIBUTING.md`](CONTRIBUTING.md). `node --test`, 367 of them, no dependencies to install.

---

## Acknowledgements

This project began with an idea from [Lance Hankins](https://www.linkedin.com/in/lhankins/). Thank you, Lance, for the spark that started it all.

MIT.
