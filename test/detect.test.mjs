/**
 * Tests for src/detect.js and src/stats.js.
 *
 * Everything here runs against synthetic corpora built to the Session[]
 * contract, so it does not depend on src/scan.js or on this machine's history.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMemories } from '../src/detect.js';
import { buildStats } from '../src/stats.js';
import { words, detectLang, makeTz, fmtNum } from '../src/detectors/_util.js';
import { mineNgrams } from '../src/detectors/_ngram.js';

const TZ = 'Asia/Almaty'; // UTC+5, no DST — keeps the fixtures readable
const OFFSET = 5 * 3600000;

/** Local wall-clock → epoch ms, for a fixed-offset zone. */
function at(y, m, d, h = 12, mi = 0) {
  return Date.UTC(y, m - 1, d, h, mi) - OFFSET;
}

const NOW = at(2026, 8, 5, 18, 30);

let uid = 0;
/**
 * Build a Session matching the module contract.
 * @param {object} o
 */
function session(o) {
  const prompts = o.prompts || [];
  const agentTurns = o.agentTurns || prompts.map((p, i) => ({
    ts: p.ts + 30000,
    text: o.agentText || `Here is what I did. ${'word '.repeat(40)}step ${i}.`,
  }));
  const start = o.start != null ? o.start : (prompts[0] ? prompts[0].ts : NOW);
  const end = o.end != null ? o.end : (prompts.length ? prompts[prompts.length - 1].ts + 120000 : start + 60000);
  return {
    id: o.id || `sess-${++uid}`,
    agent: o.agent || 'codex',
    source: `/tmp/${o.id || uid}.jsonl`,
    title: o.title || null,
    cwd: o.cwd || `/Users/x/code/${o.project || 'proj'}`,
    project: o.project || 'proj',
    gitBranch: 'main',
    startedAt: start,
    endedAt: end,
    durationMs: o.durationMs != null ? o.durationMs : Math.min(end - start, 45 * 60000),
    models: o.models || ['gpt-5.6-sol'],
    cliVersion: '1.0.0',
    humanTurns: prompts,
    agentTurns,
    reasoning: o.reasoning || [],
    tools: o.tools || { exec_command: 8, apply_patch: 3 },
    filesTouched: o.filesTouched || [`/Users/x/code/${o.project || 'proj'}/src/index.js`],
    interrupts: o.interrupts || [],
    tokens: o.tokens || { in: 40000, out: 9000, cacheRead: 900000, cacheWrite: 0, reasoning: 3000 },
    compactions: o.compactions || 0,
    subagents: o.subagents || 0,
    thinkingChars: o.thinkingChars || 0,
    forkedFrom: null,
    isSidechain: !!o.isSidechain,
  };
}

const OPTS = { now: NOW, tz: TZ, redact: (s) => s };

/* --------------------------------------------------------- corpus builders */

/** A rich six-month corpus, shaped like the real one on this machine. */
function richCorpus() {
  uid = 0;
  const sessions = [];
  const projects = ['orchard', 'beacon', 'kiln', 'workspace', 'orchard-v2'];
  const phrases = [
    'коммит и пуш', 'продолжай', 'сделай деплой', 'коммит и пуш', 'почини тесты',
    'коммит и пуш', 'do it', 'проверь ещё раз', 'коммит и пуш', 'ship it',
  ];
  let day = 0;
  for (let s = 0; s < 60; s++) {
    day += (s % 4 === 0) ? 2 : 1;
    const date = new Date(at(2026, 2, 6) + day * 86400000);
    const y = date.getUTCFullYear();
    const mo = date.getUTCMonth() + 1;
    const dd = date.getUTCDate();
    const project = projects[s % projects.length];
    const hour = [9, 12, 17, 23, 2][s % 5];
    const prompts = [];
    const nTurns = 4 + (s % 6);
    for (let i = 0; i < nTurns; i++) {
      const text = i % 3 === 0
        ? phrases[(s + i) % phrases.length]
        : `${phrases[(s + i) % phrases.length]}, и ещё проверь состояние ${project} перед деплоем`;
      prompts.push({ ts: at(y, mo, dd, hour, i * 7), text });
    }
    sessions.push(session({
      id: `s${s}`,
      agent: s % 5 === 0 ? 'claude' : 'codex',
      project,
      prompts,
      models: [s < 30 ? 'gpt-5.5' : 'gpt-5.6-sol'],
      durationMs: (20 + (s % 40)) * 60000,
      tools: { exec_command: 30 + s, exec: 12, apply_patch: 5, Read: 3 },
      interrupts: s % 3 === 0 ? [{ ts: at(y, mo, dd, hour, 20), durationMs: 4000 }] : [],
      filesTouched: [
        `/Users/x/code/${project}/src/index.js`,
        `/Users/x/code/${project}/src/util.js`,
      ],
      compactions: s % 12 === 0 ? 1 : 0,
      subagents: s % 10 === 0 ? 3 : 0,
      reasoning: s % 7 === 0
        ? [{ ts: at(y, mo, dd, hour, 3), text: '**Planning safe process termination**\n' + 'x'.repeat(4000) }]
        : [],
    }));
  }
  // A project touched exactly once, long ago, and never again.
  sessions.push(session({
    id: 'ghost',
    project: 'weekend-thing',
    prompts: [
      { ts: at(2026, 2, 14, 21, 0), text: 'давай попробуем новую идею с генератором' },
      { ts: at(2026, 2, 14, 21, 20), text: 'ладно, потом доделаю' },
    ],
    durationMs: 42 * 60000,
  }));
  return sessions;
}

/** §4.3 — three days, two projects, 24 prompts, 61 tool calls. */
function threeDayCorpus() {
  uid = 0;
  const mk = (d, project, hour, texts, tools) => session({
    id: `d${d}-${project}`,
    project,
    prompts: texts.map((t, i) => ({ ts: at(2026, 8, d, hour, i * 5), text: t })),
    durationMs: 26 * 60000,
    tools,
    filesTouched: [`/Users/x/code/${project}/app.js`],
  });
  return [
    mk(3, 'alpha', 20, [
      'помоги настроить проект', 'сделай тесты', 'запусти их', 'почини ошибку',
      'сделай коммит', 'спасибо', 'что дальше?', 'ок продолжай',
    ], { exec_command: 12, apply_patch: 4, Read: 3 }),
    mk(4, 'alpha', 21, [
      'продолжай', 'сделай рефактор', 'проверь типы', 'запусти тесты',
      'сделай коммит', 'а можно быстрее?', 'ок', 'продолжай',
    ], { exec_command: 14, apply_patch: 5, Write: 2 }),
    mk(5, 'beta', 22, [
      'новый проект', 'сделай скелет', 'добавь роутер', 'запусти dev',
      'почини стили', 'сделай коммит', 'что ещё?', 'продолжай',
    ], { exec_command: 15, apply_patch: 4, Read: 2 }),
  ];
}

/* -------------------------------------------------------------------- tests */

test('determinism: two runs over the same corpus are byte-identical', () => {
  const corpus = richCorpus();
  const a = buildMemories(corpus, OPTS);
  const b = buildMemories(richCorpus(), OPTS);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('determinism: seeds are stable uint32 hashes of the memory id', () => {
  const out = buildMemories(richCorpus(), OPTS);
  for (const m of out.memories) {
    assert.ok(Number.isInteger(m.seed) && m.seed >= 0 && m.seed <= 0xffffffff, `bad seed on ${m.id}`);
    assert.ok(m.id.includes(':'), `id must be type:key — got ${m.id}`);
  }
});

test('graceful degradation: a three-day corpus still yields at least 12 memories', () => {
  const out = buildMemories(threeDayCorpus(), OPTS);
  assert.ok(
    out.memories.length >= 12,
    `expected >= 12 cards, got ${out.memories.length}: ${out.memories.map((m) => m.type).join(', ')}`,
  );
  // Not one of them may say "not enough data".
  for (const m of out.memories) {
    assert.doesNotMatch(`${m.title} ${m.body || ''}`, /not enough data|no data|insufficient/i);
  }
  assert.equal(out.wrapped.length, 10, 'wrapped must fill all ten slots');
  assert.equal(new Set(out.wrapped).size, 10, 'no wrapped slot may repeat a detector');
});

test('graceful degradation: a three-prompt corpus produces a feed and an end card', () => {
  const tiny = [session({
    id: 'tiny',
    project: 'hello',
    prompts: [
      { ts: at(2026, 8, 5, 9, 0), text: 'привет, помоги с проектом' },
      { ts: at(2026, 8, 5, 9, 4), text: 'сделай тесты' },
      { ts: at(2026, 8, 5, 9, 9), text: 'спасибо' },
    ],
    durationMs: 9 * 60000,
    tools: { exec_command: 3 },
  })];
  const out = buildMemories(tiny, OPTS);
  assert.ok(out.memories.length >= 3, 'a tiny corpus still produces cards');
  assert.ok(out.memories.some((m) => m.type === 'first-words'));
  assert.equal(out.wrapped.length, 10);
});

test('archetype selection separates three distinct profiles', () => {
  // 1. The Midnight Interrogator — everything happens between 1 and 4 AM.
  uid = 0;
  const night = [];
  for (let d = 1; d <= 8; d++) {
    night.push(session({
      id: `n${d}`,
      project: 'owl',
      prompts: Array.from({ length: 8 }, (_, i) => ({
        ts: at(2026, 7, d * 2, 1 + (i % 4), i * 3),
        text: 'fix the failing test and explain what changed',
      })),
      durationMs: 30 * 60000,
      tools: { exec_command: 20 },
    }));
  }
  assert.equal(buildMemories(night, OPTS).profile.archetype.name, 'The Midnight Interrogator');

  // 2. The Two-Word Tyrant — three-word prompts, enormous tool volume.
  uid = 0;
  const terse = [];
  for (let d = 1; d <= 6; d++) {
    terse.push(session({
      id: `t${d}`,
      project: 'blade',
      prompts: Array.from({ length: 10 }, (_, i) => ({
        ts: at(2026, 7, 10 + d, 14, i * 4),
        text: ['do it', 'продолжай', 'fix', 'ship it', 'again'][i % 5],
      })),
      durationMs: 25 * 60000,
      tools: { exec_command: 300, apply_patch: 60 },
    }));
  }
  assert.equal(buildMemories(terse, OPTS).profile.archetype.name, 'The Two-Word Tyrant');

  // 3. The Considerate — long, polite prompts across two projects.
  uid = 0;
  const polite = [];
  for (let d = 1; d <= 10; d++) {
    polite.push(session({
      id: `p${d}`,
      project: d % 2 ? 'alpha' : 'beta',
      prompts: Array.from({ length: 6 }, (_, i) => ({
        ts: at(2026, 7, d * 2, 11, i * 6),
        text:
          'Please could you take a careful look at the failing integration test, ' +
          'and thank you for the detailed write-up earlier, it was genuinely useful ' +
          'when I was trying to work out where the regression came from in the parser ' +
          'and the surrounding helper functions that we changed last week together.',
      })),
      durationMs: 30 * 60000,
      tools: { exec_command: 10 },
    }));
  }
  assert.equal(buildMemories(polite, OPTS).profile.archetype.name, 'The Considerate');
});

test('trigger boundary: the-streak needs three consecutive days, not two', () => {
  const build = (days) => {
    uid = 0;
    return days.map((d) => session({
      id: `s${d}`,
      project: 'streaky',
      prompts: [{ ts: at(2026, 7, d, 10, 0), text: 'сделай сборку и проверь' }],
      durationMs: 20 * 60000,
    }));
  };
  const two = buildMemories(build([10, 11, 20, 25]), OPTS);
  assert.equal(two.archive.some((m) => m.type === 'the-streak'), false, 'two days must not fire');

  const three = buildMemories(build([10, 11, 12, 20, 25]), OPTS);
  const streak = three.archive.find((m) => m.type === 'the-streak');
  assert.ok(streak, 'three consecutive days must fire');
  assert.match(streak.title, /3 days/);
});

test('trigger boundary: the-long-night needs three after-midnight turns', () => {
  const build = (n) => {
    uid = 0;
    return [session({
      id: 'night',
      project: 'owl',
      prompts: [
        ...Array.from({ length: n }, (_, i) => ({ ts: at(2026, 7, 20, 3, 10 + i * 5), text: 'почему это не работает?' })),
        { ts: at(2026, 7, 20, 14, 0), text: 'ладно, продолжим завтра утром' },
      ],
      durationMs: 40 * 60000,
    })];
  };
  assert.equal(buildMemories(build(2), OPTS).archive.some((m) => m.type === 'the-long-night'), false);
  assert.equal(buildMemories(build(3), OPTS).archive.some((m) => m.type === 'the-long-night'), true);
});

test('local time: hours are bucketed in opts.tz, not UTC', () => {
  // 02:30 local in Asia/Almaty is 21:30 UTC the previous day.
  const s = [session({
    id: 'tzcheck',
    project: 'tz',
    prompts: [{ ts: at(2026, 7, 20, 2, 30), text: 'ночной вопрос про сборку' }],
    durationMs: 10 * 60000,
  })];
  const ctx = buildStats(s, { now: NOW, tz: TZ, redact: (x) => x });
  assert.equal(ctx.humanTurns[0].hour, 2);
  assert.equal(ctx.hourHist[2], 1);
  const utc = buildStats(s, { now: NOW, tz: 'UTC', redact: (x) => x });
  assert.equal(utc.humanTurns[0].hour, 21);
});

test('n-gram miner: Cyrillic phrases win, and repeats inside one turn count once', () => {
  const docs = [];
  for (let i = 0; i < 14; i++) docs.push({ text: 'коммит и пуш', ts: at(2026, 3, 2 + i, 12) });
  for (let i = 0; i < 10; i++) docs.push({ text: 'коммит', ts: at(2026, 4, 2 + i, 12) });
  // One turn saying it six times must still count once.
  docs.push({ text: 'commit commit commit commit commit commit', ts: at(2026, 5, 1, 12) });
  const res = mineNgrams(docs, { minDf: 3 });
  assert.equal(res[0].phrase, 'коммит и пуш');
  assert.equal(res[0].df, 14);
  assert.equal(res.some((r) => r.phrase === 'commit'), false, 'df of 1 must not survive');
});

test('tokenizer: Cyrillic and Latin both count, no mojibake', () => {
  assert.deepEqual(words('Коммит и Пуш!'), ['коммит', 'и', 'пуш']);
  assert.equal(words('привет мир, hello world').length, 4);
  assert.equal(detectLang('коммит и пуш пожалуйста'), 'ru');
  assert.equal(detectLang('commit and push please'), 'en');
});

test('feed rhythm: never three stat cards in a row, never two of a type in a row', () => {
  const out = buildMemories(richCorpus(), OPTS);
  const feed = out.memories;
  for (let i = 2; i < feed.length; i++) {
    const trio = [feed[i - 2], feed[i - 1], feed[i]];
    assert.ok(
      !trio.every((m) => m.kind === 'stat'),
      `three stats in a row at ${i}: ${trio.map((m) => m.type).join(' → ')}`,
    );
  }
  for (let i = 1; i < feed.length; i++) {
    assert.notEqual(feed[i].type, feed[i - 1].type, `repeated type at ${i}: ${feed[i].type}`);
  }
  assert.ok(feed.length <= 40, 'feed is capped at 40');
  assert.equal(feed[feed.length - 1].type, 'share-card', 'share card closes the feed');
});

test('paranoid redaction: no quotes, no paths, still at least 12 cards', () => {
  const redact = (s) => String(s).replace(/\/[^\s]+/g, '~');
  redact.level = 'paranoid';
  const out = buildMemories(richCorpus(), { now: NOW, tz: TZ, redact, redactLevel: 'paranoid' });
  assert.ok(out.memories.length >= 12, `got ${out.memories.length}`);
  for (const m of out.memories) {
    assert.equal(m.quote, null, `${m.type} leaked a quote in paranoid mode`);
    const text = `${m.title} ${m.body || ''}`;
    assert.doesNotMatch(text, /\/Users\//, `${m.type} leaked a path`);
  }
});

test('copy lint: banned strings never appear, bodies stay short', () => {
  const banned = [
    'productivity', 'insights', 'unlock', 'journey', 'leverage', 'optimize',
    'efficiency', 'screen time', 'Great job', 'Impressive', 'Amazing', '🎉',
    '!!', 'AI-powered', 'deep dive',
  ];
  const outs = [buildMemories(richCorpus(), OPTS), buildMemories(threeDayCorpus(), OPTS)];
  for (const out of outs) {
    for (const m of out.archive) {
      const text = `${m.eyebrow} ${m.title} ${m.body || ''}`;
      for (const b of banned) {
        assert.ok(!text.toLowerCase().includes(b.toLowerCase()), `${m.type} used banned "${b}"`);
      }
      assert.ok(!/[!]/.test(text), `${m.type} used an exclamation mark: ${text}`);
      assert.ok((m.body || '').length <= 220, `${m.type} body is ${(m.body || '').length} chars`);
    }
  }
});

test('contract: every memory has the shape the front-end expects', () => {
  const out = buildMemories(richCorpus(), OPTS);
  const kinds = new Set(['onthisday', 'stat', 'quote', 'chart', 'award']);
  for (const m of out.archive) {
    assert.equal(typeof m.id, 'string');
    assert.equal(typeof m.type, 'string');
    assert.ok(kinds.has(m.kind), `bad kind ${m.kind} on ${m.type}`);
    assert.ok(m.date === null || Number.isFinite(m.date));
    assert.ok(m.weight >= 0 && m.weight <= 100);
    assert.equal(typeof m.eyebrow, 'string');
    assert.equal(typeof m.title, 'string');
    assert.ok(m.body === null || typeof m.body === 'string');
    assert.ok(Array.isArray(m.tags));
    assert.equal(typeof m.shareable, 'boolean');
    assert.ok(!('_mag' in m), 'internal ranking fields must not ship');
  }
  assert.ok(out.profile.archetype.name);
  assert.ok(out.timeline.length > 0);
  assert.equal(typeof out.stats.humanTurns, 'number');
});

test('detector coverage: the rich corpus lights up most of the catalog', () => {
  const out = buildMemories(richCorpus(), OPTS);
  const types = new Set(out.archive.map((m) => m.type));
  for (const expected of [
    'on-this-day', 'first-words', 'the-anniversary', 'the-ratio', 'the-marathon',
    'catchphrase-yours', 'spirit-tool', 'deep-work-clock', 'the-bill', 'peak-day',
    'project-constellation', 'the-heatmap', 'model-loyalty', 'the-streak',
    'the-long-night', 'the-interruption', 'the-politeness', 'file-most-touched',
    'longest-thought', 'the-compaction', 'ghost-project', 'the-swarm', 'archetype',
  ]) {
    assert.ok(types.has(expected), `expected ${expected} to fire on the rich corpus`);
  }
});
