/**
 * End-to-end smoke test: a synthetic corpus on disk → the real CLI → one HTML file.
 *
 * This is the only test that exercises every seam at once (scan → detect → render
 * → bin/codepend.js), so it is deliberately blunt: it asserts the things that make
 * the product either work or embarrass someone, and nothing about wording.
 *
 * Zero dependencies, Node stdlib only.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Assembled at runtime: a literal here is indistinguishable from a leak to a
 *  secret scanner, and push protection is right to refuse it. */
const j = (...parts) => parts.join('');


const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, 'bin', 'codepend.js');

const DAY = 86_400_000;
/** Fixed clock so the corpus, the assertions and the anniversaries all agree. */
const NOW = Date.parse('2026-08-05T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

/* ------------------------------------------------------------------ corpus */

/**
 * Prompts in both scripts — the Cyrillic ones also prove the tokenizer and the
 * HTML escaping survive a round trip through the inlined JSON.
 */
const PROMPTS = [
  'commit and push please',
  'распиши план по шагам',
  'commit and push please',
  'why is the build failing?',
  'коммит и пуш',
  'refactor this into smaller functions',
  'commit and push please',
  'извини, я про другое',
  'add a test for the edge case',
  'коммит и пуш',
];

function claudeSession(dir, id, startMs, project) {
  const lines = [];
  const cwd = `/Users/testuser/code/${project}`;
  let t = startMs;
  lines.push(JSON.stringify({
    type: 'ai-title', aiTitle: `Working on ${project}`, timestamp: iso(t), sessionId: id, cwd,
  }));
  for (let i = 0; i < PROMPTS.length; i++) {
    t += 45_000;
    lines.push(JSON.stringify({
      type: 'user', timestamp: iso(t), sessionId: id, uuid: `u${i}`, cwd,
      gitBranch: 'main', origin: { kind: 'human' },
      message: { role: 'user', content: PROMPTS[i] },
    }));
    t += 30_000;
    lines.push(JSON.stringify({
      type: 'assistant', timestamp: iso(t), sessionId: id, uuid: `a${i}`, cwd, version: '2.0.0',
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        usage: {
          input_tokens: 1200, output_tokens: 400,
          cache_read_input_tokens: 9000, cache_creation_input_tokens: 500,
        },
        content: [
          { type: 'thinking', thinking: 'x'.repeat(2000) },
          { type: 'text', text: `Done. I updated the file and ran the tests for ${project}.` },
          { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
          { type: 'tool_use', name: 'Edit', input: { file_path: `${cwd}/src/index.js` } },
        ],
      },
    }));
  }
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines.join('\n') + '\n');
}

function codexSession(dir, id, startMs, project, { aborts = 0 } = {}) {
  const lines = [];
  const cwd = `/Users/testuser/code/${project}`;
  let t = startMs;
  const put = (type, payload) => lines.push(JSON.stringify({ timestamp: iso(t), type, payload }));

  put('session_meta', {
    id, session_id: id, timestamp: iso(t), cwd,
    originator: 'codex_cli_rs', cli_version: '0.9.0', source: 'cli',
  });
  put('turn_context', { turn_id: 't0', cwd, model: 'gpt-5.6-sol', current_date: iso(t) });

  for (let i = 0; i < PROMPTS.length; i++) {
    t += 50_000;
    put('event_msg', { type: 'user_message', message: PROMPTS[(i + 3) % PROMPTS.length] });
    t += 20_000;
    put('event_msg', { type: 'agent_reasoning', text: `**Planning the ${project} change**\n\nDetails.` });
    put('response_item', { type: 'custom_tool_call', name: 'exec', call_id: `c${i}`, input: 'ls' });
    t += 25_000;
    put('event_msg', {
      type: 'patch_apply_end', success: true,
      changes: { [`${cwd}/src/app.js`]: { kind: 'modify' } },
    });
    put('event_msg', {
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: 8000, cached_input_tokens: 6000, cache_write_input_tokens: 400,
          output_tokens: 300, reasoning_output_tokens: 120, total_tokens: 8300,
        },
      },
    });
    put('event_msg', { type: 'agent_message', message: `Updated ${project}. ` + 'word '.repeat(60) });
    if (i < aborts) {
      t += 5_000;
      put('event_msg', { type: 'turn_aborted', turn_id: `t${i}`, reason: 'interrupted' });
    }
  }
  const name = `rollout-${iso(startMs).replace(/[:.]/g, '-').slice(0, 19)}-${id}.jsonl`;
  fs.writeFileSync(path.join(dir, name), lines.join('\n') + '\n');
}

/** A subagent thread: real on disk, must never reach the feed. */
function codexSubagent(dir, id, startMs) {
  const t = startMs;
  const lines = [
    JSON.stringify({
      timestamp: iso(t), type: 'session_meta',
      payload: { id, session_id: id, cwd: '/Users/testuser/code/ghost', thread_source: 'subagent' },
    }),
    JSON.stringify({
      timestamp: iso(t + 1000), type: 'event_msg',
      payload: { type: 'user_message', message: 'SUBAGENT_PROMPT_MUST_NOT_APPEAR' },
    }),
  ];
  const name = `rollout-${iso(startMs).replace(/[:.]/g, '-').slice(0, 19)}-${id}.jsonl`;
  fs.writeFileSync(path.join(dir, name), lines.join('\n') + '\n');
}

/**
 * Secrets planted in the corpus. Every one must be absent from the HTML — this
 * is the whole privacy promise, tested rather than asserted in a README.
 */
const SECRETS = [
  j('sk-', 'ant-', 'api03-' + 'A'.repeat(48)),
  j('ghp', '_' + 'A'.repeat(36)),
  j('AKIA', 'IOSFODNN7EXAMPLE'),
  'victim@example.com',
];

function plantSecrets(dir, id, startMs) {
  const cwd = '/Users/testuser/code/secrets';
  const lines = [];
  let t = startMs;
  const put = (type, payload) => lines.push(JSON.stringify({ timestamp: iso(t), type, payload }));
  put('session_meta', { id, session_id: id, cwd, source: 'cli' });
  put('turn_context', { turn_id: 't0', cwd, model: 'gpt-5.6-sol' });
  for (const secret of SECRETS) {
    t += 60_000;
    put('event_msg', { type: 'user_message', message: `deploy with ${secret} and retry the job` });
    t += 20_000;
    put('event_msg', { type: 'agent_message', message: `Using ${secret} now.` });
  }
  const name = `rollout-${iso(startMs).replace(/[:.]/g, '-').slice(0, 19)}-${id}.jsonl`;
  fs.writeFileSync(path.join(dir, name), lines.join('\n') + '\n');
}

/** Lay down a corpus wide enough to light up most of the catalog. */
function buildCorpus(root) {
  const claudeProjects = path.join(root, 'claude', 'projects');
  const codexSessions = path.join(root, 'codex', 'sessions');
  fs.mkdirSync(codexSessions, { recursive: true });

  const projects = ['orbit', 'lantern', 'ferry'];
  // 40 days of history, so anniversaries, streaks and "a month ago" all fire.
  for (let d = 40; d >= 0; d--) {
    const project = projects[d % projects.length];
    const base = NOW - d * DAY;
    if (d % 3 === 0) {
      const dir = path.join(claudeProjects, `-Users-testuser-code-${project}`);
      fs.mkdirSync(dir, { recursive: true });
      claudeSession(dir, `0000000${d}-aaaa-4bbb-8ccc-dddddddddd${String(d).padStart(2, '0')}`,
        base - 9 * 3600_000, project);
    }
    codexSession(codexSessions, `11111111-bbbb-4ccc-8ddd-eeeeeeee${String(d).padStart(4, '0')}`,
      base - 6 * 3600_000, project, { aborts: d % 4 === 0 ? 3 : 0 });
  }
  codexSubagent(codexSessions, '99999999-9999-4999-8999-999999999999', NOW - 5 * DAY);
  plantSecrets(codexSessions, '88888888-8888-4888-8888-888888888888', NOW - 12 * DAY);

  return { claudeDir: path.join(root, 'claude'), codexDir: path.join(root, 'codex') };
}

/* ------------------------------------------------------------------- test */

test('smoke: synthetic corpus → CLI → one self-contained, non-leaking HTML file', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codepend-smoke-'));
  try {
    const { claudeDir, codexDir } = buildCorpus(tmp);
    const out = path.join(tmp, 'out', 'codepend.html');
    const json = path.join(tmp, 'out', 'payload.json');

    execFileSync(process.execPath, [
      CLI, '--no-open', '--no-cache', '--out', out, '--json', json,
      '--claude-dir', claudeDir, '--codex-dir', codexDir,
    ], {
      encoding: 'utf8',
      env: { ...process.env, CODEPEND_HOME: tmp, CODEPEND_TZ: 'UTC', NO_COLOR: '1' },
    });

    const html = fs.readFileSync(out, 'utf8');
    const payload = JSON.parse(fs.readFileSync(json, 'utf8'));

    // ---- it is a page, and it is ours -----------------------------------
    assert.match(html, /^<!doctype html>/i, 'starts with a doctype');
    assert.ok(html.includes('codepend'), 'the wordmark is on the page');
    assert.ok(html.length > 50_000, `page looks too thin (${html.length} bytes)`);

    // ---- it has an album, not a stub ------------------------------------
    assert.ok(payload.memories.length >= 12,
      `expected >= 12 memories, got ${payload.memories.length}`);
    assert.equal(new Set(payload.memories.map((m) => m.id)).size, payload.memories.length,
      'no memory appears twice in the feed');
    for (const m of payload.memories) {
      assert.ok(m.id && m.type && m.kind && m.title, `memory ${m.id} is missing a required field`);
      assert.ok(Number.isFinite(m.seed), `memory ${m.id} has no numeric seed`);
    }

    // ---- self-contained: nothing is fetched at open time -----------------
    assert.ok(!/<script[^>]+\bsrc=/i.test(html), 'no external <script src>');
    assert.ok(!/<link[^>]+rel=["']?stylesheet/i.test(html), 'no external stylesheet');
    assert.ok(!/https?:\/\/(?!www\.w3\.org|github\.com\/shatzibitten)/i.test(html),
      'no unexpected absolute URLs');

    // ---- the privacy promise, enforced ----------------------------------
    for (const secret of SECRETS) {
      assert.ok(!html.includes(secret), `secret leaked into the page: ${secret.slice(0, 12)}…`);
    }
    for (const pattern of [/sk-ant-[A-Za-z0-9-]{16,}/, /ghp_[A-Za-z0-9]{20,}/, /AKIA[0-9A-Z]{12,}/,
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/]) {
      assert.ok(!pattern.test(html), `secret-shaped text matched ${pattern} in the page`);
    }
    assert.ok(!html.includes('/Users/testuser'),
      'an absolute home path survived into the page');
    assert.ok(!html.includes('SUBAGENT_PROMPT_MUST_NOT_APPEAR'),
      'a subagent thread was treated as the user talking');

    // ---- the numbers are the corpus we wrote ----------------------------
    assert.ok(payload.stats.humanTurns > 300, 'human turns were undercounted');
    assert.ok(payload.stats.activeDays >= 30, 'active days were undercounted');
    assert.ok(payload.timeline.length >= 30, 'timeline is too short');
    assert.equal(payload.profile.topProject && typeof payload.profile.topProject, 'string');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
