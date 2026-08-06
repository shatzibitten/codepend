/**
 * codepend — per-file line normalizers.
 *
 * One parser per agent. Each parser is fed raw line Buffers (in file order) by src/scan.js and
 * emits a single `Session` object. Parsers own ALL format knowledge; scan.js owns I/O.
 *
 * Everything here is written against docs/DATA-FORMATS.md, which was verified against the real
 * corpus. Where the project brief and that document disagree, the document wins — the deviations
 * are called out inline with a `SPEC:` note.
 */

/** Idle gap cap for "time actually spent" (docs/DATA-FORMATS.md §5). */
export const IDLE_GAP_MS = 600_000;

/** Bump when extraction logic changes — invalidates every cache entry. */
export const PARSER_VERSION = 7;

/** How much of a line we ASCII-decode to classify it before deciding to JSON.parse. */
const HEAD_BYTES = 256;

/** Per-turn text caps. We keep counts for the whole string, text only up to the cap. */
const HUMAN_TEXT_CAP = 2000;
const AGENT_TEXT_CAP = 800;
const REASON_TEXT_CAP = 240;

/** Hard caps so one pathological session cannot eat the heap. */
const MAX_TURNS = 5000;
const MAX_REASONING = 5000;
const MAX_FILES = 800;
const MAX_INTERRUPTS = 2000;
const MAX_CALL_IDS = 60_000;
/** Contiguous activity bursts kept per session (see `timingFrom`). */
const MAX_BURSTS = 500;
/** Lines larger than this are never JSON.parsed (docs §6: real max observed is 2.9 MB). */
const MAX_LINE_BYTES = 16 * 1024 * 1024;

/**
 * Cyrillic-safe word tokenizer. Mirrors the tokenizer in docs/MEMORY-CATALOG.md §1.5.
 * `String.prototype.split(' ')` is banned in this codebase: it miscounts RU text and punctuation.
 * @param {string} text
 * @returns {number}
 */
export function wordCount(text) {
  if (!text) return 0;
  const m = text.match(/[\p{L}\p{N}]+(?:[’'\-][\p{L}\p{N}]+)*/gu);
  return m ? m.length : 0;
}

/**
 * Truncate on a code-point boundary (never mid-surrogate).
 * @param {string} text
 * @param {number} cap
 */
function clip(text, cap) {
  if (text.length <= cap) return text;
  return Array.from(text).slice(0, cap).join('');
}

/** @returns {{ts:number,text:string,chars:number,words:number,truncated:boolean}} */
function makeTurn(ts, text, cap) {
  const chars = [...text].length;
  return {
    ts,
    text: clip(text, cap),
    chars,
    words: wordCount(text),
    truncated: text.length > cap,
  };
}

/** Session skeleton — exactly the contract shape, plus additive extras (see README of scan). */
function blankSession(agent, file, id) {
  return {
    id,
    agent,
    source: file,
    title: null,
    cwd: null,
    project: null,
    gitBranch: null,
    startedAt: 0,
    endedAt: 0,
    durationMs: 0,
    models: [],
    cliVersion: null,
    humanTurns: [],
    agentTurns: [],
    reasoning: [],
    tools: Object.create(null),
    filesTouched: [],
    interrupts: [],
    tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    compactions: 0,
    subagents: 0,
    thinkingChars: 0,
    forkedFrom: null,
    isSidechain: false,

    // ---- additive extras (detectors need these; nothing in the contract forbids them) ----
    /** Primary model for this session (one vote per session — docs §10). */
    model: null,
    /** Where the session came from: 'Codex Desktop' | 'vscode' | 'claude-code' … */
    origin: null,
    /** Aggregate counts computed over the FULL text, before per-turn truncation. */
    counts: {
      humanTurns: 0,
      agentTurns: 0,
      toolCalls: 0,
      humanWords: 0,
      agentWords: 0,
      humanChars: 0,
      agentChars: 0,
      lines: 0,
      skippedLines: 0,
    },
    /** Prompts the user typed and then deleted (Claude `queue-operation` op=remove). */
    unsent: [],
    /** Longest single reasoning/thinking block, in chars. */
    maxThinkChars: 0,
    /** path -> how many times it was actually edited in this session. */
    fileCounts: Object.create(null),
    /** Wall-clock span; kept for debugging — never use it as "time spent" (docs §5). */
    spanMs: 0,
    /** Contiguous sittings: [{startedAt, endedAt, durationMs}]. Σ durationMs === durationMs. */
    bursts: [],
  };
}

/* ------------------------------------------------------------------ *
 * shared finish helpers
 * ------------------------------------------------------------------ */

/**
 * @param {number[]} stamps unsorted epoch-ms
 * @param {number} idleGapMs
 */
function timingFrom(stamps, idleGapMs) {
  if (!stamps.length) {
    return { startedAt: 0, endedAt: 0, durationMs: 0, spanMs: 0, bursts: [] };
  }
  // Claude emits 159 out-of-order timestamps (docs §6); sort first, clamp negatives to 0.
  stamps.sort((a, b) => a - b);
  let dur = 0;
  // A session is a *thread*, not a sitting: 36 % of them here span a day or
  // more. The bursts are the sittings — contiguous stretches with no idle gap —
  // and they are the honest unit for "one session", "that day", "without
  // closing the window". Emitted here because this is the only place that sees
  // every event timestamp; by construction Σ burst.durationMs === durationMs.
  const bursts = [];
  let bStart = stamps[0];
  let bDur = 0;
  for (let i = 1; i < stamps.length; i++) {
    const d = stamps[i] - stamps[i - 1];
    // SPEC: docs §5 writes this as `Σ min(gap, IDLE_GAP)`, but every number in its own table is
    // `Σ gap where gap ≤ IDLE_GAP` — the total span of the active bursts. We follow the numbers,
    // not the formula: charging 10 minutes for a gap that was actually three days invents 160 h
    // of "time with your agent" out of nothing, and an inflated headline is the fastest way to
    // lose the reader's trust.
    if (d > 0 && d <= idleGapMs) {
      dur += d;
      bDur += d;
    } else if (d > idleGapMs) {
      if (bursts.length < MAX_BURSTS) {
        bursts.push({ startedAt: bStart, endedAt: stamps[i - 1], durationMs: bDur });
      }
      bStart = stamps[i];
      bDur = 0;
    }
  }
  if (bursts.length < MAX_BURSTS) {
    bursts.push({ startedAt: bStart, endedAt: stamps[stamps.length - 1], durationMs: bDur });
  }
  const startedAt = stamps[0];
  const endedAt = stamps[stamps.length - 1];
  return { startedAt, endedAt, durationMs: dur, spanMs: endedAt - startedAt, bursts };
}

/** @param {string|null} cwd */
function projectOf(cwd) {
  if (!cwd) return null;
  const parts = String(cwd).split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

/** Rank models by how often they were seen; most-used first. */
function modelsByCount(counter) {
  return Object.keys(counter).sort((a, b) => counter[b] - counter[a] || (a < b ? -1 : 1));
}

/* ------------------------------------------------------------------ *
 * Claude Code
 * ------------------------------------------------------------------ */

/** Text of a `message.content` that is either a string or a block array. */
function claudeText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const b of content) {
    if (b && b.type === 'text' && typeof b.text === 'string') out += (out ? '\n' : '') + b.text;
  }
  return out;
}

const RE_CLAUDE_INTERRUPT = /^\[Request interrupted by/;

/**
 * @param {{file:string,id:string,idleGapMs?:number}} ctx
 */
export function createClaudeParser(ctx) {
  const idleGapMs = ctx.idleGapMs ?? IDLE_GAP_MS;
  const s = blankSession('claude', ctx.file, ctx.id);
  s.origin = 'claude-code';
  const stamps = [];
  const modelCount = Object.create(null);
  const files = new Map();
  /** trimmed human texts, for the queue-operation dedup (docs §3.3) */
  const humanSeen = new Set();
  /** enqueued-but-unmatched candidates, resolved in finish() */
  const enqueued = [];
  let aiTitle = null;
  let customTitle = null;

  return {
    /**
     * @param {Buffer} buf raw line, no trailing newline
     * @returns {boolean} false → stop reading this file
     */
    line(buf) {
      s.counts.lines++;
      if (buf.length > MAX_LINE_BYTES) {
        s.counts.skippedLines++;
        return true;
      }
      let o;
      try {
        o = JSON.parse(buf.toString('utf8'));
      } catch {
        s.counts.skippedLines++; // a session being written right now can end mid-line
        return true;
      }
      if (!o || typeof o !== 'object') return true;

      const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
      if (Number.isFinite(ts)) stamps.push(ts);
      if (o.cwd && !s.cwd) s.cwd = o.cwd;
      if (o.gitBranch) s.gitBranch = o.gitBranch;
      if (o.version) s.cliVersion = o.version;
      if (o.isSidechain === true) s.isSidechain = true;

      switch (o.type) {
        case 'user': {
          if (o.isMeta) break;
          const text = claudeText(o.message?.content).trim();
          if (!text) break;
          if (RE_CLAUDE_INTERRUPT.test(text)) {
            // Claude has no turn_aborted record; the injected marker is the only signal.
            if (s.interrupts.length < MAX_INTERRUPTS) {
              s.interrupts.push({ ts: Number.isFinite(ts) ? ts : 0, durationMs: null });
            }
            break;
          }
          // SPEC docs §3.3: origin.kind === 'human' is the ONLY humanity marker. Naive
          // `type === 'user'` inflates the count 28× (94 % of user lines are tool results).
          if (o.origin?.kind !== 'human') break;
          humanSeen.add(text);
          s.counts.humanTurns++;
          s.counts.humanWords += wordCount(text);
          s.counts.humanChars += [...text].length;
          if (s.humanTurns.length < MAX_TURNS) {
            s.humanTurns.push(makeTurn(Number.isFinite(ts) ? ts : 0, text, HUMAN_TEXT_CAP));
          }
          break;
        }

        case 'assistant': {
          const msg = o.message;
          if (!msg) break;
          const model = msg.model;
          // '<synthetic>' marks error/placeholder messages — excluded from models and tokens.
          const real = typeof model === 'string' && model !== '<synthetic>';
          if (real) modelCount[model] = (modelCount[model] || 0) + 1;

          if (real && msg.usage) {
            const u = msg.usage;
            // Claude's input_tokens EXCLUDES cache (unlike Codex) — no subtraction (docs §4.6).
            s.tokens.in += u.input_tokens || 0;
            s.tokens.out += u.output_tokens || 0;
            s.tokens.cacheRead += u.cache_read_input_tokens || 0;
            s.tokens.cacheWrite += u.cache_creation_input_tokens || 0;
          }

          const content = msg.content;
          if (!Array.isArray(content)) break;
          let text = '';
          for (const b of content) {
            if (!b) continue;
            if (b.type === 'text' && typeof b.text === 'string') {
              text += (text ? '\n' : '') + b.text;
            } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
              const n = b.thinking.length;
              s.thinkingChars += n;
              if (n > s.maxThinkChars) s.maxThinkChars = n;
            } else if (b.type === 'tool_use' && typeof b.name === 'string') {
              s.tools[b.name] = (s.tools[b.name] || 0) + 1;
              s.counts.toolCalls++;
              if (b.name === 'Agent' || b.name === 'Task') s.subagents++;
              const inp = b.input;
              if (inp) {
                const p = inp.file_path || inp.notebook_path;
                // Count every touch, not just the distinct set: "edited 33 times"
                // has to mean 33 edits. Ranking by distinct-sessions-touched
                // crowned a doc file with 33 sessions over the source file that
                // was actually patched 160 times.
                if (typeof p === 'string' && p && (files.has(p) || files.size < MAX_FILES)) {
                  files.set(p, (files.get(p) || 0) + 1);
                }
              }
            }
          }
          if (text.trim()) {
            const t = text.trim();
            s.counts.agentTurns++;
            s.counts.agentWords += wordCount(t);
            s.counts.agentChars += [...t].length;
            if (s.agentTurns.length < MAX_TURNS) {
              s.agentTurns.push(makeTurn(Number.isFinite(ts) ? ts : 0, t, AGENT_TEXT_CAP));
            }
          }
          break;
        }

        // Title records are APPENDED, not rewritten — up to 90 per file. Take the last.
        case 'ai-title':
          if (typeof o.aiTitle === 'string' && o.aiTitle.trim()) aiTitle = o.aiTitle.trim();
          break;
        case 'custom-title':
          if (typeof o.customTitle === 'string' && o.customTitle.trim()) {
            customTitle = o.customTitle.trim();
          }
          break;

        case 'queue-operation': {
          const content = typeof o.content === 'string' ? o.content.trim() : '';
          if (!content) break;
          if (content.startsWith('<')) break; // injected <task-notification> blobs, not typing
          if (o.operation === 'remove') {
            // Typed, then deleted. Never a human turn — but a lovely detector on its own.
            if (s.unsent.length < 200) {
              s.unsent.push(makeTurn(Number.isFinite(ts) ? ts : 0, content, HUMAN_TEXT_CAP));
            }
          } else if (o.operation === 'enqueue') {
            enqueued.push({ ts: Number.isFinite(ts) ? ts : 0, text: content });
          }
          break;
        }

        default:
          break;
      }
      return true;
    },

    /** @returns {object|null} */
    finish() {
      // A queued prompt only counts if it never showed up as a real human line (docs §3.3):
      // 102 of 231 enqueues duplicate a human line, and counting both double-counts.
      for (const q of enqueued) {
        if (humanSeen.has(q.text)) continue;
        if (s.humanTurns.length >= MAX_TURNS) break;
        s.counts.humanTurns++;
        s.counts.humanWords += wordCount(q.text);
        s.counts.humanChars += [...q.text].length;
        s.humanTurns.push(makeTurn(q.ts, q.text, HUMAN_TEXT_CAP));
      }
      s.humanTurns.sort((a, b) => a.ts - b.ts);

      s.title = customTitle || aiTitle || null;
      s.models = modelsByCount(modelCount);
      s.model = s.models[0] || null;
      s.project = projectOf(s.cwd);
      s.filesTouched = [...files.keys()];
      s.fileCounts = Object.fromEntries(files);
      Object.assign(s, timingFrom(stamps, idleGapMs));
      if (!stamps.length) return null; // nothing timestamped → not a real session
      return s;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Codex
 * ------------------------------------------------------------------ */

/** Only these (type, payload.type) pairs are worth a JSON.parse. Everything else: ts only. */
const CODEX_EVENT_MSG = new Set([
  'user_message',
  'agent_message',
  'agent_reasoning',
  'token_count',
  'turn_aborted',
  'task_started',
  'patch_apply_end',
  'mcp_tool_call_end',
  'thread_settings_applied',
  'sub_agent_activity',
  'web_search_end',
]);
const CODEX_RESPONSE_ITEM = new Set(['function_call', 'custom_tool_call', 'web_search_call']);

/** MCP servers that are Codex built-ins — their tools keep their bare names. */
const BUILTIN_MCP_SERVERS = new Set(['node_repl']);

/** Machine-authored wrappers that arrive as `user_message` but nobody typed. */
const CODEX_INJECTED_HEADINGS =
  /^#[ \t]*(AGENTS\.md instructions|Chrome tabs:|Context from my IDE setup:|Files mentioned by the user:|Response annotations:|In app browser:|Selected text:|Selection \d)/;
/** `<heartbeat>`, `<environment_context>`, `<turn_aborted>`, `<in-app-browser-context …>`, … */
const CODEX_TAG_WRAPPER = /^<[A-Za-z_][\w.-]*(\s[^>]*)?>/;
/** The IDE wrappers carry the real prompt under this heading. */
const CODEX_REQUEST_MARKER = /(?:^|\n)##[ \t]*My request for Codex:[ \t]*\r?\n?/g;

/**
 * Pull the human's actual words out of a Codex `user_message`.
 *
 * SPEC: docs §4.3 says to drop anything starting with `#`/`<`. Measured on this corpus that would
 * throw away 351 of 1000 prompts, because the IDE/Chrome/annotation wrappers *contain* the real
 * prompt under a `## My request for Codex:` heading. So: unwrap first, drop second.
 *
 * @param {string} raw
 * @returns {string|null} the typed text, or null if the message is machine-authored
 */
export function extractCodexPrompt(raw) {
  if (typeof raw !== 'string') return null;
  let t = raw.trim();
  if (!t) return null;

  CODEX_REQUEST_MARKER.lastIndex = 0;
  let last = null;
  for (const m of t.matchAll(CODEX_REQUEST_MARKER)) last = m;
  if (last) {
    t = t.slice(last.index + last[0].length).trim();
    return t || null;
  }
  if (CODEX_TAG_WRAPPER.test(t)) return null;
  if (CODEX_INJECTED_HEADINGS.test(t)) return null;
  if (t.includes('AGENTS.md instructions') || t.includes('<INSTRUCTIONS>')) return null;
  return t;
}

/** `**Planning safe process termination**` → the headline. 100 % of reasoning blocks have one. */
function reasoningHeadline(text) {
  const m = /^\s*\*\*(.+?)\*\*/s.exec(text);
  if (m) return m[1].trim();
  const first = text.split('\n', 1)[0].trim();
  return first || text.trim();
}

const RE_HEAD_TS = /^\{"timestamp":"([^"]{20,32})"/;
const RE_HEAD_TYPE = /"type":"([a-z_]+)"/;
const RE_HEAD_PTYPE = /"payload":\{"type":"([a-z_]+)"/;
/** `mcp_tool_call_end` embeds the tool's entire output — 1.9 GB of this corpus, for two fields. */
const RE_MCP = /"call_id":"([^"]*)","invocation":\{"server":"([^"]*)","tool":"([^"]*)"/;
const MCP_HEAD_BYTES = 640;

/**
 * @param {{file:string,id?:string,idleGapMs?:number,keepAll?:boolean}} ctx
 *   keepAll: don't apply the thread_source gate (used by tests / --include-subagents)
 */
export function createCodexParser(ctx) {
  const idleGapMs = ctx.idleGapMs ?? IDLE_GAP_MS;
  const s = blankSession('codex', ctx.file, ctx.id || null);
  const stamps = [];
  const modelCount = Object.create(null);
  const files = new Map();
  const taskStarted = new Map(); // turn_id -> epoch ms
  const seenCallIds = new Set(); // function_call ids, so MCP events don't double-count
  let metaSeen = false;
  let threadSource;
  let lastTurnModel = null;
  let settingsModel = null;

  /** @param {string} name */
  function tool(name) {
    if (!name) return;
    s.tools[name] = (s.tools[name] || 0) + 1;
    s.counts.toolCalls++;
    if (name === 'spawn_agent') s.subagents++;
  }

  return {
    /**
     * @param {Buffer} buf
     * @returns {boolean} false → stop reading this file (subagent/automation thread)
     */
    line(buf) {
      s.counts.lines++;
      const head = buf.toString('latin1', 0, buf.length < HEAD_BYTES ? buf.length : HEAD_BYTES);

      const mTs = RE_HEAD_TS.exec(head);
      const mType = RE_HEAD_TYPE.exec(head);
      let ts = NaN;
      if (mTs) {
        ts = Date.parse(mTs[1]);
        if (Number.isFinite(ts)) stamps.push(ts);
      }

      const type = mType ? mType[1] : null;
      // Fast path: every line carries a timestamp, and the bulk of the 4.6 GB is
      // function_call_output / reasoning(encrypted_content) / world_state. Classify from the
      // 256-byte ASCII head and never touch the rest of the bytes.
      if (type && mTs) {
        if (type === 'compacted') {
          // SPEC docs §4.1: `compacted` and `event_msg/context_compacted` co-occur 23/23.
          // Count the top-level one only, or every memory wipe doubles.
          s.compactions++;
          return true;
        }
        if (type === 'session_meta' && metaSeen) return true; // re-emitted up to 25× per file
        if (type === 'event_msg' || type === 'response_item') {
          const mP = RE_HEAD_PTYPE.exec(head);
          if (mP) {
            const p = mP[1];
            const want =
              type === 'event_msg' ? CODEX_EVENT_MSG.has(p) : CODEX_RESPONSE_ITEM.has(p);
            if (!want) return true;
            if (p === 'mcp_tool_call_end') {
              // The result blob makes these lines the single biggest cost in the corpus
              // (1.9 GB / 13.6 k lines). Both fields we need sit in the first ~200 bytes.
              const mcpHead = buf.toString(
                'latin1',
                0,
                buf.length < MCP_HEAD_BYTES ? buf.length : MCP_HEAD_BYTES,
              );
              const m = RE_MCP.exec(mcpHead);
              if (m) {
                if (!seenCallIds.has(m[1]) && m[3] && !BUILTIN_MCP_SERVERS.has(m[2])) {
                  tool(m[2] ? `mcp__${m[2]}__${m[3]}` : m[3]);
                }
                return true;
              }
            }
          }
          // no payload.type in the head → fall through and parse properly
        } else if (type !== 'session_meta' && type !== 'turn_context') {
          return true; // world_state, inter_agent_communication_metadata, …
        }
      }

      if (buf.length > MAX_LINE_BYTES) {
        s.counts.skippedLines++;
        return true;
      }
      let o;
      try {
        o = JSON.parse(buf.toString('utf8'));
      } catch {
        s.counts.skippedLines++;
        return true;
      }
      if (!o || typeof o !== 'object') return true;
      if (!Number.isFinite(ts) && o.timestamp) {
        const t2 = Date.parse(o.timestamp);
        if (Number.isFinite(t2)) stamps.push((ts = t2));
      }
      const p = o.payload;

      if (o.type === 'session_meta') {
        // Repeats up to 25× per file on context reload — take the first, ignore the rest.
        if (metaSeen || !p) return true;
        metaSeen = true;
        threadSource = p.thread_source;
        s.id = p.id || p.session_id || s.id;
        s.cwd = p.cwd || null;
        s.cliVersion = p.cli_version || null;
        s.forkedFrom = p.forked_from_id || null;
        s.gitBranch = p.git?.branch || null;
        // `source` is polymorphic: string ×113, object ×104 (docs §4.2 Finding 4).
        const src = typeof p.source === 'string' ? p.source : null;
        s.origin = p.originator || src || null;
        s.isSidechain = threadSource === 'subagent';
        // SPEC docs §4.2 Finding 3: the dedup axis is thread_source, NOT forked_from_id.
        // 105 of 217 files are subagent threads and 8 are automation runs; their prompts are
        // orchestrator-authored. Bail out here and the biggest files never get read.
        if (!ctx.keepAll) {
          const human =
            threadSource === undefined ||
            threadSource === 'user' ||
            threadSource === 'realtime_voice';
          if (!human) return false;
        }
        return true;
      }

      if (o.type === 'turn_context') {
        if (p?.model) {
          lastTurnModel = p.model;
          modelCount[p.model] = (modelCount[p.model] || 0) + 1;
        }
        if (p?.cwd && !s.cwd) s.cwd = p.cwd;
        return true;
      }

      if (!p) return true;

      if (o.type === 'response_item') {
        switch (p.type) {
          case 'function_call':
          case 'custom_tool_call':
            tool(p.name);
            if (p.call_id && seenCallIds.size < MAX_CALL_IDS) seenCallIds.add(p.call_id);
            break;
          case 'web_search_call':
            tool('web_search');
            break;
          default:
            break; // response_item/message role:user is NEVER a human turn (docs §4.3)
        }
        return true;
      }

      if (o.type !== 'event_msg') return true;

      switch (p.type) {
        case 'user_message': {
          const text = extractCodexPrompt(p.message);
          if (!text) return true;
          s.counts.humanTurns++;
          s.counts.humanWords += wordCount(text);
          s.counts.humanChars += [...text].length;
          if (s.humanTurns.length < MAX_TURNS) {
            s.humanTurns.push(makeTurn(Number.isFinite(ts) ? ts : 0, text, HUMAN_TEXT_CAP));
          }
          break;
        }
        case 'agent_message': {
          const text = typeof p.message === 'string' ? p.message.trim() : '';
          if (!text) break;
          s.counts.agentTurns++;
          s.counts.agentWords += wordCount(text);
          s.counts.agentChars += [...text].length;
          if (s.agentTurns.length < MAX_TURNS) {
            s.agentTurns.push(makeTurn(Number.isFinite(ts) ? ts : 0, text, AGENT_TEXT_CAP));
          }
          break;
        }
        case 'agent_reasoning': {
          const text = typeof p.text === 'string' ? p.text : '';
          if (!text) break;
          s.thinkingChars += text.length;
          if (text.length > s.maxThinkChars) s.maxThinkChars = text.length;
          if (s.reasoning.length < MAX_REASONING) {
            s.reasoning.push(
              makeTurn(Number.isFinite(ts) ? ts : 0, reasoningHeadline(text), REASON_TEXT_CAP),
            );
          }
          break;
        }
        case 'token_count': {
          // Sum per-turn deltas, never the running totals (docs §4.6).
          const u = p.info?.last_token_usage;
          if (!u) break;
          const cached = u.cached_input_tokens || 0;
          const input = u.input_tokens || 0;
          s.tokens.in += Math.max(0, input - cached); // Codex input INCLUDES cache
          s.tokens.cacheRead += cached;
          s.tokens.cacheWrite += u.cache_write_input_tokens || 0;
          s.tokens.out += u.output_tokens || 0;
          s.tokens.reasoning += u.reasoning_output_tokens || 0;
          break;
        }
        case 'turn_aborted': {
          // Payload is exactly {type, turn_id, reason} — no duration anywhere (docs §4.9).
          if (s.interrupts.length >= MAX_INTERRUPTS) break;
          const at = Number.isFinite(ts) ? ts : 0;
          const started = p.turn_id ? taskStarted.get(p.turn_id) : undefined;
          let durationMs = started ? at - started : null;
          if (durationMs !== null && (durationMs < 0 || durationMs > 86_400_000)) durationMs = null;
          s.interrupts.push({ ts: at, durationMs });
          break;
        }
        case 'task_started': {
          // started_at is epoch SECONDS here (docs §4.5) while sibling fields are ms.
          if (p.turn_id && typeof p.started_at === 'number') {
            taskStarted.set(p.turn_id, p.started_at * 1000);
          }
          break;
        }
        case 'patch_apply_end': {
          if (p.success !== true || !p.changes) break;
          for (const path of Object.keys(p.changes)) {
            if (!files.has(path) && files.size >= MAX_FILES) break;
            files.set(path, (files.get(path) || 0) + 1);
          }
          break;
        }
        case 'mcp_tool_call_end': {
          // These duplicate function_call records for tools the model called directly (verified:
          // 1199 shared call_ids), so only count calls with no matching function_call.
          // `node_repl` is excluded entirely: it is the sandbox that BACKS the `exec` tool, so its
          // events are the same work seen one layer down — counting them inflated `js` 1226 → 8865.
          if (p.call_id && seenCallIds.has(p.call_id)) break;
          const inv = p.invocation;
          if (!inv?.tool || BUILTIN_MCP_SERVERS.has(inv.server)) break;
          tool(inv.server ? `mcp__${inv.server}__${inv.tool}` : inv.tool);
          break;
        }
        case 'thread_settings_applied': {
          const m = p.thread_settings?.model;
          if (m) settingsModel = m;
          break;
        }
        case 'sub_agent_activity':
          // NOT a spawn. This is a lifecycle stream — kinds are started /
          // interacted / interrupted, and on this corpus 203 events describe 58
          // agents. Every `started` event_id is also a `spawn_agent` call_id, so
          // counting these on top of the tool call inflated "sub-agents spawned"
          // from 93 to 303 and handed out a "Swarm Lord" archetype for it.
          // `spawn_agent` in tool() is the one true count.
          break;
        case 'web_search_end':
          break;
        default:
          break;
      }
      return true;
    },

    /** @returns {object|null} */
    finish() {
      if (!metaSeen && !ctx.keepAll) return null; // no session_meta → not a Codex session file
      if (!ctx.keepAll && threadSource !== undefined) {
        if (threadSource !== 'user' && threadSource !== 'realtime_voice') return null;
      }
      if (!stamps.length) return null;
      // Model attribution: one vote per session (docs §10), last turn_context wins because it
      // reflects what the session actually ran on; thread_settings_applied is the fallback.
      s.model = lastTurnModel || settingsModel || null;
      const ordered = modelsByCount(modelCount);
      if (settingsModel && !ordered.includes(settingsModel)) ordered.push(settingsModel);
      if (s.model) s.models = [s.model, ...ordered.filter((m) => m !== s.model)];
      else s.models = ordered;
      s.project = projectOf(s.cwd);
      s.filesTouched = [...files.keys()];
      s.fileCounts = Object.fromEntries(files);
      Object.assign(s, timingFrom(stamps, idleGapMs));
      return s;
    },
  };
}

/**
 * Create the right parser for an agent.
 * @param {'claude'|'codex'} agent
 * @param {{file:string,id?:string,idleGapMs?:number,keepAll?:boolean}} ctx
 */
export function createParser(agent, ctx) {
  return agent === 'claude' ? createClaudeParser(ctx) : createCodexParser(ctx);
}

/**
 * Test/utility helper: run a parser over an array of JSONL strings.
 * @param {'claude'|'codex'} agent
 * @param {string[]} lines
 * @param {{file?:string,id?:string,idleGapMs?:number,keepAll?:boolean}} [ctx]
 * @returns {object|null} Session
 */
export function parseLines(agent, lines, ctx = {}) {
  const parser = createParser(agent, {
    file: ctx.file || `<memory>/${agent}.jsonl`,
    id: ctx.id ?? (agent === 'claude' ? 'test-session' : null),
    idleGapMs: ctx.idleGapMs,
    keepAll: ctx.keepAll,
  });
  for (const l of lines) {
    if (!l) continue;
    if (parser.line(Buffer.from(l, 'utf8')) === false) break;
  }
  return parser.finish();
}
