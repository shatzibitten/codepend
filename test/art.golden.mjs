#!/usr/bin/env node
/**
 * Regenerate test/art.golden.json — the committed hashes that pin cover art output.
 *
 *   node test/art.golden.mjs           # print the table and diff against the committed one
 *   node test/art.golden.mjs --write   # accept the current output as the new baseline
 *
 * Run with --write only when an art change is intentional.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { coverArt, FAMILIES } from '../src/art.js';

const OUT = new URL('./art.golden.json', import.meta.url);
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

const KINDS = ['onthisday', 'stat', 'quote', 'chart', 'award', 'profile'];
const VARIANTS = ['', 'light', 'lite'];

const optsFor = (variant) =>
  variant === 'light' ? { theme: 'light' } : variant === 'lite' ? { quality: 'lite' } : {};

const table = {};

/*
 * Two passes, and the second one is the point.
 *
 * The kind-driven pass walks `i % KINDS.length` and `i % VARIANTS.length` together. Six and three
 * share a factor, so the pairing never advances: `profile` drew `lite` on every single row and
 * `dune` in the light theme was not pinned by anything. A change to that family's light-theme
 * output landed with the table still green, which is precisely the failure a golden table exists
 * to prevent — it looked like coverage and was not.
 *
 * The second pass names the family outright, so all six are pinned in all three variants whatever
 * the kind map and the 1-in-8 alt swap happen to do.
 */
for (let i = 0; i < 24; i++) {
  const seed = (((i * 2654435761) >>> 0) ^ (i * 9871)) >>> 0;
  const kind = KINDS[i % KINDS.length];
  const variant = VARIANTS[i % VARIANTS.length];
  table[`${seed}|${kind}|${variant}|`] = sha(coverArt(seed, kind, optsFor(variant)));
}

for (let f = 0; f < FAMILIES.length; f++) {
  for (let v = 0; v < VARIANTS.length; v++) {
    const i = f * VARIANTS.length + v;
    const seed = (((i * 40503 + 7919) >>> 0) ^ (i * 2654435761)) >>> 0;
    const variant = VARIANTS[v];
    table[`${seed}|onthisday|${variant}|${FAMILIES[f]}`] = sha(
      coverArt(seed, 'onthisday', { ...optsFor(variant), family: FAMILIES[f] }),
    );
  }
}

const json = JSON.stringify(table, null, 2) + '\n';
if (process.argv.includes('--write')) {
  writeFileSync(OUT, json);
  process.stdout.write(`wrote ${OUT.pathname} (${Object.keys(table).length} entries)\n`);
} else {
  let before = null;
  try {
    before = readFileSync(OUT, 'utf8');
  } catch {
    /* not generated yet */
  }
  process.stdout.write(before === json ? 'golden table is current\n' : json);
}
