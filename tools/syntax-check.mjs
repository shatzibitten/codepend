/**
 * The whole lint story. No ESLint, no config, no 400 transitive dependencies:
 * walk the source tree and ask Node whether every file parses.
 *
 * It also enforces the two rules that actually matter for this project:
 * zero runtime dependencies, and no network APIs under src/.
 *
 *   node tools/syntax-check.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', '.git', '.github', 'docs', 'dist', 'coverage']);
const problems = [];

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(m?js|cjs)$/.test(entry.name)) yield full;
  }
}

const files = [...walk(root)];

for (const file of files) {
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (res.status !== 0) problems.push(`${path.relative(root, file)}\n${(res.stderr || '').trim()}`);
}

// Rule 1: zero runtime dependencies. `npx codepend` must be instant and boring.
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (Object.keys(pkg.dependencies || {}).length) {
  problems.push(`package.json declares dependencies: ${Object.keys(pkg.dependencies).join(', ')}`);
}

// Rule 2: nothing under src/ may reach the network. bin/ is exempt for exactly
// one reason — `--serve` binds a loopback listener — and that is audited by eye.
const NETWORK = [/\bfetch\s*\(/, /node:https?\b/, /node:net\b/, /node:dgram\b/, /XMLHttpRequest/, /WebSocket/];
for (const file of files) {
  if (!file.startsWith(path.join(root, 'src'))) continue;
  const text = fs.readFileSync(file, 'utf8');
  for (const re of NETWORK) {
    if (re.test(text)) problems.push(`${path.relative(root, file)} looks like it touches the network: ${re}`);
  }
}

if (problems.length) {
  console.error(`\n${problems.join('\n\n')}\n`);
  console.error(`${problems.length} problem(s) in ${files.length} files`);
  process.exit(1);
}

console.log(`ok — ${files.length} files parse, 0 dependencies, no network calls in src/`);
