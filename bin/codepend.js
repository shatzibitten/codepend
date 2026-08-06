#!/usr/bin/env node
/**
 * codepend — your agent history, as a photo album.
 *
 * Zero dependencies, Node >= 18. Everything happens on this machine: the only
 * socket this process can open is the optional `--serve` listener, and it binds
 * to 127.0.0.1. There is no telemetry, no update check, no analytics ping.
 *
 * Flow: parse args -> scan (streaming) -> build memories -> render one HTML
 * file -> open it. Heavy modules are imported lazily so `--help` is instant.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { resolveConfig, REDACT_LEVELS, DEFAULT_PORT, PORT_TRIES } from '../src/config.js';

const PKG = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const HELP = `
codepend — your agent history, as a photo album

  usage
    npx codepend [options]

  options
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

  advanced
        --idle-gap <sec>   gap that counts as "away", not "thinking"     (600)
        --claude-dir <dir> where Claude Code keeps sessions        (~/.claude)
        --codex-dir <dir>  where Codex keeps sessions               (~/.codex)
        --cursor-dir <dir> Cursor's User/globalStorage    (needs Node 22.5+)

  codepend reads your local agent logs and writes one HTML file. It makes no
  network requests, collects no telemetry, and uploads nothing. Ever.

  https://github.com/shatzibitten/codepend
`;

/** @type {Record<string, {type: string, alias?: string}>} */
const SPEC = {
  out: { type: 'string', alias: 'o' },
  json: { type: 'string' },
  since: { type: 'string' },
  redact: { type: 'string' },
  'idle-gap': { type: 'string' },
  'claude-dir': { type: 'string' },
  'codex-dir': { type: 'string' },
  'cursor-dir': { type: 'string' },
  serve: { type: 'port' },
  wrapped: { type: 'boolean' },
  open: { type: 'boolean' },
  cache: { type: 'boolean' },
  cursor: { type: 'boolean' },
  'json-only': { type: 'boolean' },
  quiet: { type: 'boolean', alias: 'q' },
  help: { type: 'boolean', alias: 'h' },
  version: { type: 'boolean', alias: 'v' },
};

class UsageError extends Error {}

/** The page routes Wrapped off the URL fragment; `--wrapped` just links to it. */
const WRAPPED_HASH = '#/wrapped';

/* ------------------------------------------------------------------ *
 * Arg parsing — hand-rolled, because a dependency here would be absurd
 * ------------------------------------------------------------------ */

const ALIASES = Object.fromEntries(
  Object.entries(SPEC)
    .filter(([, s]) => s.alias)
    .map(([name, s]) => [s.alias, name]),
);

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/**
 * @param {string[]} argv
 * @returns {Record<string, any>}
 */
export function parseArgs(argv) {
  const flags = { _: [] };

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];

    if (raw === '--') {
      flags._.push(...argv.slice(i + 1));
      break;
    }
    if (raw === '-' || !raw.startsWith('-')) {
      flags._.push(raw);
      continue;
    }

    let token = raw;
    let inlineValue = null;
    const eq = token.indexOf('=');
    if (eq !== -1) {
      inlineValue = token.slice(eq + 1);
      token = token.slice(0, eq);
    }

    let name = token.replace(/^--?/, '');
    if (token.length === 2 && token[0] === '-') name = ALIASES[name] || name;

    let negated = false;
    if (!SPEC[name] && name.startsWith('no-') && SPEC[name.slice(3)]?.type === 'boolean') {
      name = name.slice(3);
      negated = true;
    }

    const spec = SPEC[name];
    if (!spec) throw new UsageError(unknownOption(token));

    if (spec.type === 'boolean') {
      if (inlineValue !== null) throw new UsageError(`--${name} doesn't take a value.`);
      flags[camel(name)] = !negated;
      continue;
    }

    if (spec.type === 'port') {
      // `--serve` alone, or `--serve 8080`. Only swallow the next token when
      // it's obviously a port, so `--serve --wrapped` still works.
      flags[camel(name)] = true;
      const next = inlineValue ?? argv[i + 1];
      if (next != null && /^\d{2,5}$/.test(next)) {
        flags.port = Number(next);
        if (inlineValue === null) i++;
      } else if (inlineValue !== null) {
        throw new UsageError(`--serve wants a port number, got "${inlineValue}".`);
      }
      continue;
    }

    const value = inlineValue ?? argv[++i];
    if (value == null || (typeof value === 'string' && value.startsWith('--'))) {
      throw new UsageError(`--${name} wants a value.`);
    }
    flags[camel(name)] = value;
  }

  return flags;
}

function unknownOption(token) {
  const bare = token.replace(/^--?/, '');
  const names = Object.keys(SPEC);
  const near = names.find((n) => n.startsWith(bare.slice(0, 3)) || bare.startsWith(n.slice(0, 3)));
  const hint = near ? ` Did you mean --${near}?` : '';
  return `unknown option ${token}.${hint} Run \`codepend --help\`.`;
}

/* ------------------------------------------------------------------ *
 * Terminal
 * ------------------------------------------------------------------ */

function makeStyle(env, stream) {
  const forced = env.FORCE_COLOR != null && env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== 'false';
  const on = !env.NO_COLOR && env.TERM !== 'dumb' && (forced || !!stream.isTTY);
  const rich = on && /256|truecolor|24bit/i.test(`${env.COLORTERM || ''} ${env.TERM || ''}`);
  const wrap = (open, close) => (s) => (on ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
  return {
    on,
    dim: wrap(2, 22),
    bold: wrap(1, 22),
    // The ember. Falls back to plain yellow on 16-color terminals.
    accent: on ? (s) => (rich ? `\x1b[38;5;209m${s}\x1b[39m` : `\x1b[33m${s}\x1b[39m`) : String,
    red: wrap(31, 39),
    green: wrap(32, 39),
  };
}

/** Thin-grouped numbers: 21 910. Terminals render a plain space more reliably. */
const num = (n) => Math.round(Number(n) || 0).toLocaleString('en-US').replace(/,/g, ' ');

function fmtBytes(b) {
  if (!Number.isFinite(b) || b <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  const v = b / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDay = (ts, withYear = false) => {
  const d = new Date(ts);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${withYear ? ` ${d.getFullYear()}` : ''}`;
};

/**
 * A span reads as backwards when it crosses a year boundary and the year is hidden
 * ("Aug 22 → Jul 31"). Show the year on both ends exactly when it is the thing that
 * makes the range make sense.
 */
const fmtSpan = (first, last) => {
  if (!Number.isFinite(first) || !Number.isFinite(last)) return '';
  const crossesYears = new Date(first).getFullYear() !== new Date(last).getFullYear();
  return `${fmtDay(first, crossesYears)} → ${fmtDay(last, crossesYears)}`;
};

/**
 * The progress line. One line, rewritten in place, throttled — a 4.6 GB scan
 * takes about ten seconds and the wait should feel like something is happening,
 * not like a slot machine.
 */
function makeUI(cfg, env = process.env, stream = process.stdout) {
  const s = makeStyle(env, stream);
  const tty = !!stream.isTTY && !cfg.quiet;
  const blocks = process.platform === 'win32' && !env.WT_SESSION ? ['#', '-'] : ['█', '░'];
  let last = 0;
  let painted = false;
  let cursorHidden = false;

  const write = (t) => stream.write(t);

  const clear = () => {
    if (painted) {
      write(`\r${' '.repeat(Math.max(0, (stream.columns || 80) - 1))}\r`);
      painted = false;
    }
  };

  const showCursor = () => {
    if (cursorHidden) {
      write('\x1b[?25h');
      cursorHidden = false;
    }
  };

  return {
    s,
    /** @param {string} [text] */
    line(text = '') {
      if (cfg.quiet) return;
      clear();
      write(`${text}\n`);
    },
    /** Progress tick. Everything in `ev` is optional; render what we're given. */
    progress(ev, force = false) {
      if (!tty) return;
      const now = Date.now();
      if (!force && now - last < 80) return;
      last = now;

      const pct =
        ev.bytesTotal > 0 && ev.bytesDone >= 0
          ? ev.bytesDone / ev.bytesTotal
          : ev.filesTotal > 0
            ? ev.filesDone / ev.filesTotal
            : null;

      const width = 24;
      const filled = pct == null ? 0 : Math.max(0, Math.min(width, Math.round(pct * width)));
      const bar = pct == null ? s.dim(blocks[1].repeat(width)) : s.accent(blocks[0].repeat(filled)) + s.dim(blocks[1].repeat(width - filled));

      const bits = [];
      if (pct != null) bits.push(`${String(Math.round(pct * 100)).padStart(3)}%`);
      if (ev.bytesDone > 0) bits.push(fmtBytes(ev.bytesDone));
      else if (ev.filesDone > 0) bits.push(`${ev.filesDone} files`);
      if (ev.sessions > 0) bits.push(`${num(ev.sessions)} sessions`);

      if (!cursorHidden) {
        write('\x1b[?25l');
        cursorHidden = true;
      }
      clear();
      write(`  ${s.dim('reading')}  ${bar}  ${s.dim(bits.join('   '))}`);
      painted = true;
    },
    clear,
    done() {
      clear();
      showCursor();
    },
  };
}

/* ------------------------------------------------------------------ *
 * Opening a browser, without a shell
 * ------------------------------------------------------------------ */

function isWSL() {
  if (process.platform !== 'linux') return false;
  try {
    return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Open a local file in the default browser. `spawn` with an argv array, never
 * a shell string — the path can contain anything, including a project named
 * `; rm -rf ~`.
 * @param {string} url a fully-formed file:// URL (fragment included)
 * @returns {Promise<boolean>} true if a launcher started without erroring
 */
function openInBrowser(url) {
  /** @type {[string, string[]][]} */
  let attempts;
  if (process.platform === 'darwin') attempts = [['open', [url]]];
  else if (process.platform === 'win32') attempts = [['rundll32', ['url.dll,FileProtocolHandler', url]]];
  else if (isWSL()) attempts = [['wslview', [url]], ['xdg-open', [url]]];
  else attempts = [['xdg-open', [url]], ['gio', ['open', url]], ['sensible-browser', [url]]];

  const tryOne = ([cmd, args]) =>
    new Promise((resolve) => {
      let child;
      try {
        child = spawn(cmd, args, { stdio: 'ignore', detached: true });
      } catch {
        resolve(false);
        return;
      }
      child.once('error', () => resolve(false));
      // A launcher that hasn't failed in 400ms has handed off successfully.
      const t = setTimeout(() => {
        child.unref();
        resolve(true);
      }, 400);
      child.once('exit', (code) => {
        clearTimeout(t);
        resolve(code === 0 || code == null);
      });
    });

  return (async () => {
    for (const attempt of attempts) {
      if (await tryOne(attempt)) return true;
    }
    return false;
  })();
}

/* ------------------------------------------------------------------ *
 * --serve : a loopback file server for WSL / SSH / headless boxes
 * ------------------------------------------------------------------ */

async function serveFile(file, cfg, ui) {
  const http = await import('node:http');
  const html = fs.readFileSync(file);

  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': html.length,
      'cache-control': 'no-store',
      // The page is fully self-contained, so say so in a header the browser
      // enforces. `blob:` is for the share-card canvas export, nothing else.
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'",
    });
    res.end(req.method === 'HEAD' ? undefined : html);
  });

  const port = await new Promise((resolve, reject) => {
    let attempt = 0;
    const listen = () => {
      const p = cfg.port + attempt;
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && attempt < PORT_TRIES) {
          attempt++;
          listen();
        } else {
          reject(err);
        }
      });
      server.listen(p, cfg.host, () => resolve(p));
    };
    listen();
  });

  const suffix = cfg.wrapped ? WRAPPED_HASH : '';
  ui.line(`  ${ui.s.bold(`http://${cfg.host}:${port}${suffix}`)}   ${ui.s.dim('ctrl-c to stop')}`);
  if (cfg.host === '127.0.0.1') {
    ui.line(`  ${ui.s.dim(`over ssh: ssh -L ${port}:127.0.0.1:${port} <host>`)}`);
  }
  ui.line('');

  await new Promise((resolve) => {
    process.once('SIGINT', () => {
      server.close();
      resolve();
    });
  });
}

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */

/** Fold Session[] into the per-agent lines. Only contract fields are touched. */
function summarize(sessions) {
  const byAgent = new Map();
  for (const s of sessions) {
    const key = s.agent || 'unknown';
    const acc = byAgent.get(key) || { agent: key, sessions: 0, turns: 0, first: Infinity, last: -Infinity, ms: 0 };
    acc.sessions++;
    acc.turns += s.humanTurns?.length || 0;
    acc.ms += s.durationMs || 0;
    if (Number.isFinite(s.startedAt)) acc.first = Math.min(acc.first, s.startedAt);
    if (Number.isFinite(s.endedAt)) acc.last = Math.max(acc.last, s.endedAt);
    byAgent.set(key, acc);
  }
  return [...byAgent.values()].sort((a, b) => b.turns - a.turns);
}

const AGENT_LABEL = { claude: 'claude code', codex: 'codex', cursor: 'cursor', unknown: 'other' };

function printSummary(ui, sessions, payload, elapsedMs) {
  const s = ui.s;
  const rows = summarize(sessions);
  const profile = payload?.profile || {};
  const width = Math.max(...rows.map((r) => (AGENT_LABEL[r.agent] || r.agent).length), 11);

  // `scan()` hangs a non-enumerable stats object off the array when it can.
  const scanStats = sessions.stats;
  if (scanStats?.bytes > 0) {
    // Cursor contributes SQLite rows, not files, and `stats.files` folds both together so the
    // progress bar has one denominator. Say what each number actually is.
    const conversations = scanStats.cursor?.conversations || 0;
    const files = Math.max(0, num(scanStats.files - conversations));
    const where = conversations ? `${files} files and ${num(conversations)} conversations` : `${files} files`;
    ui.line(
      `  ${s.dim(`read ${fmtBytes(scanStats.bytes)} across ${where}` + (scanStats.cached ? `, ${num(scanStats.cached)} from cache` : ''))}`,
    );
  }

  ui.line('');
  for (const r of rows) {
    const label = (AGENT_LABEL[r.agent] || r.agent).padEnd(width);
    const span = fmtSpan(r.first, r.last);
    ui.line(
      `  ${s.dim(label)}  ${s.accent(String(r.sessions).padStart(4))} ${s.dim('sessions')}` +
        `  ${s.accent(num(r.turns).padStart(6))} ${s.dim('messages')}   ${s.dim(span)}`,
    );
  }

  const activeDays = profile.activeDays ?? payload?.timeline?.length ?? 0;
  const hours = profile.totalHours ?? sessions.reduce((a, x) => a + (x.durationMs || 0), 0) / 3.6e6;
  const memories = payload?.memories?.length ?? 0;

  ui.line('');
  ui.line(
    `  ${s.accent(num(activeDays))} ${s.dim('active days')}  ${s.dim('·')}  ` +
      `${s.accent(fmtDuration(hours * 3.6e6))} ${s.dim('together')}  ${s.dim('·')}  ` +
      `${s.accent(num(memories))} ${s.dim('memories')}`,
  );
  if (profile.archetype?.name) {
    ui.line(`  ${s.dim('you are')}  ${s.bold(profile.archetype.name)}`);
  }
  ui.line(`  ${s.dim(`scanned in ${(elapsedMs / 1000).toFixed(1)}s`)}`);
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function loadPipeline() {
  try {
    const [scan, detect, render] = await Promise.all([
      import('../src/scan.js'),
      import('../src/detect.js'),
      import('../src/render.js'),
    ]);
    return { scan: scan.scan, buildMemories: detect.buildMemories, renderHTML: render.renderHTML };
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error(`this codepend install is incomplete (${err.message}). Try reinstalling: npm i -g codepend@latest`);
    }
    throw err;
  }
}

/**
 * Nothing found. This is a legitimate outcome, not a crash — say where we
 * looked. Goes to stderr so `--quiet` still explains itself.
 */
function reportEmpty(ui, cfg) {
  const s = ui.s;
  const mark = (p) => (fs.existsSync(p) ? s.dim('found, but empty') : s.dim('not found'));
  const out = (t = '') => process.stderr.write(`${t}\n`);
  out();
  out(`  ${s.bold('No agent history here yet.')}`);
  out();
  out(`  ${s.dim('looked in')}`);
  out(`    ${prettyPath(cfg.claudeDir)}  ${mark(cfg.claudeDir)}`);
  out(`    ${prettyPath(cfg.codexSessionsDir)}  ${mark(cfg.codexSessionsDir)}`);
  if (cfg.cursor) out(`    ${prettyPath(cfg.cursorStateDb)}  ${mark(cfg.cursorStateDb)}`);
  out();
  out(`  ${s.dim('if your agents keep history somewhere else:')}`);
  out(`    codepend --claude-dir <dir> --codex-dir <dir> --cursor-dir <dir>`);
  out();
  out(`  ${s.dim('otherwise: go have a conversation with one, then come back.')}`);
  out();
}

async function run(argv, env = process.env) {
  const flags = parseArgs(argv);

  if (flags.help) {
    process.stdout.write(`${HELP.trimStart()}\n`);
    return 0;
  }
  if (flags.version) {
    process.stdout.write(`${PKG.version}\n`);
    return 0;
  }
  if (flags._.length) throw new UsageError(`codepend takes no positional arguments (got "${flags._[0]}").`);
  if (flags.redact && !REDACT_LEVELS.includes(flags.redact)) {
    throw new UsageError(`unknown --redact level "${flags.redact}". Pick: ${REDACT_LEVELS.join(', ')}.`);
  }
  if (flags.jsonOnly && !flags.json) throw new UsageError('--json-only needs --json <path> to write to.');

  const cfg = resolveConfig(flags, { env });
  const ui = makeUI(cfg, env, process.stdout);
  const s = ui.s;

  process.on('exit', () => ui.done());
  process.once('SIGINT', () => {
    ui.done();
    process.stdout.write('\n');
    process.exit(130);
  });

  ui.line('');
  ui.line(`  ${s.bold('codepend')} ${s.dim(PKG.version)}   ${s.dim('reading your agent history — locally')}`);
  ui.line('');

  const { scan, buildMemories, renderHTML } = await loadPipeline();
  const { makeRedactor } = await import('../src/redact.js');

  // --- scan -------------------------------------------------------------
  const startedAt = Date.now();
  const seen = new Set();
  const state = { filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0, sessions: 0 };

  // Advisories from the scanner ("Cursor history needs Node 22+"). Collected rather than
  // printed inline: the progress bar owns the last line while the scan is running, and a
  // note written into it would be wiped by the next tick.
  const notes = [];

  const sessions = await scan({
    claudeDir: cfg.claudeDir,
    codexDir: cfg.codexDir,
    cursorDir: cfg.cursorDir,
    cursor: cfg.cursor,
    since: cfg.since,
    cache: cfg.cache,
    cacheDir: cfg.cacheDir,
    idleGapMs: cfg.idleGapMs,
    onNote(text) {
      notes.push(text);
    },
    onProgress(ev = {}) {
      // Tolerant by design: the scanner reports {file, done, total, bytes}, but
      // count files ourselves too so a future scanner that only reports paths
      // still gets a live progress bar.
      if (ev.file && !seen.has(ev.file)) {
        seen.add(ev.file);
        state.filesDone = seen.size;
      }
      const map = { done: 'filesDone', total: 'filesTotal', bytes: 'bytesDone' };
      for (const [from, to] of Object.entries(map)) if (Number.isFinite(ev[from])) state[to] = ev[from];
      for (const k of ['filesDone', 'filesTotal', 'bytesDone', 'bytesTotal', 'sessions']) {
        if (Number.isFinite(ev[k])) state[k] = ev[k];
      }
      ui.progress(state);
    },
  });
  const elapsed = Date.now() - startedAt;
  ui.clear();

  // Print before the summary, so "one agent is missing from this list" is explained above
  // the list rather than after it.
  for (const n of notes) ui.line(`  ${s.dim('·')} ${s.dim(n)}`);

  if (!sessions || sessions.length === 0) {
    reportEmpty(ui, cfg);
    return 1;
  }

  // --- build ------------------------------------------------------------
  const payload = buildMemories(sessions, {
    now: cfg.now,
    tz: cfg.tz,
    redact: makeRedactor(cfg.redact),
    redactLevel: cfg.redact,
    idleGapMs: cfg.idleGapMs,
  });

  printSummary(ui, sessions, payload, elapsed);

  // --- write ------------------------------------------------------------
  const written = [];

  if (cfg.json) {
    fs.mkdirSync(path.dirname(cfg.json), { recursive: true });
    fs.writeFileSync(cfg.json, `${JSON.stringify(payload, null, 2)}\n`);
    written.push(cfg.json);
  }

  let htmlPath = null;
  if (!cfg.jsonOnly) {
    const html = renderHTML(payload, {
      redact: cfg.redact,
      version: PKG.version,
      // Same corpus + same `now` => byte-identical file. Keep it that way.
      generatedAt: cfg.now,
    });
    fs.mkdirSync(path.dirname(cfg.out), { recursive: true });
    fs.writeFileSync(cfg.out, html);
    htmlPath = cfg.out;
    written.push(cfg.out);
  }

  ui.line('');
  for (const f of written) {
    const size = fs.statSync(f).size;
    ui.line(`  ${s.green('✓')} ${prettyPath(f)}  ${s.dim(fmtBytes(size))}`);
  }
  ui.line(`  ${s.dim('nothing left this machine.')}`);
  ui.line('');

  // --- show -------------------------------------------------------------
  if (!htmlPath) return 0;

  if (cfg.serve) {
    await serveFile(htmlPath, cfg, ui);
    return 0;
  }

  if (!cfg.open) return 0;

  if (env.SSH_CONNECTION || env.SSH_TTY) {
    ui.line(`  ${s.dim('looks like an ssh session — no browser to open.')}`);
    ui.line(`  ${s.dim('run')} codepend --serve ${s.dim('and forward the port, or scp the file.')}`);
    ui.line('');
    return 0;
  }

  // The app enters Wrapped off the URL fragment, so `--wrapped` is a hash away.
  const url = pathToFileURL(htmlPath).href + (cfg.wrapped ? WRAPPED_HASH : '');
  const opened = await openInBrowser(url);
  if (opened) {
    ui.line(`  ${s.dim(cfg.wrapped ? 'opening Wrapped in your browser.' : 'opened in your browser.')}`);
  } else {
    ui.line(`  ${s.dim("couldn't open a browser. Open this yourself:")}`);
    ui.line(`  ${url}`);
    ui.line(`  ${s.dim('or run')} codepend --serve`);
  }
  ui.line('');
  return 0;
}

function prettyPath(p) {
  const home = os.homedir();
  return home && p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

// Only run when invoked as the CLI — `parseArgs` is imported by the tests.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const style = makeStyle(process.env, process.stderr);
  try {
    process.exitCode = await run(process.argv.slice(2));
  } catch (err) {
    const usage = err instanceof UsageError;
    process.stderr.write(`\n  ${style.red(usage ? 'usage:' : 'codepend failed:')} ${err?.message || err}\n`);
    if (!usage && process.env.CODEPEND_DEBUG) process.stderr.write(`\n${err?.stack}\n`);
    else if (!usage) process.stderr.write(`  ${style.dim('run again with CODEPEND_DEBUG=1 for the stack trace.')}\n`);
    process.stderr.write('\n');
    process.exitCode = usage ? 2 : 1;
  }
}
