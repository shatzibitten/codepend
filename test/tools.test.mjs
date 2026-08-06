/**
 * Tool identity mapping (src/stats.js).
 *
 * `normalizeTool` was written against the Claude Code and Codex vocabularies.
 * The Cursor adapter arrived later with an entirely different one — `run_terminal_command_v2`,
 * `read_file_v2`, `edit_file_v2`, `ripgrep_raw_search`, `todo_write` — none of
 * which matched a single pattern. Measured on a real 87 608-call corpus, 57.8 %
 * of every tool call landed in `Other`, which made it the winner of the
 * spirit-tool card: "Your spirit tool is Other."
 *
 * These tests pin the three things that has to keep being true:
 *   1. the vocabularies of all three agents map onto real identities,
 *   2. an unrecognised name still degrades to `Other` rather than throwing,
 *   3. `Other` can never win a ranking that names a tool.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeTool, rankTools, FALLBACK_TOOL, TOOL_PERSONALITY, buildStats,
} from '../src/stats.js';

/* ------------------------------------------------------------ the mapping */

test('normalizeTool: Claude Code vocabulary', () => {
  const cases = {
    Bash: 'Shell', BashOutput: 'Shell', KillShell: 'Shell', Monitor: 'Shell',
    Edit: 'Edit', MultiEdit: 'Edit', NotebookEdit: 'Edit',
    Read: 'Read', Write: 'Write',
    Grep: 'Search', Glob: 'Search', WebSearch: 'Search', WebFetch: 'Search',
    ToolSearch: 'Search',
    Task: 'Delegate',
    TodoWrite: 'Plan', ExitPlanMode: 'Plan', TaskCreate: 'Plan', TaskStop: 'Plan',
    mcp__ccd_session__mark_chapter: 'MCP',
    mcp__Claude_Browser__computer: 'Browser',
  };
  for (const [raw, want] of Object.entries(cases)) {
    assert.equal(normalizeTool(raw), want, `${raw} -> ${want}`);
  }
});

test('normalizeTool: Codex vocabulary', () => {
  const cases = {
    // `exec` is the JS sandbox and `exec_command` is the shell — the one
    // divergence from MEMORY-CATALOG, and the reason Script exists at all.
    exec: 'Script', js: 'Script', js_reset: 'Script',
    exec_command: 'Shell', write_stdin: 'Shell', run: 'Shell',
    apply_patch: 'Edit', view_image: 'Read',
    web_search: 'Search',
    spawn_agent: 'Delegate', wait_agent: 'Delegate', list_agents: 'Delegate',
    close_agent: 'Delegate', interrupt_agent: 'Delegate',
    send_message: 'Delegate', followup_task: 'Delegate',
    update_plan: 'Plan', create_goal: 'Plan', update_goal: 'Plan',
    mcp__codex_apps__github: 'MCP',
    mcp__playwright__browser_resize: 'Browser',
  };
  for (const [raw, want] of Object.entries(cases)) {
    assert.equal(normalizeTool(raw), want, `${raw} -> ${want}`);
  }
});

test('normalizeTool: Codex `wait` is Script and `write_stdin` is Shell', () => {
  // Measured, not guessed: `wait` takes a `cell_id` and answers "Script running
  // with cell ID 94"; `write_stdin` takes the `session_id` that `exec_command`
  // hands out. Reading the names alone would have swapped them.
  assert.equal(normalizeTool('wait'), 'Script');
  assert.equal(normalizeTool('write_stdin'), 'Shell');
  assert.equal(normalizeTool('wait_agent'), 'Delegate');
});

test('normalizeTool: Cursor vocabulary — the regression this file exists for', () => {
  const cases = {
    run_terminal_command_v2: 'Shell', run_terminal_cmd: 'Shell',
    // `await` polls a backgrounded terminal task by id, with regexes like
    // `exit_code|Results saved`.
    await: 'Shell',
    read_file_v2: 'Read', read_file: 'Read', read_lints: 'Read',
    edit_file_v2: 'Edit', edit_file: 'Edit', search_replace: 'Edit',
    delete_file: 'Edit',
    write: 'Write',
    ripgrep_raw_search: 'Search', glob_file_search: 'Search',
    codebase_search: 'Search', semantic_search_full: 'Search',
    list_dir: 'Search', list_dir_v2: 'Search', web_fetch: 'Search',
    todo_write: 'Plan', create_plan: 'Plan', switch_mode: 'Plan',
    // Returns an `agentId`.
    task_v2: 'Delegate',
  };
  for (const [raw, want] of Object.entries(cases)) {
    assert.equal(normalizeTool(raw), want, `${raw} -> ${want}`);
  }
});

test('normalizeTool: every MCP naming convention', () => {
  const mcp = [
    'mcp__ccd_session__spawn_task',            // Claude Code
    'mcp-qlik-qix_call',                       // Cursor, short form
    'mcp-Parallel Search MCP-user-Parallel Search MCP-web_search_preview',
    'mcp_Parallel_Task_MCP_getResultMarkdown', // Cursor, underscore form
    'mcp--',                                   // Cursor, degenerate but real
    'mcp',
    '_search_emails',                          // Codex connector, namespace stripped
    '_get_file_metadata',
  ];
  for (const raw of mcp) assert.equal(normalizeTool(raw), 'MCP', raw);
});

test('normalizeTool: a browser tool reads as Browser whoever delivered it', () => {
  const browser = [
    'mcp-cursor-ide-browser-browser_cdp',
    'mcp-Chrome DevTools MCP-user-Chrome DevTools MCP-take_snapshot',
    'mcp-Chrome AppleScript MCP-execute_javascript',
    'mcp_Chrome_DevTools_MCP_evaluate_script',
    'mcp__playwright__browser_navigate_back',
    // Codex computer-use: bare names, `"namespace":"mcp__computer_use"`.
    'click', 'type_text', 'press_key', 'get_app_state', 'list_apps',
  ];
  for (const raw of browser) assert.equal(normalizeTool(raw), 'Browser', raw);
});

test('normalizeTool: case-insensitive', () => {
  for (const n of ['bash', 'BASH', 'BaSh']) assert.equal(normalizeTool(n), 'Shell');
  for (const n of ['todowrite', 'TodoWrite', 'TODOWRITE']) assert.equal(normalizeTool(n), 'Plan');
});

/* ------------------------------------------------------------- the guards */

test('normalizeTool: an unknown name falls to Other without throwing', () => {
  const junk = [
    'set_active_branch', 'generate_image', 'Workflow', 'ask_question',
    '', '   ', 'ᚠᚢᚦ', '🙂', 'a'.repeat(4000), '../../etc/passwd',
    '{"not":"a name"}', 'exec_command_but_not_really',
  ];
  for (const raw of junk) assert.equal(normalizeTool(raw), FALLBACK_TOOL, JSON.stringify(raw.slice?.(0, 20)));
});

test('normalizeTool: non-string input does not throw', () => {
  for (const raw of [null, undefined, 0, 42, NaN, true, {}, [], Symbol.iterator ? [1, 2] : null]) {
    assert.doesNotThrow(() => normalizeTool(raw));
    assert.equal(typeof normalizeTool(raw), 'string');
  }
});

test('every identity normalizeTool can return has a TOOL_PERSONALITY line', () => {
  // Sweep a wide vocabulary rather than trusting a hand-kept list of identities.
  const seen = new Set();
  const vocabulary = [
    'Bash', 'exec', 'exec_command', 'Edit', 'Read', 'Write', 'Grep', 'Task',
    'TodoWrite', 'mcp__x__y', 'mcp-a-b', '_x', 'browser_click', 'click',
    'run_terminal_command_v2', 'read_file_v2', 'edit_file_v2', 'todo_write',
    'task_v2', 'await', 'wait', 'nothing_at_all', '',
  ];
  for (const raw of vocabulary) seen.add(normalizeTool(raw));
  for (const id of seen) {
    assert.equal(typeof TOOL_PERSONALITY[id], 'string', `no personality for ${id}`);
    assert.ok(TOOL_PERSONALITY[id].length > 10, `personality for ${id} is too short`);
  }
  assert.ok(seen.has(FALLBACK_TOOL), 'the sweep should have produced the fallback too');
});

test('TOOL_PERSONALITY has no entry that normalizeTool cannot produce', () => {
  // The inverse guard: a line of copy for an identity nothing maps to is dead
  // weight, and reads as a promise the mapping does not keep.
  for (const id of Object.keys(TOOL_PERSONALITY)) {
    assert.ok(id.length > 0);
    assert.equal(typeof TOOL_PERSONALITY[id], 'string');
  }
  const identities = new Set(Object.keys(TOOL_PERSONALITY));
  for (const raw of ['Bash', 'exec', 'Edit', 'Read', 'Write', 'Grep', 'Task', 'TodoWrite', 'mcp__a__b', 'browser_x', 'zzz']) {
    assert.ok(identities.has(normalizeTool(raw)), `${raw} -> ${normalizeTool(raw)} has no copy`);
  }
});

/* ------------------------------------------------- the Other-excluded rank */

test('rankTools: drops Other even when Other wins by a mile', () => {
  const list = [
    { name: 'Other', n: 50606 },
    { name: 'Script', n: 20563 },
    { name: 'Shell', n: 6733 },
  ];
  const ranked = rankTools(list);
  assert.equal(ranked[0].name, 'Script');
  assert.equal(ranked.length, 2);
  assert.ok(!ranked.some((t) => t.name === FALLBACK_TOOL));
  // Non-destructive: the raw ranking is still there for anyone counting calls.
  assert.equal(list[0].name, 'Other');
});

test('rankTools: preserves order and identity of the remaining entries', () => {
  const list = [
    { name: 'Shell', n: 9 }, { name: 'Other', n: 8 }, { name: 'Read', n: 7 },
  ];
  assert.deepEqual(rankTools(list).map((t) => t.name), ['Shell', 'Read']);
});

test('rankTools: Other-only falls back to the raw list rather than to nothing', () => {
  // A corpus where nothing was recognised still deserves a card. It says Other,
  // honestly, instead of the card disappearing.
  const ranked = rankTools([{ name: 'Other', n: 3 }]);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].name, 'Other');
});

test('rankTools: empty and malformed input', () => {
  assert.deepEqual(rankTools([]), []);
  assert.deepEqual(rankTools(null), []);
  assert.deepEqual(rankTools(undefined), []);
});

/* --------------------------------------------------------- through buildStats */

const TZ = 'Asia/Almaty';
const OPTS = { now: Date.UTC(2026, 7, 6), tz: TZ, redact: (s) => s };

let uid = 0;
function session(agent, tools, startedAt = Date.UTC(2026, 6, 1, 9)) {
  return {
    id: `s${++uid}`,
    agent,
    cwd: '/tmp/proj',
    startedAt,
    endedAt: startedAt + 3600000,
    durationMs: 3600000,
    models: ['test-model'],
    humanTurns: [{ ts: startedAt + 1000, text: 'do the thing' }],
    agentTurns: [{ ts: startedAt + 2000, text: 'done' }],
    tools,
    filesTouched: [],
    interrupts: [],
    tokens: {},
  };
}

test('buildStats: a Cursor-only corpus does not rank Other first', () => {
  const ctx = buildStats([
    session('cursor', {
      run_terminal_command_v2: 300,
      read_file_v2: 200,
      edit_file_v2: 150,
      ripgrep_raw_search: 80,
      todo_write: 40,
      ask_question: 10, // genuinely unmapped, and it should stay that way
    }),
  ], OPTS);

  const byName = Object.fromEntries(ctx.toolList.map((t) => [t.name, t.n]));
  assert.equal(byName.Shell, 300);
  assert.equal(byName.Read, 200);
  assert.equal(byName.Edit, 150);
  assert.equal(byName.Search, 80);
  assert.equal(byName.Plan, 40);
  assert.equal(byName.Other, 10);
  assert.equal(ctx.toolRanked[0].name, 'Shell');
  assert.equal(ctx.stats.spiritTool, 'Shell');
});

test('buildStats: toolRanked never leads with Other, even when Other dominates', () => {
  const ctx = buildStats([
    session('cursor', { totally_unknown_tool: 900, generate_image: 100, read_file_v2: 5 }),
  ], OPTS);

  assert.equal(ctx.toolList[0].name, 'Other', 'the raw ranking still tells the truth');
  assert.equal(ctx.toolList[0].n, 1000);
  assert.equal(ctx.toolRanked[0].name, 'Read');
  assert.equal(ctx.stats.spiritTool, 'Read');
  // Counts are untouched by the filter: this is a ranking rule, not a fudge.
  assert.equal(ctx.toolCalls, 1005);
});

test('buildStats: nothing but unknown names still names something', () => {
  const ctx = buildStats([session('cursor', { who_knows: 5 })], OPTS);
  assert.equal(ctx.toolRanked[0].name, 'Other');
  assert.equal(ctx.stats.spiritTool, 'Other');
});

test('buildStats: no tools at all', () => {
  const ctx = buildStats([session('claude', {})], OPTS);
  assert.deepEqual(ctx.toolList, []);
  assert.deepEqual(ctx.toolRanked, []);
  assert.equal(ctx.stats.spiritTool, null);
});

test('buildStats: three agents fold onto one set of identities', () => {
  const ctx = buildStats([
    session('claude', { Bash: 10, Read: 5 }),
    session('codex', { exec_command: 10, exec: 20 }),
    session('cursor', { run_terminal_command_v2: 10, read_file_v2: 5 }),
  ], OPTS);
  const byName = Object.fromEntries(ctx.toolList.map((t) => [t.name, t.n]));
  assert.equal(byName.Shell, 30, 'Bash + exec_command + run_terminal_command_v2');
  assert.equal(byName.Read, 10, 'Read + read_file_v2');
  assert.equal(byName.Script, 20, 'exec stays its own identity');
  assert.equal(byName.Other, undefined);
});

test('buildStats: raw names are still kept verbatim alongside the identities', () => {
  const ctx = buildStats([session('cursor', { run_terminal_command_v2: 7 })], OPTS);
  assert.equal(ctx.toolsRaw.get('run_terminal_command_v2'), 7);
});
