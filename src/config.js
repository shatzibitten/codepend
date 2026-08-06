/**
 * @module config
 *
 * Where things live, and what the defaults are. Everything codepend touches on
 * disk is resolved here so there is exactly one place to audit for "what does
 * this program read and write" — see docs/PRIVACY.md.
 *
 * Zero dependencies. Node stdlib only.
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { cursorPaths, defaultCursorDir } from './agents/cursor.js';

/**
 * A gap longer than this between two events in a session is "you walked away",
 * not "the agent was thinking". Sessions stay open for weeks, so without this
 * cap the headline "hours together" number is off by ~64x.
 * Measured justification lives in docs/DATA-FORMATS.md §5.
 */
export const IDLE_GAP_MS = 600_000;

/** Bump whenever extraction logic changes; invalidates every cache entry. */
export const CACHE_SCHEMA = 1;

export const REDACT_LEVELS = ['off', 'safe', 'paranoid'];
export const DEFAULT_REDACT = 'safe';

/** `--serve` binds loopback only. Never 0.0.0.0 — this page is your diary. */
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 7777;
export const PORT_TRIES = 10;

const DAY = 86_400_000;

/** @returns {string} The user's home directory (overridable for tests). */
export function homeDir(env = process.env) {
  return env.CODEPEND_HOME || os.homedir();
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Claude Code keeps sessions at `<root>/projects/<cwd-slug>/<uuid>.jsonl`.
 * Accept either the root (`~/.claude`) or the projects dir itself, because
 * people will pass both and being wrong about it is a silent empty feed.
 * @param {string} dir
 * @returns {{ root: string, projects: string }}
 */
export function normalizeClaudeDir(dir) {
  const abs = path.resolve(dir);
  if (path.basename(abs) === 'projects') return { root: path.dirname(abs), projects: abs };
  const nested = path.join(abs, 'projects');
  if (isDir(nested)) return { root: abs, projects: nested };
  // Not there (yet). Assume the conventional layout so the error message is honest.
  return { root: abs, projects: nested };
}

/**
 * Codex keeps sessions under two sibling roots: `sessions/YYYY/MM/DD/` and
 * `archived_sessions/`. They do not overlap (verified: 0 shared ids), so both
 * are read and no cross-root dedupe is needed.
 * @param {string} dir
 * @returns {{ root: string, sessions: string, archived: string }}
 */
export function normalizeCodexDir(dir) {
  const abs = path.resolve(dir);
  const base = path.basename(abs);
  const root = base === 'sessions' || base === 'archived_sessions' ? path.dirname(abs) : abs;
  return {
    root,
    sessions: path.join(root, 'sessions'),
    archived: path.join(root, 'archived_sessions'),
  };
}

/**
 * Cursor keeps everything in SQLite under `User/globalStorage`, per-platform:
 * `~/Library/Application Support/Cursor/User/globalStorage` (macOS),
 * `~/.config/Cursor/User/globalStorage` (Linux),
 * `%APPDATA%/Cursor/User/globalStorage` (Windows).
 * Accept the directory itself, its `User` parent, or the Cursor root.
 * @param {string} dir
 * @returns {{root:string, globalStorage:string, stateDb:string, searchDb:string, workspaceStorage:string}}
 */
export function normalizeCursorDir(dir) {
  const p = cursorPaths(dir);
  return { root: path.dirname(path.dirname(p.globalStorage)), ...p };
}

/**
 * Default on-disk locations, before any flags are applied.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function defaultPaths(env = process.env) {
  const home = homeDir(env);
  const cacheHome = env.CODEPEND_CACHE_DIR || env.XDG_CACHE_HOME || path.join(home, '.cache');
  return {
    claudeDir: env.CODEPEND_CLAUDE_DIR || path.join(home, '.claude'),
    codexDir: env.CODEPEND_CODEX_DIR || path.join(home, '.codex'),
    // `defaultCursorDir` reads CODEPEND_CURSOR_DIR itself and knows the per-platform layout.
    cursorDir: defaultCursorDir({ env, home }),
    out: env.CODEPEND_OUT || path.join(home, '.codepend', 'codepend.html'),
    cacheDir: path.join(cacheHome, 'codepend'),
    cacheFile: path.join(cacheHome, 'codepend', `scan-v${CACHE_SCHEMA}.json`),
  };
}

/**
 * Parse a `--since` window into an epoch-ms floor.
 * Accepts `all`, `30d`, `6w`, `3m`, `1y`, `2026-01-01`, or any ISO datetime.
 * Relative and bare-date forms resolve against **local** midnight, not UTC.
 *
 * @param {string|undefined|null} value
 * @param {number} [now]
 * @returns {number|null} epoch ms, or null for "everything"
 */
export function parseSince(value, now = Date.now()) {
  if (value == null || value === '') return null;
  const v = String(value).trim().toLowerCase();
  if (v === 'all' || v === 'ever' || v === 'forever') return null;

  const rel = /^(\d+)\s*(d|w|m|y|day|days|week|weeks|month|months|year|years)$/.exec(v);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2][0];
    if (unit === 'd') return now - n * DAY;
    if (unit === 'w') return now - n * 7 * DAY;
    const d = new Date(now);
    if (unit === 'm') d.setMonth(d.getMonth() - n);
    else d.setFullYear(d.getFullYear() - n);
    return d.getTime();
  }

  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (ymd) {
    // Local midnight: `new Date(y, m, d)` uses the process timezone by design.
    return new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3])).getTime();
  }

  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return parsed;

  throw new Error(`can't read --since "${value}". Try 30d, 6m, 1y, 2026-01-01, or all.`);
}

/** Human label for a resolved window, for the terminal summary. */
export function sinceLabel(value) {
  if (value == null || value === '' || /^(all|ever|forever)$/i.test(String(value))) return 'all time';
  return String(value);
}

/**
 * Merge parsed flags + environment + defaults into the single config object the
 * CLI passes around.
 *
 * @param {Record<string, any>} flags parsed CLI flags
 * @param {{ env?: NodeJS.ProcessEnv, now?: number }} [ctx]
 */
export function resolveConfig(flags = {}, ctx = {}) {
  const env = ctx.env || process.env;
  const now = ctx.now ?? Date.now();
  const paths = defaultPaths(env);

  const claude = normalizeClaudeDir(flags.claudeDir || paths.claudeDir);
  const codex = normalizeCodexDir(flags.codexDir || paths.codexDir);
  const cursor = normalizeCursorDir(flags.cursorDir || paths.cursorDir);

  const redact = flags.redact || env.CODEPEND_REDACT || DEFAULT_REDACT;
  if (!REDACT_LEVELS.includes(redact)) {
    throw new Error(`unknown --redact level "${redact}". Pick one of: ${REDACT_LEVELS.join(', ')}.`);
  }

  const idleGapMs = flags.idleGap != null ? Math.max(1, Number(flags.idleGap)) * 1000 : IDLE_GAP_MS;
  if (!Number.isFinite(idleGapMs)) throw new Error('--idle-gap wants a number of seconds.');

  return {
    now,
    tz: env.CODEPEND_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',

    // Scanning. `claudeDir` is the projects root (depth-2 glob lives there);
    // `codexDir` is the parent of both sessions/ and archived_sessions/.
    claudeDir: claude.projects,
    claudeRoot: claude.root,
    codexDir: codex.root,
    codexSessionsDir: codex.sessions,
    codexArchivedDir: codex.archived,
    cursorDir: cursor.globalStorage,
    cursorRoot: cursor.root,
    cursorStateDb: cursor.stateDb,
    cursorSearchDb: cursor.searchDb,
    cursor: flags.cursor !== false,

    since: parseSince(flags.since, now),
    sinceLabel: sinceLabel(flags.since),
    idleGapMs,

    // Output.
    out: flags.out ? path.resolve(flags.out) : paths.out,
    json: flags.json ? path.resolve(flags.json) : null,
    jsonOnly: !!flags.jsonOnly,
    wrapped: !!flags.wrapped,

    // Behaviour.
    redact,
    cache: flags.cache !== false,
    cacheFile: paths.cacheFile,
    cacheDir: paths.cacheDir,
    open: flags.open !== false,
    quiet: !!flags.quiet,
    serve: !!flags.serve,
    host: env.CODEPEND_HOST || DEFAULT_HOST,
    port: Number(flags.port) || DEFAULT_PORT,
  };
}
