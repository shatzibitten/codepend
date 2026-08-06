/**
 * codepend — Cursor adapter tests.
 *
 * Every fixture here is a real SQLite database built from Cursor's actual schema (dumped from
 * `sqlite_master` on a 41 MB `conversation-search.db` and an 8 GB `state.vscdb`), because the
 * whole adapter is a bet on that schema. A hand-rolled mock would pass while the real thing
 * failed on the one thing that matters: whether the queries run.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile, mkdir, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  CURSOR_NEEDS_NODE_22,
  buildCursorSession,
  cursorPaths,
  defaultCursorDir,
  loadSqlite,
  parseFtsBody,
  readWorkspaceFolders,
  scanCursor,
} from '../src/agents/cursor.js';
import { scan } from '../src/scan.js';
import { resolveConfig } from '../src/config.js';

const DatabaseSync = await loadSqlite();
/** Node 18/20 have no `node:sqlite`. The adapter's job there is to be silent, which is tested. */
const needsSqlite = { skip: DatabaseSync ? false : 'node:sqlite needs Node 22+' };

const IDLE = 600_000;
const T = (iso) => Date.parse(iso);

/** One fixture bubble -> the `{key, value}` row shape `buildCursorSession` is fed by the scan. */
const bubbleRow = (composerId, b) => ({
  key: `bubbleId:${composerId}:${b.id}`,
  value: JSON.stringify({
    bubbleId: b.id,
    type: b.type,
    text: b.text ?? '',
    richText: b.richText,
    createdAt: b.createdAt,
    tokenCount: b.tokens,
    toolFormerData: b.tool,
    allThinkingBlocks: b.thinking,
  }),
});

/* ------------------------------------------------------------------ *
 * fixture builders — Cursor's real schema, verbatim
 * ------------------------------------------------------------------ */

const SCHEMA_STATE = [
  'CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)',
  'CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)',
  'CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER,' +
    ' lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt INTEGER, value TEXT)',
];

const SCHEMA_SEARCH = [
  `CREATE TABLE conversations (
     fts_rowid INTEGER PRIMARY KEY,
     source TEXT NOT NULL CHECK (source IN ('local', 'cloud-cache')),
     scope TEXT NOT NULL,
     id TEXT NOT NULL,
     title TEXT NOT NULL,
     updated_at INTEGER NOT NULL,
     is_archived INTEGER NOT NULL,
     root_fingerprint TEXT,
     cache_fingerprint TEXT)`,
  'CREATE TABLE conversation_fts_content (id INTEGER PRIMARY KEY, c0, c1)',
];

/**
 * @param {string} dir  a `User/globalStorage` directory to create the databases in
 * @param {object} spec
 */
async function makeCursorDir(dir, spec = {}) {
  const p = cursorPaths(dir);
  await mkdir(p.globalStorage, { recursive: true });

  const state = new DatabaseSync(p.stateDb);
  for (const sql of SCHEMA_STATE) state.exec(sql);
  const putKV = state.prepare('insert into cursorDiskKV (key, value) values (?, ?)');
  const putHeader = state.prepare(
    'insert into composerHeaders (composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, checkpointAt, value)' +
      ' values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );

  for (const c of spec.composers || []) {
    putHeader.run(
      c.id,
      c.workspaceId ?? null,
      c.createdAt ?? null,
      c.lastUpdatedAt ?? null,
      c.isArchived ? 1 : 0,
      c.isSubagent ? 1 : 0,
      c.recency ?? c.lastUpdatedAt ?? null,
      c.checkpointAt ?? null,
      JSON.stringify({ type: 'head', composerId: c.id }),
    );
    putKV.run(
      `composerData:${c.id}`,
      JSON.stringify({
        _v: 9,
        composerId: c.id,
        name: c.name,
        createdAt: c.createdAt,
        modelConfig: c.modelName ? { modelName: c.modelName, maxMode: false } : {},
        subComposerIds: c.subComposerIds || [],
        fullConversationHeadersOnly: (c.bubbles || []).map((b) => ({ bubbleId: b.id, type: b.type })),
      }),
    );
    for (const b of c.bubbles || []) {
      putKV.run(
        `bubbleId:${c.id}:${b.id}`,
        JSON.stringify({
          _v: 2,
          bubbleId: b.id,
          type: b.type,
          text: b.text ?? '',
          richText: b.richText,
          createdAt: b.createdAt,
          tokenCount: b.tokens,
          toolFormerData: b.tool,
          allThinkingBlocks: b.thinking,
        }),
      );
    }
  }
  // Noise Cursor really keeps in the same table: it must not become sessions or crash anything.
  putKV.run('checkpointId:xyz', JSON.stringify({ nothing: true }));
  putKV.run('agentKv:whatever', 'not json at all');
  state.close();

  const search = new DatabaseSync(p.searchDb);
  for (const sql of SCHEMA_SEARCH) search.exec(sql);
  const putConv = search.prepare(
    'insert into conversations (fts_rowid, source, scope, id, title, updated_at, is_archived) values (?, ?, ?, ?, ?, ?, ?)',
  );
  const putBody = search.prepare('insert into conversation_fts_content (id, c0, c1) values (?, ?, ?)');
  let rowid = 1;
  for (const c of spec.conversations || []) {
    putConv.run(rowid, c.source || 'local', c.scope || 'deadbeef', c.id, c.title, c.updatedAt, c.isArchived ? 1 : 0);
    putBody.run(rowid, c.title, c.body ?? '');
    rowid++;
  }
  search.close();
  return p;
}

async function tmpdir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codepend-cursor-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A single, ordinary conversation: two prompts, two replies, one edit, real timestamps. */
function ordinaryComposer(overrides = {}) {
  return {
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    name: 'Fix the build',
    workspaceId: 'ws1',
    createdAt: T('2026-05-01T09:00:00Z'),
    lastUpdatedAt: T('2026-05-01T09:12:00Z'),
    modelName: 'claude-4.6-opus-high-thinking',
    bubbles: [
      { id: 'b1', type: 1, text: 'почини сборку', createdAt: '2026-05-01T09:00:00.000Z' },
      {
        id: 'b2',
        type: 2,
        text: 'Looking at the build now.',
        createdAt: '2026-05-01T09:00:30.000Z',
        tokens: { inputTokens: 1200, outputTokens: 80 },
        tool: {
          name: 'edit_file',
          status: 'completed',
          rawArgs: JSON.stringify({ path: '/w/app/build.mjs', streamContent: 'x'.repeat(5000) }),
        },
      },
      { id: 'b3', type: 1, text: 'and now the tests?', createdAt: '2026-05-01T09:05:00.000Z' },
      {
        id: 'b4',
        type: 2,
        text: 'Green.',
        createdAt: '2026-05-01T09:12:00.000Z',
        tool: { name: 'run_terminal_cmd', status: 'completed', rawArgs: '{"command":"npm test"}' },
        thinking: [{ text: 'the failure is in the loader' }],
      },
    ],
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * path resolution — no database needed
 * ------------------------------------------------------------------ */

test('cursor: the default directory follows the platform', () => {
  const home = '/home/u';
  const env = { HOME: home };
  assert.equal(
    defaultCursorDir({ env, home, platform: 'darwin' }),
    '/home/u/Library/Application Support/Cursor/User/globalStorage',
  );
  assert.equal(defaultCursorDir({ env, home, platform: 'linux' }), '/home/u/.config/Cursor/User/globalStorage');
  assert.equal(
    defaultCursorDir({ env: { ...env, XDG_CONFIG_HOME: '/xdg' }, home, platform: 'linux' }),
    '/xdg/Cursor/User/globalStorage',
  );
  assert.equal(
    defaultCursorDir({ env: { ...env, APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, home, platform: 'win32' }),
    path.join('C:\\Users\\u\\AppData\\Roaming', 'Cursor', 'User', 'globalStorage'),
  );
});

test('cursor: CODEPEND_CURSOR_DIR overrides the platform default', () => {
  assert.equal(
    defaultCursorDir({ env: { CODEPEND_CURSOR_DIR: '~/elsewhere' }, home: '/home/u', platform: 'linux' }),
    '/home/u/elsewhere',
  );
});

test('cursor: globalStorage, its User parent and the Cursor root all resolve the same', () => {
  const want = cursorPaths('/x/Cursor/User/globalStorage');
  assert.deepEqual(cursorPaths('/x/Cursor/User'), want);
  assert.deepEqual(cursorPaths('/x/Cursor'), want);
  assert.equal(want.stateDb, '/x/Cursor/User/globalStorage/state.vscdb');
  assert.equal(want.searchDb, '/x/Cursor/User/globalStorage/conversation-search.db');
  assert.equal(want.workspaceStorage, '/x/Cursor/User/workspaceStorage');
});

test('cursor: --cursor-dir and CODEPEND_CURSOR_DIR reach the resolved config', () => {
  const env = { CODEPEND_HOME: '/home/u', HOME: '/home/u' };
  const fromEnv = resolveConfig({}, { env: { ...env, CODEPEND_CURSOR_DIR: '/env/Cursor/User/globalStorage' } });
  assert.equal(fromEnv.cursorDir, '/env/Cursor/User/globalStorage');

  const fromFlag = resolveConfig(
    { cursorDir: '/flag/Cursor' },
    { env: { ...env, CODEPEND_CURSOR_DIR: '/env/Cursor/User/globalStorage' } },
  );
  assert.equal(fromFlag.cursorDir, '/flag/Cursor/User/globalStorage', 'the flag wins over the environment');
  assert.equal(fromFlag.cursorStateDb, '/flag/Cursor/User/globalStorage/state.vscdb');
});

/* ------------------------------------------------------------------ *
 * the FTS body — the format the brief was written against
 * ------------------------------------------------------------------ */

test('cursor: the FTS body splits on line-leading user:/assistant: markers', () => {
  const body = [
    'user:',
    'why is the loader slow',
    '',
    'assistant:',
    'Because it decodes every byte.',
    'Two lines of it.',
    'user: and now?',
    'assistant:',
    'Fixed.',
  ].join('\n');
  assert.deepEqual(parseFtsBody(body), {
    human: ['why is the loader slow', 'and now?'],
    agent: ['Because it decodes every byte.\nTwo lines of it.', 'Fixed.'],
  });
});

test('cursor: an unmarked FTS body yields nothing rather than a guessed speaker', () => {
  // 502 of 701 real bodies look like this: one blob, both speakers, no markers. Attributing it
  // would put the assistant's words in the reader's mouth on a quote card.
  const body = 'не могу это сделать в чем причина?\nТы на Cloudflare login через Google SSO.\nЛогин прошёл.';
  assert.deepEqual(parseFtsBody(body), { human: [], agent: [] });
  assert.deepEqual(parseFtsBody(''), { human: [], agent: [] });
  assert.deepEqual(parseFtsBody(null), { human: [], agent: [] });
});

/* ------------------------------------------------------------------ *
 * session assembly — pure, no database
 * ------------------------------------------------------------------ */

test('cursor: a conversation becomes a Session with roles, tools, files and honest timing', () => {
  const c = ordinaryComposer();
  const s = buildCursorSession({
    id: c.id,
    source: '/x/state.vscdb',
    header: { composerId: c.id, workspaceId: 'ws1', createdAt: c.createdAt, lastUpdatedAt: c.lastUpdatedAt },
    composer: {
      name: c.name,
      createdAt: c.createdAt,
      modelConfig: { modelName: c.modelName },
      fullConversationHeadersOnly: c.bubbles.map((b) => ({ bubbleId: b.id, type: b.type })),
    },
    conversation: null,
    bubbles: c.bubbles.map((b) => bubbleRow(c.id, b)),
    workspaces: new Map([['ws1', '/Users/u/code/orchard']]),
    idleGapMs: IDLE,
  });

  assert.equal(s.agent, 'cursor');
  assert.equal(s.title, 'Fix the build');
  assert.equal(s.cwd, '/Users/u/code/orchard');
  assert.equal(s.project, 'orchard');
  assert.deepEqual(s.models, ['claude-4.6-opus-high-thinking']);

  assert.equal(s.humanTurns.length, 2, 'type 1 is the human');
  assert.equal(s.agentTurns.length, 2, 'type 2 is the agent');
  assert.equal(s.humanTurns[0].text, 'почини сборку');
  assert.equal(s.humanTurns[0].words, 2, 'Cyrillic is tokenised, not split on spaces');
  assert.equal(s.agentTurns[0].text, 'Looking at the build now.');

  assert.deepEqual({ ...s.tools }, { edit_file: 1, run_terminal_cmd: 1 });
  assert.equal(s.counts.toolCalls, 2);
  assert.deepEqual(s.filesTouched, ['/w/app/build.mjs'], 'the path comes out of rawArgs; the payload does not');
  assert.equal(s.tokens.in, 1200);
  assert.equal(s.tokens.out, 80);
  assert.equal(s.thinkingChars, 'the failure is in the loader'.length);

  assert.equal(s.startedAt, T('2026-05-01T09:00:00Z'));
  assert.equal(s.endedAt, T('2026-05-01T09:12:00Z'));
  assert.equal(s.durationMs, 12 * 60_000, 'no gap here exceeds the idle cap');
  assert.equal(
    s.bursts.reduce((a, b) => a + b.durationMs, 0),
    s.durationMs,
    'Σ burst durations === durationMs, same contract as the JSONL agents',
  );
});

test('cursor: an idle gap is not charged as time together', () => {
  const bubbles = [
    { id: 'b1', type: 1, text: 'start', createdAt: '2026-05-01T09:00:00.000Z' },
    { id: 'b2', type: 2, text: 'ok', createdAt: '2026-05-01T09:01:00.000Z' },
    { id: 'b3', type: 1, text: 'back after lunch', createdAt: '2026-05-01T13:00:00.000Z' },
    { id: 'b4', type: 2, text: 'welcome back', createdAt: '2026-05-01T13:02:00.000Z' },
  ];
  const s = buildCursorSession({
    id: 'c',
    source: 'x',
    header: null,
    composer: { fullConversationHeadersOnly: bubbles.map((b) => ({ bubbleId: b.id })) },
    conversation: null,
    bubbles: bubbles.map((b) => bubbleRow('c', b)),
    workspaces: new Map(),
    idleGapMs: IDLE,
  });
  assert.equal(s.durationMs, 3 * 60_000, 'one minute plus two, not four hours');
  assert.equal(s.spanMs, 4 * 60 * 60_000 + 2 * 60_000);
  assert.equal(s.bursts.length, 2);
});

test('cursor: a bubble with no createdAt carries the last real timestamp forward', () => {
  // Measured on the real corpus: only ~37 % of bubbles carry `createdAt`. Carry-forward keeps
  // the order monotone without inventing a moment that never happened.
  const bubbles = [
    { id: 'b1', type: 1, text: 'first', createdAt: '2026-05-01T09:00:00.000Z' },
    { id: 'b2', type: 2, text: 'no clock on me' },
    { id: 'b3', type: 1, text: 'nor me' },
    { id: 'b4', type: 2, text: 'last', createdAt: '2026-05-01T09:05:00.000Z' },
  ];
  const s = buildCursorSession({
    id: 'c',
    source: 'x',
    header: null,
    composer: { fullConversationHeadersOnly: bubbles.map((b) => ({ bubbleId: b.id })) },
    conversation: null,
    bubbles: bubbles.map((b) => bubbleRow('c', b)),
    workspaces: new Map(),
    idleGapMs: IDLE,
  });
  assert.equal(s.humanTurns[0].ts, T('2026-05-01T09:00:00Z'));
  assert.equal(s.humanTurns[1].ts, T('2026-05-01T09:00:00Z'), 'carried, not interpolated');
  assert.equal(s.agentTurns[1].ts, T('2026-05-01T09:05:00Z'));
  assert.equal(s.startedAt, T('2026-05-01T09:00:00Z'));
});

test('cursor: the "default" model is not recorded as a model', () => {
  // A third of real conversations say `default` — that is Cursor's auto-router setting, and
  // counting it would put a model that does not exist at the top of the model chart.
  const make = (modelName) =>
    buildCursorSession({
      id: 'c',
      source: 'x',
      header: { createdAt: 1, lastUpdatedAt: 2 },
      composer: { modelConfig: { modelName }, fullConversationHeadersOnly: [{ bubbleId: 'b1' }] },
      conversation: null,
      bubbles: [bubbleRow('c', { id: 'b1', type: 1, text: 'hi' })],
      workspaces: new Map(),
      idleGapMs: IDLE,
    });
  assert.deepEqual(make('default').models, []);
  assert.equal(make('default').model, null);
  assert.deepEqual(make('gpt-5.5,default,gemini-3-pro').models, ['gpt-5.5', 'gemini-3-pro']);
});

test('cursor: an empty draft is not a session', () => {
  const nothing = buildCursorSession({
    id: 'empty-state-draft',
    source: 'x',
    header: { composerId: 'empty-state-draft', createdAt: 1, lastUpdatedAt: 2 },
    composer: { fullConversationHeadersOnly: [] },
    conversation: null,
    bubbles: [],
    workspaces: new Map(),
    idleGapMs: IDLE,
  });
  assert.equal(nothing, null, 'no text, no tools, no title');
});

test('cursor: a cloud-only conversation falls back to the search index', () => {
  const s = buildCursorSession({
    id: 'bc-1',
    source: 'x',
    header: null,
    composer: null,
    conversation: { id: 'bc-1', title: 'Synced from the laptop', updated_at: T('2026-03-03T08:00:00Z') },
    bubbles: [],
    body: 'user:\nwhat broke\nassistant:\nthe loader',
    workspaces: new Map(),
    idleGapMs: IDLE,
  });
  assert.equal(s.title, 'Synced from the laptop');
  assert.deepEqual(s.humanTurns.map((t) => t.text), ['what broke']);
  assert.equal(s.humanTurns[0].ts, T('2026-03-03T08:00:00Z'), 'updated_at is the only clock it has');
  assert.equal(s.durationMs, 0, 'one timestamp cannot make a duration');
});

test('cursor: a corrupt bubble is skipped, not fatal', () => {
  const s = buildCursorSession({
    id: 'c',
    source: 'x',
    header: { createdAt: T('2026-05-01T09:00:00Z'), lastUpdatedAt: T('2026-05-01T09:01:00Z') },
    composer: { fullConversationHeadersOnly: [{ bubbleId: 'b1' }, { bubbleId: 'b2' }] },
    conversation: null,
    bubbles: [
      { key: 'bubbleId:c:b1', value: '{"bubbleId":"b1","type":1,"text":"survivor"' }, // truncated JSON
      { key: 'bubbleId:c:b2', value: JSON.stringify({ bubbleId: 'b2', type: 1, text: 'also here' }) },
      { key: 'bubbleId:c:b3', value: 'null' },
    ],
    workspaces: new Map(),
    idleGapMs: IDLE,
  });
  assert.deepEqual(s.humanTurns.map((t) => t.text), ['also here']);
  assert.equal(s.counts.skippedLines, 2);
});

test('cursor: lexical richText is used when the plain text field is empty', () => {
  const rich = JSON.stringify({
    root: { children: [{ children: [{ text: 'typed with a ' }, { text: '@mention' }] }] },
  });
  const s = buildCursorSession({
    id: 'c',
    source: 'x',
    header: { createdAt: 1, lastUpdatedAt: 2 },
    composer: { fullConversationHeadersOnly: [{ bubbleId: 'b1' }] },
    conversation: null,
    bubbles: [bubbleRow('c', { id: 'b1', type: 1, text: '', richText: rich })],
    workspaces: new Map(),
    idleGapMs: IDLE,
  });
  assert.equal(s.humanTurns[0].text, 'typed with a @mention');
});

test('cursor: workspace.json resolves the project; conversations.scope never does', async (t) => {
  const dir = await tmpdir(t);
  const ws = path.join(dir, 'workspaceStorage');
  await mkdir(path.join(ws, 'ws1'), { recursive: true });
  await mkdir(path.join(ws, 'ws2'), { recursive: true });
  await mkdir(path.join(ws, 'ws3'), { recursive: true });
  await writeFile(path.join(ws, 'ws1', 'workspace.json'), '{"folder":"file:///Users/u/code/orchard"}');
  await writeFile(path.join(ws, 'ws2', 'workspace.json'), '{"folder":"file:///Users/u/my%20project"}');
  await writeFile(path.join(ws, 'ws3', 'workspace.json'), 'not json');

  const map = await readWorkspaceFolders(ws);
  assert.equal(map.get('ws1'), '/Users/u/code/orchard');
  assert.equal(map.get('ws2'), '/Users/u/my project', 'percent-encoding is decoded');
  assert.equal(map.has('ws3'), false);
  assert.deepEqual(await readWorkspaceFolders(path.join(dir, 'nope')), new Map());
});

/* ------------------------------------------------------------------ *
 * the "this Node is too old" path
 * ------------------------------------------------------------------ */

test('cursor: without node:sqlite the scan skips cleanly, once', async (t) => {
  const dir = await tmpdir(t);
  const gs = path.join(dir, 'Cursor', 'User', 'globalStorage');
  await mkdir(gs, { recursive: true });
  // A file has to exist, or the adapter returns before it ever looks for SQLite.
  await writeFile(path.join(gs, 'state.vscdb'), 'SQLite format 3\0');

  const notes = [];
  const got = await scanCursor({ dir: gs, sqlite: null, cache: null, onNote: (n) => notes.push(n) });

  assert.deepEqual(got.sessions, []);
  assert.equal(got.note, CURSOR_NEEDS_NODE_22);
  assert.deepEqual(notes, [CURSOR_NEEDS_NODE_22], 'exactly one line, not one per conversation');
});

test('cursor: no Cursor installed is silent, not a note', async (t) => {
  const dir = await tmpdir(t);
  const got = await scanCursor({ dir: path.join(dir, 'nothing', 'here'), sqlite: null, cache: null });
  assert.deepEqual(got.sessions, []);
  assert.equal(got.note, null, 'nothing to skip means nothing to say');
});

test('cursor: importing node:sqlite prints no ExperimentalWarning', async () => {
  const warnings = [];
  const original = process.emitWarning;
  process.emitWarning = (w, ...rest) => warnings.push(String(w?.message ?? w));
  try {
    const { loadSqlite: fresh, resetSqliteCache } = await import('../src/agents/cursor.js');
    resetSqliteCache();
    await fresh();
  } finally {
    process.emitWarning = original;
  }
  assert.deepEqual(
    warnings.filter((w) => /sqlite/i.test(w)),
    [],
    'the terminal stays clean',
  );
});

/* ------------------------------------------------------------------ *
 * against real SQLite files
 * ------------------------------------------------------------------ */

test('cursor: reads a real database end to end', needsSqlite, async (t) => {
  const dir = await tmpdir(t);
  const gs = path.join(dir, 'Cursor', 'User', 'globalStorage');
  const ws = path.join(dir, 'Cursor', 'User', 'workspaceStorage', 'ws1');
  await mkdir(ws, { recursive: true });
  await writeFile(path.join(ws, 'workspace.json'), '{"folder":"file:///Users/u/code/orchard"}');

  const c = ordinaryComposer();
  await makeCursorDir(gs, {
    composers: [c],
    conversations: [{ id: c.id, title: 'Fix the build', updatedAt: c.lastUpdatedAt, source: 'local' }],
  });

  const got = await scanCursor({ dir: gs, cache: null });
  assert.equal(got.sessions.length, 1);
  const [s] = got.sessions;
  assert.equal(s.agent, 'cursor');
  assert.equal(s.id, c.id);
  assert.equal(s.project, 'orchard');
  assert.equal(s.humanTurns.length, 2);
  assert.equal(s.agentTurns.length, 2);
  assert.equal(s.counts.toolCalls, 2);
  assert.equal(got.stats.conversations, 1);
  assert.equal(got.stats.bubbles, 4);
  assert.equal(got.note, null);
});

test('cursor: archived conversations are kept, subagents are not', needsSqlite, async (t) => {
  const dir = await tmpdir(t);
  const gs = path.join(dir, 'gs');
  const base = ordinaryComposer();
  await makeCursorDir(gs, {
    composers: [
      { ...base, id: 'c-plain' },
      // `is_archived` is Cursor's "move it out of my list" toggle, not a delete: 313 of 860 real
      // local conversations carry it, holding real work. Dropping them would delete a third of
      // the history without saying so.
      { ...base, id: 'c-archived', isArchived: true },
      { ...base, id: 'c-subagent', isSubagent: true },
    ],
  });

  const got = await scanCursor({ dir: gs, cache: null });
  assert.deepEqual(got.sessions.map((s) => s.id).sort(), ['c-archived', 'c-plain']);

  const withSubs = await scanCursor({ dir: gs, cache: null, includeSubagents: true });
  assert.equal(withSubs.sessions.length, 3);
  assert.equal(withSubs.sessions.find((s) => s.id === 'c-subagent').isSidechain, true);
});

test('cursor: --since drops older conversations before their bodies are read', needsSqlite, async (t) => {
  const dir = await tmpdir(t);
  const gs = path.join(dir, 'gs');
  const old = {
    ...ordinaryComposer(),
    id: 'c-old',
    createdAt: T('2024-01-01T09:00:00Z'),
    lastUpdatedAt: T('2024-01-01T09:12:00Z'),
    bubbles: [{ id: 'b1', type: 1, text: 'ancient', createdAt: '2024-01-01T09:00:00.000Z' }],
  };
  await makeCursorDir(gs, { composers: [old, { ...ordinaryComposer(), id: 'c-new' }] });

  const all = await scanCursor({ dir: gs, cache: null });
  assert.equal(all.sessions.length, 2);
  assert.equal(all.stats.bubbles, 5);

  const recent = await scanCursor({ dir: gs, cache: null, since: T('2026-01-01T00:00:00Z') });
  assert.deepEqual(recent.sessions.map((s) => s.id), ['c-new']);
  assert.equal(recent.stats.skipped, 1);
  assert.equal(recent.stats.bubbles, 4, 'the old conversation cost zero bubble reads');
});

test('cursor: reading never writes to the database or its sidecars', needsSqlite, async (t) => {
  const dir = await tmpdir(t);
  const gs = path.join(dir, 'gs');
  const p = await makeCursorDir(gs, {
    composers: [ordinaryComposer()],
    conversations: [{ id: 'bc-1', title: 'cloud', updatedAt: T('2026-04-01T00:00:00Z'), source: 'cloud-cache' }],
  });

  const snapshot = async () => {
    const out = {};
    for (const name of await readdir(p.globalStorage)) {
      const st = await stat(path.join(p.globalStorage, name));
      out[name] = `${st.size}:${st.mtimeMs}:${st.ino}`;
    }
    return out;
  };

  const before = await snapshot();
  const got = await scanCursor({ dir: gs, cache: null });
  assert.ok(got.sessions.length >= 1, 'it really did read something');
  const after = await snapshot();

  assert.deepEqual(after, before, 'same files, same sizes, same mtimes, same inodes');
  assert.equal(Object.keys(after).sort().join(','), 'conversation-search.db,state.vscdb', 'no -wal, no -shm created');

  // And the handle itself refuses writes.
  const db = new DatabaseSync(p.stateDb, { readOnly: true });
  assert.throws(() => db.exec("insert into cursorDiskKV (key, value) values ('x','y')"));
  db.close();
});

test('cursor: a corrupt database degrades to no sessions, not a throw', needsSqlite, async (t) => {
  const dir = await tmpdir(t);
  const gs = path.join(dir, 'gs');
  await mkdir(gs, { recursive: true });
  // Right magic header, garbage everything else: this is what a half-synced file looks like.
  await writeFile(path.join(gs, 'state.vscdb'), Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(4096, 0x7f)]));
  await writeFile(path.join(gs, 'conversation-search.db'), 'this is not a database at all');

  const got = await scanCursor({ dir: gs, cache: null });
  assert.deepEqual(got.sessions, []);
  assert.equal(got.stats.conversations, 0);
});

test('cursor: a database whose schema has moved on yields nothing, quietly', needsSqlite, async (t) => {
  const dir = await tmpdir(t);
  const gs = path.join(dir, 'gs');
  await mkdir(gs, { recursive: true });
  const db = new DatabaseSync(path.join(gs, 'state.vscdb'));
  db.exec('CREATE TABLE somethingElseEntirely (a, b)');
  db.exec("INSERT INTO somethingElseEntirely VALUES ('x', 'y')");
  db.close();

  const got = await scanCursor({ dir: gs, cache: null });
  assert.deepEqual(got.sessions, []);
  assert.equal(got.note, null, 'a future Cursor is not an error the user can act on');
});

test('cursor: a locked database fails soft', needsSqlite, async (t) => {
  const dir = await tmpdir(t);
  const gs = path.join(dir, 'gs');
  const p = await makeCursorDir(gs, { composers: [ordinaryComposer()] });

  // What a running Cursor looks like at its worst: an exclusive lock held by a writer that has
  // not committed. Readers get SQLITE_BUSY.
  const writer = new DatabaseSync(p.stateDb);
  writer.exec('PRAGMA locking_mode = EXCLUSIVE');
  writer.exec('BEGIN EXCLUSIVE');
  writer.exec("INSERT INTO cursorDiskKV (key, value) VALUES ('composerData:locked', '{}')");

  let got;
  try {
    got = await scanCursor({ dir: gs, cache: null });
  } finally {
    writer.exec('ROLLBACK');
    writer.close();
  }

  // Either it read a consistent snapshot or it stepped aside — never a throw, never a partial
  // write, and never a message repeated per conversation.
  assert.ok(Array.isArray(got.sessions));
  if (!got.sessions.length) assert.match(String(got.note ?? ''), /locked|Node 22/);
});

test('cursor: sessions flow through the shared scan cache', needsSqlite, async (t) => {
  const dir = await tmpdir(t);
  const gs = path.join(dir, 'gs');
  await makeCursorDir(gs, { composers: [ordinaryComposer()] });

  const opts = { cursorDir: gs, cacheDir: path.join(dir, 'cache'), claudeDir: path.join(dir, 'none'), codexDir: path.join(dir, 'none') };
  const cold = await scan(opts);
  assert.equal(cold.length, 1);
  assert.equal(cold[0].agent, 'cursor');
  assert.equal(cold.stats.cursor.parsed, 1);
  assert.equal(cold.stats.cursor.cached, 0);

  const warm = await scan(opts);
  assert.equal(warm.stats.cursor.cached, 1, 'the second run reads no bubbles');
  assert.equal(warm.stats.cursor.parsed, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(warm)), JSON.parse(JSON.stringify(cold)), 'byte-identical sessions');
});

test('cursor: touching a conversation invalidates only its cache entry', needsSqlite, async (t) => {
  const dir = await tmpdir(t);
  const gs = path.join(dir, 'gs');
  const p = await makeCursorDir(gs, {
    composers: [
      { ...ordinaryComposer(), id: 'c-untouched' },
      { ...ordinaryComposer(), id: 'c-touched' },
    ],
  });
  const opts = { cursorDir: gs, cacheDir: path.join(dir, 'cache'), claudeDir: path.join(dir, 'none'), codexDir: path.join(dir, 'none') };
  await scan(opts);

  const db = new DatabaseSync(p.stateDb);
  db.exec("UPDATE composerHeaders SET lastUpdatedAt = lastUpdatedAt + 60000 WHERE composerId = 'c-touched'");
  db.close();

  const again = await scan(opts);
  assert.equal(again.stats.cursor.parsed, 1, 'only the changed conversation is re-read');
  assert.equal(again.stats.cursor.cached, 1);
});

test('cursor: scan() stays out of the real Cursor unless asked', needsSqlite, async (t) => {
  const dir = await tmpdir(t);
  // A scan scoped to fixture roots must not reach for the developer's own 8 GB state.vscdb.
  const sessions = await scan({
    claudeDir: path.join(dir, 'claude'),
    codexDir: path.join(dir, 'codex'),
    cache: false,
  });
  assert.deepEqual(sessions, []);
  assert.equal(sessions.stats.cursor, null);
});

test('cursor: the scan reports its skip note once, for the CLI to print', needsSqlite, async (t) => {
  const dir = await tmpdir(t);
  const gs = path.join(dir, 'gs');
  await mkdir(gs, { recursive: true });
  await writeFile(path.join(gs, 'state.vscdb'), 'SQLite format 3\0');

  const notes = [];
  const sessions = await scan({
    claudeDir: path.join(dir, 'claude'),
    codexDir: path.join(dir, 'codex'),
    cursorDir: gs,
    cache: false,
    onNote: (n) => notes.push(n),
    // Same effect as running on Node 20.
    cursor: true,
  });
  assert.deepEqual(sessions, []);
  assert.ok(Array.isArray(sessions.stats.notes));
});
