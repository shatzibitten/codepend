/**
 * Copy variants are RANKED, not shuffled.
 *
 * Every detector writes 2–4 variants of its card. They are not equal quality:
 * one of them names a number or a quote that could only have come from this
 * person, and one of them states a fact that would be true of anybody. The old
 * selector — `blocks[hash32(id) % blocks.length]` — gave every user a coin flip
 * between them, which bought "variety" nobody can see (a detector emits ONE
 * card, so a single person never sees two variants of it) at the cost of the
 * best line in the array.
 *
 * The rule now:
 *
 *   Write `blocks` STRONGEST FIRST. Gate a variant on the data it needs by
 *   leaving `null` in its place (`cond ? {…} : null`). `bestBlock` returns the
 *   first variant whose data is actually there.
 *
 * Strength is judged the way the catalog judges it: a specific number or quote
 * beats a generic statement, and an observation about the person beats a
 * report. If two variants are genuinely equal — same shape, same specificity,
 * neither obviously better — give them the SAME explicit `rank` and the hash
 * breaks the tie. That is the only job the hash has left: varying copy between
 * two people whose data is equally strong. It can no longer cost anyone the
 * best line their history earned.
 *
 * Everything here is pure and deterministic: the same id and the same blocks
 * always produce the same block.
 */

import { hash32, makeMemory } from './_util.js';

/**
 * The strongest available variant.
 *
 * A variant is "available" when it is not null/undefined — detectors express
 * "this line needs data I don't have" by putting null in the array. Rank
 * defaults to array position (earlier = stronger); an explicit numeric `rank`
 * (higher = stronger) overrides it, and equal ranks are broken by hash.
 *
 * @param {string} id memory id (`type:key`) — the tiebreak salt
 * @param {Array<{title:string, body?:string, rank?:number}|null>} blocks best-first
 * @returns {object|null}
 */
export function bestBlock(id, blocks) {
  const list = blocks || [];
  const avail = [];
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (!b) continue;
    avail.push({ b, rank: b.rank == null ? list.length - i : b.rank });
  }
  if (!avail.length) return null;

  let top = -Infinity;
  for (const x of avail) if (x.rank > top) top = x.rank;
  const tied = avail.filter((x) => x.rank === top);
  if (tied.length === 1) return tied[0].b;
  // Equal strength by the author's own judgement — hash decides, so two people
  // with equally good data don't read the identical sentence.
  return tied[hash32(id + '|v') % tied.length].b;
}

/**
 * `makeMemory`, with the ranked variant selector instead of the uniform hash.
 *
 * Identical to `makeMemory(ctx, spec)` in every other respect; an explicit
 * `spec.block` still wins, for the handful of detectors that choose their own.
 *
 * @param {object} ctx
 * @param {object} spec
 */
export function rankedMemory(ctx, spec) {
  if (spec.block) return makeMemory(ctx, spec);
  const block = bestBlock(`${spec.type}:${spec.key}`, spec.blocks);
  return makeMemory(ctx, block ? { ...spec, block } : spec);
}

/**
 * Same idea for a bare list of strings (a clause spliced into a body): written
 * best-first, first non-null wins.
 * @template T
 * @param {Array<T|null|undefined>} options
 * @returns {T|null}
 */
export function firstOf(options) {
  for (const o of options || []) if (o) return o;
  return null;
}
