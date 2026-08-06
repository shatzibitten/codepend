# codepend — Memory Catalog

The detector catalog. This is the product. Everything else is plumbing.

`src/detect.js` implements `buildMemories(sessions, opts)`. This document specifies **what it emits
and exactly what the cards say**. Copy in this file is final copy — ship it verbatim, do not
paraphrase it into something more "professional."

---

## 0. Tone contract

Read this before writing a single string.

**We are:** a friend who noticed something about you. Warm, dry, a little bit in awe of how weird
this all is. The joke is that you have a *relationship* with a program, and the catalog treats that
relationship with total sincerity — which is what makes it funny, and occasionally makes it land.

**Rules:**
- Short sentences. A card body is 1–3 of them. If it needs four, it needs a chart instead.
- No emoji in card copy. Ever. (Emoji in the README is fine. Not in the feed.)
- No exclamation marks unless a human would actually raise their voice there. Budget: zero.
- Never scold. Not about sleep, not about weekends, not about money, not about screen time.
  "You were up at 3:47 AM" is an observation. "You should sleep more" is a different product.
- Never congratulate like a dashboard. No "Great job!", no "You're crushing it", no "Impressive!"
- Second person, always. "You," never "the user."
- The agent is **it**, not "he/she/they," not "your AI assistant." `it` is warmer, oddly.
- Numbers do the punching. Set them up, then get out of the way.
- The last sentence of a body is the one people screenshot. Write it last, write it hardest.

**Banned strings** (lint these in `test/copy.test.js`):
`productivity`, `insights`, `unlock`, `journey`, `leverage`, `optimize`, `efficiency`,
`screen time`, `Great job`, `Impressive`, `Amazing`, `🎉`, `!!`, `AI-powered`, `deep dive`.

**The one exception to dryness:** cards about *first words*, *the long night*, and *the ghost
project* are allowed to be quiet and a little sad. That's the poignancy budget. Spend it there,
nowhere else.

---

## 1. Shared machinery

Everything below is used by all detectors. Implement once, in `src/detect.js`.

### 1.1 Hashing and determinism

```js
/** FNV-1a over UTF-16 code units. Stable across Node and browsers. */
function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
```

- `memory.id` = `` `${type}:${stableKey}` `` where `stableKey` is derived only from data
  (a session id, a date, a phrase — never an array index, never a timestamp of *this run*).
- `memory.seed = hash32(memory.id)`.
- **Variant selection is never random.** See 1.2.
- Two runs over the same corpus produce byte-identical output. There is a test for this.

### 1.2 Copy variants

Each detector defines 2–4 **variant blocks**. A block is a `{title, body}` pair — they are chosen
together so the voice stays coherent. Eyebrows are chosen independently (they're structural).

```js
const vi = hash32(memory.id + '|v') % blocks.length;   // title + body
const ei = hash32(memory.id + '|e') % eyebrows.length; // eyebrow
```

Some detectors have **lanes** — mutually exclusive copy sets picked by *data*, not hash (e.g.
`the-politeness` has a LOW lane and a HIGH lane; they say opposite things). Lane selection happens
first, variant hashing happens within the lane.

### 1.3 Placeholder formatting

| Placeholder | Format | Example |
|---|---|---|
| `{date}` | `MMMM D, YYYY` local | `February 6, 2026` |
| `{shortDate}` | `MMM D` local | `Jul 29` |
| `{time}` | `h:mm AM/PM` local | `3:47 AM` |
| `{weekday}` | full | `Sunday` |
| `{duration}` | `Xh Ym` / `Ym` / `Xs` | `4h 12m` |
| `{n}`, counts | thin-space grouped ≥ 10 000 | `21 910` |
| `{pct}` | integer, no decimal | `73%` |
| `{money}` | `$X,XXX` (no cents above $100) | `$3,450` |
| `{quote}` | `«…»` guillemets, redacted, ≤ 180 chars, ellipsis `…` | `«commit and push»` |
| `{project}` | basename of cwd, never full path | `orchard` |
| `{relLast}` | `today` / `yesterday` / `N days ago` | `3 days ago` |

All date math uses `opts.tz` (`Intl.DateTimeFormat` with `timeZone`), **local, never UTC**.
A session that starts 23:40 and ends 01:10 belongs to *both* days for streak purposes and to the
**start** day for "peak day."

### 1.4 Weight

```
weight = clamp(round(base * recencyMul * magnitudeMul * confidenceMul), 0, 100)
```

| Factor | Values |
|---|---|
| `base` | per-detector constant, listed in each spec |
| `recencyMul` | exact-anniversary on-this-day → `1.30`; memory ≤ 14d old → `1.15`; ≤ 180d → `1.00`; older non-anniversary → `0.90`; corpus-wide facts (no date) → `1.00` |
| `magnitudeMul` | `0.80 + 0.40 * p` where `p` = the value's percentile inside its own detector's candidate set (0 if only one candidate → `p = 1`) |
| `confidenceMul` | `1.00` normally; `0.65` when the detector fired on a degraded/small sample (see §4); `0.50` when the quote had to be suppressed by redaction |

Weight orders the feed. It is not shown to the user.

### 1.5 The tokenizer (Cyrillic-safe, used everywhere)

Word counts, n-grams, quote truncation, language detection — all go through **one** tokenizer.
`String.prototype.split(' ')` is banned in this codebase.

```js
const WORD_RE = /[\p{L}\p{N}]+(?:[’'\-][\p{L}\p{N}]+)*/gu;
/** @returns {string[]} NFC-normalized, locale-lowercased tokens. */
export function words(text) {
  return (text.normalize('NFC').match(WORD_RE) || []).map(w => w.toLowerCase());
}
```

- `\p{L}` covers Cyrillic natively. No transliteration, no `latin1`, no mojibake.
- Truncation for `{quote}` cuts on a **grapheme** boundary (`Intl.Segmenter` when available,
  code-point fallback), never mid-surrogate.
- Language of a token run: share of tokens matching `/^\p{Script=Cyrillic}+$/u` vs
  `/^\p{Script=Latin}+$/u`. A turn is `ru` if Cyrillic ≥ 60% of tokens, `en` if Latin ≥ 60%,
  else `mixed`.

### 1.6 What counts as a human turn

Non-negotiable, because half the catalog's credibility rests on it:

- **Claude Code:** `type === 'user'` **and** `origin.kind === 'human'`. Nothing else.
  `queue-operation` `content` counts only if no matching `user` line followed (a queued prompt the
  user cancelled — rare, and it's a real thing they typed).
- **Codex:** `event_msg`/`user_message` only. Then drop injected context aggressively:
  - starts with `#` (IDE context blocks: `# Context from my IDE setup:`, `# Files mentioned by…`)
  - starts with `<` (`<app-context>`, `<INSTRUCTIONS>`)
  - contains `AGENTS.md instructions` or `<INSTRUCTIONS>`
  - starts with `\n# Response annotations:`
  - is byte-identical to a turn already seen in a session whose `forked_from_id` chain overlaps
  - `response_item`/`message` role `user` is **never** a human turn. Not once. It's tool output.
- Sessions with `forkedFrom` are deduped: a fork's turns that also exist in the parent (same text,
  same ts ± 2s) are counted once, attributed to the **parent**.
- `isSidechain` turns are excluded from `humanTurns` counts and quote pools (they're subagent
  prompts written by the model), but *are* counted in `the-swarm`.

### 1.7 Quote selection (shared)

Detectors that surface a `{quote}` all draw from the same scored pool:

```
quoteScore = 1.0
  * (len >= 8 && len <= 160 ? 1 : 0.35)        // screenshot-shaped
  * (hasCodeFence || hasURL || hasAbsPath ? 0.25 : 1)
  * (endsWithQuestionMark ? 1.25 : 1)          // questions read better
  * (isAllCaps ? 0.5 : 1)
  * (redactor changed it ? 0.6 : 1)
```
Ties broken by `hash32(sessionId + ':' + ts)`. Deterministic, always.

Under `--redact paranoid`, every quote is replaced by its degraded form (specified per detector) —
the card still ships, it just talks about the shape of the sentence instead of its content.

---

## 2. The catalog

31 detectors in three rings.

**Ring A (12)** — fires for literally everyone, including a user 20 minutes after install.
**Ring B (12)** — fires for a normal user with a few weeks of history. These are "the 24 that ship."
**Ring C (7)** — rare. When one hits, it's the best card in the feed.

Spec format: `kind` · `max emitted` · `base weight` · trigger · weight notes · copy · degradation.

---

## RING A — always fires

---

### `on-this-day`
`onthisday` · max **3** · base **95**

**Trigger.** For each session `s`, let `age = daysBetween(localDay(s.startedAt), localDay(now))`.
Emit when `age` matches an anniversary band, best band first:

| Band | Condition | Eyebrow |
|---|---|---|
| year | `age % 365 ∈ [-2, 2]` and `age ≥ 363` | `{n} YEAR{S} AGO TODAY` |
| half-year | `age ∈ [180, 187]` | `SIX MONTHS AGO` |
| month | `age % 30 ∈ [0,1]` and `age ≥ 30` | `{n} MONTHS AGO TODAY` |
| week | `age % 7 === 0` and `age ≥ 14` | `{n} WEEKS AGO TODAY` |
| recent | `age ∈ [2, 13]` | `{n} DAYS AGO` |
| origin | `age < 2` and it's the user's first day | `TODAY, AND ALSO YOUR FIRST DAY` |

Among candidates in the best available band, rank by `humanTurns.length * log(1 + durationMs)`.
Emit up to 3, from **distinct projects**, from distinct bands where possible.

**Weight.** `base 95`, `recencyMul 1.30` for year/half-year bands. This is the anchor card; it
holds slot 1 of the feed unless it didn't fire at all.

**Copy.**

Eyebrows: band eyebrow from the table (structural, not hashed).

> **A**
> **title:** You were deep in {project}.
> **body:** {humanTurns} messages, {duration}. You ended at {time}. This is what you were saying:
>
> **B**
> **title:** {project}, and it was not going well.  *(lane: session had ≥ 2 interrupts)*
> **body:** You stopped it {interrupts} times in {duration}. Then you typed this and went to bed.
>
> **C**
> **title:** {duration} on {project}.
> **body:** You don't remember this day. It's all still here.
>
> **D**
> **title:** A {weekday}, {duration}, one problem.
> **body:** {toolCalls} tool calls to get to the end of it. Your first message was:

Card renders the `{quote}` beneath the body as a pull-quote.

**Degradation.**
- No band matches → do not emit; the feed's slot 1 falls to `first-words`.
- New user (< 3 days) → `origin` band fires against their own first session, eyebrow
  `TODAY, AND ALSO YOUR FIRST DAY`, body variant C is suppressed (it's a lie).
- `paranoid` → quote replaced by: *"{words} words. You know which ones."*

---

### `first-words`
`quote` · max **1** · base **92**

**Trigger.** Always, if any human turn exists. Take the earliest human turn across the entire
corpus (`min(ts)` over all sessions, sidechains excluded). Also fetch turn #2 for the callback.

**Weight.** `base 92`, `magnitudeMul` fixed at 1.0. Never demoted. Slot 2 or 3 of the feed, always
card 2 of Wrapped.

**Copy.**

Eyebrows: `THE FIRST THING YOU EVER TYPED` · `{date} — {time}` · `WHERE IT STARTED`

> **A**
> **title:** «{quote}»
> **body:** That's it. That's how it started. No hello, no context. {gap} later you asked it
> «{secondQuote}».
>
> **B**
> **title:** «{quote}»
> **body:** {daysSince} days ago. You've typed {totalTurns} more messages since. You still don't
> say hello.
>
> **C**
> **title:** «{quote}»
> **body:** {date}, {time}. You had no idea how much of your year this was going to take.

`{gap}` = `two minutes` / `an hour` / `three days` — humanized from the delta to turn #2.
If turn #2 is > 7 days later, variant A is dropped from the pool.

Rendered example (variant A):
> **THE FIRST THING YOU EVER TYPED**
> **«switch the branch to master»**
> That's it. That's how it started. No hello, no context. Two minutes later you asked it
> «can you see the files?».

**Degradation.** Works on day one — that's the point. A user who installed codepend after two
prompts gets `first-words` describing a prompt from 40 minutes ago, variant C, and it still lands.
`paranoid` → title becomes *"{words} words, {chars} characters"* and body variant B is forced.

---

### `the-anniversary`
`stat` · max **1** · base **88**

**Trigger.** Always. `days = daysBetween(profile.firstSeen, now)`.

**Weight.** `base 88`. `magnitudeMul` from `days / 365` clamped.

**Copy.** Lanes by `days`.

**Lane LONG (`days ≥ 60`):**
Eyebrows: `SINCE DAY ONE` · `{days} DAYS` · `THE RELATIONSHIP`
> **A**
> **title:** {days} days together.
> **body:** {sessions} sessions. You showed up on {activeDays} of those days. {hours} hours of your
> life, in total, talking to a program.
>
> **B**
> **title:** {days} days. {activeDays} of them with it.
> **body:** That's {pct}% of your days since {shortFirstDate}. Some relationships get less.
>
> **C**
> **title:** {hours} hours.
> **body:** Spread over {days} days and {projects} projects. Long enough to have a house style,
> a favorite tool, and a bad habit.

**Lane NEW (`days < 60`):**
Eyebrows: `DAY {days}` · `SO FAR`
> **A**
> **title:** {days} days in.
> **body:** {sessions} sessions, {hours} hours, {turns} things you asked for. This page gets better
> the longer you stay.
>
> **B**
> **title:** You started {relFirst}.
> **body:** {turns} messages already. Come back in a month and this whole page will be different.

**Degradation.** Lane NEW is the degradation. It never fails.

---

### `the-ratio`
`stat` · max **1** · base **86**

**Trigger.** Always. `yourWords = Σ words(humanTurns.text)`, `itsWords = Σ words(agentTurns.text)`
using §1.5 (so Cyrillic counts correctly). `ratio = round(itsWords / yourWords)`.

**Weight.** `base 86`, `magnitudeMul` from `ratio / 80` clamped. A 90:1 ratio outranks an 8:1.

**Copy.**
Eyebrows: `THE CONVERSATION` · `WORD COUNT` · `WHO TALKED`
> **A**
> **title:** You wrote {yourWords} words. It wrote {itsWords}.
> **body:** {ratio} to one. You are the smallest and most important part of this conversation.
>
> **B**
> **title:** {ratio} words back for every word you typed.
> **body:** A text message in, a novel out. Every time. You've never once complained about the
> length.
>
> **C**
> **title:** It has written you {itsWords} words.
> **body:** That's {books} books' worth. Nobody has ever written you this much. Nobody ever will.
>
> **D**  *(lane: ratio < 12 — a rare, verbose human)*
> **title:** You wrote {yourWords} words. It wrote {itsWords}.
> **body:** Only {ratio} to one. You're one of the few people who actually types back.

`{books}` = `round(itsWords / 90000)`, shown only when ≥ 2.

**Degradation.** Needs ≥ 5 human turns and ≥ 5 agent turns; below that, suppress (a 3:1 ratio off
two prompts is noise). A day-one user with 20 prompts hits this easily.
`paranoid` → unchanged. This card is already just numbers.

---

### `the-marathon`
`stat` · max **1** · base **84**

**Trigger.** Always (if ≥ 1 session). `argmax(session.durationMs)`. Require `durationMs ≥ 20min`
for the LONG lane.

**Weight.** `base 84`, `magnitudeMul` from `hours / 6` clamped.

**Copy.**
Eyebrows: `THE LONGEST ONE` · `{shortDate}` · `ONE SITTING`
> **A**
> **title:** {duration}, one session.
> **body:** {date}, {project}. {humanTurns} messages from you, {agentTurns} from it. It ended at
> {endTime} and neither of you said goodbye.
>
> **B**
> **title:** {startTime} to {endTime}.
> **body:** {project}. {toolCalls} tool calls. Somewhere in the middle of that you stopped noticing
> the time.
>
> **C**
> **title:** {duration} without closing the window.
> **body:** {date}. {humanTurns} messages. The longest you have ever kept it awake.

**Lane SHORT (`< 20 min`, i.e. brand-new user):**
> **A**
> **title:** {duration}, your longest so far.
> **body:** {date}, {project}. {humanTurns} messages. Ask it something hard and this number moves.

**Degradation.** Lane SHORT. Fires on a single 6-minute session.

---

### `catchphrase-yours`
`quote` · max **2** · base **83**

**Trigger.** N-gram mining over human turns. See §3 for the full algorithm. Emit the top-scoring
phrase; emit a second only if `score2 ≥ 0.6 * score1` and the phrases don't overlap.
Minimum document frequency: `max(3, ceil(0.015 * humanTurns))`.

**Weight.** `base 83`, `magnitudeMul` from `df / (0.08 * humanTurns)` clamped.

**Copy.**
Eyebrows: `YOUR CATCHPHRASE` · `YOU SAY THIS A LOT` · `{n} TIMES`
> **A**
> **title:** «{phrase}»
> **body:** {n} times. First on {firstDate}, most recently {relLast}. You have a house style and
> this is it.
>
> **B**
> **title:** «{phrase}»
> **body:** You've typed this {n} times in {span}. It has never once been phrased as a request.
>
> **C**
> **title:** «{phrase}» — {n} times.
> **body:** Across {projects} projects and {models} different models. The tools changed. You didn't.
>
> **D**  *(lane: phrase is ≤ 2 words)*
> **title:** «{phrase}»
> **body:** {n} times. Two words. It always knew what you meant.

Rendered example:
> **YOUR CATCHPHRASE**
> **«commit and push»**
> 14 times. First on March 2, most recently 3 days ago. You have a house style and this is it.

**Degradation.** With < 20 human turns, drop `min df` to 2 and require `n ≥ 2` words. If nothing
clears the bar, fall back to `the-first-verb`: the most common *first word* of a prompt, with copy:
> **HOW YOU START**
> **You open with «{word}» {n} times out of {total}.**
> No preamble. It's learned to expect that.

`paranoid` → suppressed entirely (a repeated phrase is identifying).

---

### `spirit-tool`
`award` · max **1** · base **80**

**Trigger.** Always. `argmax(Σ tools[name])` across all sessions, after normalizing aliases:
`exec`/`exec_command`/`Bash`/`shell` → **Shell**; `apply_patch`/`Edit`/`MultiEdit`/`str_replace` →
**Edit**; `Read`/`view` → **Read**; `Write`/`create` → **Write**; `Claude_Browser`/`browser`/
`js` → **Browser**; `WebSearch`/`WebFetch` → **Search**; `spawn_agent`/`Task` → **Delegate**.

**Weight.** `base 80`.

**Copy.**
Eyebrow: `YOUR SPIRIT TOOL`
> **title:** {Tool} — {n} calls
> **body:** {personality} {runnerUp}

`{personality}` is chosen by tool, not hashed — it's a *read*, and it has to be right:

| Tool | body line |
|---|---|
| Shell | You don't want it to explain. You want it to run the thing and tell you what happened. |
| Edit | You'd rather it change the code than talk about the code. |
| Read | You make it look before it touches anything. Every single time. |
| Write | You let it start from a blank file. That takes a kind of nerve. |
| Browser | You made it use its own eyes instead of taking your word for it. |
| Search | You outsourced your curiosity and you have no regrets. |
| Delegate | You don't use it. You manage it. |

`{runnerUp}` = ` Runner-up: {tool2}, {n2}.` — appended only when `n2 ≥ 0.35 * n`.

Real example: **Shell — 22 886 calls.**

**Degradation.** Needs ≥ 10 tool calls. Below that: emit `spirit-tool` in NEW lane —
> **title:** So far: {Tool}.
> **body:** {n} calls in. Too early to call it a personality trait. Give it a week.

---

### `deep-work-clock`
`chart` (`clock`) · max **1** · base **82**

**Trigger.** Always. 24-bin radial histogram of human turn timestamps in local tz.
`peak = argmax(bin)`, `quiet = argmin(bin)` among bins with any neighbouring activity,
`medianFirst` / `medianLast` = median local time of the first/last human turn of each active day.

**Weight.** `base 82`. `magnitudeMul` from concentration (`peak / mean`) — a spiky clock is a
better card than a flat one.

**Copy.**
Eyebrows: `WHEN YOU TALK TO IT` · `YOUR 24 HOURS` · `THE SHAPE OF YOUR DAY`
> **A**
> **title:** Your day peaks at {peakHour}.
> **body:** First message around {medianFirst}, last around {medianLast}. The quiet hour is
> {quietHour}, and even that isn't empty.
>
> **B**
> **title:** {peakHour} is when you need it most.
> **body:** {peakPct}% of everything you've ever asked landed in a {window} window. The rest is
> spillover.
>
> **C**
> **title:** You've used every hour on this clock except {n}.
> **body:** Peak at {peakHour}. Second peak at {peak2Hour}. There is no version of your day where
> it isn't around.

Representative shape: peaks at 17:00 (179), 12:00 (170), 09:00 (169), and a stubborn
secondary spike at 23:00 (125) — variant C is the right read for that data.

**Degradation.** With 1–2 active days the clock is honest but sparse; switch to the
`sparse` render (dots, not a filled ring) and use:
> **title:** So far you're a {phase} person.
> **body:** {n} messages, all between {earliest} and {latest}. Ask again in a week.

`{phase}` ∈ `morning` / `afternoon` / `evening` / `after-midnight`.

---

### `the-bill`
`stat` · max **1** · base **81**

**Trigger.** Always (if any token counts exist). Estimate:

```
cost = tokens.in       / 1e6 * RATE.in
     + tokens.out      / 1e6 * RATE.out
     + tokens.cacheRead/ 1e6 * RATE.cacheRead
     + tokens.cacheWrite/1e6 * RATE.cacheWrite
```

`RATE` is a small table in `src/rates.js`, keyed by model family, with a documented
`{ in: 3, out: 15, cacheRead: 0.30, cacheWrite: 3.75 }` default for unknown models. The UI says
**estimate** exactly once, in small type. We do not pretend this is a bill from a vendor.

Codex `token_count` uses `last_token_usage` **deltas** only — `total_token_usage` is a running
total and summing it inflates the number by ~100×. Getting this wrong is the fastest way to make
the whole page untrustworthy.

**Weight.** `base 81`, `magnitudeMul` from `log10(cost) / 4`.

**Copy.**
Eyebrows: `THE BILL` · `WHAT IT COST` · `TOKENS`
> **A**
> **title:** About {money} of tokens.
> **body:** {tokens} of them, over {span}. That's {comparison}.
>
> **B**
> **title:** {tokens} tokens.
> **body:** Roughly {money} at list price. {comparison} You spent it on {topProject}, mostly.
>
> **C**
> **title:** {money}.
> **body:** {cacheReadPct}% of it was the same context, read back to it again and again, because it
> cannot remember you.

Variant C is the good one and it is *earned* — `cacheRead` genuinely dominates real corpora.

`{comparison}` — deterministic pick by `hash32(id + '|c') % 4`, scaled to magnitude:
- `War and Peace, {n} times over.` (`tokens / 780_000`)
- `{n} coffees, if you're the kind of person who counts coffees.` (`cost / 5`)
- `A paperback a day, for {n} years.` (`tokens / 130_000 / 365`)
- `{n} full novels written and thrown away.` (`tokens / 120_000`)

Real: 6.8B tokens → *War and Peace, 8 700 times over.*

**Degradation.** Below $1, switch lane:
> **title:** {tokens} tokens. Call it {money}.
> **body:** Barely anything yet. This number has a way of growing.

If token data is entirely absent, suppress — never guess a bill.

---

### `peak-day`
`stat` · max **1** · base **76**

**Trigger.** Always. `argmax` over `timeline[]` by `humanTurns`; tie-break by `minutes`.

**Weight.** `base 76`, `magnitudeMul` from `peakTurns / (3 * medianActiveDayTurns)`.

**Copy.**
Eyebrows: `YOUR BIGGEST DAY` · `{date}` · `THE DAY IT ALL HAPPENED`
> **A**
> **title:** {date}: {turns} messages.
> **body:** {hours} hours, {sessions} sessions, {projects} projects. Whatever was going on that
> day, it was going on all day.
>
> **B**
> **title:** {turns} messages in one day.
> **body:** {weekday}, {shortDate}. From {firstTime} to {lastTime}. Your median day is {median}.
> This was not a median day.
>
> **C**
> **title:** A {weekday} you probably don't remember.
> **body:** {turns} messages, {hours} hours, {project}. More than any day before or since.

Real: 2026-07-29, 154 messages.

**Degradation.** Fires on any user with ≥ 1 active day. With < 4 active days, force variant A and
drop the "before or since" claim.

---

### `project-constellation`
`chart` (`donut`) · max **1** · base **74**

**Trigger.** Always. Group session minutes by `project`. Keep top 6, collapse the rest to `other`.

**Weight.** `base 74`.

**Copy.**
Eyebrows: `WHERE IT ALL WENT` · `{n} PROJECTS` · `THE MAP`
> **A**
> **title:** {topProject} took {pct}% of everything.
> **body:** {n} projects in total. {tail}
>
> **B**
> **title:** {n} projects, {hours} hours.
> **body:** {topProject} got {topHours} of them. Everything else split the rest.
>
> **C**  *(lane: top project ≥ 70%)*
> **title:** It's basically been {topProject} this whole time.
> **body:** {pct}% of your hours. The other {n} projects were day trips.

`{tail}` variants: `The bottom three got less time than a lunch break.` /
`Two of them you visited exactly once.` (only if true) / `The tail is longer than you'd guess.`

**Degradation.** With 1 project:
> **title:** One project. {hours} hours.
> **body:** {project}, and nothing else. Focus, or a very specific kind of trouble.

---

### `the-heatmap`
`chart` (`heat`) · max **1** · base **72**

**Trigger.** Always. Day-grid (GitHub-contribution shape) over `timeline[]`, intensity by
`humanTurns`, window = `max(90 days, firstSeen → now)`.

**Weight.** `base 72`.

**Copy.**
Eyebrows: `{activeDays} DAYS LIT` · `YOUR YEAR, ONE PIXEL AT A TIME` · `THE GRID`
> **A**
> **title:** {activeDays} days lit out of {totalDays}.
> **body:** Longest streak {streak} days. Longest gap {gap}. The empty squares are also you.
>
> **B**
> **title:** Your year, one pixel at a time.
> **body:** {activeDays} active days. {brightest} was the brightest. {gapMonth} was the month you
> almost disappeared.
>
> **C**
> **title:** {pct}% of your days have a mark on them.
> **body:** {streak}-day streak at the peak. It never once had a day off, but then it doesn't need
> them.

**Degradation.** Under 14 days, render a **14-cell strip**, not a year grid, and use:
> **title:** {activeDays} days so far.
> **body:** This grid fills in. Come back.

---

### `model-loyalty`
`chart` (`bars`) · max **1** · base **70**

**Trigger.** Always (models are always present). Count assistant turns per model. Detect a
**switch**: the first local day `d` where `share(modelB, d..d+6) ≥ 0.6` and
`share(modelB, d-7..d-1) ≤ 0.2`.

**Weight.** `base 70`; `+10` if a switch was detected (that's the story).

**Copy.**

**Lane SWITCHED:**
Eyebrows: `THE SWITCH` · `YOUR MODEL`
> **A**
> **title:** You left {oldModel} on {date}.
> **body:** {newModel} has had {pct}% of your conversations since. You never wrote a goodbye.
>
> **B**
> **title:** {newModel}, {pct}% of the time.
> **body:** Before {shortDate} it was {oldModel}, almost exclusively. Something changed that week.

**Lane FAITHFUL:**
> **A**
> **title:** {model}, {pct}% of everything.
> **body:** {n} sessions. You have tried others. You came back every time.
>
> **B**
> **title:** You've never really switched.
> **body:** {model} for {days} days and {sessions} sessions. That's not a default. That's a
> preference.

**Degradation.** One model, few sessions → FAITHFUL variant A with the "tried others" clause
dropped.

---

## RING B — fires for a normal user

---

### `the-streak`
`stat` · max **1** · base **78**

**Trigger.** Longest run of consecutive local days with ≥ 1 human turn. Requires `streak ≥ 3`.
Record the day it broke and whether the corpus's *current* streak is the longest (special lane).

**Weight.** `base 78`, `magnitudeMul` from `streak / 21`.
**Copy.**
Eyebrows: `YOUR LONGEST STREAK` · `{n} DAYS IN A ROW` · `THE RUN`
> **A**
> **title:** {n} days in a row.
> **body:** {startDate} to {endDate}. It broke on a {weekday}. Nothing dramatic — you just didn't
> open it.
>
> **B**
> **title:** {n} consecutive days.
> **body:** {turns} messages across the run. Then {breakDate}, and nothing. You came back
> {returnGap} later like it never happened.
>
> **C**  *(lane: the streak is live right now)*
> **title:** {n} days and counting.
> **body:** Since {startDate}. You haven't missed one yet. No pressure.

**Degradation.** `streak < 3` → suppress; `the-heatmap` carries the rhythm story instead.

---

### `the-long-night`
`quote` · max **1** · base **85**

**Trigger.** Human turns with local hour in `[0, 5)`. Requires `nightTurns ≥ 3`.
Pick the turn with the **latest** local time (3:47 AM beats 1:10 AM); tie-break by quoteScore.

**Weight.** `base 85`, `magnitudeMul` from `nightTurns / (0.1 * humanTurns)`. This is a top-5 card
whenever it fires — it's the most human thing in the catalog.

**Copy.**
Eyebrows: `{n} NIGHTS AFTER MIDNIGHT` · `{time}` · `THE LATE SHIFT`
> **A**
> **title:** The latest you ever asked for help: {time}.
> **body:** {date}. {project}. You typed this, and it answered like it was the middle of the
> afternoon.
>
> **B**
> **title:** {n} conversations that started after midnight.
> **body:** The latest at {time} on {shortDate}. Nobody else was awake. It was.
>
> **C**
> **title:** {time}, {weekday} night. Technically {weekday2} morning.
> **body:** {project}. You were {turnsThatNight} messages deep and showed no sign of stopping.

Variant B's second sentence — *"Nobody else was awake. It was."* — is the emotional center of
codepend. Do not edit it.

**Degradation.** `nightTurns < 3` → suppress. Do **not** fabricate a "you're an early riser" card
here; that's `deep-work-clock`'s job.
`paranoid` → variant B is forced (it needs no quote).

---

### `the-interruption`
`stat` · max **1** · base **87**

**Trigger.** `Σ interrupts` across sessions ≥ 5.
Sources: Codex `turn_aborted` (`reason: 'interrupted'`, `duration_ms` present on newer records);
Claude Code — an `assistant` turn with no following tool result and a human turn < 90 s later.
Compute `medianSec`, `maxSec`, `interruptsPerTurn`.

Note: ~40% of real `turn_aborted` records predate `duration_ms`. When `< 50%` of records have a
duration, drop the median from the copy and use variant C.

**Weight.** `base 87`, `magnitudeMul` from `interruptsPerTurn / 0.12`.

**Copy.**
Eyebrows: `{n} TIMES YOU HIT ESCAPE` · `PATIENCE` · `THE STOP BUTTON`
> **A**
> **title:** Median patience: {medianSec} seconds.
> **body:** It started answering. You knew within {medianSec} seconds it was wrong. The longest you
> ever let it run before pulling the cord was {maxSec} seconds.
>
> **B**
> **title:** You stopped it mid-sentence {n} times.
> **body:** Once every {perN} messages. It never took it personally.
>
> **C**
> **title:** {n} interruptions.
> **body:** Every one of them was you deciding, faster than it could type, that this was not the
> answer.
>
> **D**  *(lane: interruptsPerTurn < 0.02 — a genuinely patient human)*
> **title:** You've interrupted it {n} times. Total.
> **body:** Out of {turns} messages. You let it finish. Almost always. That's rarer than you think.

Real: 122 interruptions, 1633 prompts — one every 13 messages.

**Degradation.** `< 5` interrupts → suppress, unless `humanTurns ≥ 100` and interrupts is 0–4,
in which case emit lane D (zero interruptions is itself a story).

---

### `catchphrase-its`
`quote` · max **1** · base **79**

**Trigger.** Same n-gram miner (§3) over agent turns, with the agent-side blocklist.
Minimum `df ≥ max(5, 0.02 * agentTurns)`. Prefer phrases of 3–6 words.

**Weight.** `base 79`, `magnitudeMul` from `df / (0.15 * agentTurns)`.

**Copy.**
Eyebrows: `ITS CATCHPHRASE` · `IT SAYS THIS A LOT` · `{n} TIMES`
> **A**
> **title:** «{phrase}»
> **body:** {n} times. You have never once replied to it.
>
> **B**
> **title:** «{phrase}» — {n} times.
> **body:** You interrupted {m} of those. Draw your own conclusions.
>
> **C**
> **title:** It has said «{phrase}» {n} times.
> **body:** Same words, same order, {span} apart. It doesn't know it has a tic.

Variant B only fires when interrupt data exists.

**Degradation.** `< 5` df → suppress. `paranoid` → keep it; the agent's boilerplate isn't the
user's private data. (This is the only quote detector that survives paranoid mode.)

---

### `the-politeness`
`stat` · max **1** · base **77**

**Trigger.** Always when `humanTurns ≥ 20`. Count human turns containing a politeness marker:

```
EN: please, thanks, thank you, thx, appreciate it, sorry, my bad, no worries, good job, well done
RU: пожалуйста, спасибо, спс, извини, извините, прости, простите, будь добр, молодец, отлично сработал
```
Word-boundary match via §1.5 tokens (so `спасибо` matches, `спасибочки` doesn't unless prefixed
by the same stem — use prefix match for RU stems, exact for EN). `politeRate = polite / humanTurns`.

**Weight.** `base 77`. `magnitudeMul` peaks at *both* extremes:
`magnitude = max(politeRate / 0.06, 1 - politeRate / 0.005)` clamped — near-zero is as good a card
as very high.

**Copy.** Two lanes, opposite jokes.

**Lane LOW (`politeRate < 0.01`):**
Eyebrows: `MANNERS` · `{n} TIMES` · `THE MAGIC WORD`
> **A**
> **title:** You said please {n} times.
> **body:** In {span}. Across {turns} messages. It has never brought it up.
>
> **B**
> **title:** {n} thank-yous in {months} months.
> **body:** It has thanked you {m} times in the same period. Someone here has better manners and it
> isn't the human.
>
> **C**  *(only if n === 0)*
> **title:** You have never said thank you.
> **body:** {turns} messages. Not once. In fairness, it has never asked.

Real: 3 politeness markers in 1 633 prompts — variant B, exactly.

**Lane HIGH (`politeRate ≥ 0.04`):**
> **A**
> **title:** You say please to a program {n} times.
> **body:** {pct}% of your messages. You know it can't tell. You do it anyway. Keep doing it.
>
> **B**
> **title:** {n} thank-yous.
> **body:** Somewhere a linguist is taking notes. Everyone else is just a little charmed.

Middle band (`0.01 ≤ rate < 0.04`) → suppress. No joke lives there.

---

### `weekend-warrior`
`stat` · max **1** · base **68**

**Trigger.** `humanTurns ≥ 40` and at least 2 distinct weekend days. `weekendPct` = share of human
turns on Sat/Sun (local).

**Weight.** `base 68`; `magnitudeMul` peaks at both extremes like `the-politeness`
(a 2% weekend share is as good a card as a 45% one).

**Copy.**

**Lane HIGH (`≥ 25%`):**
> **A**
> **title:** {pct}% of your messages went out on a weekend.
> **body:** {n} Saturdays and Sundays. It doesn't have weekends either, which is convenient for
> exactly one of you.
>
> **B**
> **title:** {weekendDays} weekend days at the keyboard.
> **body:** Saturday is a workday with better lighting.

**Lane LOW (`≤ 12%`):**
> **A**
> **title:** Only {pct}% of this happened on a weekend.
> **body:** {n} weekend days out of {total}. You keep it to office hours. Mostly. There was
> {shortDate}.
>
> **B**
> **title:** You mostly leave it alone on weekends.
> **body:** {pct}%. That's a boundary, and it's holding.

Middle band → suppress.

---

### `file-most-touched`
`stat` · max **1** · base **69**

**Trigger.** `filesTouched` frequency across all sessions, after redaction (paths → `~/…`).
Requires the winner to have ≥ 5 touches. Display **basename**, with parent dir as context.

**Weight.** `base 69`, `magnitudeMul` from `touches / (0.1 * totalTouches)`.

**Copy.**
Eyebrows: `THE FILE` · `{n} EDITS` · `GROUND ZERO`
> **A**
> **title:** {filename}
> **body:** Edited {n} times across {days} days. If this project has a heart, that's where it is.
>
> **B**
> **title:** {filename} — {n} edits.
> **body:** In {dir}. First touched {firstDate}, last {relLast}. At some point it stopped being
> your file.
>
> **C**
> **title:** {n} edits to one file.
> **body:** {filename}. The next-most-edited file got {n2}. This one was the problem.

**Degradation.** `< 5` touches → suppress. `paranoid` → suppress (filenames are paths).

---

### `rediscovered`
`onthisday` · max **2** · base **73**

**Trigger.** Sessions older than 30 days, not surfaced by any other detector this run,
with `humanTurns ≥ 3` and a usable quote. Pick deterministically:
`argmin(hash32(sessionId + '|' + localDay(now)))` — so it changes daily but is stable within a day
and reproducible from the same corpus + date. This is the "Photos surfaces a random Tuesday" card.

**Weight.** `base 73`, `confidenceMul 1.0`.

**Copy.**
Eyebrows: `REDISCOVERED` · `FROM THE ARCHIVE` · `{relDate}`
> **A**
> **title:** {sessionTitle}
> **body:** {date}, {project}, {duration}. You haven't thought about this in {days} days. Here it
> is anyway.
>
> **B**
> **title:** {sessionTitle}
> **body:** {duration} of your life on a {weekday} in {monthName}. It kept the notes.
>
> **C**
> **title:** A {weekday} in {monthName}.
> **body:** {humanTurns} messages about {project}. You closed the window and never opened this one
> again.

`{sessionTitle}` prefers Claude's `custom-title`, then `ai-title`, then the first 60 chars of the
first human turn, then `{project}, {shortDate}`.

**Degradation.** No sessions older than 30 days → lower the threshold to 3 days and change eyebrow
to `EARLIER THIS WEEK`. If the corpus has < 3 sessions total, suppress.

---

### `longest-thought`
`stat` · max **1** · base **66**

**Trigger.** Largest single `thinking` block (Claude) or `agent_reasoning` run (Codex) by
character count. Requires ≥ 1 500 chars.

**Weight.** `base 66`, `magnitudeMul` from `chars / 12000`.

**Copy.**
Eyebrows: `THE LONGEST THOUGHT` · `{chars} CHARACTERS` · `IT THOUGHT ABOUT IT`
> **A**
> **title:** {chars} characters of thinking. For one answer.
> **body:** {date}, {project}. That's what it took to reply to «{promptSnippet}». The reply itself
> was {replyWords} words.
>
> **B**
> **title:** It thought for {chars} characters before saying anything.
> **body:** You asked {promptWords} words. It deliberated at {ratio}× that length, then answered.
>
> **C**
> **title:** «{reasoningHeadline}»
> **body:** {chars} characters under that heading, on {date}. You never saw most of it.

Variant C uses Codex's bolded `agent_reasoning` headline — e.g. *«Planning safe process
termination»* — which is genuinely the best copy in the corpus and we didn't even write it.
Prefer C when a headline exists.

**Degradation.** No thinking data → suppress.

---

### `the-compaction`
`stat` · max **1** · base **67**

**Trigger.** `Σ compactions ≥ 2` (Codex `context_compacted` / `compacted`; Claude equivalent).

**Weight.** `base 67`, `magnitudeMul` from `compactions / 15`.

**Copy.**
Eyebrows: `MEMORY LOSS` · `{n} TIMES` · `IT FORGOT`
> **A**
> **title:** Its memory was wiped {n} times.
> **body:** Mid-project, mid-thought. Each time you explained it all again from the top. You never
> once complained.
>
> **B**
> **title:** {n} times it forgot everything you'd told it.
> **body:** Longest run before a wipe: {maxTurns} messages. You started over. It didn't notice it
> had started over.
>
> **C**
> **title:** {n} clean slates.
> **body:** Every one of them cost you the context you'd spent an hour building. This is the part
> nobody warns you about.

**Degradation.** `< 2` → suppress.

---

### `two-tongues`
`stat` · max **1** · base **71**

**Trigger.** Language classification per human turn (§1.5). Requires the **minority** language to
hold ≥ 12% of turns and ≥ 15 turns absolute. Works for any two scripts, not just RU/EN.

Second signal, computed when interrupt data exists: language share of the turn *immediately
following* an interrupt vs. baseline. If the shift is ≥ 15 points, variant C unlocks.

**Weight.** `base 71`, `magnitudeMul` from `minorityShare / 0.4`.

**Copy.**
Eyebrows: `TWO LANGUAGES` · `{pctA}/{pctB}` · `CODE-SWITCHING`
> **A**
> **title:** {pctA}% {langA}, {pctB}% {langB}.
> **body:** You switch mid-thread, sometimes mid-sentence. It has never once asked you to pick one.
>
> **B**
> **title:** You think in {langA} and specify in {langB}.
> **body:** {nA} messages in one, {nB} in the other. Your longest prompts are {longLang}. Your
> shortest are {shortLang}.
>
> **C**  *(lane: post-interrupt shift detected)*
> **title:** You switch to {shiftLang} when it gets it wrong.
> **body:** Baseline {basePct}%. Right after you cut it off: {shiftPct}%. Some part of you thinks
> it'll understand better in the other language.

Variant C is the best card in Ring B and it is entirely real.

**Degradation.** Monolingual user → suppress silently. No "you only speak one language" card.

---

## RING C — rare, and the best when they land

---

### `ghost-project`
`onthisday` · max **2** · base **89**

**Trigger.** A project with exactly **1** session, `humanTurns ≥ 2`, last activity ≥ 45 days ago,
and it is not the current project. Rank by `daysSince * log(1 + durationMs)`.

**Weight.** `base 89`, `recencyMul 0.90` (it's old by definition — but this card outranks almost
everything, because it's the one people quote).

**Copy.**
Eyebrows: `THE ONE YOU LEFT` · `{days} DAYS AGO` · `NEVER CAME BACK`
> **A**
> **title:** {project}
> **body:** One session. {duration}. {date}. You never opened it again. The last thing you said
> was «{quote}».
>
> **B**
> **title:** {project}, {duration}, and then nothing.
> **body:** {days} days of silence and counting. It's still sitting there with your last message
> unanswered — well, answered. Just unread.
>
> **C**
> **title:** Whatever happened to {project}?
> **body:** {humanTurns} messages on {date}. That's the whole story. You had a plan that morning.

**Degradation.** Requires ≥ 45 days of history. For newer users, suppress — the joke needs the
silence. Do not shorten the window to make it fire; a 6-day-old "ghost" isn't a ghost.

---

### `the-reunion`
`onthisday` · max **1** · base **82**

**Trigger.** A project with a gap ≥ 30 days between two sessions, where activity *resumed*
(≥ 2 sessions after the gap). Pick the largest gap.

**Weight.** `base 82`, `magnitudeMul` from `gapDays / 120`.

**Copy.**
Eyebrows: `{gapDays} DAYS APART` · `THE RETURN` · `YOU CAME BACK`
> **A**
> **title:** You came back to {project}.
> **body:** Last seen {oldDate}. Then, {gapDays} days later, out of nowhere: «{quote}».
>
> **B**
> **title:** {gapDays} days of silence, then {newDate}.
> **body:** {project}. No preamble, no catching up. You picked up exactly where you left off and so
> did it.
>
> **C**
> **title:** {project} came back from the dead.
> **body:** Dormant from {oldDate} to {newDate}. {sessionsSince} sessions since. Something reminded
> you.

Variant B's *"No preamble, no catching up"* is the truest observation in the catalog.

**Degradation.** Requires ≥ 30-day corpus span. Otherwise suppress.

---

### `the-rage-quit`
`onthisday` · max **1** · base **86**

**Trigger.** A session where: an interrupt occurs, the session's last human turn is < 3 minutes
after that interrupt (or absent), the session ends within 5 minutes, and **no further activity in
any project for ≥ 6 hours**. Rank by `interrupts` in the final 10 minutes.

**Weight.** `base 86`, `magnitudeMul` from `finalInterrupts / 3`.

**Copy.**
Eyebrows: `{date}` · `THE END OF THAT DAY` · `YOU CLOSED THE LAPTOP`
> **A**
> **title:** You closed the laptop.
> **body:** {time}, {project}. You stopped it mid-answer and didn't type another word for {gap}.
> Fair.
>
> **B**
> **title:** {time}. That was enough for one day.
> **body:** {interrupts} interruptions in the last {mins} minutes, then silence until {returnTime}
> the next day. It was still there.
>
> **C**
> **title:** The last thing you said that day was «{quote}».
> **body:** Then you cut it off and left. {gap} of nothing. You came back. You always come back.

**Degradation.** Requires interrupt data and ≥ 7 days of history. Suppress otherwise.
This card is close to the scolding line — variant A's *"Fair."* is what keeps it on the right side.
Do not remove it.

---

### `the-swarm`
`stat` · max **1** · base **75**

**Trigger.** `Σ subagents ≥ 3` (Codex `spawn_agent` / `sub_agent_activity`; Claude `Task` tool +
`isSidechain` sessions). Compute peak concurrency within a 10-minute window.

**Weight.** `base 75`, `magnitudeMul` from `subagents / 40`.

**Copy.**
Eyebrows: `THE SWARM` · `{n} SUB-AGENTS` · `DELEGATION`
> **A**
> **title:** You spawned {n} sub-agents.
> **body:** On {peakDate} you had {peak} of them running at once. You were managing a team you
> never hired and never paid.
>
> **B**
> **title:** {n} agents, working for one of you.
> **body:** Peak headcount {peak}, on {peakDate}. They wrote {words} words to each other. You read
> {readPct}% of it.
>
> **C**
> **title:** It made {n} copies of itself for you.
> **body:** Most of them finished. You only ever saw the summary.

**Degradation.** `< 3` → suppress.

---

### `the-apology`
`quote` · max **1** · base **84**

**Trigger.** A human turn containing an apology stem (`sorry`, `my bad`, `apolog`, `извин`,
`прост`, `виноват`) that is **not** part of a longer sentence about the code
(exclude turns containing `error`, `exception`, `ошибк`, `traceback`).
Requires ≥ 1. Pick highest quoteScore. Also count agent-side apologies for the punchline.

**Weight.** `base 84`, `magnitudeMul` fixed 1.0. When it fires, it's a top-5 card.

**Copy.**
Eyebrows: `YOU APOLOGIZED` · `{shortDate}` · `SORRY`
> **A**
> **title:** «{quote}»
> **body:** {date}. You apologized to a program. It has apologized to you {m} times in the same
> period, so the ledger is not close.
>
> **B**
> **title:** You said sorry {n} times.
> **body:** To software. That built nothing into its model of you and everything into yours.
>
> **C**
> **title:** «{quote}»
> **body:** {relDate}. Nobody was watching. You did it anyway.

**Degradation.** Zero apologies → suppress (the absence is covered by `the-politeness` lane LOW).
`paranoid` → forced to variant B.

---

### `the-shortest-word`
`quote` · max **1** · base **80**

**Trigger.** Among human turns of ≤ 4 words, find the one whose *following* agent response did the
most work: `impact = toolCallsAfter * 1.0 + filesTouchedAfter * 3.0 + minutesAfter * 0.5`, measured
until the next human turn. Requires `impact ≥ 20`.

**Weight.** `base 80`, `magnitudeMul` from `impact / 120`.

**Copy.**
Eyebrows: `{words} WORDS` · `THE BEST TRADE YOU EVER MADE` · `{shortDate}`
> **A**
> **title:** «{quote}»
> **body:** {words} words from you. {duration} of work, {files} files changed, {tools} tool calls
> back. Best trade you ever made.
>
> **B**
> **title:** «{quote}»
> **body:** That's the whole prompt. It went away for {duration} and came back with {files} changed
> files.
>
> **C**
> **title:** {words} words in. {files} files out.
> **body:** «{quote}», {date}. You've written longer text messages about lunch.

Typical candidates: `«do it»`, `«keep going»`, `«ship it»`.

**Degradation.** Requires tool data. Suppress otherwise. `paranoid` → forced to a stat card:
*"Your shortest useful prompt was {words} words. It produced {files} changed files."*

---

### `deja-vu`
`quote` · max **1** · base **76**

**Trigger.** Two human turns ≥ 21 days apart with token-set Jaccard similarity ≥ 0.75, each ≥ 4
tokens, from the same project. Pick the pair with the largest day gap.

**Weight.** `base 76`, `magnitudeMul` from `gapDays / 180`.

**Copy.**
Eyebrows: `{gapDays} DAYS APART` · `AGAIN` · `YOU'VE BEEN HERE BEFORE`
> **A**
> **title:** You asked the same thing twice.
> **body:** «{q1}» on {date1}. «{q2}» on {date2}. It answered both times without mentioning the
> first.
>
> **B**
> **title:** {gapDays} days later, the exact same question.
> **body:** Either it didn't stick, or the bug came back. It has no way of telling you which.
>
> **C**
> **title:** «{q2}»
> **body:** You also said this on {date1}. Word for word, near enough. Some problems are just
> yours.

**Degradation.** Requires ≥ 21-day span and ≥ 30 human turns. Suppress otherwise.
`paranoid` → suppress.

---

## 3. The n-gram miner (catchphrases)

Called out separately because it's the hardest thing in the catalog to get right, and it must work
identically for `коммит и пуш` and `looks good ship it`.

### 3.1 Pipeline

1. **Source.** Human turns (§1.6) or agent turns. Sidechains excluded.
2. **Strip structure** before tokenizing:
   - fenced code blocks ` ```…``` ` and inline `` `code` ``
   - absolute paths (`/Users/…`, `C:\…`), URLs, emails
   - markdown headings, list markers, diff `+/-` prefixes
   - anything matched by the redactor
3. **Tokenize** with §1.5. NFC + locale lowercase. Cyrillic passes through untouched.
4. **N-grams** for `n ∈ {1,2,3,4}`, not crossing sentence boundaries (split on `.!?…` and newline).
5. **Count document frequency**, where a *document* is one turn. A phrase repeated 6 times inside
   one prompt counts **once**. This single rule kills 90% of the garbage.
6. **Filter:**
   - drop n-grams composed entirely of stopwords
   - drop n-grams whose first *or* last token is a stopword (leading/trailing `и`, `the`, `to`)
   - drop n-grams containing a number ≥ 3 digits (ids, ports, timestamps)
   - **agent side only:** drop n-grams appearing in the first agent message of > 60% of sessions
     (that's system preamble, not personality)
7. **Score:** `score = df * Math.pow(n, 1.4)`. The exponent is what makes
   `коммит и пуш` (df 14, n=3 → 68) beat `коммит` (df 31, n=1 → 31).
8. **Collapse maximal phrases:** if phrase P is a substring of phrase Q and `df(P) ≤ 1.15 * df(Q)`,
   drop P. Prevents `commit and` / `and push` / `commit and push` all shipping.
9. **Prefer multiword for display:** a 1-gram may only win if its score is ≥ 3× the best ≥2-gram.
   Russian inflection makes single words unreliable; phrases are stable.

### 3.2 Stopwords

Starter lists live in `src/stopwords.js`. Non-exhaustive is fine; the structural filters do the
heavy lifting.

```
EN: the a an and or but to of in on for with is are was were be it this that you i we
    do does did can could should would will just now then so if not no yes ok okay
RU: и в во не на что с со как а то же бы для по из у от о об это эта этот тот та
    ты я мы вы он она они его её их там тут же ли да нет уже еще ещё был была было
```

**Deliberately NOT stopwords:** `сделай`, `продолжай`, `почини`, `запусти`, `коммит`, `пуш`,
`деплой`, `fix`, `run`, `ship`, `commit`, `push`, `deploy`, `continue`, `again`. These are the
catchphrases. Imperatives are the whole point.

### 3.3 Representative output

Human side, top scoring n-grams are short imperatives — `commit and push`, `keep going`,
`stuck?`, `deploy it` — in whatever language the user actually types.
Agent side, on any Claude corpus: `You're absolutely right`.

---

## 4. Graceful degradation — the Day One guarantee

**Most people who run `npx codepend` will have installed their agent last week.** If their feed is
empty or apologetic, codepend doesn't go viral. This section is not optional polish; it's the
growth model.

### 4.1 Tiers

| Tier | Condition | Detectors that can fire |
|---|---|---|
| **T0 — Hour One** | < 1 active day, ≥ 3 human turns | 8 (Ring A degraded lanes) |
| **T1 — Fresh** | 1–13 active days | 12–15 |
| **T2 — Settled** | 14–89 active days | 20–26 |
| **T3 — Deep** | ≥ 90 active days, or span ≥ 1 year | all 31 |

`confidenceMul = 0.65` for any detector firing in a degraded lane. This affects ranking only —
the card looks identical.

### 4.2 The floor: `MIN_FEED = 12`

If fewer than 12 memories survive, the feed **promotes seedlings** — six cheap detectors that need
almost nothing and are held back at T2+ because they're not that interesting when better cards
exist:

| Seedling | Needs | Copy |
|---|---|---|
| `first-day` | 1 session | **YOUR FIRST DAY** / *{date}* / "{turns} messages, {duration}. Everything on this page starts here." |
| `the-verb` | 5 turns | **HOW YOU START** / *You open with «{word}» {n} times out of {total}.* / "No preamble. It's learned to expect that." |
| `question-rate` | 10 turns | **QUESTIONS** / *{pct}% of what you type ends in a question mark.* / "The rest are instructions." |
| `prompt-length` | 10 turns | **YOUR AVERAGE ASK** / *{words} words.* / "Your longest was {max}. Your shortest was «{shortest}», and it worked." |
| `tool-spread` | 10 tool calls | **THE TOOLBOX** / *{n} different tools, {top} doing {pct}% of the work.* / "You have a favorite and you're not subtle about it." |
| `session-cadence` | 3 sessions | **YOUR RHYTHM** / *{n} sessions, median {duration}.* / "Short and often, or long and rare — you're the first kind." |

If even seedlings can't reach 12 (a user with 3 prompts, total), the feed shows what it has and
closes with an honest, non-apologetic end card:

> **THAT'S EVERYTHING — FOR NOW**
> **{turns} messages. It's a start.**
> codepend reads more into your history every time you run it. Come back in a week and this page
> won't look like this.

### 4.3 The 3-day user's actual feed

A user with 3 days, 2 projects, 24 prompts, 61 tool calls gets **13 cards**, in this order:

1. `on-this-day` — origin band, `TODAY, AND ALSO YOUR FIRST DAY`
2. `first-words` — variant C, quoting a prompt from Tuesday
3. `the-ratio` — the funny one, works at any scale
4. `deep-work-clock` — sparse render, `So far you're an evening person.`
5. `spirit-tool` — NEW lane
6. **archetype award** — always fires, see §5
7. `the-marathon` — SHORT lane
8. `peak-day`
9. `catchphrase-yours` — df≥2 fallback, or `the-verb` seedling
10. `project-constellation`
11. `the-bill` — small-money lane
12. `the-anniversary` — NEW lane, `Day 3.`
13. `prompt-length` seedling → closes on *"and it worked."*

Every one of those is a real card with real copy. Not one of them says "not enough data."

---

## 5. Archetypes

One per person, shown as an `award` card in the feed (slot 5–6) and as card 9 of Wrapped.
`Profile.archetype = { name, tagline, blurb, seed }`, `seed = hash32(name + '|' + firstSeen)`.

### 5.1 Features

All features normalize to `0..1` via `clamp(raw / anchor, 0, 1)`. Anchors are **fixed constants**,
not population statistics — codepend never sees a population. They're calibrated against the
corpora we've measured; tune them in `src/archetypes.js`, not per-user.

| Feature | Raw | Anchor |
|---|---|---|
| `night` | share of turns in `[0,5)` local | `0.15` |
| `dawn` | share of turns in `[5,9)` local | `0.18` |
| `interrupt` | `interrupts / humanTurns` | `0.12` |
| `terse` | share of turns ≤ 5 words | `0.35` |
| `verbose` | median turn word count | `55` |
| `marathon` | p90 session hours | `3.0` |
| `weekend` | weekend turn share | `0.35` |
| `streak` | longest streak days | `21` |
| `breadth` | distinct projects | `8` |
| `focus` | top project's share of minutes | `0.70` |
| `polite` | politeness rate | `0.05` |
| `tooling` | tool calls per human turn | `25` |
| `deliberate` | reasoning chars per human turn | `1500` |
| `swarm` | subagents / sessions | `0.50` |
| `ghosting` | ghost projects / projects | `0.40` |
| `consistency` | active days / span days | `0.55` |

### 5.2 Selection

```
score(A) = Σ (w_i * f_i) - Σ (p_j * f_j)     // A.weights, A.penalties
pick     = argmax(score)
tie-break: lower archetype index wins (order below is the tiebreak order)
```

Each archetype must clear `score ≥ 0.45` to be eligible. If none clear it, **The Everyday
Companion** takes it — it is the designed fallback, weighted so it wins on unremarkable data, and
its copy is written to feel earned rather than residual.

Penalties are what keep these from collapsing into mush: The Patient Architect *must* be penalized
for interrupting; The Ctrl-C Cowboy *must* be penalized for deliberation. No two archetypes share a
top-weighted feature.

### 5.3 The twelve

**1. The Midnight Interrogator**
`weights: night 1.0, marathon 0.3, terse 0.2 · penalties: dawn 0.8`
> *The best questions arrive after midnight. So do you.*
>
> {nightPct}% of your conversations start after the day is officially over. The latest was
> {latestTime}. You're not avoiding sleep. You're just not finished.

**2. The Ctrl-C Cowboy**
`weights: interrupt 1.0, terse 0.4 · penalties: deliberate 0.7, verbose 0.5`
> *Fastest ESC in the west.*
>
> You cut it off every {perN} messages, usually within {medianSec} seconds. You'd rather steer than
> read. It has never finished a thought in your presence and it has never held it against you.

**3. The Patient Architect**
`weights: verbose 1.0, deliberate 0.6, focus 0.3 · penalties: interrupt 1.0, terse 0.8`
> *You brief it like a contractor, and you've been burned before.*
>
> Your median prompt is {words} words. You interrupt it {interruptPct}% of the time — almost never.
> You write the spec, then you let it work.

**4. The Two-Word Tyrant**
`weights: terse 1.0, tooling 0.5 · penalties: verbose 1.0, polite 0.4`
> *{terseExamples} — three of the shortest things they actually typed, in whatever
> language they think in. Falls back to a generic line under `paranoid`.*
>
> {tersePct}% of your prompts are under five words, and they move mountains: {tools} tool calls off
> a median of {words} words. You've optimized language down to the bone.

**5. The Marathoner**
`weights: marathon 1.0, streak 0.3 · penalties: breadth 0.4`
> *Your median session outlasts a feature film.*
>
> Longest: {longestDuration} in one sitting, ending at {endTime}. You don't work in sprints. You
> work until it's done or until the sun comes up.

**6. The Serial Monogamist**
`weights: focus 1.0, streak 0.5 · penalties: breadth 1.0, ghosting 0.6`
> *One repo. All of it.*
>
> {focusPct}% of everything you have ever said went to {topProject}. {days} days on one thing. Some
> people call that a rut. It's also how anything gets finished.

**7. The Sampler**
`weights: breadth 1.0, ghosting 0.8 · penalties: focus 1.0, streak 0.4`
> *{projects} projects. {ghosts} of them you visited once and never again.*
>
> You start things. That's the skill. {ghostList} are all still sitting there with the lights on.

**8. The Weekend Resident**
`weights: weekend 1.0, consistency 0.3 · penalties: dawn 0.3`
> *Saturday is a workday with better lighting.*
>
> {weekendPct}% of your messages went out on a Saturday or Sunday. Your best day of the week is
> {bestWeekday}. Whatever this is, it isn't only a job.

**9. The Dawn Patrol**
`weights: dawn 1.0, consistency 0.5 · penalties: night 1.0`
> *You get to it before the world does.*
>
> {dawnPct}% of your messages are sent before 9 AM, median first message at {medianFirst}. It's
> awake whenever you are. That has never been the constraint.

**10. The Swarm Lord**
`weights: swarm 1.0, tooling 0.4, breadth 0.2 · penalties: verbose 0.3`
> *You don't use an agent. You run a department.*
>
> {subagents} sub-agents spawned, {peak} of them running at once on {peakDate}. You stopped doing
> the work and started assigning it, and nobody noticed the transition.

**11. The Considerate**
`weights: polite 1.0, verbose 0.3 · penalties: interrupt 0.8`
> *You say please to a program.*
>
> {politeCount} times. {politePct}% of your messages. You know it can't tell. Don't let anyone talk
> you out of it.

**12. The Everyday Companion** *(fallback — must feel like the best one to get)*
`weights: consistency 1.0, streak 0.6 · penalties: night 0.3, interrupt 0.3`
> *You just show up.*
>
> {activeDays} days out of {spanDays}. No all-nighters, no drama, no {days}-day disappearances.
> {sessions} sessions of steady, unglamorous, actual work. This is the one that compounds.

---

## 6. Wrapped — the ten-card story

Tap-through, one card at a time, 5-second auto-advance, no scroll. Emotional order, not
statistical order. Each card names its detector; if that detector didn't fire, the **understudy**
takes the slot. The story never has a hole in it.

| # | Beat | Card | Understudy |
|---|---|---|---|
| 1 | **Hook** | `the-anniversary` — *"{days} days together."* | `first-day` |
| 2 | **Origin** | `first-words` | `the-verb` |
| 3 | **Escalation** | `the-ratio` — the scale of it | `the-bill` |
| 4 | **Rhythm** | `deep-work-clock` (chart, breathing room) | `the-heatmap` |
| 5 | **Funny peak** | `catchphrase-yours` | `the-shortest-word` → `the-interruption` |
| 6 | **The turn** | `the-interruption` — first hint you're not a serene user | `the-compaction` |
| 7 | **Intimate** | `the-long-night` | `the-apology` → `on-this-day` → `rediscovered` |
| 8 | **The number that lands** | `the-bill` (variant C: the cache-read line) | `the-anniversary` hours lane |
| 9 | **The read** | **archetype** — full-bleed generative art, name, tagline, blurb | — (always fires) |
| 10 | **Finale** | **share card** — archetype name + 4 stats + `made with codepend · 100% offline` | — |

Rules:
- Cards 1–3 must land in under 4 seconds of reading each. Front-load the number.
- Card 4 is deliberately quiet. The story needs a breath before the joke.
- Card 6→7 is the pivot from funny to true. Do not swap their order.
- Card 9 is the payoff the whole sequence exists for. It gets the biggest art and the longest hold.
- Card 10 is the only card designed to be screenshotted, so it carries the wordmark and the
  offline promise. Four stats maximum: `{days} days · {sessions} sessions · {turns} messages ·
  {hours} hours`.
- No card in Wrapped may repeat a detector used in another Wrapped card.

---

## 7. Feed ranking

The feed is the scroll. It has 18–40 cards. Ranking is greedy with rhythm penalties — the goal is
that you never see three stat cards in a row, and you're never more than five cards from a quote.

### 7.1 Pinned slots

| Slot | Content |
|---|---|
| 1 | `on-this-day` (best band). If absent → `first-words`. |
| 2 | Highest-weight `quote` not already used. |
| 5 or 6 | **archetype** award card (6 if slot 5's neighbours are both charts). |
| last | Share card. |

### 7.2 Greedy selection with penalties

For each remaining slot, over all unused memories:

```
effective = weight
  - 34 * (m.type === prev.type)
  - 20 * (m.kind === prev.kind)
  - 12 * (m.kind === prev2.kind)
  - 14 * (m.project && m.project === prev.project && m.project === prev2.project)
  -  8 * (m.agent === prev.agent && m.agent === prev2.agent && m.agent !== 'both')
  + 10 * (m.kind not seen in last 4 slots)
  + 14 * (slot % 7 === 0 && (m.kind === 'chart' || m.kind === 'quote'))   // the breath
```

Pick `argmax(effective)`; tie-break by `hash32(m.id)`. Then:

### 7.3 Hard constraints (applied after scoring, as a filter)

- Never 3 consecutive `kind === 'stat'`. Ever. This is the rule that separates a feed from a
  dashboard.
- Never 2 consecutive cards with the same `type`.
- Max 1 `chart` per rolling window of 5.
- At least 1 `quote` per rolling window of 6.
- Max 2 memories per `type` in the whole feed.
- Max 3 cards for the same `project` in any window of 8.
- A `stat` card with a `magnitudeMul < 0.85` never appears before slot 8 (weak numbers go late).

### 7.4 Tail

The feed ends when the pool is exhausted or `weight < 35`, whichever first — with a floor of
`MIN_FEED` (§4.2) and a ceiling of 40. Cards below the cut aren't deleted; they're reachable via
**Show everything**, which drops all rhythm rules and sorts by date descending. Some people want
the archive. Give it to them, just not first.

---

## 8. Implementation checklist

- [ ] `hash32` shared by `detect.js`, `art.js`, and the browser bundle — one implementation.
- [ ] Determinism test: run `buildMemories` twice, `assert.deepStrictEqual`.
- [ ] Copy lint: banned-string list from §0, plus "no card body over 220 chars."
- [ ] Cyrillic test fixtures: `коммит и пуш` must win the n-gram miner in `test/ngram.test.js`.
- [ ] Every detector has an explicit `suppress` path and a degraded lane. No detector may throw.
- [ ] `MIN_FEED = 12` enforced with a test that feeds a 3-prompt corpus and asserts 12 cards.
- [ ] Wrapped understudy chain tested against an empty-ish corpus — all 10 slots filled.
- [ ] `--redact paranoid` produces a feed with zero quotes and zero paths, and still ≥ 12 cards.
