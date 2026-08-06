/**
 * Copy-variant ranking (src/detectors/_rank.js).
 *
 * Every detector writes its `blocks` strongest-first; the selector takes the
 * first variant whose data is present, and the hash only breaks ties between
 * variants of declared-equal strength. These tests pin that behaviour, plus the
 * three cards it was introduced to fix: `the-interruption`, `the-politeness`
 * and `deep-work-clock`.
 *
 * Detectors are exercised directly against a ctx from src/stats.js — a full
 * buildMemories() run would let feed ranking hide which variant was chosen.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildStats } from '../src/stats.js';
import { bestBlock, firstOf } from '../src/detectors/_rank.js';
import { theInterruption, thePoliteness } from '../src/detectors/behavior.js';
import { deepWorkClock } from '../src/detectors/rhythm.js';

const TZ = 'Asia/Almaty'; // UTC+5, no DST
const OFFSET = 5 * 3600000;

/** Local wall-clock → epoch ms, for a fixed-offset zone. */
function at(y, m, d, h = 12, mi = 0) {
  return Date.UTC(y, m - 1, d, h, mi) - OFFSET;
}

const NOW = at(2026, 8, 5, 18, 30);
const OPTS = { now: NOW, tz: TZ, redact: (s) => s };

let uid = 0;
/** A Session matching the src/scan.js contract. */
function session(o) {
  const prompts = o.prompts || [];
  const agentTurns = o.agentTurns || prompts.map((p, i) => ({
    ts: p.ts + 30000,
    text: `Here is what I did. ${'word '.repeat(30)}step ${i}.`,
  }));
  const start = o.start != null ? o.start : (prompts[0] ? prompts[0].ts : NOW);
  const end = o.end != null
    ? o.end
    : (prompts.length ? prompts[prompts.length - 1].ts + 120000 : start + 60000);
  return {
    id: o.id || `sess-${++uid}`,
    agent: 'codex',
    source: `/tmp/${o.id || uid}.jsonl`,
    title: null,
    cwd: `/Users/x/code/${o.project || 'proj'}`,
    project: o.project || 'proj',
    gitBranch: 'main',
    startedAt: start,
    endedAt: end,
    durationMs: o.durationMs != null ? o.durationMs : Math.min(end - start, 45 * 60000),
    models: ['gpt-5.6-sol'],
    cliVersion: '1.0.0',
    humanTurns: prompts,
    agentTurns,
    reasoning: [],
    tools: o.tools || { exec_command: 8, apply_patch: 3 },
    filesTouched: [`/Users/x/code/${o.project || 'proj'}/src/index.js`],
    interrupts: o.interrupts || [],
    tokens: { in: 40000, out: 9000, cacheRead: 900000, cacheWrite: 0, reasoning: 3000 },
    compactions: 0,
    subagents: 0,
    thinkingChars: 0,
    forkedFrom: null,
    isSidechain: false,
  };
}

const ctxOf = (sessions) => buildStats(sessions, OPTS);
const card = (detector, ctx) => detector.run(ctx)[0] || null;

/* ------------------------------------------------------------- the selector */

test('ranking: the first available variant wins, nulls are skipped', () => {
  const blocks = [
    null,
    { title: 'strong', body: 'has a number' },
    { title: 'weak', body: 'generic' },
  ];
  assert.equal(bestBlock('x:1', blocks).title, 'strong');
  assert.equal(bestBlock('x:1', [null, null, blocks[2]]).title, 'weak');
  assert.equal(bestBlock('x:1', [null, null]), null);
  assert.equal(bestBlock('x:1', []), null);
});

test('ranking: an explicit rank overrides array position', () => {
  const blocks = [
    { rank: 1, title: 'listed first but weaker' },
    { rank: 9, title: 'the good one' },
  ];
  assert.equal(bestBlock('x:1', blocks).title, 'the good one');
});

test('ranking: the hash only breaks ties between equal-rank variants', () => {
  const tied = [{ rank: 2, title: 'a' }, { rank: 2, title: 'b' }, { title: 'c' }];
  const picked = new Set();
  for (const id of ['t:1', 't:2', 't:3', 't:4', 't:5', 't:6', 't:7', 't:8']) {
    const got = bestBlock(id, tied).title;
    assert.notEqual(got, 'c', 'a lower-ranked variant must never win');
    picked.add(got);
  }
  assert.deepEqual([...picked].sort(), ['a', 'b'], 'both tied variants stay reachable');
});

test('ranking: selection is deterministic and free of Math.random', () => {
  const blocks = [{ rank: 5, title: 'a' }, { rank: 5, title: 'b' }, { rank: 5, title: 'c' }];
  const once = bestBlock('the-thing:42', blocks).title;
  for (let i = 0; i < 50; i++) {
    assert.equal(bestBlock('the-thing:42', blocks).title, once);
  }
  assert.equal(firstOf([null, undefined, 'first real', 'second']), 'first real');
  assert.equal(firstOf([null, null]), null);
});

/* ------------------------------------------------------- the-interruption */

/**
 * A busy corpus: 200 prompts and 75 interrupts, `withDurations` of which carry
 * a duration. Durations are built so the median is 11 s and the longest 5403 s
 * — the numbers measured on the real corpus that motivated this change.
 */
function interruptCorpus(withDurations) {
  uid = 0;
  const sessions = [];
  // One 5403 s outlier, and a spread whose median sits exactly on 11 s.
  const durs = [];
  if (withDurations > 0) {
    const below = Math.floor((withDurations - 1) / 2);
    const above = Math.max(0, withDurations - 2 - below);
    durs.push(5403000, 11000);
    for (let i = 0; i < below; i++) durs.push(8000);
    for (let i = 0; i < above; i++) durs.push(14000);
  }
  let made = 0;
  for (let d = 0; d < 25; d++) {
    const day = 1 + d;
    const prompts = Array.from({ length: 8 }, (_, i) => ({
      ts: at(2026, 7, day, 9 + (i % 8), i * 5),
      text: 'fix the failing test and explain what changed',
    }));
    const interrupts = [];
    for (let k = 0; k < 3 && made < 75; k++, made++) {
      const durationMs = made < durs.length ? durs[made] : null;
      interrupts.push({ ts: at(2026, 7, day, 10, k * 6), durationMs });
    }
    sessions.push(session({ id: `i${d}`, project: 'blade', prompts, interrupts }));
  }
  return sessions;
}

test('the-interruption: the median-patience variant wins when durations exist', () => {
  const ctx = ctxOf(interruptCorpus(57));
  assert.equal(ctx.interrupts.length, 75);
  assert.equal(ctx.interruptsWithDuration.length, 57, 'the gate needs >= 50 % coverage');

  const m = card(theInterruption, ctx);
  assert.ok(m, 'the-interruption must fire on a busy corpus');
  assert.equal(m.title, 'Median patience: 11 seconds.');
  // Durations are spoken, not dumped: 5403 seconds is 90 minutes.
  assert.match(m.body, /90 minutes/);
  assert.doesNotMatch(m.body, /5403/);
});

test('the-interruption: the next-best variant takes over without durations', () => {
  const ctx = ctxOf(interruptCorpus(0));
  assert.equal(ctx.interrupts.length, 75);
  assert.equal(ctx.interruptsWithDuration.length, 0);

  const m = card(theInterruption, ctx);
  assert.equal(m.title, 'You stopped it mid-sentence 75 times.');
  assert.doesNotMatch(m.title, /patience/i);
});

test('the-interruption: half-coverage is the boundary of the strongest variant', () => {
  assert.match(card(theInterruption, ctxOf(interruptCorpus(38))).title, /^Median patience/);
  assert.doesNotMatch(card(theInterruption, ctxOf(interruptCorpus(37))).title, /^Median patience/);
});

/* ---------------------------------------------------------- the-politeness */

/** `n` polite prompts out of `total`, spread over ~6 months. */
function politeCorpus(total, n) {
  uid = 0;
  const sessions = [];
  const perDay = 8;
  let made = 0;
  let polite = 0;
  for (let d = 0; made < total; d++) {
    const prompts = [];
    for (let i = 0; i < perDay && made < total; i++, made++) {
      const wantPolite = polite * total < n * made + n; // even spread, no randomness
      const text = wantPolite && polite < n
        ? 'please fix the failing test, thank you'
        : 'fix the failing test and explain what changed';
      if (text.startsWith('please')) polite++;
      prompts.push({ ts: at(2026, 2, 10 + d, 9 + (i % 10), i * 5), text });
    }
    sessions.push(session({ id: `p${d}`, project: 'manners', prompts }));
  }
  return sessions;
}

test('the-politeness: fires at 0 %, in the old dead band, and at 20 %', () => {
  const zero = ctxOf(politeCorpus(250, 0));
  assert.equal(zero.politeTurns, 0);
  const zeroCard = card(thePoliteness, zero);
  assert.ok(zeroCard, 'zero politeness must still get its own card');
  assert.equal(zeroCard.id, 'the-politeness:zero');
  assert.match(zeroCard.title, /never said thank you/i);

  // 3.6 % — the band that used to return nothing at all.
  const mid = ctxOf(politeCorpus(250, 9));
  const rate = mid.politeTurns / mid.humanTurns.length;
  assert.ok(rate >= 0.01 && rate < 0.04, `expected the old dead band, got ${rate}`);
  const midCard = card(thePoliteness, mid);
  assert.ok(midCard, 'the middle band must not be silent');
  assert.equal(midCard.id, 'the-politeness:sometimes');
  assert.ok(midCard.title.length > 0 && midCard.body.length > 0);
  assert.match(`${midCard.title} ${midCard.body}`, /\d/, 'the middle band still cites its data');

  const high = ctxOf(politeCorpus(250, 50));
  assert.equal(high.politeTurns / high.humanTurns.length, 0.2);
  const highCard = card(thePoliteness, high);
  assert.ok(highCard);
  assert.equal(highCard.id, 'the-politeness:high');
  assert.match(highCard.title, /50/);

  // Three genuinely different lanes, not one line with a different number.
  const titles = new Set([zeroCard.title, midCard.title, highCard.title]);
  assert.equal(titles.size, 3);
});

test('the-politeness: the middle band names the cadence, not just the count', () => {
  // 250 messages over ~31 days, 9 of them polite → roughly one every 3 days.
  const m = card(thePoliteness, ctxOf(politeCorpus(250, 9)));
  assert.match(m.title, /^You thank it /);
  assert.match(m.body, /polite messages out of/);
});

/* --------------------------------------------------------- deep-work-clock */

/**
 * A corpus whose hour histogram has exactly `24 - hoursUsed` empty bins, spread
 * over enough days that the sparse lane doesn't take over.
 */
function clockCorpus(hoursUsed) {
  uid = 0;
  const sessions = [];
  for (let d = 0; d < 6; d++) {
    const prompts = [];
    for (let h = 0; h < hoursUsed; h++) {
      const reps = h === 13 ? 4 : 1; // one clear peak
      for (let r = 0; r < reps; r++) {
        prompts.push({ ts: at(2026, 7, 10 + d, h, 5 + r * 6), text: 'fix the failing test' });
      }
    }
    sessions.push(session({ id: `c${d}`, project: 'clock', prompts }));
  }
  return sessions;
}

test('deep-work-clock: emptyHours 0 gets its own line, not the blandest one', () => {
  const ctx = ctxOf(clockCorpus(24));
  assert.equal(ctx.hourHist.filter((v) => v === 0).length, 0);
  const m = card(deepWorkClock, ctx);
  assert.match(m.title, /no hour of the day you haven’t used/i);
  assert.doesNotMatch(m.title, /except/);
});

test('deep-work-clock: empty hours are named, never counted', () => {
  const one = ctxOf(clockCorpus(23)); // 11 PM never used
  assert.equal(one.hourHist.filter((v) => v === 0).length, 1);
  const m1 = card(deepWorkClock, one);
  assert.equal(m1.title, 'You’ve used every hour on this clock except 11 PM.');

  const three = ctxOf(clockCorpus(21)); // 9, 10, 11 PM never used
  assert.equal(three.hourHist.filter((v) => v === 0).length, 3);
  const m3 = card(deepWorkClock, three);
  assert.equal(m3.title, 'You’ve used every hour on this clock except the stretch from 9 PM to 11 PM.');
  // The old copy rendered the COUNT here, which read as an hour: "except 3".
  assert.doesNotMatch(m3.title, /except 3\.$/);
});

test('deep-work-clock: with too many holes, the peak-hour variant takes over', () => {
  const ctx = ctxOf(clockCorpus(12)); // 12 empty hours — nothing to brag about
  const m = card(deepWorkClock, ctx);
  assert.doesNotMatch(m.title, /except/);
  assert.match(m.title, /^Your day peaks at /, 'falls through to the peak-hour line');
});

/* ------------------------------------------------------------- copy lint */

test('copy lint: the new lanes obey the same rules as the rest of the feed', () => {
  const cards = [
    card(thePoliteness, ctxOf(politeCorpus(250, 0))),
    card(thePoliteness, ctxOf(politeCorpus(250, 9))),
    card(thePoliteness, ctxOf(politeCorpus(250, 50))),
    card(theInterruption, ctxOf(interruptCorpus(57))),
    card(theInterruption, ctxOf(interruptCorpus(0))),
    card(deepWorkClock, ctxOf(clockCorpus(24))),
    card(deepWorkClock, ctxOf(clockCorpus(23))),
    card(deepWorkClock, ctxOf(clockCorpus(21))),
    card(deepWorkClock, ctxOf(clockCorpus(12))),
  ];
  const banned = ['productivity', 'insights', 'unlock', 'journey', 'leverage',
    'optimize', 'efficiency', 'screen time', 'deep dive'];
  for (const m of cards) {
    assert.ok(m, 'every lane must produce a card');
    const text = `${m.eyebrow} ${m.title} ${m.body || ''}`;
    for (const b of banned) assert.ok(!text.toLowerCase().includes(b), `banned "${b}" in ${m.id}`);
    assert.ok(!/[!]/.test(text), `exclamation mark in ${m.id}`);
    assert.ok((m.body || '').length <= 220, `${m.id} body is ${(m.body || '').length} chars`);
  }
});

/* -------------------------------------------------------------- stability */

test('ranking: the same corpus produces the same copy every run', () => {
  const build = () => {
    const ctx = ctxOf(interruptCorpus(57));
    const m = card(theInterruption, ctx);
    return `${m.eyebrow}|${m.title}|${m.body}`;
  };
  const first = build();
  for (let i = 0; i < 5; i++) assert.equal(build(), first);
});
