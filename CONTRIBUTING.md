# Contributing

codepend is small on purpose. There's no build step, no bundler, no framework, and no dependencies —
if you have Node 18+, you already have everything.

```sh
git clone https://github.com/shatzibitten/codepend.git
cd codepend
node bin/codepend.js      # runs against your own history
npm test                     # node --test, no runner to install
npm run lint                 # parses every file, asserts 0 deps and no network calls
```

There is nothing to `npm install`. If a PR adds a `dependencies` entry, CI fails it, and that is
working as intended.

---

## Pick an on-ramp

Three kinds of contribution, ordered by how much they're worth to the project. Pick one and stop
reading the other two.

| | On-ramp | Effort | What it unlocks |
|---|---|---|---|
| 1 | **[Add your agent](#on-ramp-1--add-your-agent-highest-value)** | one file, an afternoon | 31 detectors and the whole page, for a community that has nothing like this |
| 2 | **[Add your language](#on-ramp-2--add-your-language-one-copied-block)** | one copied block, an hour | catchphrases and quotes stop being garbage for everyone who types in it |
| 3 | **[Write a detector](#on-ramp-3--write-a-detector-one-function)** | one function, an evening | a new card in everyone's feed |

---

## The three rules

**1. Zero runtime dependencies.** `npx codepend` has to be instant and trustworthy. Every dependency
is a thing a stranger can change under our users tomorrow. Node's standard library is enough.

**2. Nothing touches the network.** Not from `src/`, not from the generated page, not for fonts, not
for a version check. CI greps for it. The only socket in the project is the optional `--serve`
listener in `bin/codepend.js`, bound to loopback. See [`docs/PRIVACY.md`](docs/PRIVACY.md).

**3. Streaming only, and read-only.** The corpus can be gigabytes and a single session file can be
618 MB. Never `readFileSync` a session file; use `readline` over a `createReadStream`. One malformed
line must never abort a run — `try/catch` per line, count the skip, keep going. And never write to,
lock, or move anything under an agent's own directory.

---

## The shape of the thing

```
bin/codepend.js  CLI: args, progress, opening a browser, --serve
src/scan.js         walks the transcript roots       -> Session[]
src/normalize.js    per-agent line parsers           -> one Session
src/detect.js       runs every detector              -> { profile, memories, stats, timeline }
src/detectors/*     one file per family of cards
src/art.js          deterministic seeded SVG cover art (runs in Node AND the browser)
src/render.js       inlines everything               -> one self-contained .html
src/redact.js       the secret scrubber
src/app/            the page: app.css, app.js
docs/               the specs. They are the source of truth for behaviour and copy.
```

Read [`docs/DATA-FORMATS.md`](docs/DATA-FORMATS.md) before touching `scan.js` or `normalize.js`, and
[`docs/MEMORY-CATALOG.md`](docs/MEMORY-CATALOG.md) before writing a single user-facing string.
Both were written against a real multi-gigabyte corpus and both will save you a day.

---

## On-ramp 1 — Add your agent (highest value)

This is the contribution that matters most. Every coding agent writes a transcript somewhere; each
one we can read is a whole community that suddenly has a memory feed, and it's one file of work
because everything downstream is agent-agnostic. Aider, Gemini CLI, Windsurf, opencode, Zed, Cline,
Continue — all open.

### Step 1 — find the logs, and read them read-only

Where transcripts live for the agents we already support:

| Agent | Location | Format |
|---|---|---|
| Claude Code | `~/.claude/projects/<slug>/<uuid>.jsonl` | JSONL, one record per line |
| Codex CLI | `~/.codex/sessions/**`, `~/.codex/archived_sessions/**` | JSONL rollout files |
| Cursor | `state.vscdb` in Cursor's `User/globalStorage` | SQLite key/value store |

Rules for a reader, in priority order:

- **Read-only, always.** Open with `'r'`. No lock files, no `-journal` cleanup, no "let me just
  compact this database". The user's agent may be running while we read.
- **Stream it.** Line-oriented formats go through `createReadStream`; never load a session whole.
- **Degrade, never throw.** Missing root → return `[]`. Unreadable file → skip it, count it, carry
  on. A malformed record is one `try/catch` and a `skippedLines++`.
- **Deterministic order.** Sort your file list. Two runs over the same disk must produce the same
  bytes.
- **Respect `--since`.** If the format lets you skip a file by name or mtime before parsing it, do.

### Step 2 — produce `Session` objects

This is the entire contract. The canonical skeleton is `blankSession()` in
[`src/normalize.js`](src/normalize.js); everything downstream reads only these fields.

```js
{
  id,            // string, stable across runs. Hash something intrinsic if the format has no id.
  agent,         // 'claude' | 'codex' | 'cursor' | your slug. Shown to users, so keep it short.
  source,        // absolute path of the file it came from
  title,         // string | null
  cwd,           // string | null   absolute path of the working directory
  project,       // string | null   basename of the repo/folder. The feed groups by this.
  gitBranch,     // string | null
  startedAt,     // epoch ms, 0 if unknown
  endedAt,       // epoch ms, 0 if unknown
  durationMs,    // TIME SPENT, not wall-clock span. See docs/DATA-FORMATS.md §5. 0 if unknown.
  models,        // string[]
  cliVersion,    // string | null
  humanTurns,    // [{ ts, text, chars, words, truncated }]  ts may be 0
  agentTurns,    // same shape
  reasoning,     // string[]  thinking/reasoning headlines, if the format has them
  tools,         // { [toolName]: count }
  filesTouched,  // string[]  absolute or repo-relative paths
  interrupts,    // [{ ts, durationMs }]  user hit stop
  tokens,        // { in, out, cacheRead, cacheWrite, reasoning }  all numbers, 0 if unknown
  compactions,   // number
  subagents,     // number
  thinkingChars, // number
  forkedFrom,    // session id | null
  isSidechain,   // boolean — subagent/automation thread, filtered out of the main feed
}
```

**Leave fields empty rather than guessing.** `0`, `null` and `[]` are correct answers. A detector
that can't find its data returns no card, which is invisible; a detector fed a plausible-looking
invented number produces a card that lies to the user, which is the one unrecoverable failure mode
of this project.

### Step 3 — register it

Add your root to the walk in [`src/scan.js`](src/scan.js) and your parser to `createParser()` in
[`src/normalize.js`](src/normalize.js). Sessions are deduped on `` `${agent}:${id}` ``, so your ids
must be stable and must not collide with another agent's.

### Step 4 — test it

- A fixture in `test/fixtures/` with **synthetic** content. Never commit a real transcript: it is
  someone's private history, and that includes yours.
- A test that a missing root returns `[]` without throwing.
- A test that a malformed line is skipped and the rest of the file still parses.
- `node --test` green, `npm run lint` green.

### Partial support is welcome — Cursor is the worked example

You do not need every field to ship. Cursor's chat store has **no per-message timestamps**, so
Cursor sessions carry `ts: 0` on every turn and `durationMs: 0`. That switches off every
clock-dependent card — durations, the late shift, the 24-hour clock, weekend splits, streaks — and
leaves everything text- and count-based fully working: first words, catchphrases, quotes, manners,
apologies, code-switching, projects, files, tools, models, the archetype, Wrapped, the share card.

The result is still a good feed, and users with mixed history don't notice at all, because their
Claude Code and Codex sessions supply the clock.

So the rule is: **ship the fields the format actually contains.** Detectors already degrade when a
field is missing or zero — that behaviour is tested. What breaks the product is inventing a
timestamp so a card will render. Document the gaps in your PR, in `docs/PRIVACY.md` (what file you
read) and in the README's support table, stated precisely. Do not oversell.

---

## On-ramp 2 — Add your language (one copied block)

Without a lexicon for your language, the catchphrase detector returns function words: the top phrase
of a Spanish user comes out as «el error de», which is worse than no card. Fixing that is one copied
block.

Everything lives in [`src/detectors/_stopwords.js`](src/detectors/_stopwords.js). Copy any block in
`LEX`, change the key, fill in four fields — `stop`, `polite`, `apology`, `exclude`. Every export in
the file is derived from `LEX`, so nothing else in the codebase changes. The header comment in that
file is the real spec, including the traps (stems that over-match, why `"commercial"` contains
`"merci"`, and why CJK has to go through the substring path).

Then add cases to `test/i18n-lexicon.test.mjs`: one polite sentence, one apology, one plain technical
sentence that must be neither, and every trap you can think of.

14 languages are in already. Yours is an hour of work and it makes the product real for everyone who
types in it.

---

## On-ramp 3 — Write a detector (one function)

A detector is `{ slug, kind, run(ctx) }` and returns an array of cards. The full worked example — an
entire real detector, 25 lines — is in the
[README](README.md#write-your-own-memory-detector). Checklist:

- [ ] New file in `src/detectors/`, exporting `{ slug, kind, run(ctx) }`.
- [ ] `run` returns an **array** — empty when the data isn't there. Never fabricate a card.
- [ ] Build the memory with `makeMemory(ctx, …)`; it handles the id, seed, variant choice and weight.
- [ ] Register it in `DETECTORS` in `src/detect.js`.
- [ ] 2–4 copy variants — **never** `Math.random`.
- [ ] A degraded lane for users with almost no history, or an explicit `return []`.
- [ ] Decide what `--redact paranoid` does to it: degrade, or suppress.
- [ ] Add a case to `test/` if the trigger logic is non-obvious.

You can develop against `test/fixture-payload.mjs` — a synthetic payload covering every card kind —
and render it with `node test/render-preview.mjs`, so you never need a real corpus to see your work.

### Determinism is not optional

The same corpus on the same day must produce a byte-identical page. No `Math.random`, no `Date.now`
inside detectors (use `ctx.now`), no iteration over unordered Sets where order affects output, no
locale-dependent sorting. There's a test that runs the pipeline twice and diffs it.

---

## Writing copy

Read §0 of [`docs/MEMORY-CATALOG.md`](docs/MEMORY-CATALOG.md). It is short and it is the product.
Condensed:

- Short sentences. A card body is 1–3 of them.
- Second person, always. The agent is **it** — not "he", not "they", not "your AI assistant".
- **Never scold.** "You were up at 3:47 AM" is an observation. "You should sleep more" is a
  different product, and a worse one.
- **Never congratulate like a dashboard.** No "Great job", no "Impressive", no "You're crushing it".
- No emoji in card copy. Ever. (The README is allowed a couple.)
- Numbers do the punching. Set them up, then get out of the way.
- The last sentence of a body is the one people screenshot. Write it last, write it hardest.

Banned strings, linted in tests: `productivity`, `insights`, `unlock`, `journey`, `leverage`,
`optimize`, `efficiency`, `screen time`, `Great job`, `Impressive`, `Amazing`, `AI-powered`,
`deep dive`.

Data quotes stay in whatever language the user typed. UI text is English. The tokenizer is
Unicode-aware — `String.prototype.split(' ')` is banned in this codebase, because
`коммит и пуш` has to work exactly as well as `commit and push`.

---

## Pull requests

- One idea per PR. A new detector and a scanner refactor are two PRs.
- Run `npm run check` before pushing. CI runs Node 18, 20 and 22.
- Screenshots welcome for anything visual — redact them first (`--redact paranoid`).
- Never commit a real transcript, a real payload, or a screenshot with a client's project name in it.
- If you found a way to make codepend send data anywhere, that's a security issue: open it as one
  and it gets fixed before anything else.

Bug reports: include your Node version, your OS, which agent (Claude Code, Codex or Cursor), and the
output of `npx codepend --json /tmp/p.json` **with the interesting part quoted, not the whole
file** — that payload is your history and it belongs to you.
