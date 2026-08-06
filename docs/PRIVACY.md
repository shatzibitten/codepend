# Privacy

codepend reads your agent history. That history contains your prompts, your file paths, your project
names, and — whether you meant to or not — sometimes a key you pasted at 2 AM. So this page makes
only claims you can check yourself, and tells you how to check them.

Short version: **everything happens on your machine, and nothing is uploaded, ever.**

---

## What codepend reads

A short, fixed list, all of it already on your disk, all of it written by tools you installed:

| Path | Written by | What codepend takes from it |
|---|---|---|
| `~/.claude/projects/*/*.jsonl` | Claude Code | timestamps, your prompts, model names, tool names, token counts, session titles |
| `~/.codex/sessions/**/*.jsonl` | Codex CLI | the same |
| `~/.codex/archived_sessions/*.jsonl` | Codex CLI | the same |
| Cursor's `state.vscdb` (see below) | Cursor | your prompts, project names, model names — **but no timestamps**, because it doesn't store any |

It reads nothing else. Not your shell history, not your git config, not your SSH keys, not your
editor state, not your clipboard, not `~/.env`. Nothing outside that list is ever opened.

Override the locations with `--claude-dir`, `--codex-dir` and `--cursor-dir`. Nothing is ever
*written* to any of them.

### Cursor, specifically

Cursor keeps its chat history in a SQLite database rather than in log files:

| Platform | Path |
|---|---|
| macOS | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` |
| Linux | `~/.config/Cursor/User/globalStorage/state.vscdb` |
| Windows | `%APPDATA%\Cursor\User\globalStorage\state.vscdb` |

Three things you should know about that file, because it deserves more care than a log file does:

1. **It contains the full text of your conversations with Cursor** — every prompt you typed and
   every reply, not a summary. That is the same class of content as the Claude Code and Codex
   transcripts, and the same redaction runs over it (see below). It is also why the file is worth
   knowing about even if you never run this tool.
2. **It is opened read-only, and never modified.** No writes, no schema changes, no lock, no
   journal or WAL checkpointing, no vacuum, no copy left behind. Cursor can be running while
   codepend reads, and the database is byte-identical afterwards. This is the same rule that
   applies to `~/.claude` and `~/.codex`; it just matters more when the file is a database.
3. **Only chat records are read.** The same database holds unrelated editor state — that is skipped,
   not parsed and not extracted.

Cursor stores no per-message timestamps, so Cursor sessions produce no durations, no time-of-day
cards and no streaks. Nothing is inferred to fill the gap: an unknown time stays unknown. The
consequence for you is that a Cursor-only history yields a text-and-counts feed, and a mixed history
gets its clock from your Claude Code and Codex sessions.

## What codepend writes

| Path | What | Safe to delete? |
|---|---|---|
| `~/.codepend/codepend.html` | the page (or wherever `--out` points) | yes, any time |
| `~/.cache/codepend/scan-1.json` | scan cache: file sizes, mtimes, and the extracted summary per session | yes, any time — the next run just takes ten seconds instead of one |
| `<your path>` with `--json` | the full extracted payload, for your own tooling | yes |

That's the complete list. codepend creates no config file, no dotfile, no daemon, no login item,
no cron entry, and no state anywhere else.

## What codepend never does

- **No network requests.** No API calls, no update checks, no analytics, no error reporting, no
  font or icon CDN. The process makes no outbound connections at all.
- **No telemetry.** There is no counter anywhere that knows you ran this.
- **No account, no sign-in, no license check.**
- **No dependencies.** Nothing in `node_modules` that could add any of the above in a patch release,
  because there is no `node_modules`.
- **No writes to your agents' directories.** codepend opens every source read-only — files and
  databases alike.

The one exception, stated plainly: `--serve` starts an HTTP server, **bound to `127.0.0.1`**, that
serves the one HTML file it just wrote. It exists for WSL, SSH and headless machines where opening a
browser doesn't work. It is off unless you ask for it, it listens on loopback only, and it stops
when you press Ctrl-C.

## The generated page

The output is one self-contained HTML file: inlined CSS, inlined JavaScript, inlined JSON, SVG
generated in-page, and system fonts. It has no `<script src>`, no `<link href>`, no `fetch`, no
image URLs, no iframes, no analytics beacon.

It opens over `file://`. It works with your Wi-Fi off. You can put it on a USB stick and open it on
a laptop that has never been online, and it will render identically.

---

## Redaction

Because the page quotes you back to yourself, and because people screenshot it.

Redaction runs at the same point for every agent — on extracted text, before anything reaches the
payload or the page. A prompt you typed in Cursor is scrubbed by exactly the same rules as one you
typed in Claude Code; there is no per-source exemption and no code path that skips it.

### `--redact safe` (default)

Removed before anything reaches the page:

- API keys and tokens: `sk-`, `sk-ant-`, `ghp_`/`gho_`/`ghs_`/`github_pat_`, `glpat-`, `AKIA…`,
  `xoxb-`/`xoxp-`, `AIza…`, `npm_`, `hf_`, Stripe `sk_live_`/`sk_test_`, SendGrid `SG.…`
- JWTs (`eyJ…`), `Authorization: Bearer/Basic/Token …` headers
- PEM private key blocks and age secret keys
- `KEY=value` pairs whose name looks like a credential, plus any value that's long and
  high-entropy enough not to be a word
- Credentials embedded in connection strings (`postgres://user:pass@…`) and webhook URLs
- Email addresses, IPv4 and IPv6 addresses (loopback survives), MAC addresses
- Phone numbers, and card numbers that pass a Luhn check
- File paths, replaced with `[file]` — the whole path, not just the username part.
  A bare `~` in prose survives, so `cd ~` still reads.

  Collapsing `/Users/you` to `~` used to be the whole rule. It is not enough: the
  username is rarely the sensitive part of a path. A real quote in testing was
  `@~/Downloads/<folder>/<date>_answer_<client>.docx` — no username in
  it, and still the last thing anyone wants on a screenshot.

Kept, on purpose: project names, prose, your actual words. Those are the album.
Project names come from the session's working directory, not from reading your
quotes, so deleting paths costs the cards nothing.

### `--redact paranoid`

Everything above, plus every file path, every filename, and every URL. Detectors that need a path or
a quote to make sense suppress themselves rather than ship a hollow card, and quote cards fall back
to describing the shape of the sentence ("14 words. You know which ones.") instead of its content.

The feed still produces at least 12 cards in this mode. There's a test for that.

### `--redact off`

No redaction. Your machine, your call. Note that the **share card still refuses** to render any
string that trips the secret detectors, at every level — the one thing designed to leave your
machine is the one thing that gets checked twice.

### Before you post a screenshot

- The share sheet has a **Hide project names** toggle and renders a live preview. What you see is
  what gets saved; nothing is generated after you look at it.
- Share cards never contain file paths, filenames, git branch names, code, URLs, or timestamps more
  precise than the hour.
- Git branch names are excluded from share cards specifically because they leak ticket numbers and
  client names more often than anything else in a corpus.

---

## Verify all of this yourself

Takes about two minutes, and you should not take my word for any of it.

```sh
# 1. See literally everything codepend extracted, in plain JSON.
npx codepend --json ~/codepend-payload.json

# 2. Confirm nothing in the library can reach the network.
grep -rnE "fetch\(|node:https?|node:net|XMLHttpRequest|WebSocket" src/
#    (no hits. the only listener in the project is --serve, in bin/codepend.js)

# 3. Confirm the page loads nothing externally.
grep -cE "<script[^>]+src=|<link[^>]+href=\"http" ~/.codepend/codepend.html   # 0

# 4. The best test: turn off your Wi-Fi and run it again.
```

CI runs checks 2 and 3 on every push, so a regression fails the build rather than shipping quietly.
If you find a case where any of this is untrue, that's a security bug — please
[open an issue](https://github.com/shatzibitten/codepend/issues) and it will be treated as one.
