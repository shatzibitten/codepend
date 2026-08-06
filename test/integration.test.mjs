/**
 * Cross-seam tests.
 *
 * These are the ones that belong to no single module: they exist because four things that
 * were each correct on their own disagreed with each other at the join. Each test here names
 * the seam it guards.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildStats, AGENTS } from '../src/stats.js';
import { flattenQuote, fmtQuote } from '../src/detectors/_util.js';
import { createExporter, planStoryboard, VIDEO_TARGET_MS } from '../src/app/video.js';
import { parseArgs } from '../bin/codepend.js';
import { resolveConfig } from '../src/config.js';

/** Assembled at runtime: a literal here is indistinguishable from a leak to a
 *  secret scanner, and push protection is right to refuse it. */
const j = (...parts) => parts.join('');


const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/* ── seam: a third adapter exists ──────────────────────────────────────── */

const session = (over = {}) => ({
  id: 'x',
  agent: 'cursor',
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_060_000,
  durationMs: 60_000,
  humanTurns: [{ ts: 1_700_000_000_000, text: 'hello there', words: 2, chars: 11 }],
  agentTurns: [],
  reasoning: [],
  tools: {},
  filesTouched: [],
  interrupts: [],
  models: [],
  tokens: {},
  ...over,
});

test('a Cursor session stays a Cursor session through buildStats', () => {
  // The regression: `agent: s.agent === 'claude' ? 'claude' : 'codex'` relabelled every
  // Cursor session as Codex, so the CLI summary said "cursor" and every card said "codex".
  const ctx = buildStats([session()], { now: 1_700_000_100_000 });
  assert.equal(ctx.humanTurns.length, 1);
  assert.equal(ctx.humanTurns[0].agent, 'cursor', 'the turn keeps its agent');
});

test('each adapter keeps its own identity, and an unknown one is not attributed to a real one', () => {
  const sessions = [
    session({ id: 'a', agent: 'claude', humanTurns: [{ ts: 1_700_000_000_000, text: 'a' }] }),
    session({ id: 'b', agent: 'codex', humanTurns: [{ ts: 1_700_000_001_000, text: 'b' }] }),
    session({ id: 'c', agent: 'cursor', humanTurns: [{ ts: 1_700_000_002_000, text: 'c' }] }),
    session({ id: 'd', agent: 'wat', humanTurns: [{ ts: 1_700_000_003_000, text: 'd' }] }),
  ];
  const ctx = buildStats(sessions, { now: 1_700_000_100_000 });
  assert.deepEqual(
    ctx.humanTurns.map((t) => t.agent),
    ['claude', 'codex', 'cursor', 'unknown'],
  );
});

test('the timeline reports every known agent, including the ones that day did not use', () => {
  const ctx = buildStats([session()], { now: 1_700_000_100_000 });
  const day = ctx.timeline[0];
  for (const a of AGENTS) {
    assert.equal(typeof day.agent[a], 'number', `${a} must be a number, not undefined`);
  }
  assert.equal(day.agent.cursor, 1);
  assert.equal(day.agent.claude, 0);
});

test('AGENTS lists exactly the adapters the scanner can produce', () => {
  assert.deepEqual([...AGENTS].sort(), ['claude', 'codex', 'cursor']);
});

/* ── seam: the CLI can actually reach the Cursor adapter ───────────────── */

test('the CLI accepts --cursor-dir and --no-cursor, and they reach the config', () => {
  const on = resolveConfig(parseArgs(['--cursor-dir', '/tmp/whatever']), { env: {} });
  assert.equal(on.cursor, true);
  assert.ok(on.cursorStateDb.startsWith('/tmp/whatever'), on.cursorStateDb);

  const off = resolveConfig(parseArgs(['--no-cursor']), { env: {} });
  assert.equal(off.cursor, false);
});

test('a default config still points at Cursor — the adapter is not opt-in from the CLI', () => {
  // The bug this guards: scan()'s `wantsCursor` turns Cursor off as soon as the caller
  // scopes claudeDir/codexDir, which the CLI always does. Without an explicit cursorDir
  // the whole adapter was unreachable from the command line.
  const cfg = resolveConfig({}, { env: {} });
  assert.equal(cfg.cursor, true);
  assert.ok(cfg.cursorDir, 'a default Cursor directory is resolved');
});

/* ── seam: a quote that is only punctuation ────────────────────────────── */

test('a one-character question mark is still a quote, not an empty pair of quotes', () => {
  // Cursor supplies short turns that Claude/Codex corpora rarely do. `«»` shipped on a
  // real card ("0 seconds later you asked it «»").
  assert.equal(flattenQuote('?'), '?');
  assert.equal(fmtQuote('?'), '«?»');
  assert.equal(fmtQuote('...'), '«...»');
});

test('leading punctuation is still trimmed when there is something behind it', () => {
  assert.equal(flattenQuote('  >> so what now'), 'so what now');
  assert.equal(flattenQuote('"quoted"'), 'quoted"');
});

/* ── seam: what the page keeps vs what a share asset may carry ─────────── */

test('the share-safety filter catches everything docs/PRIVACY.md promises it catches', () => {
  // `--redact safe` deliberately keeps ordinary URLs in the feed — it is your own page, and a
  // localhost dev-server link is not a leak. docs/PRIVACY.md makes a *stronger* promise about
  // the assets that leave the machine: "Share cards never contain file paths, filenames, git
  // branch names, code, URLs". That promise lives in one array in app.js, so it is checked here
  // against the real shapes a corpus produces — including a URL pasted into a prompt, which is
  // exactly what turned up in a `shareable: true` quote card on a real scan.
  const src = fs.readFileSync(path.join(ROOT, 'src', 'app', 'app.js'), 'utf8');
  const decl = src.match(/const RISKY = \[[\s\S]*?\];/);
  assert.ok(decl, 'app.js must still declare the RISKY list');
  // eslint-disable-next-line no-new-func
  const isRisky = new Function(`${decl[0]}; return (t) => !!t && RISKY.some((re) => re.test(t));`)();

  const mustBlock = [
    '@https://github.com/SomeUser/Some-Private-Repo look at this',
    'http://localhost:3000/admin',
    'mail me at someone@example.com',
    'sk-abcdefghijklmnop1234',
    j('ghp', '_abcdefghijklmnopqrst'),
    j('AKIA', 'IOSFODNN7EXAMPLE'),
    '~/work/clients/acme/secrets.ts',
    'it broke in ~/clients/northwind/main.ts again',
    '~/notes.md',
    '/etc/passwd/and/more',
    'C:\\Users\\someone\\project',
    '10.1.2.3',
    '```js\nconst x = 1\n```',
  ];
  for (const t of mustBlock) assert.equal(isRisky(t), true, `should be blocked: ${t}`);

  const mustPass = [
    'why is this still broken',
    'ok that worked, thanks',
    'сделай так, чтобы оно просто работало',
    // Ordinary prose that merely contains a slash or a tilde must still be shareable.
    'do it for the frontend and/or the backend',
    'we shipped 12/31 and it held',
    'roughly ~40 requests a second',
  ];
  for (const t of mustPass) assert.equal(isRisky(t), false, `should be allowed: ${t}`);
});

test('a quote share card keeps the funny body copy under the quotation', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'app', 'app.js'), 'utf8');
  const found = src.match(/function shareCopy\(m, opts\) \{[\s\S]*?\n\}\n\nlet drawSeq/);
  assert.ok(found, 'shareCopy must remain available to the share-card renderer');
  const fn = found[0].replace(/\n\nlet drawSeq$/, '');
  // Exercise the real browser function without introducing a DOM dependency
  // into the zero-dependency Node test suite.
  // eslint-disable-next-line no-new-func
  const shareCopy = new Function(
    'shareState', 'isRisky', 'trimQuote',
    `${fn}; return shareCopy;`,
  )({ hideProject: false }, () => false, (s) => String(s));
  const got = shareCopy({
    eyebrow: '407 TIMES',
    title: 'You have said this 407 times.',
    body: 'Across 11 projects and 20 different models. The tools changed. You didn’t.',
    quote: { text: 'сделай', who: 'you' },
  }, { hideProject: false });

  assert.equal(got.quote.text, 'сделай');
  assert.equal(
    got.line,
    'Across 11 projects and 20 different models. The tools changed. You didn’t.',
  );
});

/* ── seam: the video export must always terminate ──────────────────────── */

/** A canvas/context stub that swallows every 2D call `paintFrame` makes. */
function stubCanvas() {
  const ctx = new Proxy(
    {},
    {
      get: (t, k) => {
        if (k in t) return t[k];
        if (k === 'canvas') return { width: 1080, height: 1920 };
        if (k === 'measureText') return () => ({ width: 10 });
        if (k === 'createLinearGradient' || k === 'createRadialGradient') {
          return () => ({ addColorStop() {} });
        }
        return () => undefined;
      },
      set: (t, k, v) => { t[k] = v; return true; },
    },
  );
  return {
    width: 0,
    height: 0,
    getContext: () => ctx,
    // Models the real API: manual-frame mode, which is the path Safari needs.
    // Chrome samples an offscreen canvas on its own; Safari does not, and the
    // timed stream gave it exactly one frame. framesPushed counts what the
    // recorder was actually handed, so a regression to one frame is a failure
    // here rather than a 0.03-second file someone finds in their Downloads.
    captureStream: () => {
      const track = { stop() {}, requestFrame() { framesPushed++; } };
      return { getTracks: () => [track], getVideoTracks: () => [track] };
    },
  };
}

/** Frames handed to the recorder via requestFrame(), across the whole file. */
let framesPushed = 0;

/**
 * A window in which `requestAnimationFrame` never fires — which is exactly what Chrome does
 * to a hidden tab. Everything else works.
 */
function hiddenTabWindow() {
  const chunks = [];
  class FakeRecorder {
    static isTypeSupported() { return true; }
    constructor() { this.mimeType = 'video/mp4;codecs=avc1'; this.state = 'inactive'; }
    start() { this.state = 'recording'; setTimeout(() => this.ondataavailable?.({ data: { size: 64 } }), 0); }
    stop() { this.state = 'inactive'; this.onstop?.(); }
  }
  class FakeCanvasElement {}
  FakeCanvasElement.prototype.captureStream = function () { return null; };
  return {
    win: {
      MediaRecorder: FakeRecorder,
      HTMLCanvasElement: FakeCanvasElement,
      Blob: class { constructor(parts) { this.size = 64 * Math.max(1, parts.length); this.type = 'video/mp4;codecs=avc1'; } },
      // The whole point: registered, never called back.
      requestAnimationFrame: () => 1,
      cancelAnimationFrame: () => {},
      setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 1)),
      clearTimeout: (id) => clearTimeout(id),
      performance: { now: () => Date.now() },
    },
    chunks,
  };
}

test('an export in a hidden tab finishes instead of hanging forever', async () => {
  // The regression: the frame loop was driven by requestAnimationFrame alone. A hidden tab
  // does not throttle rAF, it stops delivering it — so `rec.stop()` was never reached, the
  // promise never settled, and the progress bar sat on "Recording" for good.
  const { win } = hiddenTabWindow();
  const ex = createExporter({
    win,
    doc: { createElement: () => stubCanvas() },
    paletteOf: () => ({ bg: '#000', fg: '#fff', accents: ['#111', '#222', '#333'] }),
    artImage: async () => null,
    markImage: async () => null,
    grainPattern: () => null,
  });

  const plan = planStoryboard([{ role: 'intro' }, { role: 'mid', id: 'm' }, { role: 'finale' }]);
  // Shorten the clock so the test is not a real 15 seconds.
  plan.duration = 60;
  for (const s of plan.scenes) s.ops = [];

  framesPushed = 0;
  const res = await withTimeout(ex.record(plan, { name: 'The Swarm Lord' }), 5000);
  assert.ok(res && res.blob, `expected a blob, got ${JSON.stringify(res)}`);
  assert.equal(res.mimeType, 'video/mp4;codecs=avc1');
  assert.match(res.filename, /\.mp4$/);
  // The Safari regression: an offscreen canvas is not composited, so a timed
  // captureStream sampled one frame and produced a valid 0.03-second file.
  // Every painted frame must be handed over explicitly.
  assert.ok(framesPushed > 1, `only ${framesPushed} frame(s) reached the recorder`);
});

test('the archetype is the finale the video ends on', () => {
  // Strategy point 5: the archetype is the payoff, so it must be the last scene and the
  // longest-held one — a storyboard that ends on a stat card is the wrong asset.
  const plan = planStoryboard([{ role: 'intro' }, ...Array.from({ length: 5 }, (_, i) => ({ role: 'mid', id: `m${i}` })), { role: 'finale' }]);
  assert.ok(plan.duration <= VIDEO_TARGET_MS);
  assert.equal(plan.width / plan.height, 9 / 16);
  const last = plan.scenes[plan.scenes.length - 1];
  assert.equal(last.role, 'finale');
  const longestMid = Math.max(...plan.scenes.filter((s) => s.role === 'mid').map((s) => s.duration));
  assert.ok(last.duration > longestMid, 'the finale is held longer than any card before it');
});

test('the finale gives its controls the pointer instead of the story tap zones', () => {
  // A child with pointer-events:auto is still unreachable when its parent has
  // pointer-events:none. Both halves of this contract are required: disable the
  // overlay zones and restore hit-testing on the active finale slide.
  const css = fs.readFileSync(path.join(ROOT, 'src', 'app', 'app.css'), 'utf8');
  assert.match(
    css,
    /\.wrapped\.is-last\s+\.wrapped__zone\s*\{[^}]*pointer-events:\s*none;/,
    'the finale must disable both navigation zones',
  );
  assert.match(
    css,
    /\.wrapped\.is-last\s+\.wslide\.is-on\s*\{[^}]*pointer-events:\s*auto;/,
    'the finale slide must restore pointer events for Save video and its sibling controls',
  );
});

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms — the export hung`)), ms).unref?.()),
  ]);
}
