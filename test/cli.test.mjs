import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseArgs } from '../bin/codepend.js';
import { parseSince, resolveConfig, normalizeClaudeDir, normalizeCodexDir } from '../src/config.js';

test('parseArgs: defaults are empty (config applies them, not the parser)', () => {
  assert.deepEqual(parseArgs([]), { _: [] });
});

test('parseArgs: values, aliases and = forms', () => {
  assert.equal(parseArgs(['--out', '/tmp/a.html']).out, '/tmp/a.html');
  assert.equal(parseArgs(['-o', '/tmp/a.html']).out, '/tmp/a.html');
  assert.equal(parseArgs(['--out=/tmp/a.html']).out, '/tmp/a.html');
  assert.equal(parseArgs(['--since', '30d']).since, '30d');
  assert.equal(parseArgs(['--redact=paranoid']).redact, 'paranoid');
  assert.equal(parseArgs(['--claude-dir', '/x']).claudeDir, '/x');
});

test('parseArgs: booleans and their negations', () => {
  assert.equal(parseArgs(['--wrapped']).wrapped, true);
  assert.equal(parseArgs(['--no-open']).open, false);
  assert.equal(parseArgs(['--no-cache']).cache, false);
  assert.equal(parseArgs(['--json-only']).jsonOnly, true);
  assert.equal(parseArgs(['-q']).quiet, true);
});

test('parseArgs: --serve takes an optional port without eating the next flag', () => {
  assert.deepEqual(parseArgs(['--serve']), { _: [], serve: true });
  assert.equal(parseArgs(['--serve', '8080']).port, 8080);
  assert.equal(parseArgs(['--serve=8080']).port, 8080);
  const both = parseArgs(['--serve', '--wrapped']);
  assert.equal(both.serve, true);
  assert.equal(both.wrapped, true);
  assert.equal(both.port, undefined);
});

test('parseArgs: rejects nonsense', () => {
  assert.throws(() => parseArgs(['--bogus']), /unknown option/);
  assert.throws(() => parseArgs(['--out']), /wants a value/);
  assert.throws(() => parseArgs(['--wrapped=yes']), /doesn't take a value/);
});

test('parseArgs: suggests the near miss', () => {
  assert.throws(() => parseArgs(['--wraped']), /--wrapped/);
});

test('parseSince: relative, absolute and all', () => {
  const now = new Date(2026, 7, 5, 12, 0, 0).getTime();
  assert.equal(parseSince('all', now), null);
  assert.equal(parseSince(undefined, now), null);
  assert.equal(parseSince('30d', now), now - 30 * 86400000);
  assert.equal(parseSince('2w', now), now - 14 * 86400000);
  assert.equal(parseSince('6m', now), new Date(2026, 1, 5, 12, 0, 0).getTime());
  assert.equal(parseSince('1y', now), new Date(2025, 7, 5, 12, 0, 0).getTime());
  // Bare dates resolve to LOCAL midnight, never UTC.
  assert.equal(parseSince('2026-01-01', now), new Date(2026, 0, 1).getTime());
  assert.throws(() => parseSince('last tuesday', now), /--since/);
});

test('normalizeClaudeDir accepts the root or the projects dir', () => {
  assert.equal(normalizeClaudeDir('/x/.claude').projects, path.resolve('/x/.claude/projects'));
  assert.equal(normalizeClaudeDir('/x/.claude/projects').projects, path.resolve('/x/.claude/projects'));
  assert.equal(normalizeClaudeDir('/x/.claude/projects').root, path.resolve('/x/.claude'));
});

test('normalizeCodexDir finds both roots from either', () => {
  const a = normalizeCodexDir('/x/.codex');
  const b = normalizeCodexDir('/x/.codex/sessions');
  assert.deepEqual(a, b);
  assert.equal(a.archived, path.resolve('/x/.codex/archived_sessions'));
});

test('resolveConfig: defaults', () => {
  const cfg = resolveConfig({}, { env: { CODEPEND_HOME: '/home/u', HOME: '/home/u' }, now: 1 });
  assert.equal(cfg.redact, 'safe');
  assert.equal(cfg.cache, true);
  assert.equal(cfg.open, true);
  assert.equal(cfg.since, null);
  assert.equal(cfg.idleGapMs, 600000);
  assert.equal(cfg.out, path.join('/home/u', '.codepend', 'codepend.html'));
  assert.equal(cfg.cacheFile, path.join('/home/u', '.cache', 'codepend', 'scan-v1.json'));
  assert.equal(cfg.host, '127.0.0.1', 'serve must never bind a public interface by default');
});

test('resolveConfig: flags win, and bad levels are refused', () => {
  const env = { CODEPEND_HOME: '/home/u', HOME: '/home/u' };
  const cfg = resolveConfig({ redact: 'paranoid', open: false, cache: false, idleGap: '30' }, { env });
  assert.equal(cfg.redact, 'paranoid');
  assert.equal(cfg.open, false);
  assert.equal(cfg.cache, false);
  assert.equal(cfg.idleGapMs, 30000);
  assert.throws(() => resolveConfig({ redact: 'yolo' }, { env }), /unknown --redact/);
});

test('resolveConfig: XDG_CACHE_HOME is respected', () => {
  const cfg = resolveConfig({}, { env: { CODEPEND_HOME: '/home/u', XDG_CACHE_HOME: '/cache' } });
  assert.equal(cfg.cacheDir, path.join('/cache', 'codepend'));
});
