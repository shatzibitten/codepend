/* ============================================================================
   codepend — archetype-card.js
   The archetype card: one person, one name, one read on them.

   This is the asset that gets posted. It is deliberately NOT the generic share
   composition — that one has to serve quotes, stats and charts, so it can only
   ever be a compromise. This module knows it is drawing exactly one thing, and
   spends the whole frame on it:

     • the NAME, enormous, fitted by measurement to the box it has;
     • the TAGLINE under it in the serif italic the product uses for quotes;
     • the BLURB small, because it is the footnote to the claim, not the claim;
     • three or four NUMBERS along the base — evidence, set quiet;
     • the wordmark and `npx codepend` at the bottom, small and always present.

   Three ideas hold it together:

   1. GEOMETRY IS PURE. `archetypeLayout()` returns every box for a preset and
      touches no canvas, no DOM, no globals. That is the only way this gets real
      test coverage, and it is why the fitting logic can be trusted: the tests
      run the same code the browser runs.

   2. TYPE IS MEASURED, NEVER GUESSED. "The Sampler" and "The Midnight
      Interrogator" differ by 14 characters and both have to look deliberate.
      The name is fitted by searching line-break partitions and taking the
      largest size that fits — see `fitName`. In the browser the measurer is
      `ctx.measureText`; in Node it is a per-glyph advance table, close enough
      that the tests assert real behaviour rather than a tautology.

   3. CONTRAST IS COMPUTED, NEVER ASSUMED. The art is the ground, full bleed.
      The scrim over it is not a designer's guess: `requiredScrimAlpha()` solves
      for the alpha at which the ink clears 4.5:1 against the brightest thing
      that seed's palette can paint, and the gradient is built so every box that
      carries ink sits at or below that alpha. See `scrimPlan`.

   PRIVACY. Whatever lands here ends up on someone's timeline. Archetype name,
   tagline, blurb, round numbers, wordmark, `npx codepend`. Nothing else — no
   project names, no quotes, no paths, no model names. `safeText()` is the gate
   and it fails closed: text it cannot make safe is dropped, and the layout is
   built to look composed with any one part missing (see the `--redact paranoid`
   case, where the Two-Word Tyrant loses its quoted tagline).

   Zero dependencies. Node stdlib only, no DOM at import time, so `node --test`
   can import this file directly.
   ========================================================================== */

const clampNum = (v, a, b) => Math.min(b, Math.max(a, v));

/* ── frames ───────────────────────────────────────────────────────────── */

/**
 * The three frames. Each is a re-composition, not a rescale:
 *   square — the default. Posts everywhere, crops nowhere. Stacked lockup.
 *   story  — 9:16, with platform-UI safe insets and a lot more air above the
 *            name; the top third is pure art.
 *   wide   — X and link previews. No vertical room, so the name and the numbers
 *            sit side by side with a hairline between them.
 */
export const ARCHETYPE_PRESETS = {
  square: [1080, 1080],
  story: [1080, 1920],
  wide: [1200, 675],
};

export const DEFAULT_PRESET = 'square';

/** Fixed copy. The eyebrow labels the name; the CTA is the whole funnel. */
export const EYEBROW = 'WHAT YOU ARE';
export const WORDMARK = 'codepend';
export const CTA = 'npx codepend';

/** WCAG AA for large text is 3:1. We hold the card to body-text AA anyway. */
export const MIN_CONTRAST = 4.5;

/** Ink and scrim per theme — the same values app.css declares. */
export const THEMES = {
  // `quiet` is lifted from the page's value on purpose. On the page it sits on a
  // solid surface; here it sits on art under a scrim that is deliberately not
  // opaque, and #827D75 tops out at 4.96:1 on a perfectly clean ground — it
  // measured 3.59-4.58:1 on real pixels, under the bar this file claims to
  // hold. Raising the scrim instead would have to take it to alpha ~1 and erase
  // the art, so the ink moves rather than the ground.
  dark: { ink: '#F4F1EC', muted: '#B9B4AC', quiet: '#BDB7AE', scrim: '#05060A', paper: '#06070A', rule: 'rgba(255,255,255,.18)' },
  light: { ink: '#12100D', muted: '#4A453D', quiet: '#4F4A42', scrim: '#FAF7F2', paper: '#F7F4EF', rule: 'rgba(0,0,0,.16)' },
};

const FALLBACK_PALETTE = { bg: '#0B0F17', fg: '#F4F1EC', accents: ['#59AAF8', '#8771DE', '#A9C7F2'] };

export const FONTS = {
  display: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  serif: '"Iowan Old Style", Georgia, "Times New Roman", serif',
};

/* ── privacy gate ─────────────────────────────────────────────────────── */

/**
 * Anything matching these never reaches the card. Kept in sync with the RISKY
 * list in app.js on purpose: two copies that agree beat one import that this
 * module cannot have (app.js is inlined, not a module with exports).
 */
const RISKY = [
  /https?:\/\/\S+/i,
  /\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/,
  /\bsk-[A-Za-z0-9_-]{8,}/,
  /\bghp_[A-Za-z0-9]{8,}/,
  /\bAKIA[0-9A-Z]{8,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\./,
  /~\/[\w.\-/]+/,
  /(^|\s)[~/][\w.-]+\/[\w.\-/]+/,
  /\b[A-Za-z]:\\[\w\\.-]+/,
  /\b\d{1,3}(\.\d{1,3}){3}\b/,
  /```/,
];

/** @param {string} t */
export function isRisky(t) {
  return !!t && RISKY.some((re) => re.test(String(t)));
}

const RX_ESC = /[.*+?^${}()|[\]\\]/g;

/**
 * The only text that may be painted.
 *
 * Two jobs, in order. First substitution: the blurbs for The Serial Monogamist
 * and The Sampler interpolate real project names, and a project name is exactly
 * the thing that must not appear on a poster someone's colleagues will see. The
 * caller passes the names it knows about (`redactNames`) and they are replaced
 * with a generic word. Second, the gate: if anything risky survives, the whole
 * string is dropped rather than partially scrubbed — a half-redacted path is
 * still a leak, and the layout is built to survive a missing field.
 *
 * @param {string} text
 * @param {{redactNames?:string[], replacement?:string, plural?:string, maxLen?:number}} [opts]
 * @returns {string} '' when the text cannot be made safe
 */
export function safeText(text, opts) {
  const o = opts || {};
  if (text == null) return '';
  let s = String(text).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const names = (o.redactNames || [])
    .map((n) => String(n || '').trim())
    .filter((n) => n.length >= 3)
    .sort((a, b) => b.length - a.length); // longest first: "acme-web" before "acme"
  const one = o.replacement || 'one project';
  for (const n of names) {
    s = s.replace(new RegExp(n.replace(RX_ESC, '\\$&'), 'gi'), one);
  }
  if (names.length) {
    // The Sampler names three ghosted projects in a row. Substituting each one
    // gives "one project, one project and one project", which is worse than the
    // leak in a different way — it reads as a bug. Collapse the run.
    const R = one.replace(RX_ESC, '\\$&');
    s = s.replace(new RegExp(`${R}(?:(?:,\\s*|\\s+and\\s+)${R})+`, 'gi'), o.plural || 'a few projects');
  }
  if (isRisky(s)) return '';
  const max = o.maxLen || 0;
  if (max && s.length > max) s = s.slice(0, max - 1).replace(/\s\S*$/, '') + '…';
  return s;
}

/* ── colour ───────────────────────────────────────────────────────────── */

/** Accepts `#rgb`, `#rrggbb`, `r g b` and `r,g,b` (the CSS custom-property form). */
export function parseColor(c) {
  const s = String(c == null ? '' : c).trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return m[1].split('').map((h) => parseInt(h + h, 16));
  m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = /^(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})$/.exec(s);
  if (m) return [1, 2, 3].map((i) => Math.min(255, +m[i]));
  return [0, 0, 0];
}

const toHex = (rgb) => '#' + rgb.map((v) => Math.round(clampNum(v, 0, 255)).toString(16).padStart(2, '0')).join('');

/** WCAG relative luminance. */
export function relLuminance(color) {
  const [r, g, b] = parseColor(color).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1..21. Order-independent. */
export function contrastRatio(a, b) {
  const la = relLuminance(a);
  const lb = relLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Linear mix in sRGB space — matches what canvas does when it composites. */
export function mixColor(a, b, t) {
  const A = parseColor(a);
  const B = parseColor(b);
  const k = clampNum(t, 0, 1);
  return toHex([0, 1, 2].map((i) => A[i] + (B[i] - A[i]) * k));
}

/** `over` painted at `alpha` on top of `base`. */
export function blendOver(base, over, alpha) {
  return mixColor(base, over, alpha);
}

/**
 * The brightest (dark theme) or darkest (light theme) thing the art can
 * plausibly paint under the type.
 *
 * `palette()` hands back bg + three accents, but art.js also paints a `hot`
 * tone near oklch L .9 and blurs it, which blooms brighter than any accent. So
 * the worst case is the extreme palette colour pushed a further 45% toward the
 * extreme. Guessing low here would mean shipping a card that fails contrast on
 * some seeds and nobody would ever find out; guessing high costs a slightly
 * heavier scrim, which is the cheap mistake.
 */
export function worstArtColor(pal, theme) {
  const p = pal && Array.isArray(pal.accents) ? pal : FALLBACK_PALETTE;
  const cols = [p.bg, ...p.accents].filter(Boolean);
  const dark = theme !== 'light';
  let pick = cols[0];
  for (const c of cols) {
    const better = dark ? relLuminance(c) > relLuminance(pick) : relLuminance(c) < relLuminance(pick);
    if (better) pick = c;
  }
  return mixColor(pick, dark ? '#FFFFFF' : '#000000', 0.45);
}

/**
 * Smallest alpha at which `ink` over `art` covered by `scrim` clears `ratio`.
 * Monotonic in alpha, so a bisection is exact to the step it returns.
 * @returns {number} 0..1, or 1 when the ratio is unreachable
 */
export function requiredScrimAlpha(ink, scrim, art, ratio = MIN_CONTRAST) {
  if (contrastRatio(ink, art) >= ratio) return 0;
  if (contrastRatio(ink, scrim) < ratio) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (contrastRatio(ink, blendOver(art, scrim, mid)) >= ratio) hi = mid;
    else lo = mid;
  }
  return Math.min(1, Math.ceil(hi * 100) / 100);
}

/* ── measurement ──────────────────────────────────────────────────────── */

/*
 * Advance widths as a fraction of the em, for the two faces the card uses.
 * These exist so `archetypeLayout` is pure: Node has no `measureText`, and a
 * layout that could only be exercised through a canvas would never be tested.
 * They are approximations of the system grotesque and the Georgia-class serif —
 * within a few percent, which is all the fitting search needs, and the browser
 * re-fits with the real metrics anyway.
 */
const W_DISPLAY = {
  ' ': 0.28, '.': 0.28, ',': 0.28, ':': 0.28, ';': 0.28, '!': 0.28, '?': 0.56,
  "'": 0.2, '’': 0.2, '"': 0.36, '“': 0.36, '”': 0.36, '«': 0.45, '»': 0.45,
  '-': 0.35, '–': 0.6, '—': 1, '/': 0.45, '\\': 0.45, '(': 0.34, ')': 0.34,
  '+': 0.6, '%': 0.9, '&': 0.72, '·': 0.28, '×': 0.6,
  i: 0.25, j: 0.25, l: 0.25, t: 0.33, f: 0.31, r: 0.37, I: 0.28,
  a: 0.56, b: 0.59, c: 0.53, d: 0.59, e: 0.56, g: 0.59, h: 0.58, k: 0.55,
  n: 0.58, o: 0.59, p: 0.59, q: 0.59, s: 0.53, u: 0.58, v: 0.52, x: 0.53,
  y: 0.52, z: 0.49, m: 0.89, w: 0.76,
  A: 0.68, B: 0.68, C: 0.72, D: 0.72, E: 0.66, F: 0.61, G: 0.77, H: 0.72,
  J: 0.53, K: 0.69, L: 0.59, N: 0.73, O: 0.78, P: 0.66, Q: 0.78, R: 0.69,
  S: 0.66, T: 0.62, U: 0.72, V: 0.67, X: 0.66, Y: 0.64, Z: 0.61, M: 0.89, W: 0.95,
};
const W_SERIF = {
  ' ': 0.25, '.': 0.25, ',': 0.25, ':': 0.28, ';': 0.28, '!': 0.33, '?': 0.44,
  "'": 0.18, '’': 0.18, '"': 0.33, '“': 0.33, '”': 0.33, '«': 0.42, '»': 0.42,
  '-': 0.33, '–': 0.5, '—': 1, '/': 0.28, '(': 0.33, ')': 0.33, '&': 0.78, '%': 0.75,
  i: 0.28, j: 0.28, l: 0.28, t: 0.28, f: 0.33, r: 0.39, I: 0.36,
  a: 0.5, b: 0.5, c: 0.44, d: 0.5, e: 0.44, g: 0.5, h: 0.5, k: 0.5, n: 0.5,
  o: 0.5, p: 0.5, q: 0.5, s: 0.39, u: 0.5, v: 0.44, x: 0.44, y: 0.44, z: 0.39,
  m: 0.72, w: 0.67,
  A: 0.72, B: 0.67, C: 0.67, D: 0.72, E: 0.61, F: 0.56, G: 0.72, H: 0.72,
  J: 0.39, K: 0.72, L: 0.61, N: 0.72, O: 0.72, P: 0.56, Q: 0.72, R: 0.67,
  S: 0.56, T: 0.61, U: 0.72, V: 0.72, X: 0.72, Y: 0.72, Z: 0.61, M: 0.89, W: 0.94,
};
const DIGIT_DISPLAY = 0.6;
const DIGIT_SERIF = 0.5;

/**
 * Width of `text` in px, from the tables. Weight widens a little; tracking is
 * counted per gap the way canvas `letterSpacing` applies it.
 * @param {string} text
 * @param {{size?:number, face?:'display'|'serif', weight?:number, tracking?:number}} [o]
 */
export function estimateWidth(text, o) {
  const s = String(text == null ? '' : text);
  if (!s) return 0;
  const opt = o || {};
  const size = opt.size == null ? 100 : opt.size;
  const serif = opt.face === 'serif';
  const table = serif ? W_SERIF : W_DISPLAY;
  const digit = serif ? DIGIT_SERIF : DIGIT_DISPLAY;
  let em = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (ch >= '0' && ch <= '9') em += digit;
    else if (table[ch] != null) em += table[ch];
    else if (code > 0x3ff) em += 0.66;       // Cyrillic/CJK-ish: wider than Latin
    else em += serif ? 0.5 : 0.58;
  }
  // 400 → 1.00, 800 → ~1.035. Bold grotesques widen, they do not just darken.
  const weight = (opt.weight || 400) >= 700 ? 1.035 : (opt.weight || 400) >= 600 ? 1.02 : 1;
  const track = (opt.tracking || 0) * Math.max(0, [...s].length - 1);
  return (em * weight + track) * size;
}

/**
 * A measurer backed by a real canvas context. Same signature as
 * `estimateWidth`, so `archetypeLayout` cannot tell them apart.
 * @param {CanvasRenderingContext2D} ctx
 * @param {{display?:string, serif?:string}} [fonts]
 */
export function makeMeasurer(ctx, fonts) {
  const f = Object.assign({}, FONTS, fonts || {});
  return (text, o) => {
    const opt = o || {};
    const size = opt.size == null ? 100 : opt.size;
    try {
      ctx.font = fontString(opt, size, f);
      const track = 'letterSpacing' in ctx;
      if (track) ctx.letterSpacing = `${(opt.tracking || 0) * size}px`;
      const w = ctx.measureText(String(text == null ? '' : text)).width;
      if (track) ctx.letterSpacing = '0px';
      // Older engines ignore letterSpacing; add it back so the fit is honest.
      return track ? w : w + (opt.tracking || 0) * size * Math.max(0, String(text).length - 1);
    } catch (e) {
      return estimateWidth(text, o);
    }
  };
}

function fontString(o, size, fonts) {
  const face = o.face === 'serif' ? fonts.serif : fonts.display;
  const style = o.italic ? 'italic ' : '';
  return `${style}${o.weight || 400} ${size}px ${face}`;
}

/* ── text fitting ─────────────────────────────────────────────────────── */

/**
 * Split `words` into exactly `k` ordered lines, minimising the widest line.
 *
 * Balanced breaks are what make a two-line name look set rather than wrapped:
 * "The Midnight / Interrogator" instead of "The / Midnight Interrogator". Names
 * are two to four words, so the exhaustive search is a few dozen partitions —
 * no need for anything cleverer, and this way it is provably optimal.
 *
 * @param {string[]} words
 * @param {number} k
 * @param {(t:string)=>number} width
 * @returns {string[]}
 */
export function balanceLines(words, k, width) {
  const n = words.length;
  if (n === 0) return [];
  if (k <= 1) return [words.join(' ')];
  if (k >= n) return words.slice();

  let best = null;
  const cuts = new Array(k - 1);
  const walk = (depth, start) => {
    if (depth === k - 1) {
      const lines = [];
      let prev = 0;
      for (const c of cuts) { lines.push(words.slice(prev, c).join(' ')); prev = c; }
      lines.push(words.slice(prev).join(' '));
      const widths = lines.map(width);
      const max = Math.max(...widths);
      const min = Math.min(...widths);
      // Primary: the widest line. Tiebreak: the tightest ragged edge.
      if (!best || max < best.max - 1e-9 || (Math.abs(max - best.max) < 1e-9 && max - min < best.spread)) {
        best = { lines, max, spread: max - min };
      }
      return;
    }
    // Every line after this cut still needs at least one word: n - c ≥ k-1-depth.
    for (let c = start; c <= n - (k - 1 - depth); c++) {
      cuts[depth] = c;
      walk(depth + 1, c + 1);
    }
  };
  walk(0, 1);
  return best.lines;
}

/**
 * The name, as large as the box allows.
 *
 * Searches every line count from 1 to `maxLines`, balances the breaks at each,
 * and keeps the count that yields the biggest type. Fewer lines wins a near-tie
 * (`tieBias`) because a name set on one line reads as a title and a name set on
 * three reads as a paragraph.
 *
 * The size is derived from the measurement — `boxWidth / widestLineAtUnitSize`
 * — so it lands on the exact size that fills the box instead of stepping down
 * from a guess until something fits.
 *
 * @param {string} name
 * @param {{w:number, h:number}} box
 * @param {(t:string,o:object)=>number} measure
 * @param {object} o
 * @returns {{lines:string[], size:number, lineHeight:number, width:number, height:number, clipped:boolean}}
 */
export function fitName(name, box, measure, o) {
  const opt = Object.assign({
    maxLines: 3, maxSize: 200, minSize: 28, leading: 1.02, tracking: -0.028,
    weight: 800, face: 'display', tieBias: 0.04,
  }, o || {});
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { lines: [], size: 0, lineHeight: 0, width: 0, height: 0, clipped: false };

  const U = 100; // measure once at a unit size; advance width is linear in size
  const at1 = (t) => measure(t, { size: U, face: opt.face, weight: opt.weight, tracking: opt.tracking });
  const maxK = Math.max(1, Math.min(opt.maxLines, words.length));

  let best = null;
  for (let k = 1; k <= maxK; k++) {
    const lines = balanceLines(words, k, at1);
    const widest = Math.max(...lines.map(at1), 1e-6);
    const byWidth = (box.w * U) / widest;
    const byHeight = box.h / (k * opt.leading);
    const size = Math.min(byWidth, byHeight, opt.maxSize);
    if (!best || size > best.size * (1 + opt.tieBias)) best = { k, lines, size, widest };
  }

  let { lines, size, widest } = best;
  let clipped = false;
  if (size < opt.minSize) {          // pathological input: hold the floor, trim instead
    size = opt.minSize;
    clipped = true;
    lines = lines.map((l) => ellipsize(l, { size, face: opt.face, weight: opt.weight, tracking: opt.tracking }, box.w, measure));
    widest = Math.max(...lines.map(at1), 1e-6);
  }
  const width = Math.min(box.w, (widest * size) / U);
  return {
    lines,
    size,
    lineHeight: size * opt.leading,
    width,
    height: lines.length * size * opt.leading,
    clipped,
  };
}

/**
 * Greedy wrap at a fixed size, capped at `maxLines`, ellipsis on overflow.
 * @returns {string[]}
 */
export function wrapLines(text, o, maxW, maxLines, measure) {
  const words = String(text == null ? '' : text).split(/\s+/).filter(Boolean);
  if (!words.length || maxLines <= 0) return [];
  const lines = [];
  let line = '';
  let i = 0;
  for (; i < words.length; i++) {
    const t = line ? line + ' ' + words[i] : words[i];
    if (line && measure(t, o) > maxW) {
      if (lines.length === maxLines - 1) break;   // this line is the last one
      lines.push(line);
      line = words[i];
    } else line = t;
  }
  if (line) lines.push(line);
  const dropped = i < words.length;
  if (dropped && lines.length) {
    const last = lines[lines.length - 1];
    lines[lines.length - 1] = ellipsize(last.replace(/[.,;:]?$/, '') + '…', o, maxW, measure);
  }
  return lines.map((l) => ellipsize(l, o, maxW, measure));
}

/** Trim from the end until it fits, then mark the cut. */
export function ellipsize(text, o, maxW, measure) {
  let s = String(text == null ? '' : text);
  if (!s || measure(s, o) <= maxW) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(s.slice(0, mid).trim() + '…', o) <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? s.slice(0, lo).trim() + '…' : '';
}

/** Shrink a size until the text fits, never below `min`. */
function fitSize(text, o, maxW, measure, size, min) {
  let s = size;
  while (s > min && measure(text, Object.assign({}, o, { size: s })) > maxW) s *= 0.94;
  return Math.max(min, s);
}

/* ── composition tables ───────────────────────────────────────────────── */

/*
 * Every number below is at the preset's own base size and scales with it, so a
 * caller can render a 2160×2160 square by passing bigger dimensions and get the
 * identical composition. `gapAbove` is the space between a block and the one
 * above it — the stacked flow is computed bottom-up, because the base (footer,
 * numbers, rule) is fixed and the name takes whatever is left.
 */
const CONFIG = {
  square: {
    flow: 'stack',
    pad: 84, padTop: 84, padBottom: 84,
    eyebrow: { size: 20, tracking: 0.2, gapAbove: 22 },
    name: { maxSize: 176, minSize: 34, maxLines: 3, leading: 1.02, tracking: -0.028, gapAbove: 24 },
    tagline: { size: 38, leading: 1.3, maxLines: 2, gapAbove: 22 },
    blurb: { size: 24, leading: 1.5, maxLines: 3, gapAbove: 32, measure: 0.82 },
    rule: { gapAbove: 30 },
    stats: { flow: 'cols', value: 40, label: 15, tracking: 0.14, inner: 12, gapAbove: 24, max: 4 },
    footer: { size: 21, mark: 26, height: 28, gapAbove: 26 },
  },
  story: {
    flow: 'stack',
    // The extra top/bottom inset is platform chrome: Instagram and TikTok both
    // park UI in roughly the first and last 12% of a story. Nothing that must
    // be read goes there.
    pad: 96, padTop: 232, padBottom: 250,
    eyebrow: { size: 23, tracking: 0.2, gapAbove: 26 },
    name: { maxSize: 210, minSize: 38, maxLines: 4, leading: 1.02, tracking: -0.028, gapAbove: 30 },
    tagline: { size: 45, leading: 1.32, maxLines: 3, gapAbove: 28 },
    blurb: { size: 27, leading: 1.55, maxLines: 4, gapAbove: 40, measure: 0.84 },
    rule: { gapAbove: 40 },
    stats: { flow: 'cols', value: 46, label: 17, tracking: 0.14, inner: 13, gapAbove: 30, max: 4 },
    footer: { size: 24, mark: 30, height: 32, gapAbove: 30 },
  },
  wide: {
    // No vertical room to stack a name over four numbers, so the frame splits:
    // claim on the left, evidence on the right, hairline between them.
    flow: 'split', splitRatio: 0.62, gutter: 52,
    pad: 64, padTop: 64, padBottom: 60,
    eyebrow: { size: 18, tracking: 0.2, gapAbove: 20 },
    name: { maxSize: 112, minSize: 26, maxLines: 3, leading: 1.03, tracking: -0.028, gapAbove: 22 },
    tagline: { size: 30, leading: 1.32, maxLines: 2, gapAbove: 20 },
    blurb: { size: 20, leading: 1.5, maxLines: 2, gapAbove: 22, measure: 1 },
    rule: { gapAbove: 26 },
    stats: { flow: 'rows', value: 34, label: 14, tracking: 0.14, inner: 8, gapAbove: 22, rowGap: 20, max: 4 },
    footer: { size: 19, mark: 24, height: 26, gapAbove: 22 },
  },
};

/** Cap height of the display face, used to turn a box top into a baseline. */
const ASCENT = 0.78;

/** Baselines for a text block laid out from its top edge. */
export function baselinesOf(block) {
  if (!block || !block.lines || !block.lines.length) return [];
  return block.lines.map((_, i) => block.y + block.size * ASCENT + i * block.lineHeight);
}

/* ── layout ───────────────────────────────────────────────────────────── */

/**
 * Where everything lands. Pure: no canvas, no DOM, no globals, no randomness.
 *
 * @param {{name?:string, tagline?:string, blurb?:string,
 *          stats?:Array<{value:any,label:string}>, seed?:number, preset?:string,
 *          theme?:string, palette?:object, eyebrow?:string, hasMark?:boolean,
 *          width?:number, height?:number, redactNames?:string[],
 *          measure?:function}} spec
 * @param {string} [preset] overrides spec.preset
 * @returns {object} boxes, type sizes, scrim plan
 */
export function archetypeLayout(spec, preset) {
  const s = spec || {};
  const key = ARCHETYPE_PRESETS[preset] ? preset
    : ARCHETYPE_PRESETS[s.preset] ? s.preset : DEFAULT_PRESET;
  const [BW, BH] = ARCHETYPE_PRESETS[key];
  const W = s.width || BW;
  const H = s.height || BH;
  const S = W / BW;                       // one scale factor for the whole table
  const C = CONFIG[key];
  const measure = typeof s.measure === 'function' ? s.measure : estimateWidth;
  const theme = s.theme === 'light' ? 'light' : 'dark';
  const T = THEMES[theme];
  const pal = s.palette && Array.isArray(s.palette.accents) ? s.palette : FALLBACK_PALETTE;

  const sc = (n) => n * S;
  const frame = {
    x: sc(C.pad),
    y: sc(C.padTop),
    w: W - sc(C.pad) * 2,
    h: H - sc(C.padTop) - sc(C.padBottom),
  };
  const bottom = frame.y + frame.h;

  /* copy, through the privacy gate ------------------------------------- */
  const red = { redactNames: s.redactNames || [], replacement: 'one project' };
  const name = safeText(s.name, red) || WORDMARK;
  const tagline = safeText(s.tagline, Object.assign({ maxLen: 120 }, red));
  const blurb = safeText(s.blurb, Object.assign({ maxLen: 320 }, red));
  const eyebrow = safeText(s.eyebrow == null ? EYEBROW : s.eyebrow, red).toUpperCase();
  const stats = normalizeStats(s.stats, red).slice(0, C.stats.max);

  /* the base: footer, numbers, rule ------------------------------------ */
  const footerH = sc(C.footer.height);
  const footer = { x: frame.x, y: bottom - footerH, w: frame.w, h: footerH };
  const markSize = s.hasMark === false ? 0 : sc(C.footer.mark);
  const footSize = sc(C.footer.size);
  footer.mark = markSize ? { x: footer.x, y: footer.y + (footerH - markSize) / 2, w: markSize, h: markSize } : null;
  footer.wordmark = {
    x: footer.x + (markSize ? markSize + sc(12) : 0),
    y: footer.y, h: footerH, size: footSize, weight: 700, text: WORDMARK,
    baseline: footer.y + footerH * 0.5 + footSize * 0.36,
  };
  footer.wordmark.w = measure(WORDMARK, { size: footSize, weight: 700 });
  const ctaW = measure(CTA, { size: footSize, weight: 600, tracking: 0.02 });
  footer.cta = {
    x: footer.x + footer.w - ctaW, y: footer.y, w: ctaW, h: footerH,
    size: footSize, weight: 600, tracking: 0.02, text: CTA,
    baseline: footer.wordmark.baseline,
  };

  const isSplit = C.flow === 'split';
  const statsBox = layoutStats(stats, C, S, frame);

  let y;                                  // running bottom edge, moving up
  let rule = null;
  let cols = null;

  if (!isSplit) {
    y = footer.y - sc(C.footer.gapAbove);
    if (statsBox.h > 0) {
      statsBox.x = frame.x; statsBox.y = y - statsBox.h; statsBox.w = frame.w;
      placeStatCells(statsBox, C, S, measure);
      y = statsBox.y - sc(C.stats.gapAbove);
    }
    rule = { x: frame.x, y: Math.round(y) - 1, w: frame.w, h: 1 };
    y = rule.y - sc(C.rule.gapAbove);
  } else {
    // Two columns above one full-width footer.
    const colsBottom = footer.y - sc(C.footer.gapAbove);
    rule = { x: frame.x, y: Math.round(colsBottom) - 1, w: frame.w, h: 1 };
    const leftW = Math.round((frame.w - sc(C.gutter)) * C.splitRatio);
    const rightX = frame.x + leftW + sc(C.gutter);
    cols = {
      left: { x: frame.x, y: frame.y, w: leftW, h: rule.y - frame.y },
      right: { x: rightX, y: frame.y, w: frame.x + frame.w - rightX, h: rule.y - frame.y },
    };
    statsBox.x = cols.right.x; statsBox.w = cols.right.w;
    statsBox.y = rule.y - sc(C.rule.gapAbove) - statsBox.h;
    placeStatCells(statsBox, C, S, measure);
    y = rule.y - sc(C.rule.gapAbove);
  }

  const colW = isSplit ? cols.left.w : frame.w;
  const colX = frame.x;

  /* the copy stack, still bottom-up ------------------------------------ */
  const blurbSize = sc(C.blurb.size);
  // The blurb is the only real prose on the card, so it gets a real measure —
  // a 900px line of 24px type is a wall, and a wall is what people scroll past.
  const blurbW = colW * (C.blurb.measure || 1);
  const blurbLines = blurb
    ? wrapLines(blurb, { size: blurbSize, face: 'display', weight: 400 }, blurbW, C.blurb.maxLines, measure)
    : [];
  const blurbBlock = block(colX, blurbW, blurbLines, blurbSize, blurbSize * C.blurb.leading, { weight: 400, face: 'display' });
  if (blurbBlock.h) { blurbBlock.y = y - blurbBlock.h; y = blurbBlock.y - sc(C.blurb.gapAbove); }

  const tagSize = sc(C.tagline.size);
  const tagLines = tagline
    ? wrapLines(tagline, { size: tagSize, face: 'serif', weight: 400, italic: true }, colW, C.tagline.maxLines, measure)
    : [];
  const tagBlock = block(colX, colW, tagLines, tagSize, tagSize * C.tagline.leading, { weight: 400, face: 'serif', italic: true });
  if (tagBlock.h) { tagBlock.y = y - tagBlock.h; y = tagBlock.y - sc(C.tagline.gapAbove); }

  /* the name takes everything that is left ----------------------------- */
  const eyeSize = sc(C.eyebrow.size);
  const eyeH = eyeSize * 1.1;
  const nameCeiling = frame.y + eyeH + sc(C.eyebrow.gapAbove);
  const nameBox = { x: colX, w: colW, h: Math.max(sc(C.name.minSize), y - sc(C.name.gapAbove) - nameCeiling) };
  const fit = fitName(name, nameBox, measure, {
    maxLines: C.name.maxLines,
    maxSize: sc(C.name.maxSize),
    minSize: sc(C.name.minSize),
    leading: C.name.leading,
    tracking: C.name.tracking,
  });
  const nameBlock = {
    x: colX, w: colW, lines: fit.lines, size: fit.size, lineHeight: fit.lineHeight,
    h: fit.height, y: y - sc(C.name.gapAbove) - fit.height,
    weight: 800, face: 'display', tracking: C.name.tracking, clipped: fit.clipped,
    box: Object.assign({ y: nameCeiling }, nameBox),
  };
  y = nameBlock.y - sc(C.eyebrow.gapAbove);

  const eyeW = eyebrow ? measure(eyebrow, { size: eyeSize, weight: 600, tracking: C.eyebrow.tracking }) : 0;
  const eyeBlock = {
    x: colX, y: y - eyeH, w: Math.min(colW, eyeW), h: eyebrow ? eyeH : 0,
    lines: eyebrow ? [eyebrow] : [], size: eyeSize, lineHeight: eyeH,
    weight: 600, face: 'display', tracking: C.eyebrow.tracking,
  };

  /* the scrim, sized to the ink it has to carry ------------------------ */
  const groupTop = Math.min(
    eyeBlock.h ? eyeBlock.y : nameBlock.y,
    statsBox.h ? statsBox.y : Infinity,
  );
  const group = { x: 0, y: groupTop, w: W, h: H - groupTop };
  const worst = worstArtColor(pal, theme);
  // Solve the scrim for the WEAKEST ink the card paints with, not the brightest.
  // Solving for `ink` alone set the plateau at the 0.5 floor, which is ample for
  // #F4F1EC and left the blurb at 2.51:1 — the file's own promise, broken by the
  // line that was supposed to keep it.
  const scrim = scrimPlan({
    height: H, groupTop, ink: weakestInk([T.ink, T.muted, T.quiet], T.scrim, worst),
    scrimColor: T.scrim, worstArt: worst,
  });

  // Each block declares the ink it will actually be painted with, so a contrast
  // check can pair them correctly. Asserting every ink against every block is
  // the wrong question — the eyebrow is never painted in `muted` — and asserting
  // only the brightest ink is how the stat labels came to be shipped below the
  // bar this file claims to hold.
  const INK_OF = {
    eyebrow: T.ink, name: T.ink, tagline: T.ink, blurb: T.muted,
    stats: T.quiet, footer: T.quiet,
  };
  const blocks = [];
  const push = (nm, b) => {
    if (b && b.h > 0) blocks.push(Object.assign({ block: nm, ink: INK_OF[nm] || T.ink }, pick(b)));
  };
  push('eyebrow', eyeBlock);
  push('name', nameBlock);
  push('tagline', tagBlock);
  push('blurb', blurbBlock);
  if (rule) blocks.push(Object.assign({ block: 'rule', ink: null }, pick(rule)));
  push('stats', statsBox);
  push('footer', footer);

  return {
    preset: key,
    width: W, height: H, scale: S, theme,
    frame, cols, group,
    ink: { primary: T.ink, muted: T.muted, quiet: T.quiet, rule: T.rule, accent: pal.accents[0], paper: pal.bg || T.paper },
    palette: pal,
    seed: (s.seed || 0) >>> 0,
    eyebrow: eyeBlock,
    name: nameBlock,
    tagline: tagBlock,
    blurb: blurbBlock,
    rule,
    stats: statsBox,
    footer,
    divider: isSplit && statsBox.h > 0
      ? { x: Math.round(cols.right.x - sc(C.gutter) / 2), y: statsBox.y, w: 1, h: Math.max(0, rule.y - sc(C.rule.gapAbove) - statsBox.y) }
      : null,
    scrim,
    worstArt: worst,
    blocks,
  };
}

const pick = (b) => ({ x: b.x, y: b.y, w: b.w, h: b.h });

function block(x, w, lines, size, lineHeight, o) {
  return Object.assign({
    x, y: 0, w, lines, size, lineHeight, h: lines.length * lineHeight,
  }, o || {});
}

/**
 * Numbers, cleaned. Values are stringified and length-capped — the base of the
 * card is for round numbers, and anything long enough to wrap is not a number.
 */
function normalizeStats(list, red) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const st of list) {
    if (!st) continue;
    const value = safeText(st.value == null ? '' : String(st.value), red);
    const label = safeText(st.label == null ? '' : String(st.label), red).toUpperCase();
    if (!value || value.length > 10) continue;
    out.push({ value, label: label.slice(0, 14) });
  }
  return out;
}

function layoutStats(cells, C, S, frame) {
  const cfg = C.stats;
  const vs = cfg.value * S;
  const ls = cfg.label * S;
  const inner = cfg.inner * S;
  const rowH = vs + inner + ls;
  const h = !cells.length ? 0
    : cfg.flow === 'rows' ? cells.length * rowH + (cells.length - 1) * cfg.rowGap * S
      : rowH;
  return {
    x: frame.x, y: 0, w: frame.w, h,
    flow: cfg.flow, valueSize: vs, labelSize: ls, inner, rowH,
    tracking: cfg.tracking, cells: cells.map((c) => Object.assign({}, c)),
    rowGap: (cfg.rowGap || 0) * S,
  };
}

/** Place each number inside the stats box, shrinking any value that overruns. */
function placeStatCells(box, C, S, measure) {
  const n = box.cells.length;
  if (!n) return;
  const gutter = 18 * S;
  box.cells.forEach((c, i) => {
    const cw = box.flow === 'rows' ? box.w : box.w / n;
    const cx = box.flow === 'rows' ? box.x : box.x + cw * i;
    const cy = box.flow === 'rows' ? box.y + i * (box.rowH + box.rowGap) : box.y;
    const avail = Math.max(20, cw - (box.flow === 'rows' ? 0 : gutter));
    c.valueSize = fitSize(c.value, { face: 'display', weight: 800 }, avail, measure, box.valueSize, box.valueSize * 0.6);
    c.labelSize = box.labelSize;
    c.label = ellipsize(c.label, { size: c.labelSize, weight: 600, tracking: box.tracking }, avail, measure);
    c.x = cx; c.y = cy; c.w = cw; c.h = box.rowH;
    c.valueBaseline = cy + c.valueSize * ASCENT;
    c.labelBaseline = cy + box.valueSize + box.inner + box.labelSize * ASCENT;
  });
}

/**
 * The gradient that guarantees the type.
 *
 * The art gets to be the ground: above the copy the scrim is a whisper, so the
 * top of the frame is the picture. From just before the first ink to the bottom
 * edge it holds `alpha`, which is the *computed* minimum for 4.5:1 against the
 * brightest thing this seed can paint — never a designer's guess, and never
 * below `floor` so the base still feels grounded on a quiet palette.
 */
/**
 * Of the inks handed in, the one that will struggle most against this ground.
 * @param {string[]} inks
 * @param {string} scrimColor
 * @param {string} worstArt
 * @returns {string}
 */
export function weakestInk(inks, scrimColor, worstArt) {
  const ground = blendOver(worstArt, scrimColor, 1);
  let worstInk = inks[0];
  let worstRatio = Infinity;
  for (const ink of inks) {
    const r = contrastRatio(ink, ground);
    if (r < worstRatio) { worstRatio = r; worstInk = ink; }
  }
  return worstInk;
}

export function scrimPlan(o) {
  const H = o.height;
  const required = requiredScrimAlpha(o.ink, o.scrimColor, o.worstArt, o.ratio || MIN_CONTRAST);
  const alpha = clampNum(Math.max(required, o.floor == null ? 0.5 : o.floor), 0, 0.97);
  const hold = clampNum((o.groupTop - H * 0.02) / H, 0, 1);   // full alpha a hair early
  const fade = clampNum(hold * 0.45, 0, hold);                // where the ramp starts
  const top = Math.min(0.14, alpha * 0.18);
  const stops = [[0, top]];
  if (fade > 0) stops.push([fade, top]);
  stops.push([hold, alpha], [1, alpha]);
  return {
    alpha, required, stops,
    alphaAt: (y) => alphaAt(stops, clampNum(y / H, 0, 1)),
  };
}

function alphaAt(stops, p) {
  for (let i = 1; i < stops.length; i++) {
    if (p <= stops[i][0]) {
      const [p0, a0] = stops[i - 1];
      const [p1, a1] = stops[i];
      if (p1 === p0) return a1;
      return a0 + ((a1 - a0) * (p - p0)) / (p1 - p0);
    }
  }
  return stops[stops.length - 1][1];
}

/** `codepend-the-swarm-lord-square.png` */
export function archetypeFilename(name, preset) {
  const slug = String(name || 'archetype').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'archetype';
  const p = ARCHETYPE_PRESETS[preset] ? preset : DEFAULT_PRESET;
  return `codepend-${slug}-${p}.png`;
}

/* ── drawing ──────────────────────────────────────────────────────────── */

/**
 * Paint the card.
 *
 * @param {CanvasRenderingContext2D} ctx already sized to the preset (any device
 *   pixel ratio must be applied as a transform by the caller — this function
 *   never touches the transform)
 * @param {object} spec see `archetypeLayout`
 * @param {{artImage?:function, palette?:function, grainPattern?:function,
 *          fonts?:object, markImage?:function}} deps browser bindings from app.js
 * @returns {Promise<object>} the layout that was painted
 */
export async function drawArchetypeCard(ctx, spec, deps) {
  const d = deps || {};
  const fonts = Object.assign({}, FONTS, d.fonts || {});
  const s = spec || {};
  const seed = (s.seed || 0) >>> 0;
  const theme = s.theme === 'light' ? 'light' : 'dark';

  let pal = null;
  try { if (typeof d.palette === 'function') pal = d.palette(seed, theme); } catch (e) { /* art is decoration */ }
  if (!pal || !Array.isArray(pal.accents) || pal.accents.length < 3) pal = FALLBACK_PALETTE;

  const measure = makeMeasurer(ctx, fonts);
  const L = archetypeLayout(Object.assign({}, s, {
    palette: pal, measure, theme, hasMark: typeof d.markImage === 'function',
  }), spec && spec.preset);
  const { width: W, height: H } = L;

  /* 1 — ground */
  ctx.save();
  ctx.fillStyle = pal.bg || L.ink.paper;
  ctx.fillRect(0, 0, W, H);

  /* 2 — the art, full bleed, cover-fit */
  if (typeof d.artImage === 'function') {
    let img = null;
    try { img = await d.artImage(seed, 'profile', W, H); } catch (e) { img = null; }
    if (img) {
      const ar = (img.width || W) / (img.height || H);
      let dw = W;
      let dh = H;
      if (ar > W / H) { dh = H; dw = H * ar; } else { dw = W; dh = W / ar; }
      ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
    }
  }

  /* 3 — the computed scrim */
  const [sr, sg, sb] = parseColor(THEMES[theme].scrim);
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  for (const [p, a] of L.scrim.stops) grad.addColorStop(clampNum(p, 0, 1), `rgba(${sr},${sg},${sb},${round3(a)})`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  /* 4 — type */
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  if (L.eyebrow.h) {
    ctx.fillStyle = L.ink.primary;
    ctx.globalAlpha = 0.66;
    setFont(ctx, fonts, { size: L.eyebrow.size, weight: 600 });
    drawTracked(ctx, L.eyebrow.lines[0], L.eyebrow.x, baselinesOf(L.eyebrow)[0], L.eyebrow.tracking * L.eyebrow.size);
    ctx.globalAlpha = 1;
  }

  if (L.name.h) {
    ctx.fillStyle = L.ink.primary;
    setFont(ctx, fonts, { size: L.name.size, weight: 800 });
    const bl = baselinesOf(L.name);
    L.name.lines.forEach((line, i) => drawTracked(ctx, line, L.name.x, bl[i], L.name.tracking * L.name.size));
  }

  if (L.tagline.h) {
    ctx.fillStyle = L.ink.primary;
    ctx.globalAlpha = 0.86;
    setFont(ctx, fonts, { size: L.tagline.size, weight: 400, face: 'serif', italic: true });
    baselinesOf(L.tagline).forEach((b, i) => ctx.fillText(L.tagline.lines[i], L.tagline.x, b));
    ctx.globalAlpha = 1;
  }

  if (L.blurb.h) {
    ctx.fillStyle = L.ink.muted;
    setFont(ctx, fonts, { size: L.blurb.size, weight: 400 });
    baselinesOf(L.blurb).forEach((b, i) => ctx.fillText(L.blurb.lines[i], L.blurb.x, b));
  }

  /* 5 — the base: hairlines and numbers */
  ctx.fillStyle = L.ink.rule;
  if (L.rule) ctx.fillRect(L.rule.x, L.rule.y, L.rule.w, L.rule.h);
  if (L.divider) ctx.fillRect(L.divider.x, L.divider.y, L.divider.w, L.divider.h);

  for (const c of L.stats.cells) {
    ctx.fillStyle = L.ink.primary;
    setFont(ctx, fonts, { size: c.valueSize, weight: 800 });
    ctx.fillText(c.value, c.x, c.valueBaseline);
    if (!c.label) continue;
    ctx.fillStyle = L.ink.quiet;
    setFont(ctx, fonts, { size: c.labelSize, weight: 600 });
    drawTracked(ctx, c.label, c.x, c.labelBaseline, L.stats.tracking * c.labelSize);
  }

  /* 6 — signature */
  if (L.footer.mark && typeof d.markImage === 'function') {
    let mk = null;
    try { mk = await d.markImage(Math.round(L.footer.mark.w)); } catch (e) { mk = null; }
    if (mk) ctx.drawImage(mk, L.footer.mark.x, L.footer.mark.y, L.footer.mark.w, L.footer.mark.h);
  }
  ctx.fillStyle = L.ink.primary;
  setFont(ctx, fonts, { size: L.footer.wordmark.size, weight: 700 });
  ctx.fillText(WORDMARK, L.footer.wordmark.x, L.footer.wordmark.baseline);
  ctx.fillStyle = L.ink.quiet;
  setFont(ctx, fonts, { size: L.footer.cta.size, weight: 600 });
  drawTracked(ctx, CTA, L.footer.cta.x, L.footer.cta.baseline, L.footer.cta.tracking * L.footer.cta.size);

  /* 7 — the same grain the page wears */
  if (typeof d.grainPattern === 'function') {
    try {
      const pat = d.grainPattern(ctx, seed);
      if (pat) {
        ctx.globalAlpha = 0.055;
        ctx.globalCompositeOperation = 'overlay';
        ctx.fillStyle = pat;
        ctx.fillRect(0, 0, W, H);
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
      }
    } catch (e) { /* grain is cosmetic */ }
  }

  ctx.restore();
  return L;
}

function setFont(ctx, fonts, o) {
  ctx.font = fontString(o, o.size, fonts);
}

/**
 * Tracked text. Canvas letter-spacing is recent; where it is missing we walk
 * the string and advance by hand, which is exact rather than the old trick of
 * shoving spaces between glyphs.
 */
function drawTracked(ctx, text, x, y, px) {
  const s = String(text == null ? '' : text);
  if (!s) return;
  if (!px) { ctx.fillText(s, x, y); return; }
  if ('letterSpacing' in ctx) {
    ctx.letterSpacing = `${px}px`;
    ctx.fillText(s, x, y);
    ctx.letterSpacing = '0px';
    return;
  }
  let cx = x;
  for (const ch of s) {
    ctx.fillText(ch, cx, y);
    cx += ctx.measureText(ch).width + px;
  }
}

const round3 = (n) => Math.round(n * 1000) / 1000;

export default drawArchetypeCard;
