/**
 * test/share-render.test.mjs
 *
 * The seam, not the drawing. `share-card.test.mjs` proves the composition; this
 * file proves the composition is actually *in the page*.
 *
 * This is the failure this whole change exists to prevent, and it has already
 * happened twice in this repo: app.js reads `globalThis.CODEPEND_SHARE_CARD`
 * once, at the top level, and if the global is absent it keeps the generic
 * `drawShareLegacy()` composition — the one that never drew a chart. Nothing
 * throws. No console warning. The ⇪ button still opens, still previews, still
 * saves a PNG. It just saves the wrong picture, which is exactly the complaint.
 * So: a test that fails if render.js stops inlining the module, and a test that
 * fails if it lands after app.js.
 *
 * Zero dependencies, Node stdlib only.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderHTML } from '../src/render.js';
import { payload, thinPayload } from './fixture-payload.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** The slice of the bundle between one IIFE header and the payload comment. */
function iifeBody(html, marker) {
  const from = html.indexOf(marker);
  assert.ok(from >= 0, `${marker} is not in the page`);
  return html.slice(from, html.indexOf('/* ---- payload ---- */', from));
}

/* ── 1. the module is in the page ──────────────────────────────────────── */

test('share-card.js is inlined and its surface is reachable from app.js', () => {
  const html = renderHTML(payload, { version: '0.1.0' });
  assert.ok(html.indexOf('globalThis.CODEPEND_SHARE_CARD') >= 0, 'the share IIFE is inlined');

  const body = iifeBody(html, 'globalThis.CODEPEND_SHARE_CARD');
  // The names app.js actually reads off the global. If any of these stops being
  // exported, app.js silently falls back to the composition with no chart.
  assert.ok(/drawShareCard:\s+typeof drawShareCard/.test(body), 'drawShareCard exposed');
  assert.ok(/shareLayout:\s+typeof shareLayout/.test(body), 'shareLayout exposed');
  assert.ok(/shareFilename:\s+typeof shareFilename/.test(body), 'shareFilename exposed');
  assert.ok(/SHARE_PRESETS:\s+typeof SHARE_PRESETS/.test(body), 'SHARE_PRESETS exposed');
  // And the code itself, not just the wrapper.
  assert.ok(body.indexOf('requiredScrimAlpha') >= 0, 'the contrast solver made it in');
  assert.ok(body.indexOf('redactChartLabels') >= 0, 'the chart privacy gate made it in');
});

test('no stray export survived the strip — that would take the whole page down', () => {
  const html = renderHTML(payload, { version: '0.1.0' });
  const body = iifeBody(html, 'globalThis.CODEPEND_SHARE_CARD');
  assert.equal(/^[ \t]*export\s/m.test(body), false, 'no surviving export statement');
  assert.equal(/\bexport\s+default\b/.test(body), false, 'no surviving default export');
});

test('the share card is evaluated before app.js reads the global', () => {
  const html = renderHTML(payload, { version: '0.1.0' });
  const def = html.indexOf('globalThis.CODEPEND_SHARE_CARD = (() =>');
  const read = html.indexOf('const SHARE_CARD = globalThis.CODEPEND_SHARE_CARD');
  assert.ok(def >= 0 && read >= 0, 'both halves of the bridge are present');
  assert.ok(def < read, 'the module must be defined before app.js reads it');
});

/* ── 2. the chart painter has to travel with it ────────────────────────── */

test('video.js hands over its chart painter, and drawShare passes it on', () => {
  const html = renderHTML(payload, { version: '0.1.0' });
  const video = iifeBody(html, 'globalThis.CODEPEND_VIDEO');
  assert.ok(/charts:\s+typeof CHART_API/.test(video), 'CHART_API is on the video bridge');
  // A share card whose `paintChart` dependency is missing composes a hole where
  // the clock goes. It does not throw, so only a string check catches it.
  assert.ok(html.indexOf('paintChart: CHARTS ? CHARTS.paint : null') >= 0,
    'drawShare hands the painter to the card');
});

test('drawShare draws the card rather than the old generic lockup', () => {
  const html = renderHTML(payload, { version: '0.1.0' });
  assert.ok(html.indexOf('SHARE_CARD.drawShareCard(bctx') >= 0, 'the sheet calls the card');
  // The legacy composition stays as a fallback, but nothing routine may reach
  // it: it is only called when the module is missing or the draw threw.
  const calls = html.match(/await drawShareLegacy\(/g) || [];
  assert.equal(calls.length, 2, 'legacy is reached only on the two failure paths');
  assert.ok(html.indexOf('async function drawShareLegacy(') >= 0, 'and it is still there to reach');
});

/* ── 3. the sheet keeps its promises ───────────────────────────────────── */

test('both presets, the toggle, both verbs and the honest note are all still there', () => {
  const html = renderHTML(payload, { version: '0.1.0' });
  assert.ok(/data-preset="wide"/.test(html), 'the wide preset');
  assert.ok(/data-preset="tall"/.test(html), 'the tall preset');
  assert.ok(/id="hideproj"/.test(html), 'the Hide project names toggle');
  assert.ok(html.indexOf('Hide project names') >= 0, 'the toggle is labelled');
  assert.ok(html.indexOf('Download PNG') >= 0, 'Download PNG');
  assert.ok(html.indexOf('Copy image') >= 0, 'Copy image');
  assert.ok(html.indexOf('Nothing is uploaded') >= 0, 'the note the page has to keep true');
  assert.ok(html.indexOf('Nothing was uploaded') >= 0, 'and the one it prints after saving');
});

test('the archetype goes to #/me — and only the archetype', () => {
  const html = renderHTML(payload, { version: '0.1.0' });
  assert.ok(html.indexOf("mem.isArchetype || mem.type === 'share-card'") >= 0,
    'openShare routes the archetype and its poster away');
  assert.ok(html.indexOf('openMe(document.activeElement)') >= 0, 'and routes them to #/me');
  // `spirit-tool` is `kind: "award"` too and it is a bars chart of tool calls.
  // Routing every award to the archetype screen hands someone a picture of a
  // different memory — the same bug, louder.
  assert.equal(html.indexOf("mem.kind === 'award'"), -1,
    'the redirect must not be by kind');
});

/* ── 4. the promises the bigger bundle must still keep ─────────────────── */

test('inlining a fifth module leaves the page self-contained', () => {
  const html = renderHTML(payload, { version: '0.1.0' });
  assert.ok(!/<script[^>]+\bsrc=/i.test(html), 'no external <script src>');
  assert.ok(!/<link[^>]+rel=["']?stylesheet/i.test(html), 'no external stylesheet');
  assert.ok(!/@import\s+url\(/i.test(html), 'no CSS @import');
  assert.ok(!/<(?:img|iframe|video|audio|source|embed)[^>]+\bsrc=["']?https?:/i.test(html),
    'no element loads a remote resource');
  assert.ok(!/<link[^>]+\bhref=["']?https?:/i.test(html), 'no remote <link>');
  assert.ok(!/\bfetch\(|XMLHttpRequest|new WebSocket|EventSource/.test(html),
    'nothing requests anything at runtime');
});

test('a thin album still ships the share card module', () => {
  const html = renderHTML(thinPayload, { version: '0.1.0' });
  assert.ok(html.indexOf('globalThis.CODEPEND_SHARE_CARD') >= 0);
  assert.ok(!/<script[^>]+\bsrc=/i.test(html));
});

test('share-card.js ships in the npm package (it is under src/)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.files.some((f) => f === 'src/' || f === 'src'),
    'src/ must be published or the page loses the share card');
  assert.ok(fs.existsSync(path.join(ROOT, 'src', 'app', 'share-card.js')));
  assert.deepEqual(pkg.dependencies, {}, 'the share card added no dependency');
});
