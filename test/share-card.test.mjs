/**
 * test/share-card.test.mjs
 *
 * The share card is the only thing about this product that a stranger ever
 * sees, and every one of its failure modes is silent. It does not throw when
 * the chart it was supposed to draw is missing — that is exactly the bug this
 * module was written to fix, and it shipped for months. It does not throw when
 * a headline lands on top of a clock, when the body sits at 3.4:1 over a bright
 * seed, or when `hideProject` scrubs the sentence and leaves four project names
 * printed around a donut.
 *
 * So `shareLayout()` is pure and this file exercises it directly:
 *   • boxes, for all five kinds × both presets, inside the frame and disjoint;
 *   • the chart, present on every memory that carries one — asserted through
 *     video.js's REAL `chartGeometry`, so "the box is usable" is a measurement;
 *   • truncation at a sentence boundary rather than mid-word;
 *   • contrast, measured against real seeded palettes from src/art.js, for every
 *     ink the card paints with and not only the brightest.
 *
 * It also imports archetype-card.js and asserts the helpers share-card.js had
 * to mirror still agree with it. render.js inlines these modules into one page
 * with their exports stripped, so neither can import the other; this test is
 * what turns that duplication from a silent drift risk into a red build.
 *
 * Zero dependencies, Node stdlib only.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SHARE_PRESETS, DEFAULT_PRESET, SHARE_KINDS, THEMES, MIN_CONTRAST, WORDMARK, CTA,
  shareLayout, drawShareCard, shareFilename,
  redactChartLabels, chartHasData, chartInset,
  chartAspect, fitAspect,
  fitBlock, wrapAll, wrapLines, ellipsize, estimateWidth, makeMeasurer, baselinesOf, fitSize,
  safeText, isRisky,
  parseColor, relLuminance, contrastRatio, mixColor, blendOver, combineAlpha, alphaToReach,
  requiredScrimAlpha, worstArtColor, weakestInk, pickInk, scrimPlan, alphaAt, groundOf,
} from '../src/app/share-card.js';

import * as CARD from '../src/app/archetype-card.js';
import { CHART_API } from '../src/app/video.js';
import { palette } from '../src/art.js';

const PRESETS = Object.keys(SHARE_PRESETS);

/* ── the five memories, as the feed actually renders them ──────────────── */

/*
 * Two of these are the cards from the owner's screenshots. They are here by
 * name so that a change which drops their chart again fails with the right
 * words on the console rather than "expected 3 to be 4".
 */
const CLOCK = {
  type: 'clock',
  bins: [4, 2, 1, 0, 1, 3, 9, 18, 34, 51, 62, 48, 40, 55, 61, 58, 44, 39, 47, 66, 71, 58, 33, 12],
  peak: 20,
  note: 'messages by hour of day',
};
const DONUT = {
  type: 'donut',
  labels: 'project',
  rows: [
    { label: 'SuperAgent', value: 57 },
    { label: 'memgram', value: 19 },
    { label: 'acme-web', value: 14 },
    { label: 'billing', value: 6 },
    { label: 'other', value: 4 },
  ],
};
const SPARK = { type: 'spark', points: [3, 7, 2, 9, 14, 6, 22, 11, 4, 18, 25, 9] };
const BARS = {
  type: 'bars',
  rows: [{ label: 'Bash', value: 904 }, { label: 'Edit', value: 411 }, { label: 'Read', value: 388 }],
};
const HEAT = { type: 'heat', values: Array.from({ length: 210 }, (_, i) => (i * 7) % 11) };

const SPECS = {
  chart: {
    kind: 'chart', eyebrow: 'YOUR DAY',
    headline: 'You’ve used every hour on this clock except 3 AM',
    body: 'Midnight is busier than lunch. The only hour you have never sent a message in is 3 AM.',
    chart: CLOCK, seed: 0x5eed1e, project: 'acme-web', agent: 'claude', dateText: 'Jul 31, 2025',
  },
  stat: {
    kind: 'stat', eyebrow: 'LONGEST SITTING', headline: '3h 4m, one sitting.',
    stat: { value: '3h 4m', unit: '', label: 'longest sitting' },
    body: 'July 31. You started at 21:12 and did not get up until after midnight.',
    chart: SPARK, seed: 77, project: 'acme-web', dateText: 'Jul 31, 2025',
  },
  quote: {
    kind: 'quote', eyebrow: 'YOU SAID',
    quote: { text: 'just make it work, I do not care how ugly it is', who: 'you', project: 'acme-web' },
    body: 'The tools changed. You didn’t.', seed: 5150, dateText: 'Mar 2, 2025',
  },
  onthisday: {
    kind: 'onthisday', eyebrow: 'ON THIS DAY',
    headline: 'A year ago today you met Claude Code',
    tagline: 'Day one of two hundred and fourteen.',
    body: 'Four sessions, ninety-one messages, and one very long argument about tabs.',
    quote: { text: 'ok let us try this again', who: 'you' },
    seed: 31337, dateText: 'Aug 7, 2025', agent: 'claude',
  },
  award: {
    kind: 'award', eyebrow: 'WHAT YOU ARE', headline: 'The Midnight Interrogator',
    tagline: 'You do your best thinking when everyone else is asleep.',
    body: '62% of your messages land after 10 PM.', seed: 4242,
  },
};

const KINDS = Object.keys(SPECS);
const spec = (k, over) => Object.assign({}, SPECS[k], over || {});

/* ── helpers ───────────────────────────────────────────────────────────── */

const EPS = 0.5;
const overlap = (a, b) =>
  a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS
  && a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS;

const inside = (b, f) =>
  b.x >= f.x - EPS && b.y >= f.y - EPS
  && b.x + b.w <= f.x + f.w + EPS && b.y + b.h <= f.y + f.h + EPS;

/** The chart block and the subject box describe the same rectangle by design. */
const sameThing = (a, b) => {
  const pair = [a.block, b.block].sort().join('|');
  return pair === 'chart|subject';
};

function allBoxes(L) {
  const out = L.blocks.slice();
  if (L.subject) out.push(Object.assign({ block: 'subject' }, box(L.subject)));
  return out;
}
const box = (b) => ({ x: b.x, y: b.y, w: b.w, h: b.h });

/** A canvas context stub good enough to drive a real draw and record it. */
function fakeCtx() {
  const calls = [];
  const rec = (op) => (...args) => { calls.push({ op, args, font: ctx.font, fill: ctx.fillStyle, alpha: ctx.globalAlpha }); };
  const ctx = {
    calls,
    font: '10px sans-serif',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    textBaseline: 'alphabetic',
    textAlign: 'left',
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    letterSpacing: '0px',
    save: rec('save'),
    restore: rec('restore'),
    fillRect: rec('fillRect'),
    fillText: rec('fillText'),
    drawImage: rec('drawImage'),
    setTransform: rec('setTransform'),
    beginPath: rec('beginPath'),
    closePath: rec('closePath'),
    moveTo: rec('moveTo'),
    rect: rec('rect'),
    arcTo: rec('arcTo'),
    arc: rec('arc'),
    fill: rec('fill'),
    stroke: rec('stroke'),
    clip: rec('clip'),
    lineTo: rec('lineTo'),
    createPattern: () => ({ pattern: true }),
    createLinearGradient: () => ({ stops: [], addColorStop(p, c) { this.stops.push([p, c]); } }),
    measureText(t) {
      const m = /(\d+(?:\.\d+)?)px/.exec(ctx.font);
      const size = m ? +m[1] : 10;
      const weight = /(\d00)\s/.exec(ctx.font);
      const face = /Georgia|Iowan|serif/.test(ctx.font) && !/sans-serif/.test(ctx.font) ? 'serif' : 'display';
      return { width: estimateWidth(t, { size, face, weight: weight ? +weight[1] : 400 }) };
    },
  };
  const say = (op) => calls.filter((c) => c.op === op).map((c) => c.args[0]);
  ctx.texts = () => say('fillText');
  return ctx;
}

const palOf = (seed, theme) => palette(seed, theme);

/* ── frames ────────────────────────────────────────────────────────────── */

test('two frames, two shapes — wide is the default the sheet opens on', () => {
  assert.deepEqual(SHARE_PRESETS.wide, [1200, 675]);
  assert.deepEqual(SHARE_PRESETS.tall, [1080, 1350]);
  assert.equal(DEFAULT_PRESET, 'wide');
  const L = shareLayout(spec('chart'));
  assert.equal(L.preset, 'wide');
  assert.equal(L.width, 1200);
  assert.equal(L.height, 675);
});

test('each preset is a re-composition, not a rescale', () => {
  // A rescale would keep every ratio identical. A landscape that puts the chart
  // beside the copy and a column that stacks it above cannot.
  const w = shareLayout(spec('chart'), 'wide');
  const t = shareLayout(spec('chart'), 'tall');
  assert.ok(w.column.w / w.width < 0.6, 'wide gives the copy a column, not the frame');
  assert.equal(t.column.w, t.frame.w, 'tall has one column');
  assert.ok(w.subject.x > w.column.x + w.column.w, 'wide puts the subject beside the copy');
  assert.ok(t.subject.x === t.column.x, 'tall stacks the subject over the copy');
  assert.ok(t.subject.y + t.subject.h < t.headline.y, 'and the copy sits under it');
});

test('a bigger canvas is the same composition, scaled', () => {
  const a = shareLayout(spec('chart'), 'tall');
  const b = shareLayout(spec('chart', { width: 2160, height: 2700 }), 'tall');
  assert.equal(b.scale, 2);
  assert.ok(Math.abs(b.frame.x / b.width - a.frame.x / a.width) < 1e-9);
  assert.ok(Math.abs(b.subject.h / b.height - a.subject.h / a.height) < 0.02);
});

/* ── geometry: the whole point of keeping the layout pure ─────────────── */

test('every box is inside the frame and nothing overlaps anything', () => {
  for (const preset of PRESETS) {
    for (const kind of KINDS) {
      const L = shareLayout(spec(kind), preset);
      const frame = { x: 0, y: 0, w: L.width, h: L.height };
      const boxes = allBoxes(L);
      assert.ok(boxes.length >= 3, `${preset}/${kind} laid out almost nothing`);
      for (const b of boxes) {
        assert.ok(inside(b, frame), `${preset}/${kind}: ${b.block} escapes the frame`);
      }
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          if (sameThing(boxes[i], boxes[j])) continue;
          assert.ok(!overlap(boxes[i], boxes[j]),
            `${preset}/${kind}: ${boxes[i].block} overlaps ${boxes[j].block}`);
        }
      }
    }
  }
});

test('the copy stack never climbs into the subject, however long the copy', () => {
  const long = 'You spent more of this year inside one single repository than you '
    + 'did inside every other repository you touched put together, and it was not '
    + 'even the one anybody actually pays you to work on. That is the whole story.';
  for (const preset of PRESETS) {
    const L = shareLayout(spec('chart', { headline: long, body: long }), preset);
    assert.ok(L.subject && L.subject.type === 'chart', `${preset}: the chart survived the headline`);
    for (const b of L.blocks) {
      if (b.block === 'chart') continue;
      assert.ok(!overlap(b, L.subject), `${preset}: ${b.block} landed on the chart`);
    }
  }
});

test('the footer holds the wordmark and the command apart, in every frame', () => {
  for (const preset of PRESETS) {
    for (const kind of KINDS) {
      const L = shareLayout(spec(kind), preset);
      const { wordmark, cta } = L.footer;
      assert.equal(wordmark.text, WORDMARK);
      assert.equal(cta.text, CTA);
      assert.ok(cta.x >= wordmark.x + wordmark.w, `${preset}/${kind}: the footer runs together`);
      assert.ok(cta.x + cta.w <= L.footer.x + L.footer.w + EPS, `${preset}/${kind}: the CTA overhangs`);
      assert.equal(wordmark.baseline, cta.baseline, 'they sit on one baseline');
    }
  }
});

test('the chart card gives the chart the space — it is the subject', () => {
  for (const preset of PRESETS) {
    const L = shareLayout(spec('chart'), preset);
    const area = (L.subject.w * L.subject.h) / (L.width * L.height);
    assert.ok(area > 0.25, `${preset}: the chart got only ${(area * 100).toFixed(0)}% of the frame`);
    assert.ok(L.subject.h > L.headline.h, `${preset}: the headline out-sized the chart`);
  }
});

/* ── the regression this module exists for ─────────────────────────────── */

test('a memory that carries a chart exports WITH its chart', () => {
  // The complaint, in one assertion: the clock card, the sitting card and the
  // project donut all came out of drawShare() with no chart in them at all.
  const carriers = [
    ['chart', CLOCK], ['chart', DONUT], ['chart', BARS], ['chart', HEAT],
    ['stat', SPARK], ['stat', DONUT],
  ];
  for (const preset of PRESETS) {
    for (const [kind, chart] of carriers) {
      const L = shareLayout(spec(kind, { chart }), preset);
      assert.ok(L.chart, `${preset}/${kind}/${chart.type}: the chart was dropped`);
      assert.equal(L.chart.type, chart.type);
      assert.ok(L.chartBox && L.chartBox.w > 0 && L.chartBox.h > 0,
        `${preset}/${kind}/${chart.type}: no box was reserved for it`);
      assert.equal(L.subject.type, 'chart');
    }
  }
});

test('the box handed to video.js produces geometry that fits inside the frame', () => {
  // Not a stub: this runs the real `chartGeometry` from video.js against the
  // real reserved box. `chartInset` exists because clockGeometry hangs its hour
  // labels at exactly half the box, and this is the test that knows it.
  for (const preset of PRESETS) {
    for (const chart of [CLOCK, DONUT, BARS, SPARK, HEAT]) {
      const L = shareLayout(spec('chart', { chart }), preset);
      const g = CHART_API.geometry(L.chart, L.chartBox);
      assert.ok(g, `${preset}/${chart.type}: video.js could not build geometry`);
      const frame = { x: 0, y: 0, w: L.width, h: L.height };
      assert.ok(inside(g.bounds, frame), `${preset}/${chart.type}: the drawing spills off the card`);
      assert.ok(inside(g.bounds, { x: 0, y: 0, w: L.width, h: L.height }));
      if (L.panel) {
        assert.ok(inside(g.bounds, L.panel),
          `${preset}/${chart.type}: the drawing spills off its own panel`);
      }
    }
  }
});

test('chartInset is what keeps the clock’s hour marks on the card', () => {
  assert.ok(chartInset('clock') < 1);
  assert.ok(chartInset('donut') < 1);
  assert.equal(chartInset('bars'), 1);
  // Without the inset the clock's "00"/"18" marks land on or past the edge.
  const naive = CHART_API.geometry(CLOCK, { x: 0, y: 0, w: 600, h: 600 });
  assert.ok(naive.bounds.x < 0 || naive.bounds.x + naive.bounds.w > 600,
    'clockGeometry really does overrun the box it is handed');
});

test('the chart grows into the room a short headline leaves behind', () => {
  // "SuperAgent took 57% of everything" is two lines. Reserving the chart's
  // share and stopping there left a dead band of flat scrim across the middle.
  const short = shareLayout(spec('chart', { chart: DONUT, headline: 'Half of it', body: null }), 'tall');
  const long = shareLayout(spec('chart', {
    chart: DONUT,
    headline: 'You spent more of this year inside one single repository than you did '
      + 'inside every other repository you touched put together, and it was not even '
      + 'the one anybody actually pays you to work on.',
  }), 'tall');
  assert.ok(short.subject.h > long.subject.h, 'the chart should take the slack');
  const gap = short.headline.y - (short.subject.y + short.subject.h);
  assert.ok(gap >= 0 && gap < short.height * 0.09, `dead band of ${gap.toFixed(0)}px under the chart`);
  assert.ok(long.subject.h > long.height * 0.2, 'and never be squeezed out by the copy');
});

test('the panel hugs the chart’s own proportions, not the box it was offered', () => {
  assert.equal(chartAspect({ type: 'clock' }), 1);
  assert.ok(chartAspect(SPARK) > 3, 'a sparkline is a ribbon');
  assert.ok(chartAspect({ type: 'heat', values: HEAT.values }) > 3);
  assert.ok(Math.abs(chartAspect(DONUT) - 460 / 330) < 1e-9);
  const fit = fitAspect({ x: 0, y: 0, w: 400, h: 400 }, 4);
  assert.deepEqual(fit, { x: 0, y: 150, w: 400, h: 100 });
  assert.deepEqual(fitAspect({ x: 0, y: 0, w: 400, h: 400 }, 0), { x: 0, y: 0, w: 400, h: 400 });

  // The wide stat card offers the sparkline a tall right-hand column. Panelling
  // the whole column would put a dark slab around a thin ribbon.
  const L = shareLayout(spec('stat', { chart: SPARK, seed: 12, palette: palOf(12, 'dark') }), 'wide');
  assert.ok(L.panel, 'expected a panel out on the faded side');
  assert.ok(L.panel.h < L.subject.h * 0.62, `the panel is ${(L.panel.h / L.subject.h * 100).toFixed(0)}% of the column`);
  assert.ok(L.panel.w / L.panel.h > 2, 'and it is shaped like the chart in it');
  const clockCard = shareLayout(spec('stat', { chart: CLOCK, seed: 12, palette: palOf(12, 'dark') }), 'wide');
  assert.ok(Math.abs(clockCard.panel.w / clockCard.panel.h - 1) < 0.25, 'a clock gets a square-ish panel');

  // And the panel really does contain the drawing — hour marks and on-arc
  // labels included, which is why it is measured off the un-inset box.
  for (const chart of [CLOCK, DONUT, BARS, SPARK, HEAT]) {
    for (const preset of PRESETS) {
      const c = shareLayout(spec('stat', { chart, seed: 12, palette: palOf(12, 'dark') }), preset);
      if (!c.panel) continue;
      const g = CHART_API.geometry(c.chart, c.chartBox);
      assert.ok(inside(g.bounds, c.panel),
        `${preset}/${chart.type}: the drawing hangs off its own panel`);
    }
  }
});

test('one number per card: a headline that restates the stat gives way to the body', () => {
  // The feed shows "3h 4m" in the lockup and "3h 4m, one sitting." underneath,
  // a world apart in style. Stacked on a poster they read as a bug.
  const L = shareLayout(spec('stat'), 'tall');
  assert.equal(L.stat.value, '3h 4m');
  const printed = L.headline.lines.concat(L.body.lines).join(' ');
  assert.equal(printed.split('3h 4m').length - 1, 0, `the number is printed twice: "${printed}"`);
  assert.ok(printed.includes('21:12'), 'and the body took the line instead');
  // A headline that says something else keeps its place.
  const keeps = shareLayout(spec('stat', { headline: 'You did not get up.' }), 'tall');
  assert.ok(keeps.headline.lines.join(' ').includes('did not get up'));
  assert.ok(keeps.body.lines.length, 'and the body stays where it was');
});

test('a memory with no chart lays out without one, and says so', () => {
  for (const preset of PRESETS) {
    for (const kind of KINDS) {
      const L = shareLayout(spec(kind, { chart: null }), preset);
      assert.equal(L.chart, null);
      assert.equal(L.chartBox, null);
      assert.equal(L.panel, null);
      assert.equal(L.subject.type, 'art', `${preset}/${kind}: the leftover should be art`);
    }
  }
});

test('chartHasData refuses the empty shapes rather than reserving a blank box', () => {
  assert.equal(chartHasData(null), false);
  assert.equal(chartHasData({ type: 'nope', rows: [{ label: 'a', value: 1 }] }), false);
  assert.equal(chartHasData({ type: 'clock', bins: new Array(24).fill(0) }), false);
  assert.equal(chartHasData({ type: 'heat', values: [0, 0, 0] }), false);
  assert.equal(chartHasData({ type: 'spark', points: [1] }), false);
  assert.equal(chartHasData({ type: 'donut', rows: [] }), false);
  assert.equal(chartHasData(CLOCK), true);
  const L = shareLayout(spec('chart', { chart: { type: 'clock', bins: new Array(24).fill(0) } }), 'tall');
  assert.equal(L.subject.type, 'art');
});

/* ── missing parts ─────────────────────────────────────────────────────── */

test('a missing body, quote, stat, eyebrow or headline still lays out', () => {
  const strip = [
    { body: null }, { quote: null }, { stat: null }, { eyebrow: '' },
    { headline: '' }, { tagline: null }, { project: null, agent: null, dateText: '' },
    { body: null, quote: null, headline: '', eyebrow: '', tagline: null, stat: null, chart: null },
  ];
  for (const preset of PRESETS) {
    for (const kind of KINDS) {
      for (const over of strip) {
        const L = shareLayout(spec(kind, over), preset);
        const frame = { x: 0, y: 0, w: L.width, h: L.height };
        for (const b of allBoxes(L)) {
          assert.ok(inside(b, frame), `${preset}/${kind} minus ${Object.keys(over)}: ${b.block} escaped`);
        }
        // Whatever else is gone, the signature is not.
        assert.equal(L.footer.wordmark.text, WORDMARK);
        assert.equal(L.footer.cta.text, CTA);
      }
    }
  }
});

test('an empty spec is still a codepend card', () => {
  for (const preset of PRESETS) {
    const L = shareLayout({}, preset);
    assert.equal(L.kind, 'onthisday');
    assert.ok(L.footer.wordmark.w > 0);
    assert.ok(L.footer.cta.w > 0);
    assert.ok(L.subject.h > 0);
  }
});

/* ── type fitting ──────────────────────────────────────────────────────── */

test('a short headline fills the box and a long one shrinks — measured, not guessed', () => {
  const short = shareLayout(spec('onthisday', { headline: 'One year.' }), 'tall');
  const long = shareLayout(spec('onthisday', {
    headline: 'A year ago today you opened a terminal and typed something you '
      + 'would go on to type four thousand more times before the year was out',
  }), 'tall');
  assert.ok(short.headline.size > long.headline.size,
    'the long headline should be set smaller than the short one');
  assert.ok(short.headline.lines.length <= long.headline.lines.length);
  assert.ok(long.headline.size >= 29, 'and never below its floor');
});

test('long copy truncates at a sentence boundary, never mid-word', () => {
  const src = 'You stopped doing the work and started assigning it. Nobody noticed the '
    + 'transition, least of all you. It happened over the course of about three weeks in '
    + 'the middle of the summer, and by the end of it the shape of your day was different '
    + 'in a way that no single commit records.';
  const words = new Set(src.replace(/[«»]/g, '').split(/\s+/).filter(Boolean));
  for (const preset of PRESETS) {
    for (const [kind, field] of [['onthisday', 'headline'], ['chart', 'body'], ['quote', 'quote']]) {
      const over = field === 'quote' ? { quote: { text: src, who: 'you' } } : { [field]: src };
      const L = shareLayout(spec(kind, over), preset);
      const blk = field === 'quote' ? L.quote : L[field];
      assert.ok(blk.lines.length, `${preset}/${kind}: ${field} vanished`);
      for (const line of blk.lines) {
        for (const w of line.replace(/[«»]/g, '').split(/\s+/).filter(Boolean)) {
          const bare = w.replace(/…$/, '');
          if (!bare) continue;
          assert.ok(words.has(bare) || words.has(w) || [...words].some((x) => x.startsWith(bare)),
            `${preset}/${kind}/${field}: "${w}" is not a whole word from the source`);
        }
      }
      const joined = blk.lines.join(' ').replace(/[«»]/g, '').trim();
      if (blk.clipped) {
        assert.ok(/[.!?…]$/.test(joined),
          `${preset}/${kind}/${field}: clipped copy must end on a stop or an ellipsis, got "${joined.slice(-30)}"`);
      }
    }
  }
});

test('a 400-character quote fits or is cut at a sentence, and stays in the serif', () => {
  const q = 'ok so the thing is I really do not want to rewrite the parser again. '
    + 'Last time it took four days and it broke everything downstream, including the '
    + 'two things nobody had touched in a year. Can we just patch it and move on with '
    + 'our lives, please? I will write the tests. I promise I will write the tests.';
  for (const preset of PRESETS) {
    const L = shareLayout(spec('quote', { quote: { text: q, who: 'you' } }), preset);
    assert.equal(L.quote.face, 'serif');
    assert.equal(L.quote.italic, true);
    assert.ok(L.quote.lines.length >= 2);
    assert.ok(L.quote.h <= L.frame.h);
    assert.ok(L.quote.lines[0].startsWith('«'));
    assert.ok(L.quote.lines[L.quote.lines.length - 1].endsWith('»'));
  }
});

test('the subject reads at thumbnail width — 300px in a feed', () => {
  const THUMB = 300;
  for (const preset of PRESETS) {
    const k = THUMB / SHARE_PRESETS[preset][0];
    const chart = shareLayout(spec('chart'), preset);
    assert.ok(chart.subject.h * k >= 40, `${preset}: the chart is ${(chart.subject.h * k).toFixed(0)}px at thumbnail`);
    const stat = shareLayout(spec('stat'), preset);
    assert.ok(stat.stat.valueSize * k >= 9, `${preset}: the number is ${(stat.stat.valueSize * k).toFixed(1)}px`);
    const quote = shareLayout(spec('quote'), preset);
    assert.ok(quote.quote.size * k >= 9, `${preset}: the quote is ${(quote.quote.size * k).toFixed(1)}px`);
    const otd = shareLayout(spec('onthisday'), preset);
    assert.ok(otd.headline.size * k >= 9, `${preset}: the headline is ${(otd.headline.size * k).toFixed(1)}px`);
  }
});

test('the stat value shrinks to fit rather than wrapping', () => {
  for (const preset of PRESETS) {
    const a = shareLayout(spec('stat', { stat: { value: '9', label: 'x' } }), preset);
    const b = shareLayout(spec('stat', { stat: { value: '1 204 806 h', label: 'x' } }), preset);
    assert.ok(a.stat.valueSize > b.stat.valueSize);
    assert.ok(b.stat.valueW <= b.stat.w + EPS, 'the number stayed inside the column');
  }
});

/* ── contrast ──────────────────────────────────────────────────────────── */

test('contrast maths agrees with the WCAG reference values', () => {
  assert.ok(Math.abs(contrastRatio('#FFFFFF', '#000000') - 21) < 1e-9);
  assert.ok(Math.abs(contrastRatio('#777777', '#FFFFFF') - 4.478) < 0.01);
  assert.ok(Math.abs(relLuminance('#FFFFFF') - 1) < 1e-9);
  assert.deepEqual(parseColor('#F4F1EC'), [244, 241, 236]);
  assert.deepEqual(parseColor('5 6 10'), [5, 6, 10]);
  assert.deepEqual(parseColor('5,6,10'), [5, 6, 10]);
  assert.equal(mixColor('#000000', '#FFFFFF', 0.5), '#808080');
});

test('every ink clears 4.5:1 over every seeded palette, in both themes', () => {
  let checked = 0;
  let worst = { r: Infinity };
  for (let seed = 0; seed < 140; seed++) {
    for (const theme of ['dark', 'light']) {
      const pal = palOf(seed, theme);
      const T = THEMES[theme];
      for (const preset of PRESETS) {
        for (const kind of KINDS) {
          const L = shareLayout(spec(kind, { seed, theme, palette: pal }), preset);
          for (const b of L.blocks) {
            if (!b.ink) continue;
            const ground = blendOver(L.worstArt, T.scrim, b.ground);
            const r = contrastRatio(b.ink, ground);
            checked++;
            if (r < worst.r) worst = { r, seed, theme, preset, kind, block: b.block };
            assert.ok(r >= MIN_CONTRAST,
              `${theme}/${preset}/${kind} seed ${seed}: ${b.block} at ${r.toFixed(2)}:1`);
          }
        }
      }
    }
  }
  assert.ok(checked > 8000, `expected a real sweep, got ${checked} checks`);
  assert.ok(worst.r >= MIN_CONTRAST);
});

test('the scrim is solved for the WEAKEST ink, not the brightest', () => {
  // Solving for `ink` alone is the mistake archetype-card.js documents: ample
  // for #F4F1EC, and it left the muted body at 2.51:1.
  for (const theme of ['dark', 'light']) {
    const T = THEMES[theme];
    for (let seed = 0; seed < 40; seed++) {
      const L = shareLayout(spec('onthisday', { seed, theme, palette: palOf(seed, theme) }), 'tall');
      const forBrightest = requiredScrimAlpha(T.ink, T.scrim, L.worstArt);
      assert.ok(L.scrim.required >= forBrightest - 1e-9,
        `${theme} seed ${seed}: the scrim was solved for the easy ink`);
      assert.ok([T.ink, T.muted, T.quiet].indexOf(L.weakestInk) >= 0);
    }
  }
});

test('requiredScrimAlpha returns the smallest alpha that clears the ratio', () => {
  const art = '#FFFFFF';
  const a = requiredScrimAlpha('#F4F1EC', '#05060A', art);
  assert.ok(a > 0 && a <= 1);
  assert.ok(contrastRatio('#F4F1EC', blendOver(art, '#05060A', a)) >= MIN_CONTRAST);
  assert.ok(contrastRatio('#F4F1EC', blendOver(art, '#05060A', Math.max(0, a - 0.03))) < MIN_CONTRAST);
  assert.equal(requiredScrimAlpha('#000000', '#FFFFFF', '#FFFFFF'), 0, 'already legible needs no scrim');
});

test('the chart panel is composited with the page scrim, not measured alone', () => {
  assert.ok(Math.abs(combineAlpha(0.5, 0.5) - 0.75) < 1e-9);
  assert.equal(combineAlpha(1, 0), 1);
  assert.ok(Math.abs(alphaToReach(0.5, 0.75) - 0.5) < 1e-9);
  assert.equal(alphaToReach(0.8, 0.7), 0);
  // A wide stat card puts the chart out on the faded side of an x-gradient, so
  // the panel is real; the composite must land on the alpha the card promised.
  const L = shareLayout(spec('stat', { seed: 12, palette: palOf(12, 'dark') }), 'wide');
  assert.ok(L.panel, 'the wide stat card needs a panel for its chart');
  const page = groundOf(L.scrim, L.panel, L.width, L.height);
  assert.ok(page < L.scrim.alpha, 'the page scrim really is thin out there');
  assert.ok(combineAlpha(page, L.panel.alpha) >= L.scrim.alpha - 1e-6);
  const chartBlock = L.blocks.find((b) => b.block === 'chart');
  assert.ok(chartBlock.ground >= L.scrim.alpha - 1e-6);
});

test('a chart card dims the art the way the feed’s .card--chart does', () => {
  for (const preset of PRESETS) {
    assert.equal(shareLayout(spec('chart'), preset).scrim.mode, 'flat');
    assert.notEqual(shareLayout(spec('quote'), preset).scrim.mode, 'flat');
  }
});

test('groundOf takes the minimum over the box, including interior stops', () => {
  const s = scrimPlan({ mode: 'y', ink: '#F4F1EC', scrimColor: '#05060A', worstArt: '#FFFFFF', capTo: 0.1, holdFrom: 0.7 });
  const W = 100;
  const H = 100;
  // A box spanning the whole height brackets the dip; its corners are both high.
  const wide = groundOf(s, { x: 0, y: 0, w: W, h: H }, W, H);
  assert.ok(wide <= s.low + 1e-9, 'the interior minimum was missed');
  assert.ok(groundOf(s, { x: 0, y: 90, w: W, h: 10 }, W, H) >= s.alpha - 1e-9);
  assert.equal(groundOf(scrimPlan({ mode: 'flat', ink: '#F4F1EC', scrimColor: '#05060A', worstArt: '#FFFFFF' }), { x: 0, y: 0, w: W, h: H }, W, H),
    scrimPlan({ mode: 'flat', ink: '#F4F1EC', scrimColor: '#05060A', worstArt: '#FFFFFF' }).alpha);
});

test('alphaAt interpolates between stops and clamps outside them', () => {
  const stops = [[0, 0.2], [0.5, 0.8], [1, 0.8]];
  assert.ok(Math.abs(alphaAt(stops, 0.25) - 0.5) < 1e-9);
  assert.equal(alphaAt(stops, -1), 0.2);
  assert.equal(alphaAt(stops, 2), 0.8);
});

test('worstArtColor takes the extreme of the palette, per theme', () => {
  const pal = { bg: '#101010', accents: ['#3355AA', '#EEEEFF', '#446688'] };
  assert.ok(relLuminance(worstArtColor(pal, 'dark')) > relLuminance('#EEEEFF') - 0.01);
  assert.ok(relLuminance(worstArtColor(pal, 'light')) < relLuminance('#101010') + 0.01);
});

test('the stat unit takes the accent only when the accent is legible', () => {
  const dim = pickInk(['#111111'], '#000000', '#FFFFFF');
  assert.equal(dim, '#FFFFFF', 'an illegible accent is refused');
  assert.equal(pickInk(['#FFFFFF'], '#000000', '#888888'), '#FFFFFF');
  let tookAccent = 0;
  let tookMuted = 0;
  for (let seed = 0; seed < 60; seed++) {
    const pal = palOf(seed, 'dark');
    const L = shareLayout(spec('stat', { seed, palette: pal, stat: { value: '361', unit: 'h', label: 'hours' } }), 'tall');
    const g = blendOver(L.worstArt, THEMES.dark.scrim, L.blocks.find((b) => b.block === 'stat').ground);
    assert.ok(contrastRatio(L.stat.unitInk, g) >= MIN_CONTRAST, `seed ${seed}: the unit is illegible`);
    if (L.stat.unitInk === pal.accents[0]) tookAccent++; else tookMuted++;
  }
  assert.ok(tookAccent + tookMuted === 60);
});

/* ── privacy ───────────────────────────────────────────────────────────── */

test('nothing risky ever reaches the card', () => {
  const nasty = [
    'the file at ~/src/codepend/secret.env',
    'ping me at alex@example.com',
    'token sk-abcdefghijklmnop',
    'ghp_0123456789abcdef',
    'AKIAIOSFODNN7EXAMPLE',
    'eyJhbGciOiJIUzI1NiJ9.x',
    'ssh 192.168.1.14',
    'C:\\Users\\alex\\repo',
    'see https://internal.example.com/x',
    'here: ```js\nsecret\n```',
  ];
  for (const t of nasty) {
    assert.equal(isRisky(t), true, `not flagged: ${t}`);
    assert.equal(safeText(t), '', `not dropped: ${t}`);
  }
  for (const preset of PRESETS) {
    const L = shareLayout(spec('onthisday', {
      headline: nasty[0], body: nasty[1], tagline: nasty[3], quote: { text: nasty[2], who: 'you' },
    }), preset);
    const printed = [
      ...L.headline.lines, ...L.body.lines, ...L.tagline.lines,
      ...L.quote.lines, ...L.pull.lines, ...L.eyebrow.lines, ...L.meta.lines,
    ].join(' ');
    for (const t of nasty) assert.ok(!printed.includes(t.slice(-12)), `leaked: ${t}`);
    assert.equal(L.footer.wordmark.text, WORDMARK);
  }
});

test('hideProject reaches the chart labels, not only the sentence', () => {
  // This is the donut from the owner's third screenshot. Redacting the headline
  // and leaving "SUPERAGENT" set at 34px in the middle of the ring is not
  // redaction, it is a bigger version of the same leak.
  const opts = {
    chart: DONUT, project: 'SuperAgent',
    redactNames: ['SuperAgent', 'memgram', 'acme-web', 'billing'],
    headline: 'SuperAgent took 57% of everything',
    body: 'Twenty-three projects, and memgram was not even second.',
    hideProject: true,
  };
  for (const preset of PRESETS) {
    const L = shareLayout(spec('chart', opts), preset);
    const labels = L.chart.rows.map((r) => r.label);
    for (const leak of ['SuperAgent', 'memgram', 'acme-web', 'billing']) {
      assert.ok(!labels.some((l) => l.toLowerCase().includes(leak.toLowerCase())),
        `${preset}: "${leak}" survived onto the donut`);
      assert.ok(!L.headline.lines.join(' ').includes(leak));
      assert.ok(!L.body.lines.join(' ').includes(leak));
      assert.ok(!L.meta.lines.join(' ').toLowerCase().includes(leak.toLowerCase()));
    }
    // The proportions are the story, so the shape has to survive the redaction.
    assert.equal(L.chart.rows.length, DONUT.rows.length);
    assert.deepEqual(L.chart.rows.map((r) => r.value), DONUT.rows.map((r) => r.value));
    assert.equal(L.chart.rows[L.chart.rows.length - 1].label, 'other', '"other" is a bucket, not a name');
    // And the label the geometry puts in the hole comes from the redacted rows.
    const g = CHART_API.geometry(L.chart, L.chartBox);
    assert.equal(g.sub, 'PROJECT 1');
    assert.equal(g.big, '57%');
  }
});

test('with the toggle off, the donut keeps the names the feed shows', () => {
  const L = shareLayout(spec('chart', { chart: DONUT, project: 'SuperAgent', hideProject: false }), 'tall');
  assert.deepEqual(L.chart.rows.map((r) => r.label), DONUT.rows.map((r) => r.label));
  const g = CHART_API.geometry(L.chart, L.chartBox);
  assert.equal(g.sub, 'SUPERAGENT');
});

test('hiding projects does not rename tools', () => {
  // A bars chart of tool names is not a project chart. "Bash" relabelled
  // "project 1" would be a worse lie than the leak it was trying to prevent.
  const chart = { type: 'bars', rows: BARS.rows.concat([{ label: 'acme-web', value: 12 }]) };
  const L = shareLayout(spec('chart', {
    chart, project: 'acme-web', redactNames: ['acme-web'], hideProject: true,
  }), 'tall');
  const labels = L.chart.rows.map((r) => r.label);
  assert.ok(labels.includes('Bash'));
  assert.ok(labels.includes('Edit'));
  assert.ok(!labels.includes('acme-web'));
  assert.ok(labels.some((l) => /^project \d+$/.test(l)));
});

test('hiding projects does not rename a donut that has no projects in it', () => {
  // `the-bill` is a donut too — INPUT / OUTPUT / CACHE READ / CACHE WRITE — and
  // the toggle used to turn that cost breakdown into "PROJECT 1 … PROJECT 4" on
  // its type alone. Same lie as renaming Bash, on a chart with no project in it.
  const bill = {
    type: 'donut',
    rows: [
      { label: 'cache read', value: 61 }, { label: 'input', value: 22 },
      { label: 'cache write', value: 11 }, { label: 'output', value: 6 },
    ],
  };
  const L = shareLayout(spec('stat', {
    chart: bill, project: 'acme-web', redactNames: ['acme-web', 'SuperAgent'], hideProject: true,
  }), 'tall');
  assert.deepEqual(L.chart.rows.map((r) => r.label), bill.rows.map((r) => r.label));

  // …while a donut that IS the project split still goes wholesale, including
  // the slices whose names nobody handed us.
  const mixed = {
    type: 'donut',
    rows: [
      { label: 'acme-web', value: 57 }, { label: 'a-name-we-were-not-told', value: 30 },
      { label: 'other', value: 13 },
    ],
  };
  const M = shareLayout(spec('chart', {
    chart: mixed, project: 'acme-web', redactNames: ['acme-web'], hideProject: true,
  }), 'tall');
  assert.deepEqual(M.chart.rows.map((r) => r.label), ['project 1', 'project 2', 'other']);
});

test('a quote card prints its date once, not twice', () => {
  // The attribution under the quote already says "IT SAID · AUG 7, 2026"; the
  // tag row four lines below used to repeat the date verbatim.
  const q = shareLayout(spec('quote', {
    project: 'acme-web', agent: 'claude', dateText: 'Jul 31, 2025',
  }), 'tall');
  assert.ok(q.attrib.lines[0].includes('JUL 31, 2025'), 'the attribution keeps the date');
  assert.ok(!q.meta.lines.join(' ').includes('JUL 31, 2025'), 'the tag row gives it up');
  assert.ok(q.meta.lines[0].includes('ACME-WEB'), 'and keeps the rest of the row');
  assert.ok(q.meta.lines[0].includes('CLAUDE'));

  // A card with no quote has no attribution, so the row keeps the date.
  const c = shareLayout(spec('chart', { agent: 'claude', dateText: 'Jul 31, 2025' }), 'tall');
  assert.ok(c.meta.lines[0].includes('JUL 31, 2025'));

  // And an on-this-day card HAS a quote — it just sets it as a pull and never
  // draws an attribution. Its tag row is the only place the date appears, so
  // the rule must not fire on the quote's mere existence.
  const o = shareLayout(spec('onthisday', { agent: 'claude', dateText: 'Jul 31, 2025' }), 'tall');
  assert.ok(o.pull.lines.length, 'on-this-day pulls the quote');
  assert.equal(o.attrib.h, 0, 'and draws no attribution');
  assert.ok(o.meta.lines[0].includes('JUL 31, 2025'), 'so the tag row keeps the date');
});

test('redactChartLabels never mutates its input and scrubs the note', () => {
  const before = JSON.stringify(DONUT);
  const out = redactChartLabels(DONUT, { hideProject: true, project: 'SuperAgent', redactNames: ['SuperAgent'] });
  assert.equal(JSON.stringify(DONUT), before, 'the source chart was mutated');
  assert.notEqual(out.rows, DONUT.rows);
  const noted = redactChartLabels(Object.assign({}, SPARK, { note: 'peak day in ~/src/acme-web' }), {});
  assert.equal(noted.note, '', 'a risky note is dropped whole');
  assert.equal(redactChartLabels(null, {}), null);
});

test('the tag row hides the project too, and keeps the rest', () => {
  const shown = shareLayout(spec('chart', { project: 'acme-web', agent: 'claude', dateText: 'Jul 31, 2025' }), 'tall');
  assert.ok(shown.meta.lines[0].includes('ACME-WEB'));
  const hidden = shareLayout(spec('chart', {
    project: 'acme-web', agent: 'claude', dateText: 'Jul 31, 2025', hideProject: true,
  }), 'tall');
  assert.ok(!hidden.meta.lines.join(' ').toUpperCase().includes('ACME-WEB'));
  assert.ok(hidden.meta.lines[0].includes('CLAUDE'));
  assert.ok(hidden.meta.lines[0].includes('JUL 31'));
});

test('project names are substituted, and a run of them reads as English', () => {
  const s = safeText('You left acme-web, memgram and billing behind.', {
    redactNames: ['acme-web', 'memgram', 'billing'],
  });
  assert.ok(!/acme|memgram|billing/i.test(s));
  assert.ok(/a few projects/.test(s), `got: ${s}`);
});

test('stat values and labels go through the same gate', () => {
  const L = shareLayout(spec('stat', { stat: { value: '~/src/x', label: 'sk-abcdefghij' } }), 'tall');
  assert.equal(L.stat, null, 'an unsafe value takes the whole lockup with it');
  const ok = shareLayout(spec('stat', { stat: { value: '18 902', label: 'messages' } }), 'tall');
  assert.equal(ok.stat.value, '18 902');
  assert.equal(ok.stat.label, 'MESSAGES');
});

/* ── determinism, naming, delegation ───────────────────────────────────── */

test('the same spec always lays out identically', () => {
  for (const preset of PRESETS) {
    for (const kind of KINDS) {
      const a = JSON.stringify(shareLayout(spec(kind), preset).blocks);
      const b = JSON.stringify(shareLayout(spec(kind), preset).blocks);
      assert.equal(a, b, `${preset}/${kind} is not deterministic`);
    }
  }
});

test('an award card is laid out, but flagged for archetype-card.js', () => {
  // The archetype has its own bespoke composition. This module refuses to grow
  // a second one; it lays the spec out so nothing crashes and tells the caller
  // where the real card lives.
  for (const preset of PRESETS) {
    const L = shareLayout(spec('award'), preset);
    assert.equal(L.kind, 'award');
    assert.equal(L.delegate, 'archetype-card');
    assert.ok(L.headline.lines.length, 'and it is still a card, not an exception');
  }
  assert.equal(shareLayout(spec('chart'), 'wide').delegate, null);
  assert.deepEqual(SHARE_KINDS, ['chart', 'stat', 'quote', 'onthisday', 'award']);
});

test('an unknown kind falls back to a moment, not to nothing', () => {
  const L = shareLayout(spec('onthisday', { kind: 'flat' }), 'tall');
  assert.equal(L.kind, 'onthisday');
});

test('filenames are slugs of the memory and the frame', () => {
  assert.equal(shareFilename({ id: 'peak-day:2025' }, 'tall'), 'codepend-peak-day-2025-tall.png');
  assert.equal(shareFilename({ headline: 'Hello, World!' }, 'wide'), 'codepend-hello-world-wide.png');
  assert.equal(shareFilename({}, 'nonsense'), 'codepend-memory-wide.png');
});

/* ── the primitives ────────────────────────────────────────────────────── */

test('the fallback measurer behaves like a font', () => {
  assert.ok(estimateWidth('iiii', { size: 40 }) < estimateWidth('WWWW', { size: 40 }));
  assert.ok(Math.abs(estimateWidth('abc', { size: 80 }) - 2 * estimateWidth('abc', { size: 40 })) < 1e-9);
  assert.ok(estimateWidth('abc', { size: 40, tracking: 0.1 }) > estimateWidth('abc', { size: 40 }));
  assert.equal(estimateWidth('', { size: 40 }), 0);
  const m = makeMeasurer(fakeCtx());
  assert.ok(m('codepend', { size: 40, weight: 700 }) > 0);
});

test('wrapAll wraps everything, wrapLines caps and marks the cut', () => {
  const m = estimateWidth;
  const text = 'one two three four five six seven eight nine ten';
  assert.ok(wrapAll(text, { size: 30 }, 200, m).length > 2);
  const capped = wrapLines(text, { size: 30 }, 200, 2, m);
  assert.equal(capped.length, 2);
  assert.ok(capped[1].endsWith('…'));
  assert.deepEqual(wrapLines('', { size: 30 }, 200, 2, m), []);
  assert.deepEqual(wrapLines(text, { size: 30 }, 200, 0, m), []);
});

test('ellipsize trims from the end and never returns something wider', () => {
  const m = estimateWidth;
  const o = { size: 40 };
  const out = ellipsize('a very long line of type indeed', o, 120, m);
  assert.ok(m(out, o) <= 120);
  assert.ok(out.endsWith('…'));
  assert.equal(ellipsize('short', o, 10000, m), 'short');
});

test('fitBlock finds the biggest size that fits, and says when it could not', () => {
  const m = estimateWidth;
  const big = fitBlock('Two words', { w: 900, h: 400 }, m, { maxSize: 100, minSize: 20, maxLines: 3 });
  assert.equal(big.size, 100);
  assert.equal(big.clipped, false);
  const tight = fitBlock('Two words', { w: 90, h: 40 }, m, { maxSize: 100, minSize: 20, maxLines: 1 });
  assert.ok(tight.size <= 100);
  assert.ok(tight.height <= 40 + EPS, 'a fitted block never exceeds its box');
  assert.deepEqual(fitBlock('', { w: 100, h: 100 }, m, {}).lines, []);
  assert.deepEqual(fitBlock('x', { w: 0, h: 100 }, m, {}).lines, []);
});

test('fitSize shrinks to fit and holds its floor', () => {
  const m = estimateWidth;
  assert.equal(fitSize('x', { weight: 400 }, 10000, m, 50, 10), 50);
  assert.ok(fitSize('a very long string indeed', { weight: 400 }, 40, m, 50, 12) <= 12.001);
});

test('baselines march down the block at the line height', () => {
  const b = { y: 100, size: 40, lineHeight: 50, lines: ['a', 'b', 'c'] };
  const bl = baselinesOf(b);
  assert.equal(bl.length, 3);
  assert.ok(Math.abs(bl[1] - bl[0] - 50) < 1e-9);
  assert.deepEqual(baselinesOf({ lines: [] }), []);
});

/* ── the mirror: this file duplicates archetype-card.js on purpose ─────── */

test('the helpers mirrored from archetype-card.js still agree with it', () => {
  // render.js inlines both modules into one page with exports stripped, so
  // neither can import the other. The duplication is deliberate; this is the
  // test that makes it safe. If one copy is fixed and the other is not, the
  // card that fails is the one nobody looks at until it is on a timeline.
  const colours = ['#F4F1EC', '#12100D', '#B9B4AC', '#4A453D', '#05060A', '#FAF7F2', '#59AAF8', '#8771DE', '#0B0F17'];
  for (const c of colours) {
    assert.deepEqual(parseColor(c), CARD.parseColor(c), `parseColor(${c})`);
    assert.equal(relLuminance(c), CARD.relLuminance(c), `relLuminance(${c})`);
    for (const d of colours) {
      assert.equal(contrastRatio(c, d), CARD.contrastRatio(c, d), `contrastRatio(${c},${d})`);
      assert.equal(blendOver(c, d, 0.37), CARD.blendOver(c, d, 0.37), `blendOver(${c},${d})`);
      assert.equal(requiredScrimAlpha(c, d, '#FFFFFF'), CARD.requiredScrimAlpha(c, d, '#FFFFFF'));
    }
  }
  for (let seed = 0; seed < 40; seed++) {
    for (const theme of ['dark', 'light']) {
      const pal = palOf(seed, theme);
      assert.equal(worstArtColor(pal, theme), CARD.worstArtColor(pal, theme), `worstArtColor ${seed}/${theme}`);
      const w = worstArtColor(pal, theme);
      const inks = [THEMES[theme].ink, THEMES[theme].muted, THEMES[theme].quiet];
      assert.equal(weakestInk(inks, THEMES[theme].scrim, w), CARD.weakestInk(inks, THEMES[theme].scrim, w));
    }
  }
  const words = 'the quick brown fox jumps over the lazy dog 12 345 «привет» — ok';
  for (const o of [{ size: 40 }, { size: 40, face: 'serif' }, { size: 22, weight: 800, tracking: 0.14 }]) {
    assert.equal(estimateWidth(words, o), CARD.estimateWidth(words, o), JSON.stringify(o));
  }
  assert.deepEqual(
    wrapLines(words, { size: 30 }, 300, 3, estimateWidth),
    CARD.wrapLines(words, { size: 30 }, 300, 3, CARD.estimateWidth),
  );
  assert.equal(
    ellipsize(words, { size: 30 }, 220, estimateWidth),
    CARD.ellipsize(words, { size: 30 }, 220, CARD.estimateWidth),
  );
  for (const t of ['~/src/x', 'a@b.com', 'sk-abcdefghij', 'plain words', '```', '10.0.0.1']) {
    assert.equal(isRisky(t), CARD.isRisky(t), `isRisky(${t})`);
    assert.equal(safeText(t, { replacement: 'one project' }), CARD.safeText(t), `safeText(${t})`);
  }
  assert.deepEqual(THEMES.dark.ink, CARD.THEMES.dark.ink);
  assert.deepEqual(THEMES.light.quiet, CARD.THEMES.light.quiet);
  assert.equal(MIN_CONTRAST, CARD.MIN_CONTRAST);
  assert.equal(WORDMARK, CARD.WORDMARK);
  assert.equal(CTA, CARD.CTA);
});

/* ── drawing ───────────────────────────────────────────────────────────── */

function stubDeps(over) {
  const painted = [];
  return Object.assign({
    painted,
    palette: (seed, theme) => palOf(seed, theme),
    artImage: async () => ({ width: 1000, height: 1250 }),
    markImage: async () => ({ width: 32, height: 32 }),
    grainPattern: () => ({ pattern: true }),
    paintChart: (ctx, chart, box, opts) => { painted.push({ chart, box, opts }); return { type: chart.type }; },
  }, over || {});
}

test('drawShareCard paints the chart, the copy and the signature', async () => {
  for (const preset of PRESETS) {
    const ctx = fakeCtx();
    const deps = stubDeps();
    const L = await drawShareCard(ctx, spec('chart'), preset, deps);
    assert.equal(deps.painted.length, 1, `${preset}: the chart was not painted`);
    const p = deps.painted[0];
    assert.equal(p.chart.type, 'clock');
    assert.equal(p.opts.progress, 1, 'a still is the end of the animation');
    assert.ok(!p.opts.panel, 'the card has already painted the ground');
    assert.ok(Array.isArray(p.opts.palette) && p.opts.palette.length >= 3);
    assert.ok(p.opts.ink.display && p.opts.ink.ink0 && p.opts.ink.ink2);
    // Not video.js's default #827D75 — the card hands over the ink its scrim
    // was solved for, or the chart's own labels are the one thing under the bar.
    assert.equal(p.opts.ink.ink2, THEMES.dark.quiet);
    assert.deepEqual(p.box, L.chartBox);

    const texts = ctx.texts();
    // The headline wraps differently in each frame, so it is asserted on the
    // joined run rather than on any one line — which is the point of the frames
    // being re-compositions instead of rescales.
    const joined = texts.join(' ');
    assert.ok(texts.includes(WORDMARK), `${preset}: no wordmark`);
    assert.ok(texts.includes(CTA), `${preset}: no npx codepend`);
    assert.ok(joined.includes('every hour on this clock'), `${preset}: no headline`);
    assert.ok(texts.some((t) => String(t).includes('YOUR DAY')), `${preset}: no eyebrow`);
    assert.ok(ctx.calls.some((c) => c.op === 'drawImage'), `${preset}: no art`);
  }
});

test('every kind paints its own subject', async () => {
  const wants = {
    chart: (ctx, d) => assert.equal(d.painted.length, 1),
    stat: (ctx, d) => {
      assert.ok(ctx.texts().includes('3h 4m'));
      assert.equal(d.painted.length, 1, 'a stat memory that carries a chart shows it');
    },
    quote: (ctx) => assert.ok(ctx.texts().some((t) => String(t).includes('«'))),
    onthisday: (ctx) => assert.ok(ctx.texts().some((t) => String(t).includes('year ago'))),
    award: (ctx) => assert.ok(ctx.texts().some((t) => String(t).includes('Midnight'))),
  };
  for (const preset of PRESETS) {
    for (const kind of KINDS) {
      const ctx = fakeCtx();
      const deps = stubDeps();
      await drawShareCard(ctx, spec(kind), preset, deps);
      wants[kind](ctx, deps);
      assert.ok(ctx.texts().includes(CTA), `${preset}/${kind}: lost the CTA`);
    }
  }
});

test('the drawn layout is the layout the geometry promised', async () => {
  const ctx = fakeCtx();
  const L = await drawShareCard(ctx, spec('onthisday'), 'tall', stubDeps());
  const heads = ctx.calls.filter((c) => c.op === 'fillText' && String(c.args[0]) === L.headline.lines[0]);
  assert.equal(heads.length, 1);
  assert.equal(heads[0].args[1], L.headline.x);
  assert.ok(Math.abs(heads[0].args[2] - baselinesOf(L.headline)[0]) < 1e-9);
});

test('a broken dependency degrades to a card, never to an exception', async () => {
  const broken = [
    { artImage: async () => { throw new Error('no art'); } },
    { palette: () => { throw new Error('no palette'); } },
    { markImage: async () => { throw new Error('no mark'); } },
    { grainPattern: () => { throw new Error('no grain'); } },
    { paintChart: () => { throw new Error('chart blew up'); } },
    { paintChart: undefined },
    {},
  ];
  for (const over of broken) {
    for (const preset of PRESETS) {
      const ctx = fakeCtx();
      const L = await drawShareCard(ctx, spec('chart'), preset, stubDeps(over));
      assert.ok(L && L.width > 0);
      assert.ok(ctx.texts().includes(CTA), `lost the CTA with ${Object.keys(over)}`);
      assert.ok(ctx.texts().includes(WORDMARK));
    }
  }
  // No deps at all — the last line of defence.
  const bare = fakeCtx();
  const L = await drawShareCard(bare, spec('quote'), 'tall', null);
  assert.ok(bare.texts().includes(CTA));
  assert.equal(L.palette.accents.length, 3, 'it falls back to a palette rather than throwing');
});

test('the export is the card: eyebrow, headline, body and chart all land', async () => {
  // The whole complaint in one test. Every field the feed shows for this memory
  // has to be findable in what the export painted, plus the chart.
  for (const preset of PRESETS) {
    const ctx = fakeCtx();
    const deps = stubDeps();
    await drawShareCard(ctx, spec('chart'), preset, deps);
    const all = ctx.texts().join(' ');
    for (const bit of ['YOUR DAY', 'every hour', 'Midnight is busier', 'ACME-WEB', WORDMARK, CTA]) {
      assert.ok(all.includes(bit), `${preset}: "${bit}" is missing from the export`);
    }
    assert.equal(deps.painted[0].chart.type, 'clock');
  }
});

test('a raw detector payload is normalised on the way in, if it can be', async () => {
  // shareLayout is pure and cannot normalise. Callers holding a raw chart hand
  // over video.js's normaliser and get the same card as callers holding a
  // cached normalised one — rather than a card that silently lost its chart.
  const raw = { type: 'donut', labels: 'project', data: { rows: DONUT.rows.map((r) => [r.label, r.value]) } };
  const without = fakeCtx();
  const a = stubDeps();
  await drawShareCard(without, spec('chart', { chart: raw }), 'tall', a);
  assert.equal(a.painted.length, 0, 'a raw payload alone is treated as no chart');

  const with_ = fakeCtx();
  const b = stubDeps({ normalizeChart: CHART_API.normalize });
  await drawShareCard(with_, spec('chart', { chart: raw }), 'tall', b);
  assert.equal(b.painted.length, 1);
  assert.equal(b.painted[0].chart.type, 'donut');
  assert.equal(b.painted[0].chart.rows.length, 5);

  // And a normaliser that throws does not take the card with it.
  const c = stubDeps({ normalizeChart: () => { throw new Error('nope'); } });
  const L = await drawShareCard(fakeCtx(), spec('chart', { chart: raw }), 'tall', c);
  assert.ok(L.width > 0);
});

test('hideProject survives the whole way to the painted chart', async () => {
  const ctx = fakeCtx();
  const deps = stubDeps();
  await drawShareCard(ctx, spec('chart', {
    chart: DONUT, project: 'SuperAgent', redactNames: ['SuperAgent', 'memgram'],
    headline: 'SuperAgent took 57% of everything', hideProject: true,
  }), 'tall', deps);
  const labels = deps.painted[0].chart.rows.map((r) => r.label).join(' ');
  assert.ok(!/superagent|memgram/i.test(labels), `leaked to the painter: ${labels}`);
  assert.ok(!/superagent/i.test(ctx.texts().join(' ')));
});
