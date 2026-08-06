/**
 * codepend — the scanner.
 *
 * Walks the Claude Code and Codex transcript roots and turns them into `Session[]`.
 *
 * Design constraints that shape everything below:
 *  - The corpus is byte-huge (4.6 GB here) but line-cheap (~250 k lines). So the win is in NOT
 *    decoding bytes: lines arrive as Buffers, and Codex lines are classified from a 256-byte
 *    ASCII head before anything decides to `JSON.parse` (see src/normalize.js).
 *  - Nothing is ever read whole. `createReadStream` + manual newline splitting; a 650 MB file
 *    costs the same resident memory as a 650 byte one.
 *  - Nothing throws. A missing root, an unreadable file, a truncated final line, a malformed
 *    record — all degrade to "we return less", never to a stack trace in the user's terminal.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createParser, IDLE_GAP_MS, PARSER_VERSION } from './normalize.js';
import { openCache } from './cache.js';
import { scanCursor } from './agents/cursor.js';

export { IDLE_GAP_MS, PARSER_VERSION };

const NEWLINE = 0x0a;
const CARRIAGE = 0x0d;
/** Read size. 4 MB measured fastest here: fewer syscalls, and the buffer is reused anyway. */
const CHUNK = 4 << 20;
/** Default pool. This work is I/O + JSON.parse, not CPU-parallel: 4 was as fast as 8 on the
 *  4.7 GB corpus and held ~100 MB less resident. */
const DEFAULT_CONCURRENCY = 4;
/** Largest single line we are willing to assemble across chunks before giving up on it. */
const MAX_CARRY = 32 << 20;
/** `--since` prefilter slack: Codex filenames are local wall-clock, records are UTC (docs §2.2). */
const SINCE_SLACK_MS = 24 * 60 * 60 * 1000;

/**
 * @typedef {object} ScanOptions
 * @property {string} [claudeDir]  `~/.claude` or `~/.claude/projects`
 * @property {string} [codexDir]   `~/.codex` or a directory of rollout files
 * @property {string} [cursorDir]  Cursor's `User/globalStorage` (or its parent)
 * @property {boolean} [cursor=true]  set false to skip Cursor entirely
 * @property {number|Date|string} [since]  drop sessions that ended before this
 * @property {boolean} [cache=true]
 * @property {string} [cacheDir]
 * @property {number} [idleGapMs]
 * @property {number} [concurrency]
 * @property {boolean} [includeSubagents=false]  keep Codex subagent/automation threads too
 * @property {(p: {file:string, done:number, total:number, bytes:number}) => void} [onProgress]
 * @property {(note: string) => void} [onNote]  one-shot advisory lines for the CLI to print
 */

/**
 * Scan every agent transcript on this machine.
 * @param {ScanOptions} [opts]
 * @returns {Promise<object[]>} sessions, oldest first. The array carries a non-enumerable
 *   `stats` property ({files, cached, parsed, bytes, ms, skipped}) for the CLI's summary line.
 */
export async function scan(opts = {}) {
  const t0 = Date.now();
  const since = normalizeSince(opts.since);
  const idleGapMs = opts.idleGapMs ?? IDLE_GAP_MS;
  const concurrency = Math.max(
    1,
    Math.min(opts.concurrency || Math.min(os.cpus().length || 4, DEFAULT_CONCURRENCY), 16),
  );
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;

  const targets = [
    ...(await listClaudeFiles(await resolveClaudeRoots(opts.claudeDir))),
    ...(await listCodexFiles(await resolveCodexRoots(opts.codexDir), since)),
  ];
  // Biggest first: with a bounded pool this minimises the long tail (the 650 MB file starts at t0).
  targets.sort((a, b) => b.size - a.size);

  const cache = await openCache({ enabled: opts.cache !== false, dir: opts.cacheDir });
  const total = targets.length;
  const sessions = [];
  const stats = { files: total, cached: 0, parsed: 0, bytes: 0, skipped: 0, ms: 0, notes: [], cursor: null };
  let done = 0;
  let next = 0;

  /** One-shot advisories (`Cursor history needs Node 22+ — skipped`). Never repeated. */
  const noteSeen = new Set();
  const note = (text) => {
    if (!text || noteSeen.has(text)) return;
    noteSeen.add(text);
    stats.notes.push(text);
    if (typeof opts.onNote === 'function') {
      try {
        opts.onNote(text);
      } catch {
        /* a broken note callback must not break the scan */
      }
    }
  };

  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= total) return;
      const t = targets[i];
      let session = cache.get(t.file, t);
      if (session === undefined) {
        const got = await parseFile(t, { idleGapMs, includeSubagents: opts.includeSubagents });
        session = got.session;
        cache.set(t.file, t, session);
        // Bytes we actually pulled off disk, not the size of the files we looked
        // at: a subagent thread stops after its first chunk, so 113 files worth
        // 1.5 GB here cost 4 MB each. Reporting `t.size` claimed a read rate the
        // run never achieved, which is a strange thing to lie about on a page
        // whose whole pitch is that the numbers are real.
        stats.bytes += got.bytes;
        stats.parsed++;
      } else {
        stats.cached++;
      }
      if (session) sessions.push(session);
      else stats.skipped++;
      done++;
      if (onProgress) {
        try {
          onProgress({ file: t.file, done, total, bytes: stats.bytes });
        } catch {
          /* a broken progress callback must not break the scan */
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, total || 1) }, worker));

  // Cursor is SQLite, not JSONL: it cannot join the file pool. `node:sqlite` is a synchronous
  // API, so running it "concurrently" with the readers above would only block the event loop
  // they need. It runs after them, on the same cache, and reports through the same callback.
  const cursorKeys = [];
  if (wantsCursor(opts)) {
    const got = await scanCursor({
      dir: opts.cursorDir,
      since,
      idleGapMs,
      includeSubagents: opts.includeSubagents,
      cache,
      onNote: note,
      onProgress: onProgress
        ? (ev) => onProgress({ ...ev, done: total + (ev.done || 0), total: total + (ev.total || 0) })
        : null,
    });
    for (const s of got.sessions) sessions.push(s);
    for (const k of got.keys) cursorKeys.push(k);
    stats.cursor = got.stats;
    stats.files += got.stats.conversations;
    stats.cached += got.stats.cached;
    stats.parsed += got.stats.parsed;
    stats.bytes += got.stats.bytes;
    stats.skipped += got.stats.skipped;
  }

  await cache.save(new Set([...targets.map((t) => t.file), ...cursorKeys]));

  const out = dedupe(sessions).filter((s) => (since ? s.endedAt >= since : true));
  out.sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1));
  stats.ms = Date.now() - t0;
  Object.defineProperty(out, 'stats', { value: stats, enumerable: false });
  return out;
}

/* ------------------------------------------------------------------ *
 * file discovery
 * ------------------------------------------------------------------ */

/** Accept either `~/.claude` or `~/.claude/projects` — but never scan `~/.claude` wholesale. */
async function resolveClaudeRoots(dir) {
  const base = dir ? path.resolve(expandHome(dir)) : path.join(os.homedir(), '.claude');
  const projects = path.join(base, 'projects');
  return (await isDir(projects)) ? [projects] : [base];
}

/** Accept either `~/.codex` or a directory of rollout files. */
async function resolveCodexRoots(dir) {
  const base = dir ? path.resolve(expandHome(dir)) : path.join(os.homedir(), '.codex');
  const roots = [];
  for (const name of ['sessions', 'archived_sessions']) {
    const p = path.join(base, name);
    if (await isDir(p)) roots.push(p);
  }
  return roots.length ? roots : [base];
}

async function isDir(p) {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** @returns {Promise<import('node:fs').Dirent[]>} — [] when the directory does not exist */
async function readDirSafe(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function statSafe(file) {
  try {
    const st = await fs.stat(file);
    return st.isFile() && st.size > 0 ? st : null;
  } catch {
    return null;
  }
}

/**
 * Claude sessions live at EXACTLY `<root>/<cwd-slug>/<uuid>.jsonl`. Everything deeper
 * (`subagents/`, `tool-results/`, `workflows/`) is harness output, not a session: 193 files and
 * 7× the bytes of the 22 real ones (docs §2.1).
 */
async function listClaudeFiles(roots) {
  const out = [];
  const seen = new Set();
  for (const root of roots) {
    for (const d of await readDirSafe(root)) {
      if (!d.isDirectory()) continue;
      const dir = path.join(root, d.name);
      for (const f of await readDirSafe(dir)) {
        if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
        const file = path.join(dir, f.name);
        if (seen.has(file)) continue;
        const st = await statSafe(file);
        if (!st) continue;
        seen.add(file);
        out.push({
          agent: 'claude',
          file,
          id: f.name.slice(0, -'.jsonl'.length),
          size: st.size,
          mtimeMs: st.mtimeMs,
        });
      }
    }
  }
  return out;
}

/** `rollout-2026-07-15T09-43-34-<uuid>.jsonl` → epoch ms of the LOCAL wall-clock in the name. */
function filenameDate(name) {
  const m = /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const t = new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Codex rollouts, recursively (`sessions/YYYY/MM/DD/…` and the flat `archived_sessions/`). */
async function listCodexFiles(roots, since) {
  const out = [];
  const seen = new Set();

  async function walk(dir, depth) {
    if (depth > 5) return;
    for (const e of await readDirSafe(dir)) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        // Never descend into the Claude root if someone points --codex-dir at a shared parent.
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        await walk(p, depth + 1);
        continue;
      }
      if (!e.isFile() || !e.name.endsWith('.jsonl') || !e.name.startsWith('rollout-')) continue;
      if (seen.has(p)) continue;
      if (since !== null) {
        // Cheap prefilter only — the name is local time, the records are UTC, so widen by a day.
        const nameTs = filenameDate(e.name);
        if (nameTs !== null && nameTs < since - SINCE_SLACK_MS) continue;
      }
      const st = await statSafe(p);
      if (!st) continue;
      seen.add(p);
      out.push({ agent: 'codex', file: p, id: null, size: st.size, mtimeMs: st.mtimeMs });
    }
  }

  for (const root of roots) await walk(root, 0);
  return out;
}

/**
 * Cursor is opt-in, and deliberately so.
 *
 * Claude and Codex are directories: pointing the scanner at a fixture directory scopes it
 * completely. Cursor is a per-user SQLite database in a fixed OS location, so "scan these two
 * fixture roots" would otherwise still drag in 1.8 GB of the developer's own real chat history
 * — non-hermetic for tests, and surprising for anyone embedding `scan()`.
 *
 * So: an explicit `cursorDir` (or `cursor: true`) turns it on, `cursor: false` turns it off,
 * and a scan that scopes nothing — `scan()` with no roots, the whole-machine case — gets it by
 * default, which is what the CLI wants.
 *
 * @param {ScanOptions} opts
 */
function wantsCursor(opts) {
  if (opts.cursor === false) return false;
  if (opts.cursor === true || opts.cursorDir) return true;
  return !opts.claudeDir && !opts.codexDir;
}

function normalizeSince(since) {
  if (since === undefined || since === null || since === '') return null;
  if (since instanceof Date) return since.getTime();
  if (typeof since === 'number') return Number.isFinite(since) ? since : null;
  const t = Date.parse(since);
  return Number.isFinite(t) ? t : null;
}

/* ------------------------------------------------------------------ *
 * streaming
 * ------------------------------------------------------------------ */

/**
 * Read one file through its parser, one reusable buffer at a time.
 *
 * Two deliberate choices, both measured on the 4.7 GB corpus here:
 *  - We split on `\n` over raw bytes instead of using `readline`, which would decode all 4.7 GB
 *    to UTF-16 — 99 % of those bytes belong to tool-output lines nobody ever looks at.
 *  - We `read()` into ONE preallocated buffer per file instead of `createReadStream`, which
 *    hands out a fresh Buffer per chunk. Those chunks are external memory, so V8 has no heap
 *    pressure to collect them and RSS balloons: 4700 allocations of 1 MB peaked at 718 MB.
 *    Reusing the buffer holds the whole scan flat at ~4 MB per concurrent file.
 *
 * @param {{agent:'claude'|'codex', file:string, id:string|null}} target
 * @param {{idleGapMs:number, includeSubagents?:boolean}} opts
 * @returns {Promise<{session: object|null, bytes: number}>} the Session (or null if the file
 *   isn't one) plus the number of bytes actually streamed off disk.
 */
async function parseFile(target, opts) {
  const parser = createParser(target.agent, {
    file: target.file,
    id: target.id,
    idleGapMs: opts.idleGapMs,
    keepAll: target.agent === 'codex' ? !!opts.includeSubagents : false,
  });

  let bytes = 0;
  let fh;
  try {
    fh = await fs.open(target.file, 'r');
  } catch {
    return { session: null, bytes: 0 };
  }

  const buf = Buffer.allocUnsafe(CHUNK);
  /** @type {Buffer|null} bytes of an unterminated line carried across a chunk boundary */
  let carry = null;
  let stop = false;
  /** A single line bigger than MAX_CARRY is being skipped; wait for its newline. */
  let dropping = false;

  const emit = (line) => {
    let end = line.length;
    if (end && line[end - 1] === CARRIAGE) end--; // tolerate CRLF
    if (!end) return true;
    return parser.line(end === line.length ? line : line.subarray(0, end)) !== false;
  };

  try {
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, CHUNK, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      let start = 0;
      for (;;) {
        const nl = buf.indexOf(NEWLINE, start);
        if (nl === -1 || nl >= bytesRead) break;
        if (dropping) {
          // The newline that finally ends an over-long line. Resume normally after it.
          dropping = false;
          start = nl + 1;
          continue;
        }
        let line = buf.subarray(start, nl);
        if (carry) {
          line = Buffer.concat([carry, line]);
          carry = null;
        }
        if (!emit(line)) {
          stop = true;
          break;
        }
        start = nl + 1;
      }
      if (stop) break;
      if (start < bytesRead && !dropping) {
        const tail = buf.subarray(start, bytesRead);
        if ((carry ? carry.length : 0) + tail.length > MAX_CARRY) {
          // Refuse to buffer an unbounded line. Nothing legitimate is this big (the largest
          // real record in this corpus is 2.9 MB) and a corrupt file must not exhaust memory.
          carry = null;
          dropping = true;
        } else {
          // Copy: the next read overwrites `buf` in place.
          carry = carry ? Buffer.concat([carry, tail]) : Buffer.from(tail);
        }
      }
    }
    // A file being appended to right now can end without a newline. Try it anyway; a failed
    // parse is swallowed inside the parser.
    if (!stop && carry && carry.length) emit(carry);
  } catch {
    // Truncated read, permission flip mid-stream, disk hiccup: keep whatever we got.
  } finally {
    await fh.close().catch(() => {});
  }

  try {
    return { session: parser.finish(), bytes };
  } catch {
    return { session: null, bytes };
  }
}

/* ------------------------------------------------------------------ *
 * dedupe
 * ------------------------------------------------------------------ */

/**
 * Same session id seen twice (e.g. a rollout copied into `archived_sessions/`) → keep the richer
 * copy. Measured on this machine the intersection is empty, but the cost of being wrong is a
 * doubled headline number, so we check anyway.
 * @param {object[]} sessions
 */
function dedupe(sessions) {
  const byId = new Map();
  for (const s of sessions) {
    const key = `${s.agent}:${s.id}`;
    const prev = byId.get(key);
    if (!prev) {
      byId.set(key, s);
      continue;
    }
    const score = (x) => x.counts.lines * 1000 + x.counts.humanTurns;
    if (score(s) > score(prev)) byId.set(key, s);
  }
  return [...byId.values()];
}
