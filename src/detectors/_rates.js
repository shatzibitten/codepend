/**
 * List-price estimates, USD per million tokens, keyed by model family.
 *
 * These are estimates and the UI says so. We are not pretending to be a bill
 * from a vendor — the point of the card is the order of magnitude, not the cent.
 *
 * Note on inputs: `Session.tokens.in` is expected to EXCLUDE cache reads for
 * both agents (Codex reports `input_tokens` inclusive of `cached_input_tokens`;
 * src/scan.js normalizes that away). Applying one convention to both would
 * misstate cache stats by ~95%.
 */

/** @type {{in:number,out:number,cacheRead:number,cacheWrite:number}} */
export const DEFAULT_RATE = { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 };

const FAMILIES = [
  [/opus/i, { in: 15, out: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
  [/fable|sonnet/i, { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  [/haiku/i, { in: 0.8, out: 4, cacheRead: 0.08, cacheWrite: 1 }],
  [/gpt-5.*(mini|nano)/i, { in: 0.25, out: 2, cacheRead: 0.025, cacheWrite: 0.25 }],
  [/gpt-5|codex/i, { in: 1.25, out: 10, cacheRead: 0.125, cacheWrite: 1.25 }],
  [/gpt-4/i, { in: 2.5, out: 10, cacheRead: 1.25, cacheWrite: 2.5 }],
];

/**
 * @param {string|null} model
 * @returns {{in:number,out:number,cacheRead:number,cacheWrite:number}}
 */
export function rateFor(model) {
  if (!model) return DEFAULT_RATE;
  for (const [re, rate] of FAMILIES) if (re.test(model)) return rate;
  return DEFAULT_RATE;
}

/**
 * Cost estimate in USD.
 * @param {{in:number,out:number,cacheRead:number,cacheWrite:number}} tokens
 * @param {string|null} model
 */
export function estimateCost(tokens, model) {
  const r = rateFor(model);
  return (
    ((tokens.in || 0) * r.in +
      (tokens.out || 0) * r.out +
      (tokens.cacheRead || 0) * r.cacheRead +
      (tokens.cacheWrite || 0) * r.cacheWrite) / 1e6
  );
}
