/**
 * codepend — the Cursor adapter.
 *
 * Cursor does not keep JSONL transcripts. It keeps SQLite, in two databases that live side by
 * side under `User/globalStorage/` and that know about each other only through a shared id:
 *
 *   state.vscdb              the real store. A key/value table (`cursorDiskKV`) holding
 *                            `composerData:<id>` (one blob per conversation) and
 *                            `bubbleId:<id>:<bubbleId>` (one blob per message), plus a
 *                            `composerHeaders` table that is a cheap index over the former.
 *   conversation-search.db   the search index. One row per conversation in `conversations`
 *                            (id, title, updated_at) and a flattened FTS body.
 *
 * The brief for this adapter was written against `conversation-search.db` alone, on the
 * assumption that it was the only store. Measured on the real corpus here, that store is
 * close to useless as a transcript:
 *
 *   - 701 conversations, of which 195 have an empty FTS body.
 *   - Of the 506 with a body, **4** use the `user:` / `assistant:` line markers. The other 502
 *     are one undelimited blob of concatenated user and assistant prose with no way to tell
 *     which is which. The measured 12-user / 45-assistant ratio is not a coverage ratio; it is
 *     the whole marker population, and it comes from those 4 conversations.
 *   - `updated_at` is the only time signal, one per conversation.
 *
 * `state.vscdb` has all of it: per-message role (`type` 1 = user, 2 = assistant), per-message
 * ISO timestamps, model names, tool calls with arguments, token counts, workspace ids that
 * resolve to real project paths, and a subagent flag. So this adapter reads `state.vscdb` as
 * the transcript and uses `conversation-search.db` for titles and as a fallback clock for
 * conversations that exist only in the search index (cloud-cache rows with no local blob).
 *
 * Everything here is optional and independent. A missing database, an unreadable database, a
 * schema that has moved on, a Node without `node:sqlite` — each degrades to "fewer sessions",
 * never to a throw.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IDLE_GAP_MS, wordCount } from '../normalize.js';

/** Bump when Cursor extraction changes. Folded into the scan cache key. */
export const CURSOR_PARSER_VERSION = 1;

/** The single line the CLI prints when `node:sqlite` is not available. Exactly once. */
export const CURSOR_NEEDS_NODE_22 = 'Cursor history needs Node 22+ — skipped';

/* Mirrors of the private caps in src/normalize.js. Kept in sync by hand: the Session contract
 * is what is shared between adapters, not the helpers. */
const HUMAN_TEXT_CAP = 2000;
const AGENT_TEXT_CAP = 800;
const REASON_TEXT_CAP = 240;
const MAX_TURNS = 5000;
const MAX_REASONING = 5000;
const MAX_FILES = 800;
const MAX_BURSTS = 500;

/** A `rawArgs` blob can carry an entire file. Only the head is ever searched for a path. */
const RAW_ARGS_HEAD = 2048;
/** Refuse to copy a database bigger than this when the original is locked (state.vscdb is 8 GB). */
const MAX_COPY_BYTES = 512 << 20;
/** `--since` prefilter slack: the header clock lags the newest bubble by minutes, not days. */
const SINCE_SLACK_MS = 6 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ *
 * where Cursor keeps things
 * ------------------------------------------------------------------ */

/**
 * Default `User/globalStorage` directory for this platform.
 * @param {{env?: NodeJS.ProcessEnv, platform?: string, home?: string}} [ctx]
 * @returns {string}
 */
export function defaultCursorDir(ctx = {}) {
  const env = ctx.env || process.env;
  const platform = ctx.platform || process.platform;
  const home = ctx.home || env.CODEPEND_HOME || os.homedir();
  if (env.CODEPEND_CURSOR_DIR) return path.resolve(expandHome(env.CODEPEND_CURSOR_DIR, home));
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'Cursor', 'User', 'globalStorage');
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage');
  }
  const xdg = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.startsWith('/')
    ? env.XDG_CONFIG_HOME
    : path.join(home, '.config');
  return path.join(xdg, 'Cursor', 'User', 'globalStorage');
}

function expandHome(p, home) {
  return p.startsWith('~') ? path.join(home, p.slice(1)) : p;
}

/**
 * Accept the `globalStorage` directory, its `User` parent, or the Cursor root — people will
 * pass all three, and guessing wrong is a silent empty feed.
 * @param {string} dir
 * @returns {{globalStorage:string, stateDb:string, searchDb:string, workspaceStorage:string}}
 */
export function cursorPaths(dir) {
  let abs = path.resolve(dir);
  const base = path.basename(abs);
  if (base === 'User') abs = path.join(abs, 'globalStorage');
  else if (base !== 'globalStorage' && base !== '') {
    // `.../Cursor` (or anything else): try the conventional layout underneath it.
    const nested = path.join(abs, 'User', 'globalStorage');
    abs = nested;
  }
  return {
    globalStorage: abs,
    stateDb: path.join(abs, 'state.vscdb'),
    searchDb: path.join(abs, 'conversation-search.db'),
    workspaceStorage: path.join(path.dirname(abs), 'workspaceStorage'),
  };
}

/* ------------------------------------------------------------------ *
 * node:sqlite, carefully
 * ------------------------------------------------------------------ */

/**
 * `node:sqlite` shipped in Node 22.5 and the package declares `engines: >=18`, so it is a
 * runtime feature, not a build-time one. It also emits an ExperimentalWarning on import, which
 * would put a Node stack trace in the terminal of a tool whose whole pitch is that it is quiet.
 *
 * @returns {() => void} restores the real `process.emitWarning`
 */
function muteSqliteWarning() {
  const original = process.emitWarning;
  process.emitWarning = function patched(warning, ...rest) {
    const isObj = warning !== null && typeof warning === 'object';
    const name = String(isObj ? warning.name : rest[0] ?? '');
    const message = String(isObj ? warning.message : warning);
    // Narrow on purpose: only SQLite's own experimental notice, never anyone else's warning.
    if (name === 'ExperimentalWarning' && /sqlite/i.test(message)) return undefined;
    return original.call(process, warning, ...rest);
  };
  return () => {
    process.emitWarning = original;
  };
}

/** @type {Promise<Function|null>|null} */
let sqlitePromise = null;

/**
 * @returns {Promise<Function|null>} the `DatabaseSync` constructor, or null on Node < 22.5
 *   (or any build without the SQLite module compiled in).
 */
export function loadSqlite() {
  if (sqlitePromise) return sqlitePromise;
  sqlitePromise = (async () => {
    const restore = muteSqliteWarning();
    try {
      const mod = await import('node:sqlite');
      return typeof mod.DatabaseSync === 'function' ? mod.DatabaseSync : null;
    } catch {
      return null;
    } finally {
      restore();
    }
  })();
  return sqlitePromise;
}

/** Test seam: forget the cached feature detection. */
export function resetSqliteCache() {
  sqlitePromise = null;
}

async function statSafe(file) {
  try {
    const st = await fs.stat(file);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

/**
 * Open a Cursor database for reading and nothing else.
 *
 * `readOnly: true` is the guarantee — SQLite is opened with SQLITE_OPEN_READONLY, so no write,
 * no checkpoint, no journal rollback can touch the user's file. The one thing it cannot do is
 * read a WAL database whose `-shm` it is not allowed to map; that is what a running Cursor
 * looks like on some systems. In that case we fall back to a private copy of the db and its
 * sidecars, which leaves the originals untouched, and we refuse to do even that if the file is
 * large enough that copying it would be its own kind of rude.
 *
 * @param {Function} DatabaseSync
 * @param {string} file
 * @returns {Promise<{db:object, close:()=>Promise<void>}|null>}
 */
export async function openCursorDb(DatabaseSync, file) {
  const st = await statSafe(file);
  if (!st || st.size === 0) return null;

  const restore = muteSqliteWarning();
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    // A handle can open lazily; force a page read so a locked db fails here and not later.
    db.prepare('select count(*) from sqlite_master').get();
    return { db, close: async () => closeQuietly(db) };
  } catch {
    /* locked, or a WAL we cannot map — fall through to the copy */
  } finally {
    restore();
  }

  if (st.size > MAX_COPY_BYTES) return null;
  return copyAndOpen(DatabaseSync, file);
}

/** @returns {Promise<{db:object, close:()=>Promise<void>}|null>} */
async function copyAndOpen(DatabaseSync, file) {
  let tmpDir = null;
  const restore = muteSqliteWarning();
  try {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codepend-cursor-'));
    const copy = path.join(tmpDir, path.basename(file));
    // The sidecars matter: without `-wal` the copy is the database as of the last checkpoint,
    // which on a busy Cursor can be days behind.
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        await fs.copyFile(file + suffix, copy + suffix);
      } catch {
        if (suffix === '') throw new Error('copy failed');
      }
    }
    const db = new DatabaseSync(copy, { readOnly: true });
    db.prepare('select count(*) from sqlite_master').get();
    const dir = tmpDir;
    return {
      db,
      close: async () => {
        closeQuietly(db);
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      },
    };
  } catch {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    return null;
  } finally {
    restore();
  }
}

function closeQuietly(db) {
  try {
    db.close();
  } catch {
    /* already closed, or closed by a failed open */
  }
}

/** Run a query, and treat a schema that has moved on as "no rows". */
function query(db, sql, ...params) {
  try {
    return db.prepare(sql).all(...params);
  } catch {
    return [];
  }
}

function hasTable(db, name) {
  return query(db, "select name from sqlite_master where type='table' and name=?", name).length > 0;
}

/* ------------------------------------------------------------------ *
 * projects
 * ------------------------------------------------------------------ */

/**
 * `composerHeaders.workspaceId` is the same hash VS Code uses for `workspaceStorage/<id>/`,
 * and that directory holds a `workspace.json` naming the real folder. This is the only honest
 * project signal Cursor exposes — `conversations.scope` is an opaque digest and is never used
 * to invent a name.
 *
 * @param {string} workspaceStorage
 * @returns {Promise<Map<string,string>>} workspaceId -> absolute folder path
 */
export async function readWorkspaceFolders(workspaceStorage) {
  const out = new Map();
  let entries;
  try {
    entries = await fs.readdir(workspaceStorage, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    let raw;
    try {
      raw = await fs.readFile(path.join(workspaceStorage, e.name, 'workspace.json'), 'utf8');
    } catch {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const uri = parsed?.folder || parsed?.workspace;
    const folder = fileUriToPath(uri);
    if (folder) out.set(e.name, folder);
  }
  return out;
}

/** `file:///Users/x/y` -> `/Users/x/y`. Anything else -> null. */
function fileUriToPath(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file://')) return null;
  try {
    const p = decodeURIComponent(uri.slice('file://'.length));
    if (!p || p === '/') return null;
    // `file:///C:/x` on Windows.
    return /^\/[a-zA-Z]:\//.test(p) ? p.slice(1) : p;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * session assembly
 * ------------------------------------------------------------------ */

/** Session skeleton — the same contract shape src/normalize.js builds, filled from Cursor. */
function blankCursorSession(id, source) {
  return {
    id,
    agent: 'cursor',
    source,
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

    model: null,
    origin: 'cursor',
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
    unsent: [],
    maxThinkChars: 0,
    fileCounts: Object.create(null),
    spanMs: 0,
    bursts: [],
  };
}

function clip(text, cap) {
  if (text.length <= cap) return text;
  return Array.from(text).slice(0, cap).join('');
}

function makeTurn(ts, text, cap) {
  return {
    ts,
    text: clip(text, cap),
    chars: [...text].length,
    words: wordCount(text),
    truncated: text.length > cap,
  };
}

/**
 * Contiguous-burst timing. Mirrors `timingFrom` in src/normalize.js so a Cursor hour and a
 * Claude hour mean the same thing: idle gaps are not charged, and Σ burst.durationMs ===
 * durationMs.
 * @param {number[]} stamps
 * @param {number} idleGapMs
 */
function timingFrom(stamps, idleGapMs) {
  if (!stamps.length) return { startedAt: 0, endedAt: 0, durationMs: 0, spanMs: 0, bursts: [] };
  stamps.sort((a, b) => a - b);
  let dur = 0;
  const bursts = [];
  let bStart = stamps[0];
  let bDur = 0;
  for (let i = 1; i < stamps.length; i++) {
    const d = stamps[i] - stamps[i - 1];
    if (d > 0 && d <= idleGapMs) {
      dur += d;
      bDur += d;
    } else if (d > idleGapMs) {
      if (bursts.length < MAX_BURSTS) bursts.push({ startedAt: bStart, endedAt: stamps[i - 1], durationMs: bDur });
      bStart = stamps[i];
      bDur = 0;
    }
  }
  if (bursts.length < MAX_BURSTS) {
    bursts.push({ startedAt: bStart, endedAt: stamps[stamps.length - 1], durationMs: bDur });
  }
  return {
    startedAt: stamps[0],
    endedAt: stamps[stamps.length - 1],
    durationMs: dur,
    spanMs: stamps[stamps.length - 1] - stamps[0],
    bursts,
  };
}

function projectOf(cwd) {
  if (!cwd) return null;
  const parts = String(cwd).split(/[/\\]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

/** Lexical rich-text (what Cursor stores next to `text` for user bubbles) -> plain text. */
function richTextToPlain(rich) {
  if (typeof rich !== 'string' || !rich.startsWith('{')) return '';
  let doc;
  try {
    doc = JSON.parse(rich);
  } catch {
    return '';
  }
  const parts = [];
  const walk = (node, depth) => {
    if (!node || depth > 12 || parts.length > 400) return;
    // Lexical text nodes already carry their own spacing; joining them with anything inserts
    // gaps that were never typed.
    if (typeof node.text === 'string' && node.text) parts.push(node.text);
    const kids = node.children;
    if (Array.isArray(kids)) {
      for (const k of kids) walk(k, depth + 1);
      // A paragraph break is a newline, not a space.
      if (depth === 1) parts.push('\n');
    }
  };
  walk(doc.root, 0);
  return parts.join('').trim();
}

/**
 * Pull a file path out of a tool call's arguments without parsing the arguments.
 * `rawArgs` is a JSON *string* whose `streamContent` can be an entire source file; parsing it
 * for every one of 122 471 bubbles is the difference between a scan and a coffee break.
 */
const RE_ARG_PATH = /"(?:path|target_file|file_path|relative_workspace_path|filePath)"\s*:\s*"((?:[^"\\]|\\.){1,512})"/;

function pathFromRawArgs(rawArgs) {
  if (typeof rawArgs !== 'string' || !rawArgs) return null;
  const m = RE_ARG_PATH.exec(rawArgs.length > RAW_ARGS_HEAD ? rawArgs.slice(0, RAW_ARGS_HEAD) : rawArgs);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return null;
  }
}

/** Tools whose invocation means a file actually changed, as opposed to being read. */
const EDIT_TOOLS = new Set([
  'edit_file',
  'edit_file_v2',
  'search_replace',
  'write',
  'write_file',
  'create_file',
  'delete_file',
  'MultiEdit',
  'apply_patch',
  'str_replace_editor',
]);

/**
 * Split a `conversation_fts` body into turns — but only when it says which is which.
 *
 * The body uses line-leading `user:` / `assistant:` markers. Measured on the real corpus:
 * 4 conversations out of 701 actually carry them. The other 502 non-empty bodies are one
 * undelimited run of concatenated user and assistant prose.
 *
 * Unmarked bodies return nothing. They *could* be attributed to the human — the blob usually
 * opens with the opening prompt — but the memories built from human turns are the quote cards,
 * the ones that put words in the reader's mouth. Guessing there would put the assistant's
 * sentences in quotation marks under the reader's name, which is worse than a thinner feed.
 *
 * @param {string|null|undefined} body
 * @returns {{human:string[], agent:string[]}}
 */
export function parseFtsBody(body) {
  const out = { human: [], agent: [] };
  if (typeof body !== 'string' || !body) return out;
  const re = /^(user|assistant):[ \t]*/gim;
  const marks = [];
  for (let m = re.exec(body); m; m = re.exec(body)) {
    // `at` is where the marker line starts, `from` where its text does. The next marker's `at`
    // is this turn's end — using its `from` would swallow the marker word into the turn above.
    marks.push({ role: m[1].toLowerCase(), at: m.index, from: m.index + m[0].length });
  }
  if (!marks.length) return out;
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].at : body.length;
    const text = body.slice(marks[i].from, Math.max(end, marks[i].from)).trim();
    if (!text) continue;
    (marks[i].role === 'user' ? out.human : out.agent).push(text);
  }
  return out;
}

/**
 * Turn one conversation's raw parts into a Session.
 *
 * @param {object} input
 * @param {string} input.id                      composer / conversation id
 * @param {string} input.source                  which database this came from
 * @param {object|null} input.header             row from `composerHeaders`
 * @param {object|null} input.composer           parsed `composerData:<id>` blob
 * @param {object|null} input.conversation       row from `conversations`
 * @param {Array<{key:string,value:string}>} input.bubbles raw `bubbleId:<id>:*` rows
 * @param {string} [input.body]                  `conversation_fts` body, for cloud-only rows
 * @param {Map<string,string>} input.workspaces  workspaceId -> folder
 * @param {number} input.idleGapMs
 * @returns {object|null} a Session, or null when there is nothing here at all
 */
export function buildCursorSession(input) {
  const { id, source, header, composer, conversation, bubbles, body, workspaces, idleGapMs } = input;
  const s = blankCursorSession(id, source);

  s.title = firstString(composer?.name, conversation?.title, composer?.text) || null;

  // ---- project ---------------------------------------------------------
  const cwd = firstString(
    workspaces?.get(header?.workspaceId),
    fileUriToPath(composer?.draftTarget?.environment?.uri?.external),
    composer?.draftTarget?.environment?.uri?.fsPath,
  );
  if (cwd) {
    s.cwd = cwd;
    s.project = projectOf(cwd);
  }

  // ---- model -----------------------------------------------------------
  const modelName = firstString(composer?.modelConfig?.modelName);
  // `default` is Cursor's "let the router pick" setting, not a model. Recording it as one puts
  // a fake winner at the top of the model chart for a third of all conversations.
  if (modelName && modelName !== 'default') {
    // Multi-model conversations store a comma-joined list.
    for (const m of modelName.split(',').map((x) => x.trim()).filter(Boolean)) {
      if (m !== 'default' && !s.models.includes(m)) s.models.push(m);
    }
  }
  s.model = s.models.length ? s.models[0] : null;

  // ---- subagents -------------------------------------------------------
  s.isSidechain = !!(header?.isSubagent) || !!composer?.isBestOfNSubcomposer;
  const subs = composer?.subComposerIds;
  if (Array.isArray(subs)) s.subagents = subs.length;

  // ---- bubbles ---------------------------------------------------------
  // The key order of `bubbleId:<cid>:<uuid>` is uuid order, which is nothing. Real order is
  // `fullConversationHeadersOnly`; fall back to timestamp, then to key, so the output is
  // deterministic either way.
  const order = new Map();
  const headers = composer?.fullConversationHeadersOnly;
  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length; i++) {
      const bid = headers[i]?.bubbleId;
      if (typeof bid === 'string') order.set(bid, i);
    }
  }

  // Two passes, and the first one throws the blob away.
  //
  // A bubble blob averages ~15 KB — code blocks, retrieved context chunks, diffs, capability
  // records — of which this adapter keeps a handful of fields. Retaining the parsed blob until
  // the end of the conversation (which is what holding `v` in this array did) put the whole
  // conversation live at once, and V8 sizes the heap from the live set: on a real corpus that
  // was ~2.6 GB of heap for ~9 MB of sessions. Extracting eagerly is the difference.
  //
  // Everything order-independent (thinking totals) is folded straight into `s` here. Everything
  // that depends on turn order — the turn arrays, the carried-forward clock, the order
  // `filesTouched` is filled in — waits for the sort below.
  const parsed = [];
  for (const row of bubbles || []) {
    s.counts.lines++;
    let v;
    try {
      v = JSON.parse(typeof row.value === 'string' ? row.value : String(row.value));
    } catch {
      s.counts.skippedLines++;
      continue;
    }
    if (!v || typeof v !== 'object') {
      s.counts.skippedLines++;
      continue;
    }
    const key = String(row.key);
    const bid = typeof v.bubbleId === 'string' ? v.bubbleId : key.slice(key.lastIndexOf(':') + 1);
    parsed.push(compactBubble(v, bid, key, order, s));
  }

  parsed.sort(
    (a, b) =>
      a.rank - b.rank ||
      (a.ts ?? Number.MAX_SAFE_INTEGER) - (b.ts ?? Number.MAX_SAFE_INTEGER) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );

  // Only ~37 % of bubbles carry `createdAt`. The rest get the timestamp of the most recent
  // bubble that did — carried forward, never invented, never interpolated into a gap. A turn
  // with no clock at all upstream of it is stamped with the conversation's own start.
  const fallbackTs = firstFinite(
    parsed.find((p) => p.ts !== null)?.ts,
    header?.createdAt,
    composer?.createdAt,
    conversation?.updated_at,
    header?.lastUpdatedAt,
  );
  let carried = fallbackTs;
  for (const p of parsed) {
    if (p.ts !== null) carried = p.ts;
    else p.ts = carried;
  }

  const stamps = [];
  const files = new Map();

  for (const p of parsed) {
    if (Number.isFinite(p.ts)) stamps.push(p.ts);

    // tools
    if (p.toolName) {
      s.tools[p.toolName] = (s.tools[p.toolName] || 0) + 1;
      s.counts.toolCalls++;
      if (p.toolFile) files.set(p.toolFile, (files.get(p.toolFile) || 0) + 1);
    }
    // Cursor marks a stopped generation on the tool call, not on the turn.
    if (p.toolCancelled && s.interrupts.length < 2000 && Number.isFinite(p.ts)) {
      s.interrupts.push({ ts: p.ts, durationMs: 0 });
    }

    // tokens
    if (p.tokens) {
      s.tokens.in += p.tokens.in;
      s.tokens.out += p.tokens.out;
      s.tokens.cacheRead += p.tokens.cacheRead;
      s.tokens.cacheWrite += p.tokens.cacheWrite;
    }

    // thinking (the totals were folded in during extraction; only the clock waits for order)
    if (p.thinking) {
      for (const t of p.thinking) {
        if (s.reasoning.length >= MAX_REASONING) break;
        s.reasoning.push({ ts: Number.isFinite(p.ts) ? p.ts : 0, ...t });
      }
    }

    // turns
    if (!p.turn) continue;
    if (p.type === 1) {
      s.counts.humanTurns++;
      s.counts.humanWords += p.turn.words;
      s.counts.humanChars += p.turn.chars;
      if (s.humanTurns.length < MAX_TURNS) s.humanTurns.push({ ts: p.ts ?? 0, ...p.turn });
    } else if (p.type === 2) {
      s.counts.agentTurns++;
      s.counts.agentWords += p.turn.words;
      s.counts.agentChars += p.turn.chars;
      if (s.agentTurns.length < MAX_TURNS) s.agentTurns.push({ ts: p.ts ?? 0, ...p.turn });
    }
  }

  for (const [file, n] of files) {
    if (s.filesTouched.length >= MAX_FILES) break;
    s.filesTouched.push(file);
    s.fileCounts[file] = n;
  }

  // A conversation that only exists in the search index — synced from another machine, with no
  // local `composerData` blob. The FTS body is all there is, and `updated_at` is the only clock
  // it will ever have, so every turn carries it. That is not a per-message timestamp and is not
  // dressed up as one: these sessions have no duration.
  if (!s.humanTurns.length && !s.agentTurns.length && body) {
    const split = parseFtsBody(body);
    const ts = firstFinite(conversation?.updated_at, header?.lastUpdatedAt, header?.createdAt) ?? 0;
    for (const text of split.human) {
      s.counts.humanTurns++;
      s.counts.humanWords += wordCount(text);
      s.counts.humanChars += [...text].length;
      if (s.humanTurns.length < MAX_TURNS) s.humanTurns.push(makeTurn(ts, text, HUMAN_TEXT_CAP));
    }
    for (const text of split.agent) {
      s.counts.agentTurns++;
      s.counts.agentWords += wordCount(text);
      s.counts.agentChars += [...text].length;
      if (s.agentTurns.length < MAX_TURNS) s.agentTurns.push(makeTurn(ts, text, AGENT_TEXT_CAP));
    }
    if (Number.isFinite(ts) && ts > 0 && !stamps.length) stamps.push(ts);
  }

  // ---- timing ----------------------------------------------------------
  // The header clock is authoritative for the *edges* only when we have no bubbles: measured
  // here, `composerHeaders.lastUpdatedAt` can sit minutes behind the newest bubble.
  const headerStart = firstFinite(header?.createdAt, composer?.createdAt);
  const headerEnd = firstFinite(header?.lastUpdatedAt, header?.recency, conversation?.updated_at);
  if (stamps.length) {
    if (Number.isFinite(headerStart) && headerStart < stamps[0]) stamps.push(headerStart);
    if (Number.isFinite(headerEnd) && headerEnd > stamps[stamps.length - 1]) stamps.push(headerEnd);
  } else {
    for (const t of [headerStart, headerEnd]) if (Number.isFinite(t)) stamps.push(t);
  }

  const timing = timingFrom(stamps, idleGapMs ?? IDLE_GAP_MS);
  s.startedAt = timing.startedAt;
  s.endedAt = timing.endedAt;
  s.durationMs = timing.durationMs;
  s.spanMs = timing.spanMs;
  s.bursts = timing.bursts;

  // Nothing at all: no text, no tools, no clock. Cursor keeps a lot of these — empty drafts,
  // `empty-state-draft`, abandoned composers — and each one would otherwise count as a session
  // and quietly inflate the only number on the page nobody can check.
  if (!s.startedAt) return null;
  const hasContent = s.humanTurns.length || s.agentTurns.length || s.counts.toolCalls;
  // A titled conversation with a real clock is a real conversation, even when the transcript
  // did not survive the sync. It counts as a day you were here; it contributes no words.
  if (!hasContent && !s.title) return null;

  return s;
}

/**
 * Reduce one parsed bubble blob to the handful of fields this adapter uses, so the blob itself
 * becomes garbage the moment this returns.
 *
 * Order-independent totals (`thinkingChars`, `maxThinkChars`) are folded into `s` right here;
 * everything the sort can reorder is left on the record for the second pass.
 *
 * @param {object} v      the parsed `bubbleId:…` blob
 * @param {string} bid
 * @param {string} key
 * @param {Map<string, number>} order  bubbleId -> position in `fullConversationHeadersOnly`
 * @param {object} s      the session under construction
 */
function compactBubble(v, bid, key, order, s) {
  const rec = {
    bid,
    key,
    ts: parseIso(v.createdAt),
    rank: order.has(bid) ? order.get(bid) : Number.MAX_SAFE_INTEGER,
    type: v.type,
    turn: null,
    toolName: null,
    toolFile: null,
    toolCancelled: false,
    tokens: null,
    thinking: null,
  };

  const tool = v.toolFormerData;
  if (tool && typeof tool === 'object') {
    const name = typeof tool.name === 'string' && tool.name ? tool.name : null;
    if (name) {
      rec.toolName = name;
      // Only edit tools can contribute a touched file, so only they pay for the path scan.
      if (EDIT_TOOLS.has(name)) rec.toolFile = pathFromRawArgs(tool.rawArgs);
    }
    const status = String(tool.status || tool.additionalData?.status || '');
    if (/cancel|abort|interrupt/i.test(status)) rec.toolCancelled = true;
  }

  const tk = v.tokenCount;
  if (tk && typeof tk === 'object') {
    rec.tokens = {
      in: num(tk.inputTokens),
      out: num(tk.outputTokens),
      cacheRead: num(tk.cacheReadTokens ?? tk.cachedTokens),
      cacheWrite: num(tk.cacheWriteTokens),
    };
  }

  const blocks = v.allThinkingBlocks;
  if (Array.isArray(blocks)) {
    for (const b of blocks) {
      const text = firstString(typeof b === 'string' ? b : b?.text, b?.signature ? '' : undefined);
      if (!text) continue;
      const chars = [...text].length;
      s.thinkingChars += chars;
      if (chars > s.maxThinkChars) s.maxThinkChars = chars;
      // Clipped now, at 240 chars, rather than carrying the whole thought to the second pass.
      const { ts: _drop, ...body } = makeTurn(0, text, REASON_TEXT_CAP);
      (rec.thinking ||= []).push(body);
    }
  }

  if (v.type === 1 || v.type === 2) {
    const raw = firstString(v.text, richTextToPlain(v.richText));
    const text = v.type === 1 ? extractCursorPrompt(raw) : raw;
    if (text && text.trim()) {
      const { ts: _drop, ...body } = makeTurn(0, text, v.type === 1 ? HUMAN_TEXT_CAP : AGENT_TEXT_CAP);
      rec.turn = body;
    }
  }

  return rec;
}

/** Bubbles Cursor stores as `type: 1` that no human typed. */
const CURSOR_TAG_WRAPPER = /^<[A-Za-z_][\w.-]*(\s[^>]*)?>/;
const CURSOR_INJECTED = /(system[_-]?reminder|task-notification|following task has finished|ignore this notification|they are already aware|<automation|Automation ID:)/i;
/**
 * Cursor's own button prompts. Clicking "Implement plan" or a diff-tab action
 * sends a fixed template as a `type: 1` bubble, indistinguishable from typing.
 * Measured here: the plan template was the single most repeated "human" turn at
 * 102 occurrences — more than twice the most common thing this person actually
 * typed. Counting a button as a catchphrase would put words in their mouth.
 */
const CURSOR_UI_TEMPLATE =
  /^(Implement the plan as specified|Execute the selected diff-tab|Continue the conversation from where|Fix the linter errors? in|Explain the (selected|highlighted))/i;

/**
 * Pull the human's actual words out of a Cursor user bubble.
 *
 * Cursor writes injected context — rule reminders, background-task
 * notifications, automation payloads — into the same `type: 1` bubbles as typed
 * prompts, with nothing to tell them apart but their shape. Measured here: 143
 * of 5 012 "human" turns, which is only 2.9% but they repeat verbatim, so they
 * swamped the catchphrase miner. The top two phrases the card offered were
 * «following task has finished» and «aware ignore this notification» — neither
 * of which anyone typed.
 *
 * Same shape as `extractCodexPrompt` in normalize.js, and the same lesson:
 * telling a typed prompt from injected context is the correctness crux of every
 * adapter, and getting it wrong is not a small error — it decides what the
 * product claims you said.
 *
 * @param {string|null} raw
 * @returns {string|null} the typed text, or null if machine-authored
 */
export function extractCursorPrompt(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!t) return null;
  if (CURSOR_TAG_WRAPPER.test(t)) return null;
  if (CURSOR_INJECTED.test(t)) return null;
  if (CURSOR_UI_TEMPLATE.test(t)) return null;
  return t;
}

function num(v) {
  return Number.isFinite(v) ? v : 0;
}

function firstString(...vals) {
  for (const v of vals) {
    if (typeof v === 'string') {
      const t = v.trim();
      if (t) return t;
    }
  }
  return null;
}

function firstFinite(...vals) {
  for (const v of vals) if (Number.isFinite(v)) return v;
  return undefined;
}

/** ISO 8601 -> epoch ms, or null. Cursor stores bubble times as strings. */
function parseIso(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/* ------------------------------------------------------------------ *
 * enumeration
 * ------------------------------------------------------------------ */

/**
 * Cheap pass: everything except the message bodies.
 *
 * This is what makes `--since` and the cache pay off. `composerHeaders` is 860 rows of
 * fixed-width columns and `conversations` is 701 — both are milliseconds. Bubble bodies are
 * 1.76 GB and are only read for conversations that survive this pass and miss the cache.
 *
 * @returns {{id:string, endHint:number, fingerprint:string, hasLocal:boolean}[]}
 */
function enumerateConversations({ stateDb, searchDb }) {
  /** @type {Map<string, {id:string, header:object|null, conversation:object|null}>} */
  const byId = new Map();

  if (stateDb && hasTable(stateDb, 'composerHeaders')) {
    for (const h of query(
      stateDb,
      'select composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, checkpointAt from composerHeaders',
    )) {
      if (typeof h?.composerId !== 'string' || !h.composerId) continue;
      byId.set(h.composerId, { id: h.composerId, header: h, conversation: null });
    }
  }

  if (searchDb && hasTable(searchDb, 'conversations')) {
    for (const c of query(searchDb, 'select id, title, updated_at, is_archived, source from conversations')) {
      if (typeof c?.id !== 'string' || !c.id) continue;
      const prev = byId.get(c.id);
      if (prev) prev.conversation = c;
      else byId.set(c.id, { id: c.id, header: null, conversation: c });
    }
  }

  return byId;
}

/**
 * @param {Map<string, {id:string, header:object|null, conversation:object|null}>} byId
 * @returns {{id:string, header:object|null, conversation:object|null, endHint:number, fingerprint:string, hasLocal:boolean}[]}
 */
function withHints(byId) {

  return [...byId.values()].map((e) => {
    const end = firstFinite(
      maxFinite(e.header?.lastUpdatedAt, e.header?.recency, e.header?.checkpointAt, e.conversation?.updated_at),
      e.header?.createdAt,
      0,
    );
    return {
      id: e.id,
      header: e.header,
      conversation: e.conversation,
      endHint: end || 0,
      // Cache identity. Any edit to a conversation moves at least one of these.
      fingerprint: `${CURSOR_PARSER_VERSION}:${e.header?.lastUpdatedAt ?? ''}:${e.header?.recency ?? ''}:${e.header?.checkpointAt ?? ''}:${e.conversation?.updated_at ?? ''}`,
      hasLocal: !!e.header,
    };
  });
}

function maxFinite(...vals) {
  let best;
  for (const v of vals) if (Number.isFinite(v) && (best === undefined || v > best)) best = v;
  return best;
}

/**
 * `is_archived` on `conversations` and `composerHeaders` is Cursor's own "archived" toggle in
 * the chat list — a user moving an old thread out of the way. It is not a delete and it is not
 * a tombstone: 313 of 860 local conversations here are archived, and they hold real work with
 * real timestamps. Dropping them would silently delete a third of the history, so they are
 * kept. (Checked before deciding, as instructed.)
 */

/* ------------------------------------------------------------------ *
 * the scan
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} CursorScanOptions
 * @property {string} [dir]        `User/globalStorage` (or its parent)
 * @property {number|null} [since] epoch ms floor
 * @property {number} [idleGapMs]
 * @property {boolean} [includeSubagents=false]
 * @property {{get:Function,set:Function}} [cache]  the scan cache from src/cache.js
 * @property {(ev:object)=>void} [onProgress]
 * @property {(note:string)=>void} [onNote]
 * @property {Function|null} [sqlite]  test seam: the `DatabaseSync` constructor to use.
 *   `undefined` feature-detects, `null` forces the "this Node has no SQLite" path.
 */

/**
 * Read every Cursor conversation on this machine.
 *
 * @param {CursorScanOptions} [opts]
 * @returns {Promise<{sessions:object[], keys:string[], stats:object, note:string|null}>}
 *   `keys` are the cache keys this scan owns, so the caller's cache pruning does not evict them.
 */
export async function scanCursor(opts = {}) {
  const stats = { conversations: 0, sessions: 0, cached: 0, parsed: 0, bubbles: 0, bytes: 0, skipped: 0 };
  const empty = { sessions: [], keys: [], stats, note: null };

  const paths = cursorPaths(opts.dir || defaultCursorDir());
  const hasAny = (await statSafe(paths.stateDb)) || (await statSafe(paths.searchDb));
  if (!hasAny) return empty;

  const DatabaseSync = 'sqlite' in opts ? opts.sqlite : await loadSqlite();
  if (!DatabaseSync) {
    // One line, once. Not a warning per conversation, not a stack trace.
    if (typeof opts.onNote === 'function') opts.onNote(CURSOR_NEEDS_NODE_22);
    return { ...empty, note: CURSOR_NEEDS_NODE_22 };
  }

  const stateHandle = await openCursorDb(DatabaseSync, paths.stateDb);
  const searchHandle = await openCursorDb(DatabaseSync, paths.searchDb);
  if (!stateHandle && !searchHandle) {
    // Both unreadable: Cursor is holding them in a way we will not fight over. Say so once.
    const note = 'Cursor history is locked by a running Cursor — skipped';
    if (typeof opts.onNote === 'function') opts.onNote(note);
    return { ...empty, note };
  }

  const idleGapMs = opts.idleGapMs ?? IDLE_GAP_MS;
  const since = Number.isFinite(opts.since) ? opts.since : null;
  const cache = opts.cache || null;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const workspaces = await readWorkspaceFolders(paths.workspaceStorage);

  const sessions = [];
  const keys = [];

  try {
    const entries = withHints(
      enumerateConversations({
        stateDb: stateHandle?.db || null,
        searchDb: searchHandle?.db || null,
      }),
    );
    stats.conversations = entries.length;

    // Deterministic: oldest conversation first, id as the tiebreak.
    entries.sort((a, b) => a.endHint - b.endHint || (a.id < b.id ? -1 : 1));

    const bubbleStmt = stateHandle && hasTable(stateHandle.db, 'cursorDiskKV')
      ? prepareQuiet(stateHandle.db, 'select key, value from cursorDiskKV where key >= ? and key < ?')
      : null;
    const composerStmt = stateHandle && hasTable(stateHandle.db, 'cursorDiskKV')
      ? prepareQuiet(stateHandle.db, 'select value from cursorDiskKV where key = ?')
      : null;
    // An index seek, not a read: answers "are there bubbles for this conversation" without
    // pulling a single blob off the page cache.
    const probeStmt = stateHandle && hasTable(stateHandle.db, 'cursorDiskKV')
      ? prepareQuiet(stateHandle.db, 'select 1 as ok from cursorDiskKV where key >= ? and key < ? limit 1')
      : null;
    // Only ever consulted for a conversation with no local blob — see `parseFtsBody`.
    const bodyStmt = searchHandle && hasTable(searchHandle.db, 'conversation_fts_content')
      ? prepareQuiet(
          searchHandle.db,
          'select c.c1 as body from conversation_fts_content c join conversations v on v.fts_rowid = c.id where v.id = ?',
        )
      : null;

    let done = 0;
    for (const entry of entries) {
      done++;
      // `--since` on the cheap clock, widened: the exact end comes from the bubbles, and the
      // caller filters again on `endedAt`. This only avoids reading bodies we cannot want.
      if (since !== null && entry.endHint && entry.endHint < since - SINCE_SLACK_MS) {
        stats.skipped++;
        continue;
      }

      const key = `${paths.stateDb}#${entry.id}`;
      keys.push(key);
      // The scan cache is keyed on {size, mtimeMs}. There is no file here, so the pair carries
      // the conversation's own fingerprint instead: a string hash for `size` would not compare,
      // so the two numeric slots hold the two clocks that move whenever the thread changes.
      const stamp = { size: hash32(entry.fingerprint), mtimeMs: entry.endHint };

      let session = cache ? cache.get(key, stamp) : undefined;
      if (session === undefined) {
        let composer = null;
        if (composerStmt) {
          const row = composerStmt.get(`composerData:${entry.id}`);
          if (row) {
            stats.bytes += byteLength(row.value);
            composer = parseJsonSafe(asText(row.value));
          }
        }
        // Range scan on the primary key, not a LIKE: `;` is the byte right after `:`.
        const lo = `bubbleId:${entry.id}:`;
        const hi = `bubbleId:${entry.id};`;
        // Whether there is anything here has to be known *before* the rows are read, because
        // it decides the FTS fallback below — and the rows themselves are streamed, so their
        // count is not available until after they have been consumed.
        const hasBubbles = !!(probeStmt && probeStmt.get(lo, hi));
        const bubbles = bubbleStmt && hasBubbles ? streamBubbles(bubbleStmt, lo, hi, stats) : [];
        let body = null;
        if (!hasBubbles && bodyStmt && entry.conversation) {
          const row = bodyStmt.get(entry.id);
          if (row) {
            body = asText(row.body);
            stats.bytes += body.length;
          }
        }
        session = buildCursorSession({
          id: entry.id,
          source: entry.header ? paths.stateDb : paths.searchDb,
          header: entry.header,
          composer,
          conversation: entry.conversation,
          bubbles,
          body,
          workspaces,
          idleGapMs,
        });
        if (cache) cache.set(key, stamp, session);
        stats.parsed++;
      } else {
        stats.cached++;
      }

      if (session && (opts.includeSubagents || !session.isSidechain)) {
        sessions.push(session);
        stats.sessions++;
      } else if (!session) {
        stats.skipped++;
      }

      if (onProgress) {
        try {
          onProgress({ file: key, done, total: entries.length, bytes: stats.bytes });
        } catch {
          /* a broken progress callback must not break the scan */
        }
      }
    }
  } catch {
    // A schema that has moved on, a corrupt page, a database that vanished mid-read: keep
    // whatever we already built.
  } finally {
    await stateHandle?.close();
    await searchHandle?.close();
  }

  return { sessions, keys, stats, note: null };
}

/**
 * Yield one bubble row at a time, counting as they go.
 *
 * `.all()` would put every blob of a conversation in memory simultaneously — on the corpus
 * here that is 121 106 blobs and 1.8 GB. `.iterate()` hands them over one at a time, so each
 * one is collectable as soon as `compactBubble` has taken what it needs. It landed in
 * `node:sqlite` after `DatabaseSync` itself did, so a Node that predates it falls back.
 *
 * @param {object} stmt
 * @param {string} lo
 * @param {string} hi
 * @param {{bubbles:number, bytes:number}} stats
 */
function* streamBubbles(stmt, lo, hi, stats) {
  let rows;
  try {
    rows = typeof stmt.iterate === 'function' ? stmt.iterate(lo, hi) : stmt.all(lo, hi);
  } catch {
    return;
  }
  for (const row of rows) {
    stats.bubbles++;
    // Measured without decoding: `asText(row.value).length` here was materialising every blob
    // a second time purely to report a number in the summary line.
    stats.bytes += byteLength(row.value);
    yield row;
  }
}

/** Size of a SQLite text/blob column without decoding it into a JS string. */
function byteLength(v) {
  if (v == null) return 0;
  if (typeof v === 'string') return Buffer.byteLength(v);
  if (typeof v.byteLength === 'number') return v.byteLength;
  return 0;
}

function prepareQuiet(db, sql) {
  try {
    return db.prepare(sql);
  } catch {
    return null;
  }
}

function asText(v) {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof v.toString === 'function') return v.toString('utf8');
  return String(v ?? '');
}

function parseJsonSafe(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** FNV-1a. Only ever compared for equality, never stored as an identifier. */
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
