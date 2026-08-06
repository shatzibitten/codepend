/**
 * test/archetype-render.test.mjs
 *
 * The seam, not the drawing. `archetype-card.test.mjs` proves the composition;
 * this file proves the composition is actually *in the page* — because app.js
 * reads `globalThis.CODEPEND_ARCHETYPE_CARD` once and, finding nothing, quietly
 * draws its own smaller fallback instead. That failure has no error, no console
 * warning and no visual tell in a screenshot: the button still works, it just
 * saves a different picture than the one that was reviewed. So it gets a test.
 *
 * Also re-asserts the offline invariant against the enlarged bundle, and puts a
 * ceiling on the page so a future module cannot double the file by accident.
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

test('archetype-card.js is inlined and its surface is reachable from app.js', () => {
  const html = renderHTML(payload, { version: '0.1.0' });
  assert.ok(html.indexOf('globalThis.CODEPEND_ARCHETYPE_CARD') >= 0, 'the card IIFE is inlined');

  const body = iifeBody(html, 'globalThis.CODEPEND_ARCHETYPE_CARD');
  // The two names app.js actually reads off the global. If either stops being
  // exported, app.js silently falls back and nobody finds out.
  assert.ok(/drawArchetypeCard:\s+typeof drawArchetypeCard/.test(body), 'drawArchetypeCard exposed');
  assert.ok(/ARCHETYPE_PRESETS:\s+typeof ARCHETYPE_PRESETS/.test(body), 'ARCHETYPE_PRESETS exposed');
  // And the code itself, not just the wrapper.
  assert.ok(body.indexOf('requiredScrimAlpha') >= 0, 'the contrast solver made it in');
  assert.ok(body.indexOf('balanceLines') >= 0, 'the line fitter made it in');
});

test('no stray export survived the strip — that would take the whole page down', () => {
  const html = renderHTML(payload, { version: '0.1.0' });
  const body = iifeBody(html, 'globalThis.CODEPEND_ARCHETYPE_CARD');
  assert.equal(/^[ \t]*export\s/m.test(body), false, 'no surviving export statement');
  assert.equal(/\bexport\s+default\b/.test(body), false, 'no surviving default export');
});

test('the card is evaluated before app.js reads the global', () => {
  const html = renderHTML(payload, { version: '0.1.0' });
  const card = html.indexOf('globalThis.CODEPEND_ARCHETYPE_CARD = (() =>');
  const read = html.indexOf('const CARD_API = globalThis.CODEPEND_ARCHETYPE_CARD');
  assert.ok(card >= 0 && read >= 0, 'both halves of the bridge are present');
  assert.ok(card < read, 'the module must be defined before app.js reads it');
});

test('a thin album still ships the card module', () => {
  const html = renderHTML(thinPayload, { version: '0.1.0' });
  assert.ok(html.indexOf('globalThis.CODEPEND_ARCHETYPE_CARD') >= 0);
  assert.ok(!/<script[^>]+\bsrc=/i.test(html));
});

test('archetype-card.js ships in the npm package (it is under src/)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.files.some((f) => f === 'src/' || f === 'src'));
  assert.ok(fs.existsSync(path.join(ROOT, 'src', 'app', 'archetype-card.js')));
  assert.deepEqual(pkg.dependencies, {}, 'the archetype card added no dependency');
});

/* ── 2. the promises the bigger bundle must still keep ─────────────────── */

test('the enlarged bundle still loads nothing over the network', () => {
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

test('the archetype screen exists in the page and is routable', () => {
  const html = renderHTML(payload, { version: '0.1.0' });
  assert.ok(/<dialog[^>]+id="me"/.test(html), 'the #/me screen is in the markup');
  assert.ok(html.indexOf('Save archetype') >= 0, 'the verb is on the page');
  assert.ok(html.indexOf("hh === '#/me'") >= 0, 'the route is wired');
});

test('inlining a fourth module does not blow the page up', () => {
  // The page is one file people open, host and email. ~380 KB was the number
  // before the archetype screen; this ceiling is deliberately close to it, so a
  // future module that doubles the bundle fails here rather than in review.
  const html = renderHTML(payload, { version: '0.1.0' });
  const kb = Buffer.byteLength(html, 'utf8') / 1024;
  assert.ok(kb < 700, `rendered page is ${Math.round(kb)} KB, over the 700 KB ceiling`);
});
