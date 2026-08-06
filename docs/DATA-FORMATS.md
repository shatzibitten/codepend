# codepend — Data Extraction Spec

**Status:** verified against the real corpus on this machine, 2026-08-05.
**Audience:** whoever implements `src/scan.js`. This document is the contract; where it disagrees
with the project brief, **this document wins** (see §11 for the list of brief errors).

Every table below was produced by a command actually run against `~/.claude/projects` and
`~/.codex/sessions`. Claims I could not verify are marked **[UNVERIFIED]**. All paths are shown
with the home directory collapsed to `~`.

---

## 1. Corpus at a glance (measured)

| | Claude Code | Codex |
|---|---|---|
| Root | `~/.claude/projects/` | `~/.codex/sessions/` + `~/.codex/archived_sessions/` |
| Files on disk (`*.jsonl`) | **215** | **217** (211 + 6 archived) |
| Files that are *sessions* | **22** | 217 |
| Files that are *human* sessions | 22 | **104** (see §4.2) |
| Bytes | 88.8 MB (top level) / 619 MB (incl. subagent dirs) | 4.3 GB + 33 MB |
| Lines | **12,203** | **236,639** |
| Largest single file | 21.5 MB | **618.2 MB** |
| Largest single *line* | 1,236,793 B (1.2 MB) | 2,896,357 B (2.9 MB) |
| Malformed JSON lines | **0** | **0** |
| True UTF-8 decode errors | **0** | **0** |
| Byte-order marks | 0 | 0 |
| Files missing trailing newline | 0 | 0 |

Full 4.3 GB Codex walk with per-line `json.loads` completed in **9.9 s** (warm page cache). The
corpus is byte-huge but line-cheap: ~18 KB average per line, so parse cost is dominated by a few
enormous tool-output lines, not by line count.

---

## 2. Which files to read

### 2.1 Claude Code

```
~/.claude/projects/<cwd-slug>/<sessionUuid>.jsonl          ← SESSIONS (22)
~/.claude/projects/<cwd-slug>/<sessionUuid>/subagents/...   ← NOT sessions (193 files)
~/.claude/projects/<cwd-slug>/<sessionUuid>/tool-results/
~/.claude/projects/<cwd-slug>/<sessionUuid>/workflows/
```

**Rule:** glob `~/.claude/projects/*/*.jsonl` only — depth exactly 2. The 193 nested files are
subagent transcripts, workflow scripts and spilled tool results. They hold 530 MB against the
22 sessions' 88.8 MB — a **7.0× byte inflation** — and their prompts are orchestrator-authored,
not typed by the human.

`<cwd-slug>` is the absolute cwd with `/` → `-`, e.g.
`-Users-dev-work-Projects-orchard`. It is a **lossy** encoding — a real
directory containing `-` is indistinguishable from a `/`. Do not reconstruct paths from the slug;
read `cwd` off the line records instead (§3.2). Use the slug only as a grouping key and derive the
display project name from its last segment.

### 2.2 Codex

```
~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl
~/.codex/archived_sessions/rollout-<ISO>-<uuid>.jsonl
```

**Archived sessions do NOT duplicate `sessions/`.** Measured: 6 archived ids, 211 session ids,
**0 intersection**, and 0 duplicate ids within `sessions/`. Read both directories; no cross-root
dedup is needed.

The `<ISO>` in the filename is **local wall-clock time**, while the `timestamp` inside is UTC. For
`rollout-2026-03-11T11-49-04-...` the first record reads `2026-03-11T06:49:10.632Z` — a +5h offset
(Asia/Almaty). **Never parse the filename for time.** Use it only as a cheap pre-filter for
`--since`, and widen the window by ±24 h to stay safe across timezones.

---

## 3. Claude Code format

### 3.1 Line type inventory (all 22 sessions, 12,203 lines)

| `type` | Count | Carries signal? | Use for |
|---|---:|---|---|
| `assistant` | 5,436 | ✅ high | models, tokens, tools, thinking, files touched |
| `user` | 3,175 | ⚠️ mixed | **only 114 are human** — see §3.3 |
| `last-prompt` | 871 | ⛔ | rewritten every turn; redundant with §3.3 |
| `ai-title` | 853 | ✅ | session headline (take **last**) |
| `attachment` | 629 | ⚠️ low | mostly UI plumbing; see §3.5 |
| `queue-operation` | 478 | ⚠️ mixed | typed-while-busy prompts; see §3.3 |
| `custom-title` | 345 | ✅ | user-set title (take **last**, prefer over `ai-title`) |
| `mode` | 316 | ⛔ | plan/normal toggles |
| `system` | 95 | ⛔ | `stop_hook_summary` ×94, `api_error` ×1 |
| `frame-link` | 5 | ⛔ | preview iframe bookkeeping |

**`last-prompt`, `ai-title`, `custom-title` and `mode` have NO `timestamp` field.** Measured:
871 / 853 / 345 / 316 lines respectively lack it entirely. Never feed them to time math.

Title records are **appended repeatedly**, not rewritten: one 928-line session carries 90 `ai-title`
and 91 `custom-title` records. Always take the **last** occurrence in file order. Some sessions have
zero `custom-title` (e.g. `756b3b01…` has `ai=23 custom=0`), so fall back `customTitle → aiTitle → null`.

### 3.2 Common fields on timestamped lines

`timestamp` (ISO-8601 with `Z`, millisecond precision), `uuid`, `parentUuid`, `sessionId`, `cwd`,
`gitBranch`, `version` (CLI version, e.g. `2.1.219`), `userType`, `entrypoint`, `slug`, `isSidechain`.

**One `sessionId` per file.** Measured: 0 of 22 files contain more than one distinct `sessionId`.
Claude Code resumes append to the *same* file, so there is no resumed-session merge problem and
`basename(file, '.jsonl')` is a safe stable session id.

**`isSidechain` is always `false`** in all 5,436 assistant lines of the 22 top-level files —
sidechains now live in the separate `subagents/` directory we exclude. Keep the field in the
`Session` shape for compatibility, but do not build a detector on it.

### 3.3 Human-turn detection — Claude **(critical)**

**Rule:** a real typed prompt is `type === 'user'` **and** `origin.kind === 'human'`.

Measured distribution over all 3,175 `user` lines:

| `origin.kind` | Count | What it is |
|---|---:|---|
| *(absent)* | 3,023 | tool-result carriers — content is a `tool_result` block array |
| `human` | **114** | ✅ the real typed prompts |
| `task-notification` | 38 | injected `<task-notification>` XML from background tasks |

Content-block census across those 3,175 lines: `tool_result` ×2,988, `text` ×25, `image` ×10.
So **94 % of `user` lines are tool output**, and naive `type === 'user'` inflates human turns by 28×.

`message.content` is a **string in 162 cases and an array in 3,013**. Handle both. For arrays,
concatenate only blocks with `type === 'text'`; ignore `tool_result` and `image` blocks.

**Do not filter on `promptSource`.** All 114 human prompts on this machine carry
`promptSource: 'sdk'` (because Claude Code is driven through the Agent SDK here), and 3,017 lines
have it absent. It is an entrypoint marker, not a humanity marker.

`isMeta: true` appears on 9 lines — drop them.

#### `queue-operation` — the double-count trap

Operations measured: `enqueue` 239, `dequeue` 158, `remove` 81. Of the 231 enqueues that carry
`content`:

- **102 texts also appear as an `origin.kind==='human'` user line** → counting both double-counts.
- **123 texts never appear as a human user line** — and they are overwhelmingly injected
  `<task-notification>` blobs, not prompts.
- **7 human texts never appear in any enqueue** — so enqueues are not a superset either.

In the measured corpus the very first line of one session file is an `enqueue` carrying that
session's genuine opening prompt — which is exactly why it is tempting to trust the queue, and
exactly why you must dedupe.

**Rule:** take `origin.kind === 'human'` as the sole primary source. Optionally add an enqueue as a
*fallback* human turn only when **all** hold: it does not start with `<`, its exact trimmed text
does not match any human user line in the same session, and its `operation === 'enqueue'`.
The 81 `remove` operations are prompts the user typed and then deleted — a lovely detector
("things you almost said"), but they must never enter `humanTurns`.

### 3.4 Assistant lines

`message.model` census: `claude-fable-5` 3,155 · `claude-opus-5` 1,367 · `claude-opus-4-8` 899 ·
**`<synthetic>` 15**. `<synthetic>` is a placeholder on error/synthetic messages — **exclude it**
from model stats and from token sums. 12 lines carry `isApiErrorMessage: true`.

Top-level `effort`: absent 3,145 · `xhigh` 1,393 · `high` 898.

Content blocks: `tool_use` 2,988 · `thinking` 1,700 · `text` 748. `thinkingChars` should sum
`block.thinking` string lengths over `thinking` blocks.

### 3.5 Attachments

`attachment.type` census (629): `task_reminder` 322, `edited_text_file` 73,
`deferred_tools_delta` 55, `hook_additional_context` 49, `queued_command` 28, `skill_listing` 25,
`mcp_instructions_delta` 24, `agent_listing_delta` 22, `date_change` 7, `plan_mode` 7,
`ultra_effort_enter` 6, `plan_mode_exit` 5, `workflow_keyword_request` 3, `command_permissions` 2,
`read_truncation_notice` 1.

All of these are harness plumbing, **none is human-authored**. Skip the whole type. (`date_change`
is mildly interesting as a "you worked past midnight" signal — optional, low priority.)

---

## 4. Codex format

Every line is `{timestamp, type, payload}`. `timestamp` is ISO-8601 UTC with `Z`, ms precision, and
is present on **every** line type observed.

### 4.1 Line type inventory

Measured over a 29-session sample spanning 2026-02-06 → 2026-08-01 (330 MB, 27,913 lines), chosen
as up to 6 files per active month:

| `type` / `payload.type` | Count | Signal |
|---|---:|---|
| `event_msg`/`token_count` | 5,999 | ✅ tokens (§4.6) |
| `response_item`/`reasoning` | 3,488 | ⛔ **skip** — carries huge `encrypted_content` |
| `response_item`/`function_call` | 3,422 | ✅ tools |
| `response_item`/`function_call_output` | 3,422 | ⛔ bulk output |
| `response_item`/`message` | 2,205 | ⚠️ **trap** (§4.4) |
| `event_msg`/`agent_reasoning` | 1,849 | ✅✅ **card copy gold** (§4.5) |
| `event_msg`/`agent_message` | 1,760 | ✅ agent turns |
| `turn_context` | 1,617 | ✅ per-turn model, cwd, timezone |
| `event_msg`/`mcp_tool_call_end` | 927 | ✅ MCP tools |
| `response_item`/`custom_tool_call` | 899 | ✅ tools |
| `response_item`/`custom_tool_call_output` | 899 | ⛔ bulk output |
| `event_msg`/`user_message` | 241 | ✅✅ **the only human source** |
| `response_item`/`web_search_call` | 217 | ✅ optional |
| `event_msg`/`task_started` | 216 | ✅ turn timing (§4.5) |
| `event_msg`/`task_complete` | 207 | ✅ `last_agent_message` |
| `session_meta` | 98 | ✅ identity — **repeats!** (§4.2) |
| `event_msg`/`patch_apply_end` | 83 | ✅ files touched (§4.8) |
| `event_msg`/`exec_command_end` | 70 | ✅ `parsed_cmd` (§4.8) |
| `response_item`/`tool_search_call` | 46 | ⛔ |
| `response_item`/`tool_search_output` | 46 | ⛔ |
| `world_state` | 45 | ⛔ very large, skip |
| `event_msg`/`web_search_end` | 43 | ✅ `.query` |
| `event_msg`/`thread_settings_applied` | 43 | ✅ model, reasoning_effort |
| `compacted` | 23 | ✅ memory wipe |
| `event_msg`/`context_compacted` | 23 | ✅ memory wipe (payload is `{type}` only) |
| `event_msg`/`item_completed` | 9 | ⚪ `item.{type,text}`, e.g. `Plan` |
| `event_msg`/`turn_aborted` | 9 | ✅✅ interruptions (§4.9) |
| `event_msg`/`sub_agent_activity` | 2 | ✅ `occurred_at_ms` |
| `inter_agent_communication_metadata` | 2 | ⛔ |
| `response_item`/`agent_message` | 2 | ⛔ dup of event_msg |
| `event_msg`/`thread_goal_updated` | 1 | ⛔ |

Types in the brief that **do not exist** under those names: there is no `event_msg`/`compacted`
(it is a **top-level** `compacted` type), and no `response_item`/`local_shell_call` in this corpus.

`compacted` and `context_compacted` co-occur 23/23 — count **one** of them, not both, or you double
every memory wipe.

### 4.2 Session identity and dedup **(critical)**

`session_meta` payload keys, by frequency over 98 occurrences:
`id`, `timestamp`, `cwd`, `originator`, `cli_version`, `source`, `model_provider`,
`base_instructions` (98 each); `git` 97; `thread_source` 83; `session_id` 82; `dynamic_tools` 80;
`memory_mode` 69; `history_mode` 42; `context_window` 10; `parent_thread_id`, `agent_nickname`,
`multi_agent_version` 3 each.

**Finding 1 — `session_meta` repeats inside a single file.** One 4,894-line file contains **25**
`session_meta` lines, all with byte-identical `id`, `session_id` and `timestamp`, at lines
1, 137, 248, 328, 437, 623, … They are re-emitted on context reload, not new sessions.
→ **Take the first `session_meta`; ignore every subsequent one.** Treating each as a session
inflates the session count ~4.5×.

**Finding 2 — 105 of 217 files are subagent threads, not human sessions.**

| `thread_source` | Files | Human session? |
|---|---:|---|
| `subagent` | **105** | ❌ no |
| `user` | 78 | ✅ yes |
| *(absent — legacy, Feb–Mar builds)* | 25 | ✅ yes |
| `automation` | 8 | ❌ no (cron/automation runs) |
| `realtime_voice` | 1 | ✅ yes (a human speaking) |

**Rule:** a file is a human session iff `thread_source ∈ {undefined, 'user', 'realtime_voice'}`.
That gives **104 human sessions** out of 217 files.

**Finding 3 — `forked_from_id` never means "a duplicate session".** It is set on **73 files, all 73
of which are `thread_source: 'subagent'`.** It records that the subagent's context was seeded by
forking the parent (`spawn_agent({fork_context: true})`). Verified example:

```
id                = 019f7e3b-e7a8-7c10-9f9b-6634d3dd20b6
session_id        = 019f7e24-dcd6-70e0-8679-a27866bf1c58   ← ROOT thread
forked_from_id    = 019f7e24-dcd6-70e0-8679-a27866bf1c58
parent_thread_id  = 019f7e24-dcd6-70e0-8679-a27866bf1c58
thread_source     = "subagent"
agent_nickname    = "Plato"
```

Dropping files *because* `forked_from_id` is set (as the brief instructs) is harmless only because
those files are already excluded as subagents. **Do not implement fork-dedup — implement
`thread_source` filtering.** Nicknames observed: Plato, Hooke, Franklin, Cicero — charming material
for a "your agent spawned a Greek philosopher" card, but they are *not* the human.

**Finding 4 — `payload.source` is polymorphic.** Measured: string `"vscode"` ×113, object
`{subagent: {thread_spawn: {parent_thread_id, depth, agent_path, agent_nickname, agent_role}}}` ×104.
`typeof source === 'string' ? source : 'subagent'`. A naive `String(source)` yields `[object Object]`.

**Finding 5 — `session_id` is the ROOT thread, `id` is this file's thread.** For human sessions
`id === session_id` (76/78 `user` files). Use `payload.id` as `Session.id`; use `payload.session_id`
to group a root with its subagent threads if you ever want subagent attribution.

Other measured metadata: `originator` = `Codex Desktop` 184 · `codex_vscode` 16 ·
`codex_work_desktop` 11 · `codex-chrome-extension-sidepanel` 6. `cwd` top values:
one dominant project dir 137 · its parent 65. 24 distinct `cli_version`
values from `0.104.0-alpha.1` to `0.147.0-alpha.1.2`.

### 4.3 Human-turn detection — Codex **(critical)**

**Rule:** human turns are `event_msg` / `user_message` → `payload.message` (a plain string),
**and only in files that passed the `thread_source` gate of §4.2.**

**Never use `response_item`/`message` with `role: 'user'`.** Measured over the 29-file sample:
241 `user_message` vs 328 `role:user` — **88 of the 328 (27 %) are injected context.** Their exact
opening signatures:

| Count | First 80 chars of the false positive |
|---:|---|
| 10 | `# AGENTS.md instructions for ~/work/Projects/orchard…` |
| 9 | `# AGENTS.md instructions for ~/work\n\n<INSTRUCTIONS>\n# Agen…` |
| 9 | `<turn_aborted>\nThe user interrupted the previous turn on purpose…` |
| 8 | `<recommended_plugins>\nHere is a list of plugins that are availab…` |
| 7 | `# AGENTS.md instructions for ~/work\n\n<INSTRUCTIONS>\n## Ski…` |
| 6 | `<environment_context>\n  <cwd>~/work</cwd>\n  <shell>zsh</sh…` |
| 45 | further `<environment_context>` variants, one per active date |

Note the fourth row: `<turn_aborted>The user interrupted the previous turn on purpose…` is *itself*
injected as a user message. Counting it would turn every interruption into a fake human prompt —
double-corrupting both `humanTurns` and `interrupts`.

**Coverage check:** I compared, per file, every `role:user` text against the `user_message` set and
counted texts that neither matched nor began with `#`/`<`. Result across all 29 files spanning
Feb→Aug: **0**. `event_msg/user_message` is complete — there is no prompt it misses, in any CLI
version from `0.104` to `0.147`. So the aggressive prefix-filter the brief proposes is unnecessary:
just ignore `response_item/message` entirely for human turns.

**Subagent and automation `user_message` are machine-authored.** Each subagent file contains
exactly one, and it is the orchestrator's task brief. Verified samples:

```
subagent (nickname "Hooke"):
  "You are an independent IBCS dashboard critic in a Gauntlet Loop. Do not edit files. …"

automation:
  "Automation: Daily digest post\nAutomation ID: daily-digest-post\n…"
```

This is precisely why the §4.2 gate must be applied *before* harvesting prompts.

**Measured impact of getting this right:**

| Metric | All 217 files (what the brief reports) | Human sessions only (correct) |
|---|---:|---:|
| Human prompts | 1,640 | **997** |
| `turn_aborted` | 122 | **63** |
| Σ `total_tokens` | 6,810,335,756 | **3,954,771,323** |
| `exec` calls | 22,037 | 19,095 |

Real human prompts are short, imperative, and frequently non-English. Shape-equivalent examples
(synthesised — the measured corpus is private):
`switch the branch to master` · `можешь посмотреть файлы?` · `show me` ·
`build it and check the game runs` · `can you work autonomously for a few hours?`

> ⚠️ **Privacy finding.** One genuine human prompt in the Feb corpus is a pasted live OpenAI API key
> (`sk-proj-…`, 164 chars). It is a *real credential in real prompt text*, and any "your first words"
> or "longest prompt" detector can surface it. `makeRedactor('safe')` stripping `sk-*` is therefore
> **not optional** — it must run before any quote reaches the payload, and the `safe` level must be
> the default. This document deliberately does not reproduce the key.

### 4.4 Reasoning headlines — the card-copy source

`event_msg`/`agent_reasoning` → `payload.text`. Measured on one 2,530-line session: **173 of 173
(100 %)** begin with a `**bold headline**`. Extract with `/^\*\*(.+?)\*\*/`.

Real examples: *Combining invoices for Olga* · *Planning safe process termination* ·
*Deciding on combined June invoice number* · *Finalizing combined invoice details for June*.

Use `event_msg/agent_reasoning`, **not** `response_item/reasoning`. The latter carries the same
headline under `summary[0].text` but also an `encrypted_content` blob of several KB per record —
3,488 of them in the sample. Skipping it is a large share of the I/O win.

### 4.5 Timestamps and units **(mixed units — read carefully)**

| Field | Type | Unit | Verified how |
|---|---|---|---|
| line `timestamp` (both agents) | string | ISO-8601 UTC, ms | present on every Codex line |
| `session_meta.timestamp` | string | ISO-8601 UTC | — |
| `task_started.started_at` | number | **epoch SECONDS** | `1783258254` on a line stamped `2026-07-05T13:30:54.163Z` — exact match |
| `sub_agent_activity.occurred_at_ms` | number | **epoch MILLISECONDS** | `1785596742615` |
| `exec_command_end.duration` | object | `{secs, nanos}` | `{'secs': 0, 'nanos': 9833}` |
| `mcp_tool_call_end.duration` | object | `{secs, nanos}` | `{'secs': 1, 'nanos': 490717834}` |
| `rate_limits.*.resets_at` | number | epoch seconds | `1783247086` |
| `turn_aborted` | — | **has no time field at all** | §4.9 |

Convert `{secs, nanos}` as `secs * 1000 + nanos / 1e6`. The brief's claim that
`turn_aborted.started_at` is epoch seconds is moot — the field does not exist (§4.9).

`turn_context` confirms the user's zone directly: `{"current_date":"2026-08-03","timezone":"Asia/Almaty"}`.
Prefer this over the system zone when bucketing days, falling back to the host zone.

### 4.6 Tokens **(exact algorithm)**

`event_msg`/`token_count` → `payload.info` has `last_token_usage` and `total_token_usage`, both with
identical key sets. Measured over 6,769 `token_count` lines in 40 random files:

| Key | Present | Notes |
|---|---:|---|
| `input_tokens` | 6,769 | **includes** `cached_input_tokens` |
| `cached_input_tokens` | 6,769 | subset of `input_tokens` |
| `output_tokens` | 6,769 | **includes** `reasoning_output_tokens` |
| `reasoning_output_tokens` | 6,769 | 0 violations of `reasoning ≤ output` |
| `total_tokens` | 6,769 | `= input + output` |
| `cache_write_input_tokens` | 2,171 | **always 0 on this machine** — key exists, never populated |

`total_token_usage` is a running cumulative total; `last_token_usage` is the per-turn delta.
Verified on consecutive records: turn 1 `input=19331`, turn 2 `last.input=27021`,
turn 2 `total.input=46352` = 19331 + 27021. ✅

**Algorithm — sum the deltas, never the totals:**

```
for each token_count line, in file order:
    u = payload.info.last_token_usage
    if !u: continue
    tokens.in        += u.input_tokens        - u.cached_input_tokens   // fresh prompt tokens
    tokens.cacheRead += u.cached_input_tokens
    tokens.cacheWrite+= u.cache_write_input_tokens ?? 0
    tokens.out       += u.output_tokens
    tokens.reasoning += u.reasoning_output_tokens
```

Summing `total_token_usage` instead multiplies the result by roughly the number of turns.

**Edge case — 43 of 6,769 lines (0.6 %) have `input=output=reasoning=0` but `total_tokens > 0`**
(e.g. `{input:0, cached:0, output:0, reasoning:0, total:21778}`). These break the
`input + output == total` invariant. Do not assert on it; just accumulate the individual fields and
let those lines contribute nothing.

**Claude tokens** live on `assistant.message.usage`. Keys present on all 5,436 lines:
`input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`,
`service_tier`, `cache_creation`, `inference_geo`; plus `server_tool_use`, `iterations`, `speed`
on 5,430. Unlike Codex, **`input_tokens` here EXCLUDES cache** — the three are disjoint, so
`in`/`cacheRead`/`cacheWrite` map directly with no subtraction. Skip lines where
`message.model === '<synthetic>'`.

Measured Claude totals: input 692,017 · output 6,580,993 · cache_creation 81,567,770 ·
cache_read 1,214,450,275 — **93.7 % of all input tokens were cache reads.** Codex human sessions:
cached 3,753,342,848 of 3,934,620,670 input = **95.4 %**. That contrast is a great "your agent
mostly re-read its own memory" card, and it only works if the disjoint/subset distinction above is
respected.

### 4.7 Tool vocabulary

Codex tool names come from three places, all of which must be merged:

1. `response_item`/`function_call` → `payload.name`, args in `payload.arguments` (**a JSON string**)
2. `response_item`/`custom_tool_call` → `payload.name`, args in `payload.input` (**a raw string, not JSON**)
3. `event_msg`/`mcp_tool_call_end` → `payload.invocation.{server, tool}`

Full-corpus counts, human sessions only: `exec` 19,095 · `exec_command` 5,572 · `js` 1,226 ·
`write_stdin` 846 · `wait` 648 · `apply_patch` 605 · `wait_agent` 271 · `view_image` 142 ·
`update_plan` 95 · `spawn_agent` 93 · `send_message` 71 · `followup_task` 71.

> ⚠️ **`exec` does NOT run shell commands.** I classified 2,076 `exec` inputs: **2,071 are
> JavaScript**, 5 are JavaScript with an `// @exec: {...}` header comment. **Zero are shell.**
> Real example input:
> `const r = await tools.exec_command({ cmd: "rg -n \"webhook|bot|chat_id\" …" });`
> `exec` is the Node sandbox; it *calls* `exec_command` from inside JS. The shell tool is
> **`exec_command`** (`{cmd, workdir, yield_time_ms, max_output_tokens}`).
> Labelling `exec` as "ran a shell command" — as the brief does — mislabels the single most
> frequent tool in the corpus.

`js` is likewise an MCP tool: `mcp_tool_call_end.invocation = {server: 'node_repl', tool: 'js'}`.

Claude tool names come from `assistant.message.content[].tool_use.name`. Counts: Bash 977 ·
Edit 578 · Read 371 · `mcp__Claude_Browser__computer` 176 · `mcp__Claude_Browser__javascript_tool`
151 · Write 95 · `mcp__Claude_Preview__preview_eval` 94 · TaskUpdate 63 ·
`mcp__Claude_Browser__navigate` 60 · TaskCreate 45 · WebFetch 39 · ToolSearch 31 · WebSearch 27.

#### Recommended label map

Parse MCP names first: `/^mcp__(.+?)__(.+)$/` → `"<Server>: <tool>"` with `_`→` `. For Codex,
`invocation.server` + `invocation.tool` gives the same shape without parsing.

| Raw name | Label |
|---|---|
| `exec_command`, `Bash` | ran a shell command |
| `exec`, `js` | ran a script |
| `apply_patch`, `Edit`, `MultiEdit` | edited a file |
| `Write` | wrote a new file |
| `Read`, `view_image` | read a file |
| `write_stdin` | talked to a running process |
| `wait`, `wait_agent` | waited |
| `spawn_agent`, `Agent`, `Task` | delegated to a subagent |
| `update_plan`, `TaskCreate`, `TaskUpdate` | reorganised the plan |
| `WebSearch`, `web_search_call` | searched the web |
| `WebFetch` | fetched a page |
| `mcp__X__y` / `{server,tool}` | `X: y` |

Roll the ~40 long-tail names (`_search_emails`, `imagegen`, `press_key`, `set_value`, …) into
"used a tool" rather than special-casing; they are <1 % of calls each.

### 4.8 Files touched

**Codex, authoritative:** `event_msg`/`patch_apply_end`. Payload keys:
`call_id, changes, status, stderr, stdout, success, turn_id, type`. `changes` is an object whose
**keys are absolute paths** and whose values are
`{type: 'update'|'add'|'delete', unified_diff, move_path}`. The `type` field is a free
created/modified/deleted classification the brief does not mention. Gate on `success === true`.

Full corpus, human sessions: **595 distinct files patched**.

**Codex, bonus:** `event_msg`/`exec_command_end` carries a pre-parsed
`parsed_cmd: [{type: 'read', cmd, name, path}]` — file access without writing a shell parser.
Only 70 occurrences in the sample, so treat as enrichment, not a primary source.

**Claude:** `assistant.message.content[].tool_use.input.file_path`. Measured carriers:
Edit 578, Read 371, Write 95, Artifact 5 — **1,049 of 2,988 tool_use blocks**, 253 distinct paths.
`Bash` has `command`/`description` and no path. `NotebookEdit` uses `notebook_path` **[UNVERIFIED —
no NotebookEdit calls in this corpus]**.

> **Absolute-path leakage.** Every path is absolute and contains the username — spelled out here
> once, deliberately, as `/Users/<username>/…` because this is the exact string the redactor must
> catch. `changes` keys, `parsed_cmd.path`, `file_path`, `session_meta.cwd`,
> `turn_context.workspace_roots` and `view_image.path` (which leaks
> `/var/folders/q_/m8hg…/T/codex-clipboard-<uuid>.png`) all carry it. The redactor must run over
> **paths as well as prose**, and `filesTouched` should be stored basename-first with the directory
> collapsed to `~/…` at `safe` level and dropped entirely at `paranoid`.

### 4.9 Interruptions

**Verified against all 122 `turn_aborted` records in the entire corpus** (not a sample):

```json
{"timestamp":"2026-03-03T04:32:30.168Z","type":"event_msg",
 "payload":{"type":"turn_aborted","turn_id":"019cb1f7-…","reason":"interrupted"}}
```

- Payload keys are **exactly** `{type, turn_id, reason}` — 122/122.
- `reason` is `"interrupted"` — 122/122. No other value exists.
- **There is no `started_at`, no `completed_at`, and no `duration_ms`.** The brief is wrong.

To populate `interrupts: [{ts, durationMs}]`:

```
ts         = Date.parse(line.timestamp)
durationMs = ts - (task_started[payload.turn_id]?.started_at * 1000)   // seconds → ms
```

Build the `turn_id → started_at` map from `event_msg`/`task_started` in the same pass; emit
`durationMs: null` when the turn start is missing (possible after a compaction). Human-session
total is **63**, not 122 (§4.3).

---

## 5. Session timing and the "time spent" rule **(highest-impact decision)**

`startedAt` = min timestamp over timestamped lines; `endedAt` = max. But **`endedAt - startedAt` is
a catastrophic overestimate** — sessions stay open for weeks.

Measured naive span totals: Claude **932.0 h**, Codex sample **1,780.5 h** → **2,712 h ≈ 113 days**
of "time with your agent" inside a 6-month window. One Codex session alone spans **748.6 h (31 days)**;
one Claude session spans 333.0 h.

Inter-event gap distribution:

| Percentile | Claude (9,637 gaps) | Codex (27,884 gaps) |
|---|---:|---:|
| p50 | 1.7 s | 0.0 s |
| p75 | 6.8 s | 1.7 s |
| p90 | 18.3 s | 5.4 s |
| p95 | 42.4 s | 9.9 s |
| p99 | 762.1 s | 35.7 s |
| p99.9 | 68,872 s | 44,542 s |
| max | 313.5 h | 316.9 h |

The distribution is **sharply bimodal** — work happens in seconds, absence happens in days, and
almost nothing lives in between. Claude gap buckets: `<10 s` 7,932 · `10–60 s` 1,323 · `1–5 m` 234 ·
`5–15 m` 52 · `15–30 m` 21 · `30–60 m` 16 · `>1 h` 59.

Total active hours by idle cutoff:

| Cutoff | Claude | Codex | Combined |
|---|---:|---:|---:|
| 60 s | 12.1 h | 14.9 h | 27.0 h |
| 120 s | 14.7 h | 16.2 h | 30.9 h |
| 300 s | 18.8 h | 18.4 h | 37.2 h |
| **600 s** | **22.0 h** | **20.4 h** | **42.4 h** |
| 900 s | 24.3 h | 21.5 h | 45.8 h |
| 1800 s | 30.1 h | 24.0 h | 54.1 h |
| 3600 s | 39.9 h | 29.2 h | 69.1 h |

**Recommendation: `IDLE_GAP_MS = 600_000` (10 minutes).**

```
durationMs = Σ min(t[i+1] - t[i], IDLE_GAP_MS)   over timestamps sorted ascending
```

Justification: 10 min sits above Codex p99 (35.7 s) and near Claude p99 (12.7 min), so it keeps
essentially all genuine agent-turn latency — long builds, long model turns — while discarding the
"laptop closed for three days" tail. It yields **42.4 h across 57 active days ≈ 45 min/day**, which
is defensible in a way that 113 days is not. Because the distribution is bimodal, anything in
300–1800 s changes the headline by only ±30 % while the naive span is off by **64×** — so the exact
value matters far less than capping at all. Expose `--idle-gap` and **state the rule in the UI**;
a viral stat that inflates the user's life by two orders of magnitude is the fastest way to lose
trust.

`durationMs` must be computed per session and summed; never derive it from `endedAt - startedAt`.

---

## 6. Edge cases (measured, not hypothesised)

| Case | Reality on this machine | Required handling |
|---|---|---|
| Malformed JSON line | **0 of 248,842 lines** | still `try/catch` per line and count skips — a session being written *right now* can end mid-line |
| Empty file | 0 | `size === 0` → return `[]`, do not throw |
| Truncated final line | 0 (all files end with `\n`) | last chunk without `\n` → attempt parse, drop silently on failure |
| Huge single line | Codex max **2.9 MB**, Claude max **1.2 MB** | safe to parse; cap at e.g. 16 MB and skip beyond, counting the skip |
| Non-UTF-8 | **0 true errors** (verified with an incremental decoder) | use `readline` with `encoding: 'utf8'`; a naive fixed-size chunk decoder **will** report false errors by splitting multibyte chars — I hit exactly this and had to re-verify |
| Cyrillic | pervasive; prompts are mixed RU/EN | never `Buffer.byteLength` for word counts. `'сделай улучшенную копию, только намного лучше'` = 44 chars, **79 bytes**, 6 words. Use `str.match(/[^\W_]+/gu)` with the `u` flag |
| Out-of-order timestamps | **159 in Claude, 0 in Codex** | dominated by `queue-operation → system` (94×), max backwards jump **68,869 s (19.1 h)**. **Sort timestamps ascending before gap math and clamp negative deltas to 0.** |
| Session with zero human turns | common — all 105 subagent files, plus short Codex sessions | keep the `Session` (it holds real tool/token activity) but never let it produce a quote memory; guard every `humanTurns[0]` access |
| Clock skew | not observed beyond the above | tolerate; clamp |
| Session still being written | yes — the largest file grew 646,412,596 → 648,184,439 B **during this investigation** | never assume size stability within a run |
| `payload.source` polymorphic | string ×113, object ×104 | §4.2 Finding 4 |
| Title records without timestamps | 2,385 Claude lines | §3.1 |

---

## 7. Performance and caching

Budget: 4.4 GB, 248,842 lines, 239 session files. A full parse of everything took 9.9 s warm.

**Streaming is mandatory** — a 618 MB `readFileSync` would blow the default heap. Use
`readline.createInterface({ input: createReadStream(path, {encoding:'utf8'}), crlfDelay: Infinity })`.

**Cheap wins, in order:**

1. **Byte-prefilter before `JSON.parse`.** Most bulk lines are `function_call_output`,
   `custom_tool_call_output`, `world_state` and `response_item/reasoning` — together ~7,800 of
   27,913 sample lines but the overwhelming majority of the bytes. A `line.length > 65536 &&
   !line.startsWith('{"timestamp"')`-style guard is not reliable; instead parse, then bail on
   `type` before touching `payload`. Better: `indexOf('"encrypted_content"')` and
   `indexOf('"world_state"')` early-outs skip the two worst offenders without parsing.
2. **Never retain** `unified_diff`, `aggregated_output`, `result`, `encrypted_content`,
   `base_instructions`. Copy out the scalar you need and drop the parsed object.
3. `base_instructions` alone is several KB on every one of the 98+ `session_meta` records.

**Cache key.** Files are append-only in practice, but `mtime` is **not** a proxy for content time:
20 of 22 Claude files have `mtime` more than 2 h past their last timestamped line, because
`ai-title` / `custom-title` / `last-prompt` records are appended afterwards with no timestamp.

```
key   = `${path}:${size}:${mtimeMs}`
value = { schema: 1, session: <Session>, bytesRead: size }
```

Invalidate on any change to `size` or `mtimeMs`, and include a `schema` integer bumped whenever the
extraction logic changes. **Incremental resume is viable but must be guarded:** only resume from
`bytesRead` when the new `size >= cachedSize` *and* a hash of the first 4 KB is unchanged;
otherwise re-scan the file whole. Rotation or compaction would otherwise silently corrupt the cache.

Store the cache at `~/.cache/codepend/scan-v1.json` (respect `XDG_CACHE_HOME`), never inside the
output HTML.

---

## 8. Recommended scan order

1. Enumerate files (§2). Depth-2 glob for Claude; both roots for Codex.
2. Cheap pre-filter on filename date for `--since`, widened ±24 h.
3. For each file, stream lines; `try/catch` each.
4. Codex: read the **first** `session_meta`, apply the `thread_source` gate (§4.2), and **skip the
   rest of the file entirely** if it is a subagent/automation thread — this drops 113 of 217 files,
   including several of the largest, before any real work.
5. Accumulate per §3–§4. Sort timestamps at the end; compute `durationMs` per §5.
6. Emit `Session[]`.

Step 4 is where most of the 4.3 GB goes away.

---

## 9. Ground-truth numbers for detector calibration

Human sessions only, full corpus, Asia/Almaty day bucketing:

| | Claude | Codex |
|---|---:|---:|
| Sessions | 22 | 104 |
| Human prompts | 114 | 997 |
| Active days | 21 | 57 |
| First / last line | 2026-06-15 → 2026-08-05 | 2026-02-06 → 2026-08-05 |
| Distinct files touched | 253 | 595 |
| Interruptions | n/a | 63 |
| Σ output tokens | 6,580,993 | 11,917,770 |
| Σ cache-read tokens | 1,214,450,275 | 3,753,342,848 |
| Cache share of input | 93.7 % | 95.4 % |

---

## 10. Open questions / **[UNVERIFIED]**

- `NotebookEdit.input.notebook_path` — no such call exists in this corpus.
- `cache_write_input_tokens` is present on 2,171 Codex records but **0 in every one**. Whether it is
  ever non-zero on other machines is unknown; treat as `?? 0`.
- Claude `promptSource` values other than `'sdk'`. This machine drives Claude Code through the Agent
  SDK, so a plain-terminal user may show different values. **Do not build logic on it.**
- Codex model attribution is genuinely ambiguous. `turn_context.model` over 40 random files gives
  `gpt-5.3-codex` 980 · `gpt-5.6-sol` 115 · `gpt-5.5` 75 · `gpt-5.4` 14 · `gpt-5.6-terra` 8, while
  `thread_settings_applied` over the same files gives `gpt-5.6-sol` 77 · `gpt-5.5` 10 ·
  `gpt-5.6-terra` 1 — and `gpt-5.3-codex` never appears there at all. `turn_context` is emitted per
  turn, so it over-weights long sessions. **Recommendation:** count models **per session**
  (one vote per session, from the last `turn_context.model`, falling back to
  `thread_settings_applied`), and say "sessions", not "messages", in the UI. The brief's per-message
  figures are not reproducible from either source alone.
- `memory_mode`, `history_mode`, `dynamic_tools`, `context_window` in `session_meta` — present but
  not investigated.
- Whether Claude Code ever writes a second `sessionId` into an existing file after a `--resume`
  across a version upgrade. Not observed (0/22), but the corpus spans only 6 CLI minor versions.

---

## 11. Corrections to the module contract in the project brief

These are places the brief is **wrong** and `src/scan.js` must not follow it:

1. **`turn_aborted` has no `started_at` / `completed_at` / `duration_ms`.** Payload is exactly
   `{type, turn_id, reason}`, verified on all 122 records. Join to `task_started` for duration (§4.9).
2. **`exec` is not a shell tool.** 2,071 / 2,076 inputs are JavaScript. `exec_command` is the shell
   tool. The proposed label `"exec" → "ran a shell command"` mislabels the corpus's most frequent
   tool (§4.7).
3. **`forked_from_id` does not mark duplicate sessions.** All 73 occurrences are on subagent
   threads. The real dedup axis is `thread_source`, which the brief never mentions and which
   excludes **105 of 217 files** (§4.2).
4. **`session_meta` is not once per file.** Up to 25 identical copies per file; take the first (§4.2).
5. **The brief's Codex statistics count subagent and automation threads as the user's own.**
   Human prompts are **997**, not 1,633/1,640; interruptions **63**, not 122; tokens **3.95 B**, not
   6.81 B (§4.3).
6. **Codex `input_tokens` includes `cached_input_tokens`; Claude's does not include its cache
   fields.** Applying one convention to both misstates cache stats by ~95 % (§4.6).
7. **`payload.source` is not always a string** — 104 of 217 are objects (§4.2).
8. **`event_msg/compacted` does not exist**; `compacted` is a top-level type that co-occurs 23/23
   with `event_msg/context_compacted`. Counting both doubles every memory wipe (§4.1).
9. **`response_item/message` role:user needs no prefix heuristic** — it should be ignored entirely
   for human turns, because `event_msg/user_message` has 0 misses across Feb→Aug (§4.3).
10. **Claude `queue-operation` overlaps `origin.kind==='human'` on 102 texts** — using both without
    dedup double-counts (§3.3).
11. **`endedAt - startedAt` is not a duration.** It overstates time spent by **64×** (2,712 h vs
    42.4 h). The `Session.durationMs` field must be the idle-capped sum (§5).
12. **Claude's first session is 2026-06-15**, not 2026-07-06 as stated in the brief; Claude active
    days are **21**, and the 57 active days figure comes from Codex.
