/**
 * test/video.test.mjs
 *
 * The video export is 95% browser API, but the parts that decide how long the
 * clip is, which container it lands in and what the file is called are pure —
 * and they are exactly the parts that break silently. A clip named `.webm` that
 * is really MP4 is rejected on upload with no error anyone can read, so the
 * filename/extension mapping is tested as hard as the timing.
 *
 * Also re-asserts the offline invariant: adding video.js to the bundle must not
 * introduce a single external reference into the rendered page.
 *
 * Zero dependencies, Node stdlib only.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  VIDEO_W, VIDEO_H, VIDEO_FPS, VIDEO_TARGET_MS, XFADE_MS, SCENE_TIMING,
  CODEC_CANDIDATES, pickCodec, extensionFor, videoFilename,
  planStoryboard, storyboardDuration, videoSupported, createExporter,
} from '../src/app/video.js';

import { renderHTML } from '../src/render.js';
import { payload, thinPayload } from './fixture-payload.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const mids = (n) => Array.from({ length: n }, (_, i) => ({ role: 'mid', id: `m${i}` }));
const full = (n) => [{ role: 'intro' }, ...mids(n), { role: 'finale' }];

/* ── 1. frame geometry ─────────────────────────────────────────────────── */

test('the canvas is a 9:16 story frame at 1080×1920', () => {
  assert.equal(VIDEO_W, 1080);
  assert.equal(VIDEO_H, 1920);
  assert.equal(VIDEO_W / VIDEO_H, 9 / 16);
  assert.equal(VIDEO_FPS, 30);
  const plan = planStoryboard(full(7));
  assert.equal(plan.width, 1080);
  assert.equal(plan.height, 1920);
  assert.equal(plan.fps, 30);
});

/* ── 2. storyboard timing ──────────────────────────────────────────────── */

test('the runtime is the sum of what there is to read, not a fixed budget', () => {
  const plan = planStoryboard(full(6));
  assert.equal(storyboardDuration(plan), plan.duration, 'scene durations sum to the total');
  assert.ok(plan.duration <= VIDEO_TARGET_MS, 'the target is a ceiling');
  for (const s of plan.scenes.filter((x) => x.role === 'mid')) {
    assert.ok(s.duration >= SCENE_TIMING.midMin,
      `a card held ${s.duration}ms cannot be read`);
  }
});

test('a card with more to read is held longer', () => {
  const short = { role: 'mid', headline: 'Nine hours.' };
  const long = {
    role: 'mid',
    eyebrow: 'THE LONGEST SITTING',
    headline: 'Nine hours and eleven minutes, one session.',
    body: 'It started at 19:01 and it ended at 04:12. Nobody asked either of you to do that.',
  };
  const plan = planStoryboard([{ role: 'intro' }, short, long, { role: 'finale' }]);
  const [a, b] = plan.scenes.filter((s) => s.role === 'mid');
  assert.ok(b.duration > a.duration,
    `the wordier card got ${b.duration}ms against ${a.duration}ms`);
});

test('scenes are contiguous: each starts where the last one ended', () => {
  const plan = planStoryboard(full(7));
  let at = 0;
  for (const s of plan.scenes) {
    assert.equal(s.start, at, `scene ${s.index} starts at ${at}`);
    assert.ok(s.duration > 0, 'no zero-length scene');
    assert.equal(s.end, s.start + s.duration);
    at = s.end;
  }
  assert.equal(at, plan.duration);
});

test('the finale is last and is held longer than any middle card', () => {
  const plan = planStoryboard(full(7));
  const last = plan.scenes[plan.scenes.length - 1];
  assert.equal(last.role, 'finale');
  assert.equal(last.duration, SCENE_TIMING.finale);
  assert.ok(last.duration >= 2500, 'the archetype frame is the thumbnail — hold it');
  for (const s of plan.scenes.filter((x) => x.role === 'mid')) {
    assert.ok(last.duration > s.duration, 'finale outlasts every middle card');
  }
});

test('the intro is first and roles survive the plan', () => {
  const plan = planStoryboard(full(6));
  assert.equal(plan.scenes[0].role, 'intro');
  assert.equal(plan.scenes[0].duration, SCENE_TIMING.intro);
  assert.deepEqual(plan.scenes.map((s) => s.role),
    ['intro', 'mid', 'mid', 'mid', 'mid', 'mid', 'mid', 'finale']);
});

test('a thin album makes a shorter clip rather than a card held for ten seconds', () => {
  const plan = planStoryboard(full(2));
  assert.ok(plan.duration < VIDEO_TARGET_MS, 'shorter than the target');
  for (const s of plan.scenes.filter((x) => x.role === 'mid')) {
    assert.ok(s.duration <= SCENE_TIMING.midMax, 'no middle card outstays midMax');
    assert.ok(s.duration >= SCENE_TIMING.midMin, 'no middle card is a subliminal flash');
  }
});

test('too many memories are trimmed, not crammed', () => {
  const plan = planStoryboard(full(40));
  assert.ok(plan.scenes.length <= SCENE_TIMING.midCountMax + 2);
  assert.ok(plan.duration <= VIDEO_TARGET_MS);
  // The point of the whole change: overrunning the ceiling sheds cards. It must
  // never buy the time back by holding what is left for less than it takes to read.
  for (const s of plan.scenes.filter((x) => x.role === 'mid')) {
    assert.ok(s.duration >= SCENE_TIMING.midMin);
  }
});

test('the cross-dissolve fits inside the shortest scene', () => {
  assert.ok(XFADE_MS > 0);
  assert.ok(XFADE_MS < SCENE_TIMING.midMin / 2,
    'a dissolve longer than half a card would never resolve');
});

test('an empty storyboard is a zero-length plan, not a crash', () => {
  const plan = planStoryboard([]);
  assert.equal(plan.scenes.length, 0);
  assert.equal(plan.duration, 0);
  assert.equal(storyboardDuration(plan), 0);
  assert.equal(storyboardDuration(null), 0);
  assert.equal(planStoryboard(null).duration, 0);
});

test('a lower ceiling drops cards rather than rushing them', () => {
  const wide = planStoryboard(full(6));
  const tight = planStoryboard(full(6), { target: 20000 });
  assert.ok(tight.duration <= 20000, 'the ceiling holds');
  assert.ok(tight.scenes.length < wide.scenes.length, 'it fits by showing less');
  for (const s of tight.scenes.filter((x) => x.role === 'mid')) {
    assert.ok(s.duration >= SCENE_TIMING.midMin, 'and never by reading faster');
  }
});

/* ── 3. codec preference ───────────────────────────────────────────────── */

test('mp4/avc1 is preferred over every WebM flavour', () => {
  assert.equal(CODEC_CANDIDATES[0], 'video/mp4;codecs=avc1');
  assert.equal(pickCodec(() => true), 'video/mp4;codecs=avc1');
});

test('preference order falls back mp4 → vp9 → vp8 → webm', () => {
  const cases = [
    [['video/mp4;codecs=avc1'], 'video/mp4;codecs=avc1'],
    [['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'], 'video/webm;codecs=vp9'],
    [['video/webm;codecs=vp8', 'video/webm'], 'video/webm;codecs=vp8'],
    [['video/webm'], 'video/webm'],
  ];
  for (const [supported, want] of cases) {
    assert.equal(pickCodec((m) => supported.indexOf(m) >= 0), want);
  }
});

test('nothing supported is null, not a guess', () => {
  assert.equal(pickCodec(() => false), null);
  assert.equal(pickCodec(undefined), null);
});

test('a probe that throws is treated as unsupported for that candidate only', () => {
  const pick = pickCodec((m) => {
    if (m.indexOf('mp4') >= 0) throw new TypeError('nope');
    return m === 'video/webm;codecs=vp9';
  });
  assert.equal(pick, 'video/webm;codecs=vp9');
});

test('candidate list can be overridden', () => {
  assert.equal(pickCodec(() => true, ['video/webm;codecs=vp8']), 'video/webm;codecs=vp8');
  assert.equal(pickCodec(() => true, []), null);
});

/* ── 4. filename + extension ───────────────────────────────────────────── */

test('the extension follows the container that was actually produced', () => {
  assert.equal(extensionFor('video/mp4;codecs=avc1'), 'mp4');
  assert.equal(extensionFor('video/mp4'), 'mp4');
  assert.equal(extensionFor('video/webm;codecs=vp9'), 'webm');
  assert.equal(extensionFor('video/webm;codecs="vp8,opus"'), 'webm');
  // Chrome sometimes answers an avc1 request with an MKV container. Naming it
  // .mp4 would produce a file that will not open at all.
  assert.equal(extensionFor('video/x-matroska;codecs=avc1'), 'mkv');
  assert.equal(extensionFor('video/quicktime'), 'mov');
});

test('an unknown or missing mime degrades to webm rather than no extension', () => {
  assert.equal(extensionFor(''), 'webm');
  assert.equal(extensionFor(null), 'webm');
  assert.equal(extensionFor(undefined), 'webm');
  assert.equal(extensionFor('application/octet-stream'), 'webm');
});

test('the filename carries the archetype and the true extension', () => {
  assert.equal(
    videoFilename('The Midnight Interrogator', 'video/mp4;codecs=avc1'),
    'codepend-the-midnight-interrogator-wrapped.mp4');
  assert.equal(
    videoFilename('The Midnight Interrogator', 'video/webm;codecs=vp9'),
    'codepend-the-midnight-interrogator-wrapped.webm');
});

test('filenames survive punctuation, scripts and absent names', () => {
  assert.equal(videoFilename('', 'video/webm'), 'codepend-wrapped.webm');
  assert.equal(videoFilename(null, 'video/webm'), 'codepend-wrapped.webm');
  assert.equal(videoFilename('Полуночный дознаватель', 'video/webm'), 'codepend-wrapped.webm');
  assert.equal(videoFilename('The 3 A.M. — Refactorer!', 'video/mp4'),
    'codepend-the-3-a-m-refactorer-wrapped.mp4');
  const long = videoFilename('x'.repeat(200), 'video/mp4');
  assert.ok(long.length < 90, 'no filesystem-hostile 200-character name');
  assert.ok(!/[/\\:*?"<>|]/.test(long), 'no characters that break a save dialog');
});

/* ── 5. capability detection ───────────────────────────────────────────── */

test('a browser without MediaRecorder or captureStream is unsupported, not broken', () => {
  assert.equal(videoSupported({}), false);
  assert.equal(videoSupported(null), false);
  assert.equal(videoSupported({ MediaRecorder: function MR() {} }), false, 'no canvas');
  assert.equal(videoSupported({
    MediaRecorder: function MR() {},
    HTMLCanvasElement: function C() {},
  }), false, 'canvas without captureStream');
});

test('a browser with the full stack and a supported codec is supported', () => {
  function MR() {}
  MR.isTypeSupported = (m) => m === 'video/webm;codecs=vp9';
  function C() {}
  C.prototype.captureStream = function () { return null; };
  assert.equal(videoSupported({ MediaRecorder: MR, HTMLCanvasElement: C }), true);
});

test('a full stack that can record nothing we asked for is unsupported', () => {
  function MR() {}
  MR.isTypeSupported = () => false;
  function C() {}
  C.prototype.captureStream = function () { return null; };
  assert.equal(videoSupported({ MediaRecorder: MR, HTMLCanvasElement: C }), false);
});

test('a thrown probe never escapes videoSupported', () => {
  function MR() {}
  Object.defineProperty(MR, 'isTypeSupported', { get() { throw new Error('boom'); } });
  function C() {}
  C.prototype.captureStream = function () { return null; };
  assert.equal(videoSupported({ MediaRecorder: MR, HTMLCanvasElement: C }), false);
});

test('the exporter reports unsupported instead of throwing, with no DOM at all', async () => {
  const ex = createExporter({ win: {}, doc: null });
  assert.equal(ex.supported(), false);
  const res = await ex.record(planStoryboard(full(3)), {});
  assert.deepEqual(res, { error: 'unsupported' });
});

/* ── 6. the page stays self-contained ──────────────────────────────────── */

test('inlining video.js adds no external reference to the page', () => {
  const html = renderHTML(payload, { version: '0.1.0' });
  assert.ok(!/<script[^>]+\bsrc=/i.test(html), 'no external <script src>');
  assert.ok(!/<link[^>]+rel=["']?stylesheet/i.test(html), 'no external stylesheet');
  assert.ok(!/@import\s+url\(/i.test(html), 'no CSS @import');
  // data: URIs are fine (favicon, art); http(s) URIs are not.
  const urls = html.match(/https?:\/\/[^\s"'<>)]+/gi) || [];
  const bad = urls.filter((u) => !/^https?:\/\/www\.w3\.org\//i.test(u));
  assert.deepEqual(bad, [], `unexpected absolute URLs: ${bad.slice(0, 3).join(', ')}`);
});

test('video.js really is inside the rendered page and reachable from app.js', () => {
  const html = renderHTML(payload, { version: '0.1.0' });
  assert.ok(html.indexOf('globalThis.CODEPEND_VIDEO') >= 0, 'the video IIFE is inlined');
  assert.ok(html.indexOf('createExporter') >= 0, 'the factory is exposed');
  assert.ok(html.indexOf('captureStream') >= 0, 'the recorder made it in');
  assert.ok(html.indexOf('video/mp4;codecs=avc1') >= 0, 'codec preference made it in');
  // No stray `export` survived the strip — that would be a syntax error in a
  // classic-scope IIFE and would take the whole page down.
  const iife = html.slice(html.indexOf('globalThis.CODEPEND_VIDEO'));
  const body = iife.slice(0, iife.indexOf('/* ---- payload ---- */'));
  assert.equal(/^[ \t]*export\s/m.test(body), false, 'no surviving export statement');
});

test('a thin album still renders with the video code present', () => {
  const html = renderHTML(thinPayload, { version: '0.1.0' });
  assert.ok(html.indexOf('globalThis.CODEPEND_VIDEO') >= 0);
  assert.ok(!/<script[^>]+\bsrc=/i.test(html));
});

test('video.js ships in the npm package (it is under src/)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.files.some((f) => f === 'src/' || f === 'src'),
    'src/ must be published or the page loses the video export');
  assert.ok(fs.existsSync(path.join(ROOT, 'src', 'app', 'video.js')));
  assert.deepEqual(pkg.dependencies, {}, 'the video export added no dependency');
});
