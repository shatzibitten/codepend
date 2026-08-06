/**
 * test/video-charts.test.mjs
 *
 * The charts in the exported clip are drawn with the 2D API, which is not
 * testable in Node — but everything that decides WHERE a shape goes is pure and
 * lives in video.js, and that is where this class of bug actually lives.
 *
 * The failure that prompted the geometry split is instructive: the page's SVG
 * figures read `chart.data.rows`, while every detector emits `chart.data` as a
 * flat array. Nothing threw, nothing logged — `chartFigure()` just returned an
 * empty string and seven cards silently had no chart in them. So the
 * normaliser is tested against the real payload shapes first, and the geometry
 * against the invariants a reader would notice if they broke: a full turn of
 * donut, bars that top out at the widest value, points inside their box.
 *
 * The cast derivation is tested the same way, including the case that is easy
 * to get wrong and impossible to miss: someone who has only ever used one agent
 * must never see another one credited.
 *
 * Zero dependencies, Node stdlib only.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeChart, chartGeometry,
  clockGeometry, donutGeometry, barsGeometry, sparkGeometry, heatGeometry, castGeometry,
  castFromTimeline, castHeadline, AGENT_NAMES, HEAT_OPS,
  planStoryboard, trimMids, SCENE_TIMING, VIDEO_TARGET_MS,
} from '../src/app/video.js';

const TAU = Math.PI * 2;
const BOX = { x: 96, y: 346, w: 888, h: 760 };

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);
const inBox = (p, box) =>
  p.x >= box.x - 0.001 && p.x <= box.x + box.w + 0.001
  && p.y >= box.y - 0.001 && p.y <= box.y + box.h + 0.001;

/* ── 1. normalisation: the shapes the detectors actually emit ──────────── */

test('a clock payload is a bare array of 24 numbers, not an object', () => {
  const raw = { type: 'clock', data: [138, 12, 3, 0, 1, 2, 46, 56, 105, 247, 398, 381, 588, 542, 424, 334, 344, 373, 361, 397, 327, 296, 265, 123] };
  const c = normalizeChart(raw);
  assert.equal(c.type, 'clock');
  assert.equal(c.bins.length, 24);
  assert.equal(c.bins[12], 588);
  assert.equal(c.peak, 12, 'the busiest hour is found, not trusted from the payload');
});

test('a short clock series is padded to a full day rather than refused', () => {
  const c = normalizeChart({ type: 'clock', data: [0, 0, 5] });
  assert.equal(c.bins.length, 24);
  assert.equal(c.bins[23], 0);
  assert.equal(c.peak, 2);
});

test('rows arrive as {label, v} and come out sorted by value, biggest first', () => {
  const c = normalizeChart({
    type: 'bars',
    data: [{ label: 'Read', v: 2096 }, { label: 'Other', v: 50606 }, { label: 'Shell', v: 6733 }],
  });
  assert.deepEqual(c.rows.map((r) => r.label), ['Other', 'Shell', 'Read']);
  assert.equal(c.rows[0].value, 50606);
});

test('every row shape in the codebase decodes to the same thing', () => {
  const want = [{ label: 'a', value: 3 }, { label: 'b', value: 1 }];
  for (const data of [
    [{ label: 'a', v: 3 }, { label: 'b', v: 1 }],
    [{ label: 'a', value: 3 }, { label: 'b', value: 1 }],
    [{ name: 'a', n: 3 }, { name: 'b', n: 1 }],
    [['a', 3], ['b', 1]],
    { rows: [{ label: 'a', v: 3 }, { label: 'b', v: 1 }] },
    { slices: [{ label: 'a', v: 3 }, { label: 'b', v: 1 }] },
  ]) {
    assert.deepEqual(normalizeChart({ type: 'bars', data }).rows, want, JSON.stringify(data));
  }
});

test('bars stop at eight rows and a donut folds the tail into "other"', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ label: `p${i}`, v: 100 - i }));
  assert.equal(normalizeChart({ type: 'bars', data: many }).rows.length, 8);
  const donut = normalizeChart({ type: 'donut', data: many }).rows;
  assert.equal(donut.length, 5);
  assert.equal(donut[4].label, 'other');
  assert.equal(donut[4].value, many.slice(4).reduce((s, r) => s + r.v, 0));
});

test('heat and spark payloads are [{date, v}] and reduce to plain series', () => {
  const days = Array.from({ length: 21 }, (_, i) => ({ date: `2026-01-${i + 1}`, v: i }));
  assert.deepEqual(normalizeChart({ type: 'heat', data: days }).values.length, 21);
  assert.deepEqual(normalizeChart({ type: 'spark', data: days }).points[20], 20);
});

test('nothing worth drawing returns null so the card stays text-only', () => {
  assert.equal(normalizeChart(null), null);
  assert.equal(normalizeChart({ type: 'clock', data: new Array(24).fill(0) }), null);
  assert.equal(normalizeChart({ type: 'bars', data: [] }), null);
  assert.equal(normalizeChart({ type: 'spark', data: [4] }), null, 'one point is not a trend');
  assert.equal(normalizeChart({ type: 'heat', data: [1, 2] }), null, 'two days is not a grid');
  assert.equal(normalizeChart({ type: 'sankey', data: [1, 2, 3] }), null, 'unknown types are refused');
});

/* ── 2. clock geometry ─────────────────────────────────────────────────── */

test('the clock has one ray per hour, midnight up, going clockwise', () => {
  const bins = Array.from({ length: 24 }, (_, i) => i + 1);
  const g = clockGeometry(bins, BOX);
  assert.equal(g.rays.length, 24);
  near(g.rays[0].a, -Math.PI / 2, 1e-9, 'hour 0 points straight up');
  near(g.rays[6].a, 0, 1e-9, 'hour 6 points right');
  near(g.rays[12].a, Math.PI / 2, 1e-9, 'hour 12 points down');
  for (let i = 1; i < 24; i++) {
    near(g.rays[i].a - g.rays[i - 1].a, TAU / 24, 1e-9, `step ${i}`);
  }
});

test('ray length is the hour\'s share of the peak, between the two rings', () => {
  const bins = new Array(24).fill(0);
  bins[3] = 10; bins[9] = 5; bins[10] = 0;
  const g = clockGeometry(bins, BOX);
  const len = (r) => Math.hypot(r.x2 - g.cx, r.y2 - g.cy);
  near(len(g.rays[3]), g.r1, 1e-6, 'the peak hour reaches the outer ring');
  near(len(g.rays[9]), g.r0 + (g.r1 - g.r0) * 0.5, 1e-6, 'half the peak is half way out');
  near(len(g.rays[10]), g.r0, 1e-6, 'an empty hour is a stub at the inner ring');
  assert.equal(g.rays[10].zero, true);
});

test('the peak hour is flagged, and the small hours keep the night accent', () => {
  const bins = new Array(24).fill(1);
  bins[2] = 99;
  const g = clockGeometry(bins, BOX);
  assert.equal(g.peak, 2);
  assert.equal(g.rays.filter((r) => r.peak).length, 1, 'exactly one peak');
  assert.deepEqual(g.rays.filter((r) => r.night).map((r) => r.i), [0, 1, 2, 3, 4, 5]);
  assert.equal(g.big, '02');
});

test('the clock is square and centred whatever the band it is given', () => {
  for (const box of [BOX, { x: 0, y: 0, w: 400, h: 900 }, { x: 40, y: 12, w: 900, h: 300 }]) {
    const g = clockGeometry(new Array(24).fill(1), box);
    near(g.cx, box.x + box.w / 2, 1e-9, 'centred x');
    near(g.cy, box.y + box.h / 2, 1e-9, 'centred y');
    assert.ok(g.r1 * 2 <= Math.min(box.w, box.h) + 1e-9, 'never wider than the band');
    assert.ok(g.r0 < g.r1);
  }
});

/* ── 3. donut geometry ─────────────────────────────────────────────────── */

test('donut arcs sum to a full turn, in payload order, starting at the top', () => {
  const rows = [{ label: 'a', value: 50 }, { label: 'b', value: 30 }, { label: 'c', value: 20 }];
  const g = donutGeometry(rows, BOX);
  const total = g.arcs.reduce((s, a) => s + a.sweep, 0);
  near(total, TAU, 1e-9, 'the ring closes');
  near(g.arcs[0].start, -Math.PI / 2, 1e-9, 'the first segment starts at twelve o\'clock');
  for (let i = 1; i < g.arcs.length; i++) {
    near(g.arcs[i].start, g.arcs[i - 1].start + g.arcs[i - 1].sweep, 1e-9, `segment ${i} follows`);
  }
  near(g.arcs[0].sweep, TAU / 2, 1e-9, 'half the total is half the ring');
});

test('a single segment still closes the ring instead of drawing nothing', () => {
  const g = donutGeometry([{ label: 'only', value: 7 }], BOX);
  near(g.arcs[0].sweep, TAU, 1e-9);
  assert.equal(g.big, '100%');
});

test('the hole carries the leading share, and thin segments lose their label', () => {
  const g = donutGeometry([
    { label: 'workspace', value: 90 }, { label: 'tiny', value: 5 },
    { label: 'tinier', value: 3 }, { label: 'tiniest', value: 2 },
  ], BOX);
  assert.equal(g.big, '90%');
  assert.equal(g.sub, 'WORKSPACE');
  assert.equal(g.arcs[0].roomy, true, 'the big one is labelled on the mark');
  assert.equal(g.arcs[3].roomy, false, 'a 7° sliver is not');
});

test('the donut keeps the page\'s 460×330 proportion inside any band', () => {
  const g = donutGeometry([{ label: 'a', value: 1 }], { x: 0, y: 0, w: 460, h: 900 });
  near(g.r, 104, 1e-9, 'scaled by width when width is the constraint');
  near(g.sw, 28, 1e-9);
});

/* ── 4. bars geometry ──────────────────────────────────────────────────── */

test('bars normalise to the largest value, not to the total', () => {
  const rows = [{ label: 'Other', value: 50606 }, { label: 'Script', value: 20563 }, { label: 'Shell', value: 6733 }];
  const g = barsGeometry(rows, BOX);
  assert.equal(g.max, 50606);
  near(g.bars[0].w, g.trackW, 1e-9, 'the biggest bar fills the track');
  near(g.bars[1].w / g.trackW, 20563 / 50606, 1e-9, 'the rest are its fraction');
  near(g.bars[2].w / g.trackW, 6733 / 50606, 1e-9);
  for (const b of g.bars) assert.ok(b.w > 0 && b.w <= g.trackW + 1e-9, 'no bar escapes the track');
});

test('a zero row is still drawn as a hairline rather than vanishing', () => {
  const g = barsGeometry([{ label: 'a', value: 10 }, { label: 'b', value: 0 }], BOX);
  assert.ok(g.bars[1].w > 0);
});

test('bar rows stack without overlapping and stay inside the band', () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({ label: `t${i}`, value: 8 - i }));
  const g = barsGeometry(rows, BOX);
  for (let i = 1; i < g.bars.length; i++) {
    assert.ok(g.bars[i].y >= g.bars[i - 1].y + g.bars[i - 1].h, `row ${i} clears row ${i - 1}`);
  }
  const last = g.bars[7];
  assert.ok(last.y + last.h <= BOX.y + BOX.h + 1e-9, 'the last row fits');
  assert.ok(g.bars[0].y >= BOX.y - 1e-9, 'the first row fits');
});

test('values are grouped for the eye above ten thousand', () => {
  const g = barsGeometry([{ label: 'a', value: 50606 }, { label: 'b', value: 812 }], BOX);
  assert.equal(g.bars[0].text, '50 606');
  assert.equal(g.bars[1].text, '812');
});

/* ── 5. spark geometry ─────────────────────────────────────────────────── */

test('spark points map into the box, first at the left edge and last at the right', () => {
  const pts = [55, 21, 43, 7, 16, 1, 26, 4, 15, 60];
  const g = sparkGeometry(pts, BOX);
  assert.equal(g.pts.length, pts.length);
  for (const p of g.pts) assert.ok(inBox(p, BOX), `(${p.x}, ${p.y}) is inside the band`);
  near(g.pts[0].x, g.x, 1e-9, 'starts flush left');
  near(g.pts[pts.length - 1].x, g.x + g.w, 1e-9, 'ends flush right');
  for (let i = 1; i < g.pts.length; i++) assert.ok(g.pts[i].x > g.pts[i - 1].x, 'time only goes forward');
});

test('the highest reading sits above the lowest, and a flat series does not divide by zero', () => {
  const g = sparkGeometry([1, 9, 5], BOX);
  assert.ok(g.pts[1].y < g.pts[0].y, 'canvas y grows downward, so the peak is the smallest y');
  assert.ok(g.pts[2].y < g.pts[0].y && g.pts[2].y > g.pts[1].y);
  const flat = sparkGeometry([4, 4, 4], BOX);
  for (const p of flat.pts) assert.ok(isFinite(p.y) && inBox(p, BOX));
});

/* ── 6. heat geometry ──────────────────────────────────────────────────── */

test('the heat grid is seven rows deep and a column per week', () => {
  for (const n of [350, 7, 8, 364, 100]) {
    const g = heatGeometry(new Array(n).fill(1), BOX);
    assert.equal(g.rows, 7, `${n} days`);
    assert.equal(g.cols, Math.ceil(n / 7), `${n} days → ${Math.ceil(n / 7)} columns`);
    assert.equal(g.cells.length, n);
    assert.equal(g.cells[g.cells.length - 1].col, Math.floor((n - 1) / 7));
    assert.equal(g.cells[g.cells.length - 1].row, (n - 1) % 7);
  }
});

test('cells fill column by column and every one lands in the band', () => {
  const g = heatGeometry(Array.from({ length: 30 }, (_, i) => i), BOX);
  for (let i = 0; i < 7; i++) near(g.cells[i].x, g.cells[0].x, 1e-9, 'first week shares a column');
  assert.ok(g.cells[7].x > g.cells[6].x, 'week two is to the right');
  for (const c of g.cells) {
    assert.ok(c.x >= BOX.x - 1e-9 && c.x + c.s <= BOX.x + BOX.w + 1e-9, 'inside horizontally');
    assert.ok(c.y >= BOX.y - 1e-9 && c.y + c.s <= BOX.y + BOX.h + 1e-9, 'inside vertically');
  }
});

test('intensity is five steps of the peak, and an empty day is the empty step', () => {
  const g = heatGeometry([0, 1, 3, 6, 8, 10], BOX);
  assert.deepEqual(g.cells.map((c) => c.step), [0, 1, 2, 3, 4, 5]);
  assert.equal(HEAT_OPS.length, 6);
  assert.equal(HEAT_OPS[0] < HEAT_OPS[5], true);
});

/* ── 7. the dispatcher ─────────────────────────────────────────────────── */

test('chartGeometry routes every type and refuses a band with no room', () => {
  const cases = {
    clock: { type: 'clock', data: new Array(24).fill(3) },
    donut: { type: 'donut', data: [{ label: 'a', v: 2 }] },
    bars: { type: 'bars', data: [{ label: 'a', v: 2 }] },
    spark: { type: 'spark', data: [1, 2, 3] },
    heat: { type: 'heat', data: new Array(28).fill(1) },
  };
  for (const [type, raw] of Object.entries(cases)) {
    const g = chartGeometry(normalizeChart(raw), BOX);
    assert.equal(g.type, type);
    assert.ok(g.bounds.w > 0 && g.bounds.h > 0, `${type} has drawable bounds`);
  }
  assert.equal(chartGeometry(null, BOX), null);
  assert.equal(chartGeometry(normalizeChart(cases.bars), { x: 0, y: 0, w: 0, h: 0 }), null);
});

/* ── 8. the cast ───────────────────────────────────────────────────────── */

const day = (date, agent) => ({ date, sessions: 1, minutes: 10, humanTurns: 0, agent });

test('the split is messages per agent, summed across the timeline', () => {
  const c = castFromTimeline([
    day('2026-01-01', { claude: 5, codex: 0, cursor: 20 }),
    day('2026-01-02', { claude: 1, codex: 9, cursor: 5 }),
    day('2026-01-03', { claude: 0, codex: 0, cursor: 0 }),
  ]);
  assert.equal(c.total, 40);
  assert.equal(c.days, 2, 'a day with nothing on it is not a day together');
  assert.deepEqual(c.agents.map((a) => [a.name, a.messages]), [
    ['Cursor', 25], ['Codex', 9], ['Claude Code', 6],
  ]);
  near(c.agents[0].share, 25 / 40, 1e-12, 'share');
  near(c.agents.reduce((s, a) => s + a.share, 0), 1, 1e-12, 'shares sum to one');
});

test('an agent you have never used is never credited', () => {
  const c = castFromTimeline([
    day('2026-01-01', { claude: 12, codex: 0, cursor: 0 }),
    day('2026-01-02', { claude: 30, codex: 0, cursor: 0 }),
  ]);
  assert.equal(c.agents.length, 1, 'one agent, one credit');
  assert.equal(c.agents[0].name, 'Claude Code');
  assert.equal(c.agents[0].share, 1);
  assert.equal(c.headline, 'Claude Code presents', 'singular verb for a solo act');
  assert.ok(!/Cursor|Codex/.test(c.headline), 'nobody else gets a mention');
});

test('the headline reads as a title card for one, two or three agents', () => {
  const of = (...names) => names.map((name) => ({ name }));
  assert.equal(castHeadline(of('Codex')), 'Codex presents');
  assert.equal(castHeadline(of('Cursor', 'Codex')), 'Cursor and Codex present');
  assert.equal(castHeadline(of('Cursor', 'Codex', 'Claude Code')),
    'Cursor, Codex and Claude Code present');
  assert.equal(castHeadline([]), '', 'no cast, no card');
});

test('agents are credited by real product name, and unknown keys degrade politely', () => {
  assert.equal(AGENT_NAMES.claude, 'Claude Code');
  assert.equal(AGENT_NAMES.codex, 'Codex');
  assert.equal(AGENT_NAMES.cursor, 'Cursor');
  const c = castFromTimeline([day('2026-01-01', { aider: 4 })]);
  assert.equal(c.agents[0].name, 'Aider');
});

test('an empty or malformed timeline produces no cast rather than a broken one', () => {
  for (const tl of [[], null, undefined, [{ date: 'x' }], [day('2026-01-01', { cursor: 0 })]]) {
    const c = castFromTimeline(tl);
    assert.equal(c.agents.length, 0);
    assert.equal(c.total, 0);
    assert.equal(c.headline, '');
  }
});

test('ties break by name so two runs of the same history draw the same card', () => {
  const a = castFromTimeline([day('2026-01-01', { cursor: 10, codex: 10 })]);
  const b = castFromTimeline([day('2026-01-01', { codex: 10, cursor: 10 })]);
  assert.deepEqual(a.agents.map((x) => x.name), b.agents.map((x) => x.name));
  assert.deepEqual(a.agents.map((x) => x.name), ['Codex', 'Cursor']);
});

test('the cast block lays out one row per agent over one stacked bar', () => {
  const cast = castFromTimeline([day('2026-01-01', { cursor: 80, codex: 17, claude: 3 })]);
  const g = castGeometry(cast, BOX);
  assert.equal(g.rows.length, 3);
  assert.deepEqual(g.rows.map((r) => r.pct), ['80%', '17%', '3%']);
  for (let i = 1; i < g.rows.length; i++) assert.ok(g.rows[i].y > g.rows[i - 1].y, 'rows stack down');
  assert.equal(g.segments.length, 3);
  near(g.segments[0].x, BOX.x, 1e-9, 'the bar starts at the left margin');
  for (let i = 1; i < g.segments.length; i++) {
    assert.ok(g.segments[i].x > g.segments[i - 1].x, 'segments run left to right in credit order');
  }
  assert.ok(g.segments[2].w > 0, 'a 3% share is still visible');
  assert.ok(g.barY > g.rows[2].y - g.rows[2].nameSize, 'the bar sits under the names');
  assert.ok(g.bounds.y >= BOX.y - 1e-9 && g.bounds.y + g.bounds.h <= BOX.y + BOX.h + 1e-9);
  assert.equal(castGeometry({ agents: [] }, BOX), null);
});

test('a share below one per cent is rounded up, never to nothing', () => {
  const cast = castFromTimeline([day('2026-01-01', { cursor: 10000, claude: 1 })]);
  const g = castGeometry(cast, BOX);
  assert.equal(g.rows[1].pct, '1%', 'a real agent is never credited with 0%');
});

/* ── 9. the cast card in the storyboard ────────────────────────────────── */

test('the cast card opens the clip and the runtime stays under the ceiling', () => {
  const scenes = [
    { role: 'cast' }, { role: 'intro' },
    ...Array.from({ length: 7 }, (_, i) => ({ role: 'mid', id: i })),
    { role: 'finale' },
  ];
  const plan = planStoryboard(scenes);
  assert.equal(plan.scenes[0].role, 'cast', 'first frame says who this is with');
  assert.equal(plan.scenes[0].start, 0);
  assert.equal(plan.scenes[0].duration, SCENE_TIMING.cast);
  assert.equal(plan.scenes[1].role, 'intro');
  assert.ok(plan.duration <= VIDEO_TARGET_MS);
  let at = 0;
  for (const s of plan.scenes) { assert.equal(s.start, at); at = s.end; }
});

test('a storyboard with no cast card simply opens on the intro', () => {
  const plan = planStoryboard([
    { role: 'intro' },
    ...Array.from({ length: 7 }, () => ({ role: 'mid' })),
    { role: 'finale' },
  ]);
  assert.equal(plan.scenes[0].role, 'intro');
  assert.ok(plan.duration <= VIDEO_TARGET_MS);
});

test('over budget, a card with a chart outlives a card without one', () => {
  const mids = [
    { id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'clock', chart: { type: 'clock' } },
    { id: 'd' }, { id: 'e' }, { id: 'f' }, { id: 'donut', chart: { type: 'donut' } },
  ];
  const kept = trimMids(mids, 7).map((s) => s.id);
  assert.equal(kept.length, 7);
  assert.ok(kept.includes('clock') && kept.includes('donut'), 'both figures survive');
  assert.ok(!kept.includes('f'), 'the last text-only card is the one surrendered');
  assert.deepEqual(kept, ['a', 'b', 'c', 'clock', 'd', 'e', 'donut'], 'order is never rearranged');
});

test('when every card carries a chart the trim still fits the budget', () => {
  const mids = Array.from({ length: 9 }, (_, i) => ({ id: i, chart: { type: 'bars' } }));
  assert.equal(trimMids(mids, 7).length, 7);
});

test('the whole path holds: real payload → scene → geometry', () => {
  const chart = normalizeChart({
    type: 'donut',
    data: [
      { label: 'cache read', v: 5169838035 }, { label: 'input', v: 259172541 },
      { label: 'output', v: 21110797 }, { label: 'cache write', v: 89583522 },
    ],
  });
  const plan = planStoryboard([
    { role: 'cast' }, { role: 'intro' }, { role: 'mid', chart }, { role: 'finale' },
  ]);
  const mid = plan.scenes[2];
  assert.equal(mid.chart.type, 'donut', 'the chart survives the storyboard');
  const g = chartGeometry(mid.chart, BOX);
  near(g.arcs.reduce((s, a) => s + a.sweep, 0), TAU, 1e-9);
  assert.equal(g.big, '93%', 'cache reads are 93% of the tokens, and the card says so');
});
