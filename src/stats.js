/**
 * Precomputed aggregates for the detectors.
 *
 * The corpus is large (gigabytes of JSONL reduced to Session objects). Walking
 * it once here, instead of once per detector, is the difference between a
 * snappy `npx codepend` and a coffee break. Everything below is derived purely
 * from the Session[] contract — no I/O, no clock, no randomness.
 */

import {
  hash32, words, detectLang, makeTz, median, percentile, clamp01, flatten,
} from './detectors/_util.js';
import { mineNgrams, preamblePhrases, stripStructure } from './detectors/_ngram.js';
import {
  POLITE_EN, POLITE_EN_PHRASES, POLITE_RU_STEMS, RU_STEM_EXCLUDE,
  APOLOGY_EN, APOLOGY_EN_PHRASES, APOLOGY_RU_STEMS, APOLOGY_EXCLUDE,
} from './detectors/_stopwords.js';
import { estimateCost } from './detectors/_rates.js';

const DAY = 86400000;

/* --------------------------------------------------------------- tool names */

/**
 * The bucket a tool name lands in when nothing else claims it. Exported because
 * "Other" is a guard rail, not an answer — see `rankTools`.
 */
export const FALLBACK_TOOL = 'Other';

/**
 * Exact raw name -> identity. Keys are lowercase; lookup lowercases too, so
 * `Bash`, `bash` and `BASH` agree.
 *
 * This table is measured, not guessed. Every entry below appears in a real
 * corpus, and the ambiguous ones were resolved by reading the arguments and
 * results the agent actually recorded rather than by reading the name:
 *
 *  - Codex `wait` takes a `cell_id` and its output reads "Script running with
 *    cell ID 94" — it is `exec`'s companion, so it is Script, not Delegate.
 *    Codex `write_stdin` takes a `session_id`, which is what `exec_command`
 *    hands out, so that one is Shell.
 *  - Cursor `await` takes `{taskId, blockUntilMs, regex}` and the regexes in the
 *    corpus are things like `exit_code|Results saved` — it is polling a
 *    backgrounded terminal command. Shell.
 *  - Cursor `task_v2` returns an `agentId`. Delegate.
 *  - Codex `send_message`, `followup_task`, `list_agents`, `close_agent` and
 *    `interrupt_agent` all declare `"namespace":"collaboration"`, the same
 *    namespace as `spawn_agent`/`wait_agent`. Delegate.
 *  - Codex `click`, `type_text`, `press_key`, `set_value`, `get_app_state`,
 *    `list_apps` and `perform_secondary_action` all declare
 *    `"namespace":"mcp__computer_use"`. Browser, which is the identity that
 *    already means "it looked at a screen instead of taking your word for it".
 */
const TOOL_ALIASES = new Map(Object.entries({
  // ---- Shell ------------------------------------------------------------
  bash: 'Shell',
  bashoutput: 'Shell',
  shell: 'Shell',
  exec_command: 'Shell',
  run_command: 'Shell',
  run: 'Shell',
  killshell: 'Shell',
  kill_shell: 'Shell',
  write_stdin: 'Shell',
  monitor: 'Shell',
  // Cursor's terminal, all three generations of its name, plus the poller that
  // waits on a backgrounded one.
  run_terminal_cmd: 'Shell',
  run_terminal_command: 'Shell',
  run_terminal_command_v2: 'Shell',
  await: 'Shell',

  // ---- Script -----------------------------------------------------------
  exec: 'Script',
  js: 'Script',
  js_reset: 'Script',
  javascript_tool: 'Script',
  run_javascript: 'Script',
  wait: 'Script',

  // ---- Edit -------------------------------------------------------------
  edit: 'Edit',
  multiedit: 'Edit',
  apply_patch: 'Edit',
  str_replace: 'Edit',
  str_replace_editor: 'Edit',
  notebookedit: 'Edit',
  edit_file: 'Edit',
  edit_file_v2: 'Edit',
  search_replace: 'Edit',
  delete_file: 'Edit',

  // ---- Read -------------------------------------------------------------
  read: 'Read',
  view: 'Read',
  view_image: 'Read',
  read_file: 'Read',
  read_file_v2: 'Read',
  // Diagnostics for a set of paths: still "look before you touch".
  read_lints: 'Read',

  // ---- Write ------------------------------------------------------------
  write: 'Write',
  create: 'Write',
  create_file: 'Write',
  write_file: 'Write',

  // ---- Search -----------------------------------------------------------
  grep: 'Search',
  glob: 'Search',
  ls: 'Search',
  find: 'Search',
  websearch: 'Search',
  webfetch: 'Search',
  web_search: 'Search',
  web_search_call: 'Search',
  web_fetch: 'Search',
  ripgrep_raw_search: 'Search',
  glob_file_search: 'Search',
  file_search: 'Search',
  codebase_search: 'Search',
  semantic_search_full: 'Search',
  list_dir: 'Search',
  list_dir_v2: 'Search',
  toolsearch: 'Search',

  // ---- Delegate ---------------------------------------------------------
  task: 'Delegate',
  task_v2: 'Delegate',
  agent: 'Delegate',
  spawn_agent: 'Delegate',
  wait_agent: 'Delegate',
  list_agents: 'Delegate',
  close_agent: 'Delegate',
  interrupt_agent: 'Delegate',
  send_message: 'Delegate',
  followup_task: 'Delegate',

  // ---- Plan -------------------------------------------------------------
  todowrite: 'Plan',
  todo_write: 'Plan',
  update_plan: 'Plan',
  create_plan: 'Plan',
  exitplanmode: 'Plan',
  switch_mode: 'Plan',
  create_goal: 'Plan',
  update_goal: 'Plan',
  get_goal: 'Plan',
  taskcreate: 'Plan',
  taskupdate: 'Plan',
  tasklist: 'Plan',
  taskget: 'Plan',
  taskstop: 'Plan',

  // ---- Browser (Codex's computer-use namespace) --------------------------
  click: 'Browser',
  type_text: 'Browser',
  press_key: 'Browser',
  set_value: 'Browser',
  get_app_state: 'Browser',
  list_apps: 'Browser',
  perform_secondary_action: 'Browser',
  gettabcontext: 'Browser',

  // ---- MCP ---------------------------------------------------------------
  mcp: 'MCP',
  mcp_auth: 'MCP',
  get_mcp_tools: 'MCP',
  list_mcp_resources: 'MCP',
  fetch_mcp_resource: 'MCP',
}));

/**
 * Names that are about a screen, whatever server they came from.
 *
 * Substring, not anchored, because these arrive wrapped in whatever prefix the
 * host felt like: `mcp__playwright__browser_resize`, `mcp-cursor-ide-browser-browser_cdp`,
 * `mcp-Chrome DevTools MCP-user-Chrome DevTools MCP-take_snapshot`. Checked
 * before the MCP prefix rule so a browser tool that happens to be delivered over
 * MCP reads as Browser — which is what the card is actually about.
 */
const BROWSER_RE = new RegExp([
  'browser', 'screenshot', 'navigate', 'read_page', 'computer', 'form_input',
  'devtools', 'playwright', 'puppeteer', 'chrome', 'cdp',
  'take_snapshot', 'list_pages', 'new_page', 'select_page', 'resize_page',
  'page_content', 'open_url', 'reload_tab', 'list_tabs', 'switch_to_tab',
  'get_current_tab', 'evaluate_script', 'execute_javascript',
].join('|'), 'i');

/**
 * Every MCP naming convention seen in the wild, in one prefix rule.
 *
 * Claude Code writes `mcp__server__tool`. Cursor writes `mcp-<Server Name>-tool`
 * and `mcp_<Server_Name>_tool` — and, when the server name is duplicated by its
 * own config, `mcp-user-Chrome DevTools MCP-user-Chrome DevTools MCP-new_page`.
 * The old rule was `^mcp__` alone, so every Cursor MCP call in the corpus fell
 * through to Other.
 */
const MCP_PREFIX_RE = /^mcp[-_]/i;

/**
 * Codex writes a connector tool with its namespace stripped and a leading
 * underscore left behind: `_search_emails`, `_batch_read_email`,
 * `_get_file_metadata`. Every one of them in the corpus carries a
 * `"namespace":"mcp__codex_apps__…"`, so the underscore is an MCP call with its
 * address torn off.
 */
const STRIPPED_MCP_RE = /^_[a-z][a-z0-9_]*$/i;

/**
 * Collapse the ~350 raw tool names into the handful of identities the
 * spirit-tool card can have a personality about.
 *
 * Divergence from MEMORY-CATALOG, on purpose: the catalog folds Codex's `exec`
 * into Shell, but DATA-FORMATS §11.2 measured 2 071 / 2 076 `exec` inputs as
 * JavaScript. `exec_command` is the shell. Folding them would mislabel the most
 * frequent tool in the corpus, so `exec`/`js` get their own identity: Script.
 *
 * @param {string} raw
 * @returns {string} one of the keys of TOOL_PERSONALITY
 */
export function normalizeTool(raw) {
  const n = String(raw || '');
  if (!n) return FALLBACK_TOOL;
  const exact = TOOL_ALIASES.get(n.toLowerCase());
  if (exact) return exact;
  if (BROWSER_RE.test(n)) return 'Browser';
  if (/^sub_agent/i.test(n)) return 'Delegate';
  if (MCP_PREFIX_RE.test(n) || STRIPPED_MCP_RE.test(n)) return 'MCP';
  return FALLBACK_TOOL;
}

/**
 * The identity ranking with the fallback bucket taken out.
 *
 * "Your spirit tool is Other" is not a card. `Other` is where a name goes when
 * nothing recognised it, so it is a measure of this program's ignorance, not of
 * anybody's habits — and on a corpus with a long tail of one-off MCP servers it
 * can still add up to the largest bucket even after everything real is mapped.
 * Anything that names a tool should rank over this, never `ctx.toolList`.
 *
 * The unfiltered list is returned when `Other` is all there is, so a corpus of
 * nothing but unrecognised names still gets a card instead of nothing.
 *
 * @param {Array<{name:string, n:number}>} toolList
 * @returns {Array<{name:string, n:number}>}
 */
export function rankTools(toolList) {
  const list = Array.isArray(toolList) ? toolList : [];
  const named = list.filter((t) => t && t.name !== FALLBACK_TOOL);
  return named.length ? named : list.slice();
}

/** The read. Chosen by tool, never hashed — it has to be right. */
export const TOOL_PERSONALITY = {
  Shell: 'You don’t want it to explain. You want it to run the thing and tell you what happened.',
  Edit: 'You’d rather it change the code than talk about the code.',
  Read: 'You make it look before it touches anything. Every single time.',
  Write: 'You let it start from a blank file. That takes a kind of nerve.',
  Browser: 'You made it use its own eyes instead of taking your word for it.',
  Search: 'You outsourced your curiosity and you have no regrets.',
  Delegate: 'You don’t use it. You manage it.',
  Script: 'You had it write a program to find out about your program. A very specific kind of impatience.',
  Plan: 'You make it write the plan down first. Someone taught you that the hard way.',
  MCP: 'Most of your work happens through tools you wired up yourself.',
  Other: 'Your toolbox does not look like anybody else’s.',
};

/* ------------------------------------------------------------------ helpers */

function basename(p) {
  if (!p) return null;
  const parts = String(p).split(/[/\\]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

const num = (v) => (Number.isFinite(v) ? v : 0);

/* ------------------------------------------------------------- the big walk */

/**
 * Build the shared detector context.
 *
 * @param {Array<object>} rawSessions Session[] from src/scan.js
 * @param {{now:number, tz:string, redact:(s:string)=>string, redactLevel?:string}} opts
 * @returns {object} ctx
 */
/**
 * Every adapter that exists. This list is the reason it exists: the normalizer used to read
 * `agent === 'claude' ? 'claude' : 'codex'`, which silently relabelled every Cursor session as
 * Codex — correct in the CLI summary (it reads raw sessions) and wrong on every card, chart and
 * tag on the page. A new adapter has to be added here as well as in scan().
 */
export const AGENTS = ['claude', 'codex', 'cursor'];
const AGENT_SET = new Set(AGENTS);

/** Anything unrecognised stays 'unknown' rather than being attributed to a real agent. */
function normalizeAgent(a) {
  const v = typeof a === 'string' ? a.trim().toLowerCase() : '';
  return AGENT_SET.has(v) ? v : 'unknown';
}

function emptyAgentCounts() {
  const o = Object.create(null);
  for (const a of AGENTS) o[a] = 0;
  return o;
}

export function buildStats(rawSessions, opts) {
  const now = opts && Number.isFinite(opts.now) ? opts.now : 0;
  const idleGapMs = opts && Number.isFinite(opts.idleGapMs) ? opts.idleGapMs : 600_000;
  const tzh = makeTz((opts && opts.tz) || 'UTC');
  const redact = (opts && opts.redact) || ((s) => s);
  const redactLevel =
    (opts && opts.redactLevel) || (redact && redact.level) || 'safe';
  const paranoid = redactLevel === 'paranoid';

  // ---- normalize + sort ---------------------------------------------------
  const sessions = (rawSessions || [])
    .filter((s) => s && Number.isFinite(s.startedAt))
    .map((s, i) => ({
      id: s.id || `s${i}`,
      agent: normalizeAgent(s.agent),
      title: s.title || null,
      cwd: s.cwd || null,
      project: s.project || basename(s.cwd) || null,
      gitBranch: s.gitBranch || null,
      startedAt: s.startedAt,
      endedAt: Number.isFinite(s.endedAt) ? s.endedAt : s.startedAt,
      durationMs: Math.max(0, num(s.durationMs)),
      models: Array.isArray(s.models) ? s.models.filter(Boolean) : [],
      cliVersion: s.cliVersion || null,
      humanTurns: Array.isArray(s.humanTurns) ? s.humanTurns : [],
      agentTurns: Array.isArray(s.agentTurns) ? s.agentTurns : [],
      reasoning: Array.isArray(s.reasoning) ? s.reasoning : [],
      tools: s.tools && typeof s.tools === 'object' ? s.tools : {},
      filesTouched: Array.isArray(s.filesTouched) ? s.filesTouched : [],
      interrupts: Array.isArray(s.interrupts) ? s.interrupts : [],
      tokens: s.tokens || {},
      compactions: num(s.compactions),
      subagents: num(s.subagents),
      thinkingChars: num(s.thinkingChars),
      forkedFrom: s.forkedFrom || null,
      isSidechain: !!s.isSidechain,
      bursts: Array.isArray(s.bursts) ? s.bursts : [],
      fileCounts: s.fileCounts && typeof s.fileCounts === 'object' ? s.fileCounts : null,
    }))
    .sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1));

  const mainSessions = sessions.filter((s) => !s.isSidechain);

  // ---- turns --------------------------------------------------------------
  /** @type {Array<object>} */
  const humanTurns = [];
  /** @type {Array<object>} */
  const agentTurns = [];
  const seenHuman = new Set(); // guards fork double-counting: same text, ~same instant

  for (const s of sessions) {
    // models[0] is the authoritative one: normalize.js puts the session's primary
    // model first (Claude sorts by frequency, Codex pins the last turn_context).
    // Reading the tail picked the *least*-used model of every mixed session.
    const model = s.models.length ? s.models[0] : null;
    if (!s.isSidechain) {
      for (const t of s.humanTurns) {
        if (!t || !Number.isFinite(t.ts)) continue;
        const text = String(t.text || '');
        if (!text.trim()) continue;
        const dedupeKey = hash32(text) + ':' + Math.round(t.ts / 2000);
        if (seenHuman.has(dedupeKey)) continue;
        seenHuman.add(dedupeKey);
        const toks = words(text);
        const red = redact(text);
        humanTurns.push({
          ts: t.ts,
          text,
          redactedText: red,
          redacted: red !== text,
          sessionId: s.id,
          agent: s.agent,
          project: s.project,
          model,
          tokens: toks,
          wordCount: toks.length,
          lang: detectLang(text),
          question: /[?？]\s*$/.test(text.trim()),
          day: tzh.dayIndex(t.ts),
          hour: tzh.parts(t.ts).h,
          weekday: tzh.parts(t.ts).wd,
        });
      }
    }
    for (const t of s.agentTurns) {
      if (!t || !Number.isFinite(t.ts)) continue;
      const text = String(t.text || '');
      if (!text.trim()) continue;
      agentTurns.push({
        ts: t.ts,
        text,
        sessionId: s.id,
        agent: s.agent,
        project: s.project,
        model,
        sidechain: s.isSidechain,
      });
    }
  }
  humanTurns.sort((a, b) => a.ts - b.ts);
  agentTurns.sort((a, b) => a.ts - b.ts);

  // Per-session views, so detectors never re-walk the corpus.
  const turnsBySession = new Map();
  for (const t of humanTurns) {
    let arr = turnsBySession.get(t.sessionId);
    if (!arr) turnsBySession.set(t.sessionId, (arr = []));
    arr.push(t);
  }
  const sessionInfo = new Map();
  for (const s of sessions) {
    const turns = turnsBySession.get(s.id) || [];
    let toolCalls = 0;
    for (const v of Object.values(s.tools)) toolCalls += num(v);
    sessionInfo.set(s.id, {
      session: s,
      turns,
      humanCount: turns.length,
      firstHuman: turns[0] || null,
      lastHuman: turns[turns.length - 1] || null,
      toolCalls,
      interrupts: s.interrupts.length,
      agentCount: s.agentTurns.length,
    });
  }

  // ---- sittings -----------------------------------------------------------
  // A Session is a *thread*, not a sitting. Codex threads stay open for weeks:
  // 36 % of them here span a day or more, and the longest covers 31 days across
  // 14 separate days at the keyboard. Any card that says "one session", "without
  // closing the window" or "then you typed this and went to bed" is really about
  // a contiguous burst of activity, so that is the unit we compute here: split a
  // thread's event stream wherever nothing happened for longer than the idle gap.
  const sittings = [];
  for (const s of mainSessions) {
    // `bursts` come from the scanner, which is the only layer that sees every
    // event timestamp (tool calls and token records included, not just turns).
    // Fall back to the whole thread when an older cache entry predates them.
    const bursts = Array.isArray(s.bursts) && s.bursts.length
      ? s.bursts
      : [{ startedAt: s.startedAt, endedAt: s.endedAt, durationMs: s.durationMs }];
    for (const b of bursts) {
      if (!Number.isFinite(b.startedAt)) continue;
      sittings.push({
        sessionId: s.id, agent: s.agent, project: s.project, title: s.title,
        startedAt: b.startedAt,
        endedAt: Number.isFinite(b.endedAt) ? b.endedAt : b.startedAt,
        durationMs: Math.max(0, num(b.durationMs)),
        day: tzh.dayIndex(b.startedAt),
      });
    }
  }
  sittings.sort((a, b) => a.startedAt - b.startedAt);

  // Attach the turns/interrupts that fall inside each sitting, so a card about a
  // sitting quotes from that sitting and counts only its own interruptions.
  const inRange = (arr, lo, hi) => arr.filter((x) => x.ts >= lo && x.ts <= hi);
  for (const sit of sittings) {
    const own = turnsBySession.get(sit.sessionId) || [];
    sit.turns = inRange(own, sit.startedAt, sit.endedAt);
    sit.humanCount = sit.turns.length;
    const sess = sessionInfo.get(sit.sessionId)?.session;
    sit.interrupts = sess
      ? inRange(sess.interrupts.filter((i) => Number.isFinite(i.ts)), sit.startedAt, sit.endedAt).length
      : 0;
  }

  // ---- reasoning ("thinking") ---------------------------------------------
  const reasoning = [];
  for (const s of sessions) {
    for (const r of s.reasoning) {
      if (!r || !Number.isFinite(r.ts)) continue;
      const text = String(r.text || '');
      if (!text) continue;
      reasoning.push({ ts: r.ts, text, chars: text.length, sessionId: s.id, project: s.project, agent: s.agent });
    }
  }
  reasoning.sort((a, b) => a.ts - b.ts);

  // ---- sub-agent transcripts ---------------------------------------------
  let subagentWords = 0;
  let subagentSummaryWords = 0;
  for (const s of sessions) {
    if (!s.isSidechain) continue;
    const turns = s.agentTurns.filter((t) => t && t.text);
    for (const t of turns) subagentWords += countWordsFast(String(t.text));
    if (turns.length) subagentSummaryWords += countWordsFast(String(turns[turns.length - 1].text));
  }

  // ---- day buckets --------------------------------------------------------
  const days = new Map(); // dayIndex -> bucket
  const touchDay = (idx) => {
    let b = days.get(idx);
    if (!b) {
      b = {
        idx, sessions: 0, minutes: 0, humanTurns: 0, projects: new Set(),
        firstTs: Infinity, lastTs: -Infinity, agent: emptyAgentCounts(),
      };
      days.set(idx, b);
    }
    return b;
  };
  for (const s of mainSessions) {
    const b = touchDay(tzh.dayIndex(s.startedAt));
    b.sessions++;
    if (s.project) b.projects.add(s.project);
  }
  // Minutes are charged to the day they were actually spent. Charging a thread's
  // whole duration to its start day put 14 hours of work spread over three weeks
  // onto one Wednesday, which is how "peak day" ended up quoting the wrong month.
  for (const sit of sittings) {
    const b = touchDay(sit.day);
    b.minutes += sit.durationMs / 60000;
    if (sit.project) b.projects.add(sit.project);
  }
  for (const t of humanTurns) {
    const b = touchDay(t.day);
    b.humanTurns++;
    b.agent[t.agent] = (b.agent[t.agent] || 0) + 1;
    if (t.ts < b.firstTs) b.firstTs = t.ts;
    if (t.ts > b.lastTs) b.lastTs = t.ts;
    if (t.project) b.projects.add(t.project);
  }
  const dayIdxs = [...days.keys()].sort((a, b) => a - b);
  const activeIdxs = dayIdxs.filter((i) => days.get(i).humanTurns > 0 || days.get(i).sessions > 0);

  const timeline = activeIdxs.map((i) => {
    const b = days.get(i);
    return {
      date: tzh.keyFromIndex(i),
      sessions: b.sessions,
      minutes: Math.round(b.minutes),
      humanTurns: b.humanTurns,
      // Every known agent, always, whether or not this day saw it — a consumer that reads
      // `d.agent.cursor` should get 0, not undefined, on a day you only used Claude.
      agent: Object.fromEntries(AGENTS.map((a) => [a, b.agent[a] || 0])),
    };
  });

  // ---- streaks ------------------------------------------------------------
  const streak = computeStreaks(activeIdxs, tzh.dayIndex(now));

  // ---- histograms ---------------------------------------------------------
  const hourHist = new Array(24).fill(0);
  const weekdayHist = new Array(7).fill(0);
  for (const t of humanTurns) {
    hourHist[t.hour]++;
    weekdayHist[t.weekday]++;
  }

  // ---- projects -----------------------------------------------------------
  const projects = new Map();
  const proj = (name) => {
    let p = projects.get(name);
    if (!p) {
      p = {
        name, sessions: 0, minutes: 0, humanTurns: 0,
        firstTs: Infinity, lastTs: -Infinity, sessionTs: [],
      };
      projects.set(name, p);
    }
    return p;
  };
  for (const s of mainSessions) {
    const name = s.project || 'unknown';
    const p = proj(name);
    p.sessions++;
    p.minutes += s.durationMs / 60000;
    p.sessionTs.push(s.startedAt);
    if (s.startedAt < p.firstTs) p.firstTs = s.startedAt;
    if (s.endedAt > p.lastTs) p.lastTs = s.endedAt;
  }
  for (const t of humanTurns) {
    if (!t.project) continue;
    const p = proj(t.project);
    p.humanTurns++;
    if (t.ts < p.firstTs) p.firstTs = t.ts;
    if (t.ts > p.lastTs) p.lastTs = t.ts;
  }
  for (const p of projects.values()) p.sessionTs.sort((a, b) => a - b);
  const projectList = [...projects.values()].sort(
    (a, b) => b.minutes - a.minutes || b.humanTurns - a.humanTurns || a.name.localeCompare(b.name, 'en'),
  );
  const totalMinutes = projectList.reduce((a, p) => a + p.minutes, 0);

  // ---- tools --------------------------------------------------------------
  const tools = new Map();
  const toolsRaw = new Map();
  let toolCalls = 0;
  for (const s of sessions) {
    for (const [raw, n] of Object.entries(s.tools)) {
      const c = num(n);
      if (c <= 0) continue;
      toolCalls += c;
      toolsRaw.set(raw, (toolsRaw.get(raw) || 0) + c);
      const norm = normalizeTool(raw);
      tools.set(norm, (tools.get(norm) || 0) + c);
    }
  }
  const toolList = [...tools.entries()]
    .map(([name, n]) => ({ name, n }))
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, 'en'));
  // What anything that *names* a tool should read: same ranking, `Other` removed.
  const toolRanked = rankTools(toolList);

  // ---- files --------------------------------------------------------------
  const files = new Map();
  for (const s of mainSessions) {
    const d = tzh.dayIndex(s.startedAt);
    for (const f of new Set(s.filesTouched)) {
      if (!f) continue;
      let e = files.get(f);
      if (!e) {
        e = { path: f, count: 0, sessions: 0, days: new Set(), firstTs: Infinity, lastTs: -Infinity };
        files.set(f, e);
      }
      // `count` is edits, not sessions-that-touched-it. Ranking by the latter put
      // a docs file (33 sessions) ahead of the source file that was patched 160
      // times, under a card that says "Edited 33 times".
      e.count += num(s.fileCounts?.[f]) || 1;
      e.sessions++;
      e.days.add(d);
      if (s.startedAt < e.firstTs) e.firstTs = s.startedAt;
      if (s.endedAt > e.lastTs) e.lastTs = s.endedAt;
    }
  }
  const fileList = [...files.values()].sort(
    (a, b) => b.count - a.count || a.path.localeCompare(b.path, 'en'),
  );
  const totalTouches = fileList.reduce((a, f) => a + f.count, 0);

  // ---- tokens + cost ------------------------------------------------------
  const tokens = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  let cost = 0;
  for (const s of sessions) {
    const t = s.tokens || {};
    const bucket = {
      in: num(t.in), out: num(t.out), cacheRead: num(t.cacheRead),
      cacheWrite: num(t.cacheWrite), reasoning: num(t.reasoning),
    };
    for (const k of Object.keys(tokens)) tokens[k] += bucket[k];
    cost += estimateCost(bucket, s.models.length ? s.models[0] : null);
  }
  const totalTokens = tokens.in + tokens.out + tokens.cacheRead + tokens.cacheWrite;

  // ---- models (one vote per session — see DATA-FORMATS §10) ---------------
  const models = new Map();
  for (const s of mainSessions) {
    if (!s.models.length) continue;
    const m = s.models[0];
    let e = models.get(m);
    if (!e) {
      e = { name: m, sessions: 0, firstTs: Infinity, lastTs: -Infinity, days: [] };
      models.set(m, e);
    }
    e.sessions++;
    e.days.push(tzh.dayIndex(s.startedAt));
    if (s.startedAt < e.firstTs) e.firstTs = s.startedAt;
    if (s.startedAt > e.lastTs) e.lastTs = s.startedAt;
  }
  const modelList = [...models.values()].sort(
    (a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name, 'en'),
  );

  // ---- interrupts ---------------------------------------------------------
  const interrupts = [];
  for (const s of sessions) {
    for (const it of s.interrupts) {
      if (!it || !Number.isFinite(it.ts)) continue;
      interrupts.push({
        ts: it.ts,
        durationMs: Number.isFinite(it.durationMs) ? it.durationMs : null,
        sessionId: s.id,
        project: s.project,
      });
    }
  }
  interrupts.sort((a, b) => a.ts - b.ts);
  const withDuration = interrupts.filter((i) => i.durationMs != null && i.durationMs > 0);

  // ---- language, politeness, apologies ------------------------------------
  // Seeded with the four codes every consumer may read unconditionally; every
  // other code detectLang can return (de, zh, ja, ko, …) appears only when the
  // corpus actually contains it.
  const langCounts = { ru: 0, en: 0, mixed: 0, none: 0 };
  let politeTurns = 0;
  const apologyTurns = [];
  for (const t of humanTurns) {
    langCounts[t.lang] = (langCounts[t.lang] || 0) + 1;
    // Flattened once, read by both predicates. It used to be built twice per
    // turn, and on a corpus of this size that is a full pass over every
    // message for nothing.
    const low = flatten(t.text).toLowerCase();
    if (isPolite(t, low)) politeTurns++;
    if (isApology(t, low)) apologyTurns.push(t);
  }
  let agentApologies = 0;
  let agentPolite = 0;
  for (const t of agentTurns) {
    const low = t.text.slice(0, 400).toLowerCase();
    if (/\b(sorry|apologies|i apologize|my mistake|you’re right|you're right)\b/.test(low)) agentApologies++;
    if (/\b(thank you|thanks)\b/.test(low)) agentPolite++;
  }

  // ---- word counts --------------------------------------------------------
  let yourWords = 0;
  for (const t of humanTurns) yourWords += t.wordCount;
  let itsWords = 0;
  for (const t of agentTurns) itsWords += countWordsFast(t.text);

  const turnWordCounts = humanTurns.map((t) => t.wordCount);
  const terseTurns = humanTurns.filter((t) => t.wordCount > 0 && t.wordCount <= 5).length;

  // ---- n-grams ------------------------------------------------------------
  const humanDocs = humanTurns.map((t) => ({
    text: paranoid ? '' : t.redactedText,
    ts: t.ts, project: t.project, model: t.model, sessionId: t.sessionId,
  }));
  const minDfHuman = humanTurns.length < 20
    ? 2
    : Math.max(3, Math.ceil(0.015 * humanTurns.length));
  const ngramHuman = paranoid
    ? []
    : mineNgrams(humanDocs, { minDf: minDfHuman, maxN: 4 });

  const firstAgentBySession = new Map();
  for (const t of agentTurns) {
    if (t.sidechain) continue;
    if (!firstAgentBySession.has(t.sessionId)) firstAgentBySession.set(t.sessionId, t.text);
  }
  const preamble = preamblePhrases([...firstAgentBySession.values()], firstAgentBySession.size);
  const agentDocs = agentTurns
    .filter((t) => !t.sidechain)
    .map((t) => ({ text: t.text, ts: t.ts, project: t.project, model: t.model, sessionId: t.sessionId }));
  const ngramAgent = mineNgrams(agentDocs, {
    minDf: Math.max(5, Math.ceil(0.02 * agentDocs.length)),
    maxN: 6,
    agentSide: true,
    preamble,
  });

  // ---- session-level rollups ---------------------------------------------
  const sessionHours = mainSessions.map((s) => s.durationMs / 3600000);
  const totalHours = sessionHours.reduce((a, b) => a + b, 0);
  const compactions = sessions.reduce((a, s) => a + s.compactions, 0);
  const subagents = sessions.reduce((a, s) => a + s.subagents, 0);
  const thinkingChars = sessions.reduce((a, s) => a + s.thinkingChars, 0);

  const firstSeen = humanTurns.length
    ? Math.min(humanTurns[0].ts, mainSessions.length ? mainSessions[0].startedAt : humanTurns[0].ts)
    : mainSessions.length ? mainSessions[0].startedAt : now;
  const lastSeen = humanTurns.length
    ? humanTurns[humanTurns.length - 1].ts
    : mainSessions.length ? mainSessions[mainSessions.length - 1].endedAt : now;

  const spanDays = Math.max(1, tzh.dayIndex(lastSeen) - tzh.dayIndex(firstSeen) + 1);
  const daysSinceFirst = Math.max(0, tzh.dayIndex(now) - tzh.dayIndex(firstSeen));
  const activeDays = activeIdxs.length;

  const weekendTurns = humanTurns.filter((t) => t.weekday === 0 || t.weekday === 6).length;
  const nightTurns = humanTurns.filter((t) => t.hour >= 0 && t.hour < 5);
  const dawnTurns = humanTurns.filter((t) => t.hour >= 5 && t.hour < 9).length;

  // first/last human turn of each active day, for the clock card
  const firstLastByDay = [];
  for (const idx of activeIdxs) {
    const b = days.get(idx);
    if (b.firstTs === Infinity) continue;
    firstLastByDay.push({
      idx,
      first: tzh.parts(b.firstTs).h * 60 + tzh.parts(b.firstTs).mi,
      last: tzh.parts(b.lastTs).h * 60 + tzh.parts(b.lastTs).mi,
    });
  }

  const tier = activeDays >= 90 || spanDays >= 365 ? 3 : activeDays >= 14 ? 2 : activeDays >= 2 ? 1 : 0;

  // Per-day views, so a day-anchored card never has to re-walk the corpus.
  const turnsByDay = new Map();
  for (const t of humanTurns) {
    let arr = turnsByDay.get(t.day);
    if (!arr) turnsByDay.set(t.day, (arr = []));
    arr.push(t);
  }
  const sittingsByDay = new Map();
  for (const sit of sittings) {
    let arr = sittingsByDay.get(sit.day);
    if (!arr) sittingsByDay.set(sit.day, (arr = []));
    arr.push(sit);
  }
  const interruptsByDay = new Map();
  for (const it of interrupts) {
    const d = tzh.dayIndex(it.ts);
    interruptsByDay.set(d, (interruptsByDay.get(d) || 0) + 1);
  }

  const ctx = {
    now, tzh, tz: tzh.tz, redact, redactLevel, paranoid, idleGapMs,
    sessions, mainSessions,
    humanTurns, agentTurns, turnsBySession, sessionInfo,
    sittings, sittingsByDay, turnsByDay, interruptsByDay,
    used: new Set(),
    markUsed(id) { if (id) ctx.used.add(id); },
    days, dayIdxs, activeIdxs, timeline, streak,
    hourHist, weekdayHist, firstLastByDay,
    projects, projectList, totalMinutes,
    tools, toolsRaw, toolList, toolRanked, toolCalls,
    files, fileList, totalTouches,
    tokens, totalTokens, cost,
    models, modelList,
    interrupts, interruptsWithDuration: withDuration,
    langCounts, politeTurns, apologyTurns, agentApologies, agentPolite,
    yourWords, itsWords, turnWordCounts, terseTurns,
    ngramHuman, ngramAgent,
    compactions, subagents, thinkingChars,
    reasoning, subagentWords, subagentSummaryWords,
    sessionHours, totalHours,
    firstSeen, lastSeen, spanDays, daysSinceFirst, activeDays,
    weekendTurns, nightTurns, dawnTurns,
    tier,
  };

  ctx.stats = flatStats(ctx);
  ctx.features = archetypeFeatures(ctx);
  return ctx;
}

/* ------------------------------------------------------------- sub-routines */

function countWordsFast(text) {
  // Agent messages are enormous; a full tokenize on all of them would dominate
  // the run. Whitespace runs are within a couple of percent of the tokenizer
  // for prose, and this number is only ever shown rounded.
  //
  // Except that Chinese and Japanese don't put spaces between words, so the
  // whitespace count alone reads a whole paragraph as one word — which flipped
  // `the-ratio` upside down for CJK users, claiming the agent wrote less than
  // they did. Han and kana are therefore counted separately and converted at
  // their average word lengths (~1.5 chars for Han, ~2 for kana-heavy
  // Japanese). Still one pass, still no regex, still nowhere near the tokenizer
  // in cost — and the result is only ever shown rounded.
  let n = 0;
  let han = 0;
  let kana = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c === 32 || c === 10 || c === 13 || c === 9;
    // CJK ideographs, kana, and Hangul syllables break words on their own.
    const isHan = (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf)
      || (c >= 0xf900 && c <= 0xfaff);
    const isKana = (c >= 0x3040 && c <= 0x30ff) || (c >= 0x31f0 && c <= 0x31ff);
    if (isHan) { han++; inWord = false; } else if (isKana) { kana++; inWord = false; } else if (ws) {
      inWord = false;
    } else if (!inWord) { inWord = true; n++; }
  }
  return n + Math.round(han / 1.5 + kana / 2);
}

function computeStreaks(activeIdxs, todayIdx) {
  if (!activeIdxs.length) {
    return { longest: 0, longestStart: null, longestEnd: null, current: 0, currentStart: null, longestGap: 0, gapStart: null, gapEnd: null, live: false };
  }
  let best = 1;
  let bestStart = activeIdxs[0];
  let bestEnd = activeIdxs[0];
  let run = 1;
  let runStart = activeIdxs[0];
  let longestGap = 0;
  let gapStart = null;
  let gapEnd = null;
  for (let i = 1; i < activeIdxs.length; i++) {
    const gap = activeIdxs[i] - activeIdxs[i - 1];
    if (gap === 1) {
      run++;
    } else {
      if (gap - 1 > longestGap) {
        longestGap = gap - 1;
        gapStart = activeIdxs[i - 1];
        gapEnd = activeIdxs[i];
      }
      run = 1;
      runStart = activeIdxs[i];
    }
    if (run > best) {
      best = run;
      bestStart = runStart;
      bestEnd = activeIdxs[i];
    }
  }
  // current streak: consecutive run ending today or yesterday
  let current = 0;
  let currentStart = null;
  const last = activeIdxs[activeIdxs.length - 1];
  if (todayIdx - last <= 1) {
    current = 1;
    currentStart = last;
    for (let i = activeIdxs.length - 1; i > 0; i--) {
      if (activeIdxs[i] - activeIdxs[i - 1] === 1) { current++; currentStart = activeIdxs[i - 1]; }
      else break;
    }
  }
  return {
    longest: best, longestStart: bestStart, longestEnd: bestEnd,
    current, currentStart, longestGap, gapStart, gapEnd,
    live: current >= best && current > 0,
  };
}

/**
 * One alternation instead of N substring scans.
 *
 * The phrase lists went from 8 entries (English + Russian) to 157 across
 * fourteen languages, and every one of them used to be a separate
 * `low.includes(p)` over the whole turn — 157 scans per message, twice, on
 * every human turn in the corpus. A single alternation is ~3× faster at 50 000
 * turns and gives bit-identical verdicts (there is a test).
 *
 * `sort` by descending length is not for correctness — alternation is
 * leftmost-first and we only ever ask `.test()`, never which branch won — it
 * just puts the likeliest matches first. Nothing here is a user-supplied
 * pattern, but the escape stays: a lexicon entry with a `.` or `(` in it must
 * not silently become a wildcard.
 * @param {string[]} list
 */
function phraseMatcher(list) {
  if (!list || !list.length) return { test: () => false };
  const alts = list
    .map((s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((a, b) => b.length - a.length);
  return new RegExp(alts.join('|'));
}

const POLITE_PHRASE_RE = phraseMatcher(POLITE_EN_PHRASES);
const APOLOGY_PHRASE_RE = phraseMatcher(APOLOGY_EN_PHRASES);
const APOLOGY_EXCLUDE_RE = phraseMatcher(APOLOGY_EXCLUDE);

function stemHit(token, stems) {
  if (RU_STEM_EXCLUDE.has(token)) return false;
  for (const s of stems) if (token.startsWith(s)) return true;
  return false;
}

function isPolite(turn, low) {
  if (POLITE_PHRASE_RE.test(low)) return true;
  for (const t of turn.tokens) {
    if (POLITE_EN.includes(t)) return true;
    if (stemHit(t, POLITE_RU_STEMS)) return true;
  }
  return false;
}

function isApology(turn, low) {
  // An error word anywhere in the turn vetoes it: "sorry, that throws an
  // exception" is a bug report, not an apology.
  if (APOLOGY_EXCLUDE_RE.test(low)) return false;
  if (APOLOGY_PHRASE_RE.test(low)) return true;
  for (const t of turn.tokens) {
    if (APOLOGY_EN.includes(t)) return true;
    if (stemHit(t, APOLOGY_RU_STEMS)) return true;
  }
  return false;
}

/** Flat numbers for the front-end summary and Wrapped. */
function flatStats(ctx) {
  const top = ctx.projectList[0];
  return {
    sessions: ctx.mainSessions.length,
    humanTurns: ctx.humanTurns.length,
    agentTurns: ctx.agentTurns.length,
    activeDays: ctx.activeDays,
    spanDays: ctx.spanDays,
    daysSinceFirst: ctx.daysSinceFirst,
    totalHours: Math.round(ctx.totalHours * 10) / 10,
    totalMinutes: Math.round(ctx.totalMinutes),
    projects: ctx.projectList.length,
    topProject: top ? top.name : null,
    topProjectShare: ctx.totalMinutes ? (top ? top.minutes / ctx.totalMinutes : 0) : 0,
    toolCalls: ctx.toolCalls,
    distinctTools: ctx.toolList.length,
    // `toolRanked`, not `toolList`: the summary must not tell anyone their
    // spirit tool is the bucket for names we failed to recognise.
    spiritTool: ctx.toolRanked.length ? ctx.toolRanked[0].name : null,
    filesTouched: ctx.fileList.length,
    yourWords: ctx.yourWords,
    itsWords: ctx.itsWords,
    ratio: ctx.yourWords ? Math.round(ctx.itsWords / ctx.yourWords) : 0,
    tokensIn: ctx.tokens.in,
    tokensOut: ctx.tokens.out,
    tokensCacheRead: ctx.tokens.cacheRead,
    tokensCacheWrite: ctx.tokens.cacheWrite,
    tokensReasoning: ctx.tokens.reasoning,
    totalTokens: ctx.totalTokens,
    cost: Math.round(ctx.cost * 100) / 100,
    interrupts: ctx.interrupts.length,
    compactions: ctx.compactions,
    subagents: ctx.subagents,
    thinkingChars: ctx.thinkingChars,
    longestStreak: ctx.streak.longest,
    currentStreak: ctx.streak.current,
    nightTurns: ctx.nightTurns.length,
    weekendTurns: ctx.weekendTurns,
    politeTurns: ctx.politeTurns,
    questionRate: ctx.humanTurns.length
      ? ctx.humanTurns.filter((t) => t.question).length / ctx.humanTurns.length
      : 0,
    medianPromptWords: Math.round(median(ctx.turnWordCounts)),
    topModel: ctx.modelList.length ? ctx.modelList[0].name : null,
    models: ctx.modelList.length,
    firstSeen: ctx.firstSeen,
    lastSeen: ctx.lastSeen,
    tier: ctx.tier,
  };
}

/**
 * Archetype features (§5.1). Anchors are fixed constants, not population
 * statistics — codepend never sees a population.
 */
function archetypeFeatures(ctx) {
  const n = ctx.humanTurns.length || 1;
  const A = {
    night: 0.15, dawn: 0.18, interrupt: 0.12, terse: 0.35, verbose: 55,
    marathon: 3.0, weekend: 0.35, streak: 21, breadth: 8, focus: 0.7,
    polite: 0.05, tooling: 25, deliberate: 1500, swarm: 0.5, ghosting: 0.4,
    consistency: 0.55,
  };
  const ghosts = ctx.projectList.filter((p) => p.sessions === 1).length;
  const raw = {
    night: ctx.nightTurns.length / n,
    dawn: ctx.dawnTurns / n,
    interrupt: ctx.interrupts.length / n,
    terse: ctx.terseTurns / n,
    verbose: median(ctx.turnWordCounts),
    marathon: percentile(ctx.sessionHours, 0.9),
    weekend: ctx.weekendTurns / n,
    streak: ctx.streak.longest,
    breadth: ctx.projectList.length,
    focus: ctx.stats ? ctx.stats.topProjectShare : (ctx.projectList[0] && ctx.totalMinutes ? ctx.projectList[0].minutes / ctx.totalMinutes : 0),
    polite: ctx.politeTurns / n,
    tooling: ctx.toolCalls / n,
    deliberate: ctx.thinkingChars / n,
    swarm: ctx.mainSessions.length ? ctx.subagents / ctx.mainSessions.length : 0,
    ghosting: ctx.projectList.length ? ghosts / ctx.projectList.length : 0,
    consistency: ctx.activeDays / ctx.spanDays,
  };
  const f = {};
  for (const k of Object.keys(A)) f[k] = clamp01(raw[k] / A[k]);
  f._raw = raw;
  f._ghosts = ghosts;
  return f;
}

export { stripStructure };
