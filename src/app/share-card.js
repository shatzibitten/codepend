/* ============================================================================
   codepend — share-card.js
   The export IS the card. Not a template the card is poured into.

   WHAT WENT WRONG BEFORE. `drawShare()` in app.js was one generic composition
   serving thirty-four different memories: full-bleed art, an eyebrow, one
   enormous number, the headline demoted to a caption, a footer. It never drew a
   chart at all. So the card that reads "You've used every hour on this clock
   except 3 AM" over a 24-spoke radial clock exported as contour art with
   "12 PM / PEAK HOUR" set in it and no clock anywhere. The chart is the reason
   those cards are worth sharing, and the chart was exactly what got dropped.

   THE RULE THIS FILE HOLDS. Hold the screenshot of the feed next to the export
   and it is the same card: same eyebrow, same headline, same body, same chart,
   same art, same palette. Five kinds, and each is composed for what it actually
   is rather than squeezed through one lockup:

     • chart      — the chart is the subject and gets the frame. Copy underneath.
     • stat       — the number is the subject; a chart the memory carries comes
                    with it, because the feed shows it.
     • quote      — the quote is the subject, in the serif, with room around it.
     • onthisday  — a date, a headline, usually a pulled quote. A moment.
     • award      — belongs to archetype-card.js. Laid out here so nothing
                    crashes, flagged with `delegate` so the caller can route it.

   Each preset is a RE-COMPOSITION. `wide` (1200×675) is a landscape: the copy
   takes a column and the subject sits beside it. `tall` (1080×1350) is a
   column: the subject stacks over the copy. Nothing is rescaled.

   Three ideas, the same three archetype-card.js is built on:

   1. GEOMETRY IS PURE. `shareLayout()` returns every box for a preset and
      touches no canvas, no DOM, no globals, no clock. That is the only reason
      any of this gets real coverage — the tests run the code the browser runs.

   2. TYPE IS MEASURED, NEVER GUESSED. Headlines run from four words to forty;
      quotes to 180 characters. Both are fitted by searching sizes against a
      measurer — `ctx.measureText` in the browser, a per-glyph advance table in
      Node — so a long headline shrinks and a short one fills.

   3. CONTRAST IS COMPUTED, NEVER ASSUMED, FOR EVERY INK. Not the brightest one.
      Every block declares the ink it will be painted with and the effective
      scrim alpha over it (page scrim composited with the chart panel where
      there is one), and `blocks[].ground` is that number. A test asserts 4.5:1
      for every block, every seed, both themes. Solving for `ink` alone is how
      the archetype card once shipped its blurb at 2.51:1.

   PRIVACY. `hideProject` reaches the CHART, not just the copy. A donut of
   "share of time by project" is labelled with project names and its centre
   reads the top project's name at 34px — redacting the sentence underneath and
   leaving that is not redaction. Labels are rewritten before the geometry is
   built, so every downstream number (the "57%", the label in the hole) is
   derived from the redacted rows.

   NO IMPORTS. render.js inlines each app module into one IIFE with its exports
   stripped; an `import` would either be a syntax error inside that IIFE or a
   network fetch from a page that promises to work offline. So the colour,
   measurement and privacy helpers below are a deliberate mirror of the ones in
   archetype-card.js — the same trade that file already made with app.js's
   RISKY list. test/share-card.test.mjs imports BOTH modules and asserts the
   mirrored functions agree, so drift is a red test rather than a card that
   silently ships at 3:1.

   Zero dependencies. Node stdlib only, no DOM at import time.
   ========================================================================== */

const clampNum = (v, a, b) => Math.min(b, Math.max(a, v));

/* ── frames ───────────────────────────────────────────────────────────── */

/**
 * The two frames the share sheet offers, unchanged from app.js's PRESETS so a
 * caller can swap this module in without touching the UI.
 *   wide — 1200×675. Link previews and X. No vertical room, so the copy takes a
 *          column and the subject lives beside it.
 *   tall — 1080×1350. The portrait feed post. Subject over copy.
 */
export const SHARE_PRESETS = { wide: [1200, 675], tall: [1080, 1350] };

export const DEFAULT_PRESET = 'wide';

/** The kinds app.js's `norm()` emits. `flat` never reaches an export. */
export const SHARE_KINDS = ['chart', 'stat', 'quote', 'onthisday', 'award'];

export const WORDMARK = 'codepend';
export const CTA = 'npx codepend';

/** WCAG AA for body text. Large text would only need 3:1; we hold the bar. */
export const MIN_CONTRAST = 4.5;

/**
 * Ink and scrim per theme. Identical to archetype-card.js's THEMES, including
 * the reason `quiet` is not the page's own `--ink-2`: #827D75 tops out at
 * 4.96:1 on a perfectly clean ground and measured 3.59:1 on real pixels.
 */
export const THEMES = {
  dark: { ink: '#F4F1EC', muted: '#B9B4AC', quiet: '#BDB7AE', scrim: '#05060A', paper: '#06070A', rule: 'rgba(255,255,255,.18)', inv: '#06070A' },
  light: { ink: '#12100D', muted: '#4A453D', quiet: '#4F4A42', scrim: '#FAF7F2', paper: '#F7F4EF', rule: 'rgba(0,0,0,.16)', inv: '#F7F4EF' },
};

const FALLBACK_PALETTE = { bg: '#0B0F17', fg: '#F4F1EC', accents: ['#59AAF8', '#8771DE', '#A9C7F2'] };

export const FONTS = {
  display: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  serif: '"Iowan Old Style", Georgia, "Times New Roman", serif',
};

/* ── privacy gate ─────────────────────────────────────────────────────── */

/**
 * Kept in sync with app.js's RISKY and archetype-card.js's copy on purpose:
 * three copies that agree beat one import none of these files can have.
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
 * Substitution first — headlines and bodies interpolate project names, and a
 * project name is the thing that must not appear on a poster someone's
 * colleagues will see. Then the gate: anything still risky is dropped whole
 * rather than partially scrubbed, because a half-redacted path is still a leak.
 * Every composition below is built to look composed with any one part missing.
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
    .sort((a, b) => b.length - a.length);      // "acme-web" before "acme"
  const one = o.replacement || 'a project';
  for (const n of names) {
    s = s.replace(new RegExp(n.replace(RX_ESC, '\\$&'), 'gi'), one);
  }
  if (names.length) {
    const R = one.replace(RX_ESC, '\\$&');
    s = s.replace(new RegExp(`${R}(?:(?:,\\s*|\\s+and\\s+)${R})+`, 'gi'), o.plural || 'a few projects');
  }
  if (isRisky(s)) return '';
  const max = o.maxLen || 0;
  if (max && s.length > max) s = s.slice(0, max - 1).replace(/\s\S*$/, '') + '…';
  return s;
}

/* ── charts: privacy, before geometry ─────────────────────────────────── */

const CHART_TYPES = ['clock', 'donut', 'bars', 'spark', 'heat'];

/** Does this normalised chart carry anything worth drawing? */
export function chartHasData(chart) {
  if (!chart || CHART_TYPES.indexOf(String(chart.type)) < 0) return false;
  if (chart.type === 'clock') return Array.isArray(chart.bins) && chart.bins.some((v) => v > 0);
  if (chart.type === 'heat') return Array.isArray(chart.values) && chart.values.some((v) => v > 0);
  if (chart.type === 'spark') return Array.isArray(chart.points) && chart.points.length >= 2;
  return Array.isArray(chart.rows) && chart.rows.length > 0;
}

/**
 * `hideProject` has to reach here, not stop at the sentence.
 *
 * A donut labelled ACME-WEB / BILLING / INFRA / OTHER with "57% / ACME-WEB" in
 * the hole leaks four project names and the top one twice, no matter how
 * carefully the headline above it was scrubbed. So labels are rewritten BEFORE
 * `chartGeometry()` runs — the percentage in the hole, the label in the hole and
 * the labels on the arcs are all derived from these rows, so redacting the rows
 * redacts every one of them at once.
 *
 * Two ways a label is known to be a project name:
 *   • the chart says so — `chart.labels === 'project'`, or it is a donut with
 *     at least one label that IS a known project name, in which case the rest
 *     of its slices are project names too and go with it; or
 *   • it matches `project` / one of `redactNames`.
 * A bars chart of tool names is not touched by the first rule, because "Bash"
 * relabelled "PROJECT 1" would be a worse lie than the leak. The donut used to
 * be redacted wholesale on its type alone, on the belief that in this product a
 * donut is only ever the project split. It is not: `the-bill` is a donut of
 * INPUT / OUTPUT / CACHE READ / CACHE WRITE, and the toggle turned a cost
 * breakdown into "PROJECT 1 … PROJECT 4" — the same lie, on a chart with no
 * project in it. One matching label is what earns the wholesale rule now.
 *
 * @param {object} chart normalised chart (output of video.js `normalizeChart`)
 * @param {{hideProject?:boolean, project?:string, redactNames?:string[]}} o
 * @returns {object|null} a copy; the input is never mutated
 */
export function redactChartLabels(chart, o) {
  if (!chartHasData(chart)) return null;
  const opt = o || {};
  const out = Object.assign({}, chart);
  const note = safeText(chart.note, { redactNames: namesFor(opt), replacement: 'a project', maxLen: 90 });
  out.note = note || '';
  if (!Array.isArray(chart.rows)) return out;

  const byName = namesFor(opt).map((n) => String(n).toLowerCase());
  const matches = (label) => byName.some((p) => p && String(label).toLowerCase().indexOf(p) >= 0);
  const wholesale = !!opt.hideProject
    && (chart.labels === 'project'
      || (chart.type === 'donut' && chart.rows.some((r) => matches(r && r.label))));
  let n = 0;
  out.rows = chart.rows.map((r) => {
    const label = String(r.label == null ? '' : r.label);
    const low = label.toLowerCase();
    // "other" is a bucket, not a name — keeping it keeps the donut readable.
    const bucket = low === 'other' || low === 'others' || low === 'rest';
    let next = label;
    if (!bucket && opt.hideProject && (wholesale || matches(low))) next = `project ${++n}`;
    if (isRisky(next)) next = bucket ? 'other' : `project ${++n}`;
    return Object.assign({}, r, { label: next });
  });
  return out;
}

function namesFor(o) {
  const list = [];
  if (o.project) list.push(o.project);
  if (Array.isArray(o.redactNames)) for (const n of o.redactNames) if (n) list.push(n);
  return o.hideProject ? list : [];
}

/**
 * How much of the reserved box the chart may actually use.
 *
 * `clockGeometry` sizes itself off `min(w,h)` and then hangs its hour marks at
 * `r1 + 18k` = exactly half that — so the "00" and "18" labels sit ON the box
 * edge and their glyphs spill past it. `donutGeometry` puts its on-mark labels
 * outside the ring. Neither is a bug in video.js; both mean the caller has to
 * hand over a box slightly smaller than the space it owns.
 */
export function chartInset(type) {
  if (type === 'clock') return 0.86;
  if (type === 'donut') return 0.92;
  return 1;
}

/**
 * The proportions each chart actually wants, taken from the same viewBoxes the
 * page's SVG figures and video.js's geometry are built on.
 *
 * This is not used to size the chart — `chartGeometry` already fits itself to
 * whatever box it is handed. It is used to size the PANEL behind it. A sparkline
 * is 520×140; dropped into the 464×524 right-hand column of a wide stat card it
 * draws a thin ribbon across the middle of a tall dark slab, and the slab is
 * the sort of unexplained rectangle that made the old exports look broken.
 *
 * @returns {number} width ÷ height
 */
export function chartAspect(chart) {
  if (!chart) return 1;
  if (chart.type === 'clock') return 1;
  if (chart.type === 'donut') return 460 / 330;
  if (chart.type === 'spark') return 520 / 140;
  if (chart.type === 'bars') {
    const n = Math.max(1, (chart.rows || []).length);
    return 520 / (n * 40 - 10);
  }
  if (chart.type === 'heat') {
    const cols = Math.max(1, Math.ceil((chart.values || []).length / 7));
    return (cols * 13 - 3) / (7 * 13 - 3);
  }
  return 1;
}

/** The largest rectangle of ratio `ar` centred inside `box`. */
export function fitAspect(box, ar) {
  const a = ar > 0 && isFinite(ar) ? ar : 1;
  let w = box.w;
  let h = w / a;
  if (h > box.h) { h = box.h; w = h * a; }
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
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

/** Linear mix in sRGB — what canvas does when it composites. */
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
 * Two scrims, one over the other. The page gradient is laid down first and the
 * chart panel on top of it, so the ground under a chart label is not `panel`
 * but the composite. Getting this wrong is silent: the panel looks heavy, the
 * label looks fine on the developer's seed, and one palette in twenty ships at
 * 3.8:1.
 */
export function combineAlpha(a, b) {
  return 1 - (1 - clampNum(a, 0, 1)) * (1 - clampNum(b, 0, 1));
}

/** The extra alpha `b` must carry so that `a` composited with it reaches `want`. */
export function alphaToReach(a, want) {
  const base = clampNum(a, 0, 1);
  if (base >= want) return 0;
  if (base >= 1) return 0;
  return clampNum((want - base) / (1 - base), 0, 1);
}

/**
 * The brightest (dark theme) or darkest (light theme) thing this seed's art can
 * plausibly paint under the type. `palette()` returns bg + three accents, but
 * art.js also lays a near-white `hot` tone and blurs it, which blooms past any
 * accent — hence the further 45% push toward the extreme. Guessing low ships a
 * card that fails on some seeds and nobody ever finds out; guessing high costs
 * a slightly heavier scrim, which is the cheap mistake.
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
 * Monotonic in alpha, so the bisection is exact to the step it returns.
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

/**
 * Of the inks handed in, the one that will struggle most against this ground.
 * The card paints in three of them and the scrim has to serve the weakest.
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

/**
 * First candidate that clears the bar on this ground, else the fallback.
 *
 * The stat's unit ("h", "×", "days") is painted in the palette accent on the
 * page, and an accent is a colour chosen for the art, not for legibility. Rather
 * than ban it or ship it blind, measure it: seeds where the accent reads keep
 * the accent, seeds where it does not get muted ink.
 */
export function pickInk(candidates, ground, fallback, ratio = MIN_CONTRAST) {
  for (const c of candidates) {
    if (c && contrastRatio(c, ground) >= ratio) return c;
  }
  return fallback;
}

/* ── measurement ──────────────────────────────────────────────────────── */

/*
 * Advance widths as a fraction of the em, for the two faces the card uses.
 * They exist so `shareLayout` is pure: Node has no `measureText`, and a layout
 * that could only be exercised through a canvas would never be tested. They are
 * approximations of the system grotesque and the Georgia-class serif — within a
 * few percent, which is all the fitting search needs, and the browser re-fits
 * with the real metrics anyway.
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
 * counted per gap, the way canvas `letterSpacing` applies it.
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
  const weight = (opt.weight || 400) >= 700 ? 1.035 : (opt.weight || 400) >= 600 ? 1.02 : 1;
  const track = (opt.tracking || 0) * Math.max(0, [...s].length - 1);
  return (em * weight + track) * size;
}

/**
 * A measurer backed by a real canvas context. Same signature as
 * `estimateWidth`, so `shareLayout` cannot tell them apart.
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

/** Greedy wrap with no line cap. The raw shape a fit search needs. */
export function wrapAll(text, o, maxW, measure) {
  const words = String(text == null ? '' : text).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  let line = '';
  for (const w of words) {
    const t = line ? line + ' ' + w : w;
    if (line && measure(t, o) > maxW) { lines.push(line); line = w; } else line = t;
  }
  if (line) lines.push(line);
  return lines;
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

/**
 * Greedy wrap at a fixed size, capped at `maxLines`, ellipsis on overflow.
 *
 * When it has to drop words it prefers ending on a full stop over trailing off
 * mid-word: "…the tools changed. You didn't." reads as an edit, "…the tools cha…"
 * reads as a rendering bug on something somebody is about to post. The sentence
 * break is only taken when it keeps most of the text; otherwise the ellipsis is
 * the honest signal that there was more.
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
    const whole = lines.join(' ');
    const stop = Math.max(whole.lastIndexOf('. '), whole.lastIndexOf('! '), whole.lastIndexOf('? '));
    if (stop > whole.length * 0.55) {
      const kept = whole.slice(0, stop + 1);
      const rewrapped = wrapAll(kept, o, maxW, measure);
      if (rewrapped.length <= maxLines) return rewrapped.map((l) => ellipsize(l, o, maxW, measure));
    }
    const last = lines[lines.length - 1];
    lines[lines.length - 1] = ellipsize(last.replace(/[.,;:]?$/, '') + '…', o, maxW, measure);
  }
  return lines.map((l) => ellipsize(l, o, maxW, measure));
}

/**
 * The largest size at which `text` fits `box` in at most `maxLines` lines.
 *
 * Search downward from `maxSize` in 6% steps. Falls back to `minSize` with a
 * truncating wrap, and says so (`clipped`) — a caller that wants to know whether
 * the headline survived intact can ask.
 *
 * @param {string} text
 * @param {{w:number,h:number}} box
 * @param {(t:string,o:object)=>number} measure
 * @returns {{lines:string[], size:number, lineHeight:number, height:number,
 *            width:number, clipped:boolean}}
 */
export function fitBlock(text, box, measure, o) {
  const opt = Object.assign({
    maxSize: 80, minSize: 24, maxLines: 4, leading: 1.16,
    face: 'display', weight: 700, italic: false, tracking: 0,
  }, o || {});
  const s = String(text == null ? '' : text).trim();
  const empty = { lines: [], size: 0, lineHeight: 0, height: 0, width: 0, clipped: false };
  if (!s || box.w <= 0 || box.h <= 0) return empty;

  const attr = (size) => ({ size, face: opt.face, weight: opt.weight, italic: opt.italic, tracking: opt.tracking });
  let size = opt.maxSize;
  for (let guard = 0; guard < 80 && size > opt.minSize; guard++) {
    const lines = wrapAll(s, attr(size), box.w, measure);
    if (lines.length <= opt.maxLines && lines.length * size * opt.leading <= box.h + 0.5) {
      return finish(lines, size, false);
    }
    size *= 0.94;
  }
  size = Math.max(opt.minSize, Math.min(opt.maxSize, size));
  const cap = Math.max(1, Math.min(opt.maxLines, Math.floor((box.h + 0.5) / (size * opt.leading))));
  const lines = wrapLines(s, attr(size), box.w, cap, measure);
  return finish(lines, size, true);

  function finish(lines, sz, clipped) {
    const widest = lines.length ? Math.max(...lines.map((l) => measure(l, attr(sz)))) : 0;
    return {
      lines, size: sz, lineHeight: sz * opt.leading,
      height: lines.length * sz * opt.leading,
      width: Math.min(box.w, widest),
      clipped,
    };
  }
}

/** Shrink a single line until it fits, never below `min`. */
export function fitSize(text, o, maxW, measure, size, min) {
  let s = size;
  for (let i = 0; i < 200 && s > min && measure(text, Object.assign({}, o, { size: s })) > maxW; i++) s *= 0.94;
  return Math.max(min, s);
}

/** Cap height of both faces, used to turn a box top into a first baseline. */
const ASCENT = 0.78;

/** Baselines for a text block laid out from its top edge. */
export function baselinesOf(block) {
  if (!block || !block.lines || !block.lines.length) return [];
  return block.lines.map((_, i) => block.y + block.size * ASCENT + i * block.lineHeight);
}

/* ── the scrim ────────────────────────────────────────────────────────── */

/**
 * Piecewise-linear alpha along one axis.
 * @param {Array<[number,number]>} stops sorted by position
 */
export function alphaAt(stops, p) {
  const t = clampNum(p, 0, 1);
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [p0, a0] = stops[i - 1];
      const [p1, a1] = stops[i];
      if (p1 === p0) return a1;
      return a0 + ((a1 - a0) * (t - p0)) / (p1 - p0);
    }
  }
  return stops[stops.length - 1][1];
}

/**
 * The gradient that guarantees the type, in three shapes.
 *
 * `flat` — one alpha everywhere. Chart cards use this on purpose: the feed's
 *   own `.card--chart` sets a solid surface and drops the art to 0.22 opacity,
 *   because a chart drawn over moving contours is a chart nobody can read. The
 *   export matching the feed means matching that decision too.
 *
 * `y` — tall frames. Full alpha across the eyebrow band at the top, a window of
 *   near-clear art through the middle where nothing is written, then full alpha
 *   from just above the first ink of the main group down to the bottom edge.
 *   The window is what makes the art the ground rather than a texture.
 *
 * `x` — wide frames. Full alpha across the copy column, fading out past it, so
 *   the subject beside the copy sits on art rather than on a wash.
 *
 * `alpha` is never a designer's guess: it is `requiredScrimAlpha()` for the
 * WEAKEST ink the card paints with, floored so a quiet palette still feels
 * grounded.
 */
export function scrimPlan(o) {
  const required = requiredScrimAlpha(o.ink, o.scrimColor, o.worstArt, o.ratio || MIN_CONTRAST);
  const alpha = clampNum(Math.max(required, o.floor == null ? 0.5 : o.floor), 0, 0.97);
  const low = Math.min(0.16, alpha * 0.22);
  const mode = o.mode === 'flat' || o.mode === 'x' ? o.mode : 'y';
  let stops;
  if (mode === 'flat') {
    stops = [[0, alpha], [1, alpha]];
  } else if (mode === 'x') {
    const edge = clampNum(o.holdTo == null ? 0.62 : o.holdTo, 0.2, 1);
    stops = edge >= 0.995 ? [[0, alpha], [1, alpha]]
      : [[0, alpha], [edge, alpha], [Math.min(1, edge + 0.26), low], [1, low]];
  } else {
    const capTo = clampNum(o.capTo == null ? 0.1 : o.capTo, 0, 1);
    const hold = clampNum(o.holdFrom == null ? 0.5 : o.holdFrom, 0, 1);
    // No window worth having → one flat wash rather than a gradient that
    // pretends to reveal art it never reveals.
    if (hold - capTo < 0.14) stops = [[0, alpha], [1, alpha]];
    else {
      stops = [
        [0, alpha], [capTo, alpha],
        [capTo + (hold - capTo) * 0.34, low], [hold - (hold - capTo) * 0.22, low],
        [hold, alpha], [1, alpha],
      ];
    }
  }
  return { mode, alpha, required, low, stops, alphaAt: (p) => alphaAt(stops, p) };
}

/**
 * The WORST (lowest) page-scrim alpha anywhere inside `box`.
 *
 * Sampling the corners is not enough on its own — the gradient's minimum can sit
 * at an interior stop — so every stop that falls inside the box's span is
 * sampled too. This is the number the contrast promise is made against, which
 * is why it takes the minimum and not the middle.
 */
export function groundOf(scrim, box, W, H) {
  if (!scrim) return 0;
  if (scrim.mode === 'flat') return scrim.alpha;
  const span = scrim.mode === 'x'
    ? [box.x / W, (box.x + box.w) / W]
    : [box.y / H, (box.y + box.h) / H];
  const lo = clampNum(Math.min(span[0], span[1]), 0, 1);
  const hi = clampNum(Math.max(span[0], span[1]), 0, 1);
  let worst = Math.min(scrim.alphaAt(lo), scrim.alphaAt(hi));
  for (const [p] of scrim.stops) {
    if (p > lo && p < hi) worst = Math.min(worst, scrim.alphaAt(p));
  }
  return worst;
}

/* ── composition tables ───────────────────────────────────────────────── */

/*
 * Every number is at the preset's own base size and scales with it, so a caller
 * can render a 2160×2700 tall card by passing bigger dimensions and get the
 * identical composition.
 *
 * `copyCol` is the fraction of the frame the copy column takes on a wide frame
 * — per kind, because a chart needs half the landscape and a quote needs two
 * thirds of it. On tall frames there is one column and the number is unused.
 */
const CONFIG = {
  wide: {
    axis: 'x',
    pad: 62, padTop: 56, padBottom: 52, gutter: 44,
    eyebrow: { size: 18, tracking: 0.2, gapBelow: 22 },
    headline: { maxSize: 56, minSize: 23, maxLines: 4, leading: 1.14, tracking: -0.02, gapAbove: 20 },
    tagline: { maxSize: 26, minSize: 17, maxLines: 2, leading: 1.34, gapAbove: 14 },
    body: { size: 20, leading: 1.5, maxLines: 3, gapAbove: 16 },
    quote: { maxSize: 50, minSize: 21, maxLines: 6, leading: 1.3, gapAbove: 18 },
    pull: { maxSize: 28, minSize: 17, maxLines: 3, leading: 1.34, gapAbove: 18 },
    attrib: { size: 17, tracking: 0.14, gapAbove: 16 },
    stat: { maxSize: 132, minSize: 40, label: 19, tracking: 0.16, unit: 0.36, gapAbove: 18, labelGap: 14 },
    meta: { size: 16, tracking: 0.1, gapAbove: 20 },
    rule: { gapAbove: 20 },
    footer: { size: 18, mark: 22, height: 24, gapAbove: 18 },
    chartBand: 0.44,          // fraction of the copy column's height, stat kind
    copyCol: { chart: 0.5, stat: 0.55, quote: 0.66, onthisday: 0.62, award: 0.62 },
  },
  tall: {
    axis: 'y',
    pad: 80, padTop: 76, padBottom: 74, gutter: 0,
    eyebrow: { size: 22, tracking: 0.2, gapBelow: 30 },
    headline: { maxSize: 78, minSize: 29, maxLines: 5, leading: 1.14, tracking: -0.02, gapAbove: 26 },
    tagline: { maxSize: 34, minSize: 21, maxLines: 2, leading: 1.34, gapAbove: 18 },
    body: { size: 26, leading: 1.5, maxLines: 4, gapAbove: 20 },
    quote: { maxSize: 72, minSize: 27, maxLines: 7, leading: 1.3, gapAbove: 24 },
    pull: { maxSize: 36, minSize: 21, maxLines: 3, leading: 1.34, gapAbove: 24 },
    attrib: { size: 21, tracking: 0.14, gapAbove: 20 },
    stat: { maxSize: 188, minSize: 52, label: 24, tracking: 0.16, unit: 0.36, gapAbove: 24, labelGap: 18 },
    meta: { size: 19, tracking: 0.1, gapAbove: 24 },
    rule: { gapAbove: 24 },
    footer: { size: 22, mark: 28, height: 30, gapAbove: 22 },
    chartBand: 0.2,           // fraction of the FRAME height, stat kind
    chartShare: 0.44,         // fraction of the frame the chart claims, chart kind
    copyCol: { chart: 1, stat: 1, quote: 1, onthisday: 1, award: 1 },
  },
};

/* ── layout ───────────────────────────────────────────────────────────── */

/** `award` is archetype-card.js's job; everything else falls back to onthisday. */
function normalizeKind(k) {
  const s = String(k || '').toLowerCase();
  return SHARE_KINDS.indexOf(s) >= 0 ? s : 'onthisday';
}

const pick = (b) => ({ x: b.x, y: b.y, w: b.w, h: b.h });

function textBlock(x, w, lines, size, lineHeight, o) {
  return Object.assign({
    x, y: 0, w, lines: lines || [], size, lineHeight,
    h: (lines || []).length * lineHeight,
  }, o || {});
}

/**
 * Where everything lands. Pure: no canvas, no DOM, no globals, no randomness,
 * no `Date.now()`. The same spec always produces the same object.
 *
 * `spec.chart` must already be NORMALISED — the output of video.js's
 * `normalizeChart()`, which is what app.js's `normChart()` caches and what the
 * feed's own SVG figures read. This function is pure and cannot call it. A raw
 * detector payload is treated as no chart at all rather than half-drawn;
 * `drawShareCard` will normalise for you if you hand it `deps.normalizeChart`.
 *
 * @param {{kind?:string, eyebrow?:string, headline?:string, body?:string,
 *          tagline?:string, quote?:{text:string,who?:string,project?:string},
 *          stat?:{value:any,unit?:string,label?:string}, chart?:object,
 *          seed?:number, project?:string, agent?:string, dateText?:string,
 *          date?:number, note?:string, theme?:string, palette?:object,
 *          hideProject?:boolean, redactNames?:string[],
 *          width?:number, height?:number, measure?:function}} spec
 * @param {string} [preset] 'wide' | 'tall'; overrides spec.preset
 * @returns {object}
 */
export function shareLayout(spec, preset) {
  const s = spec || {};
  const key = SHARE_PRESETS[preset] ? preset
    : SHARE_PRESETS[s.preset] ? s.preset : DEFAULT_PRESET;
  const [BW, BH] = SHARE_PRESETS[key];
  const W = s.width || BW;
  const H = s.height || BH;
  const S = W / BW;
  const C = CONFIG[key];
  const sc = (n) => n * S;
  const measure = typeof s.measure === 'function' ? s.measure : estimateWidth;
  const theme = s.theme === 'light' ? 'light' : 'dark';
  const T = THEMES[theme];
  const pal = s.palette && Array.isArray(s.palette.accents) ? s.palette : FALLBACK_PALETTE;
  const kind = normalizeKind(s.kind);
  const wide = key === 'wide';

  /* copy, through the privacy gate ------------------------------------- */
  const red = {
    redactNames: namesFor({ hideProject: s.hideProject, project: s.project, redactNames: s.redactNames }),
    replacement: 'a project',
  };
  const eyebrow = safeText(s.eyebrow, Object.assign({ maxLen: 60 }, red)).toUpperCase();
  let headline = safeText(s.headline, Object.assign({ maxLen: 220 }, red));
  const tagline = safeText(s.tagline, Object.assign({ maxLen: 140 }, red));
  let body = safeText(s.body, Object.assign({ maxLen: 300 }, red));
  const quoteText = s.quote && s.quote.text
    ? safeText(s.quote.text, Object.assign({ maxLen: 260 }, red)) : '';
  const stat = normalizeStat(s.stat, red);
  const chart = redactChartLabels(s.chart, {
    hideProject: s.hideProject, project: s.project, redactNames: s.redactNames,
  });
  // A quote card sets its attribution under the quote ("IT SAID · AUG 7, 2026")
  // and the tag row under that. Both carried the date, so the export printed
  // the same date twice, four lines apart, which reads as a rendering fault
  // rather than a design. The attribution wins it; the tag row keeps the rest.
  //
  // Only on a quote card, and this is the whole of the condition: `attrib` is
  // computed for anything with a quote in it, but only the `quote` composition
  // PLACES it — an on-this-day card puts its quote in the pull block and never
  // draws an attribution. Keying this off the string rather than the kind took
  // the date off on-this-day and gave it to nothing.
  const attrib = quoteText ? attribLine(s, red) : '';
  const meta = metaBits(s, red, kind === 'quote' && attrib ? { noDate: true } : null);

  // One number per card. The feed can afford to show "3h 4m" in the stat lockup
  // and again in the title underneath, because the two are styled a world apart
  // and separated by whitespace the card does not have. Set one above the other
  // on a poster they read as a rendering fault. app.js's `shareCopy` already
  // made this call for the old export; this is the same rule, kept in step.
  if (kind === 'stat' && stat && headline && headline.indexOf(stat.value) >= 0) {
    headline = body;
    body = '';
  }

  /* frame, footer, rule ------------------------------------------------ */
  const frame = {
    x: sc(C.pad), y: sc(C.padTop),
    w: W - sc(C.pad) * 2, h: H - sc(C.padTop) - sc(C.padBottom),
  };
  const colFrac = C.copyCol[kind] || 1;
  const colW = wide && colFrac < 1
    ? Math.round((frame.w - sc(C.gutter)) * colFrac)
    : frame.w;
  const colX = frame.x;
  const subjectX = colX + colW + sc(C.gutter);
  const subjectW = Math.max(0, frame.x + frame.w - subjectX);

  const footerH = sc(C.footer.height);
  const footer = { x: colX, y: frame.y + frame.h - footerH, w: colW, h: footerH };
  let markSize = s.hasMark === false ? 0 : sc(C.footer.mark);
  // The wordmark and the command are the two things that are always on the
  // card, so they are fitted rather than trusted: a narrow copy column (the
  // wide chart card gives it half the frame) would otherwise run them together
  // or push `npx codepend` off the edge. The mark is dropped first, then both
  // labels shrink together, and only then do they touch.
  let footSize = sc(C.footer.size);
  const gapMin = sc(16);
  const wmAt = (z) => measure(WORDMARK, { size: z, weight: 700 });
  const ctaAt = (z) => measure(CTA, { size: z, weight: 600, tracking: 0.02 });
  const lead = () => (markSize ? markSize + sc(12) : 0);
  if (lead() + wmAt(footSize) + gapMin + ctaAt(footSize) > colW) markSize = 0;
  for (let i = 0; i < 120 && footSize > sc(C.footer.size) * 0.6; i++) {
    if (lead() + wmAt(footSize) + gapMin + ctaAt(footSize) <= colW) break;
    footSize *= 0.96;
  }
  footer.mark = markSize
    ? { x: footer.x, y: footer.y + (footerH - markSize) / 2, w: markSize, h: markSize }
    : null;
  const wmX = footer.x + lead();
  const wmW = wmAt(footSize);
  const ctaW = ctaAt(footSize);
  const footBase = footer.y + footerH * 0.5 + footSize * 0.36;
  footer.wordmark = { x: wmX, y: footer.y, w: wmW, h: footerH, size: footSize, weight: 700, text: WORDMARK, baseline: footBase };
  footer.cta = {
    x: Math.max(wmX + wmW + gapMin, footer.x + footer.w - ctaW),
    y: footer.y, w: ctaW, h: footerH, size: footSize, weight: 600,
    tracking: 0.02, text: CTA, baseline: footBase,
  };

  let y = footer.y - sc(C.footer.gapAbove);
  const rule = { x: colX, y: Math.round(y) - 1, w: colW, h: 1 };
  y = rule.y - sc(C.rule.gapAbove);

  const metaSize = sc(C.meta.size);
  const metaBlock = meta
    ? textBlock(colX, colW, [ellipsize(meta, { size: metaSize, weight: 600, tracking: C.meta.tracking }, colW, measure)],
      metaSize, metaSize * 1.2, { weight: 600, face: 'display', tracking: C.meta.tracking })
    : textBlock(colX, colW, [], metaSize, 0, {});
  if (metaBlock.h) { metaBlock.y = y - metaBlock.h; y = metaBlock.y - sc(C.meta.gapAbove); }

  /* the ceiling: the eyebrow is pinned to the top of the column --------- */
  const eyeSize = sc(C.eyebrow.size);
  const eyeH = eyebrow ? eyeSize * 1.12 : 0;
  let eyeFit = eyeSize;
  if (eyebrow) {
    eyeFit = fitSize(eyebrow, { weight: 600, tracking: C.eyebrow.tracking }, colW, measure, eyeSize, eyeSize * 0.72);
  }
  const eyeBlock = {
    x: colX, y: frame.y, w: colW, h: eyeH,
    lines: eyebrow ? [ellipsize(eyebrow, { size: eyeFit, weight: 600, tracking: C.eyebrow.tracking }, colW, measure)] : [],
    size: eyeFit, lineHeight: eyeH, weight: 600, face: 'display', tracking: C.eyebrow.tracking,
  };
  const ceiling = frame.y + (eyeH ? eyeH + sc(C.eyebrow.gapBelow) : 0);

  /* the subject claims its space FIRST --------------------------------- */
  const hasChart = !!chart;
  let chartBox = null;
  let subject = null;

  if (wide && colFrac < 1 && subjectW > 40) {
    subject = { x: subjectX, y: frame.y, w: subjectW, h: rule.y - frame.y, type: 'art' };
    if (hasChart && (kind === 'chart' || kind === 'stat')) {
      subject.type = 'chart';
      chartBox = insetBox(subject, chartInset(chart.type));
    }
  } else if (!wide && kind === 'chart' && hasChart) {
    // The chart is the subject: it takes its share off the top of the column
    // and the copy lives in what is left. The other way round — copy first,
    // chart in the remainder — is how a 34-word headline squeezes a clock into
    // a 90px strip, which is the bug this file exists to fix.
    const want = Math.min(C.chartShare * H, y - ceiling - sc(60));
    const h = Math.max(0, want);
    if (h > H * 0.14) {
      subject = { x: colX, y: ceiling, w: colW, h, type: 'chart' };
      chartBox = insetBox(subject, chartInset(chart.type));
    }
  }

  /* the copy stack, bottom-up, capped by the room it actually has ------- */
  const stackTop = subject && subject.type === 'chart' && !wide
    ? subject.y + subject.h + sc(C.headline.gapAbove)
    : ceiling;
  let room = Math.max(0, y - stackTop);
  const takeRoom = (h, gap) => { room = Math.max(0, room - h - gap); };

  const emptyAt = (x, w) => textBlock(x, w, [], 0, 0, {});
  let bodyBlock = emptyAt(colX, colW);
  let attribBlock = emptyAt(colX, colW);
  let quoteBlock = emptyAt(colX, colW);
  let headBlock = emptyAt(colX, colW);
  let tagBlock = emptyAt(colX, colW);
  let pullBlock = emptyAt(colX, colW);
  let statBlock = null;

  /* stat kind, tall: the chart band sits under the copy, as it does in the
     feed, where `.card--stat .figure` is the last thing in the card. */
  if (!wide && kind === 'stat' && hasChart) {
    const bandH = Math.min(C.chartBand * H, room * 0.34);
    if (bandH > H * 0.08) {
      subject = { x: colX, y: y - bandH, w: colW, h: bandH, type: 'chart' };
      chartBox = insetBox(subject, chartInset(chart.type));
      y = subject.y - sc(C.body.gapAbove);
      takeRoom(bandH, sc(C.body.gapAbove));
    }
  }

  const place = (block, gapAbove) => {
    if (!block.h) return;
    block.y = y - block.h;
    y = block.y - gapAbove;
    takeRoom(block.h, gapAbove);
  };

  /**
   * Fit a block into at most `share` of the room that is left, and refuse to
   * place it at all when one line of it would not fit.
   *
   * This is the invariant the whole stack rests on: every block's box is capped
   * by `room`, and `fitBlock` never returns more height than its box, so the
   * stack can never grow past `stackTop` and collide with the subject above it.
   * Letting a block fall back to its minimum size regardless of the room left is
   * how a long headline ends up printed across the middle of a chart.
   */
  const fitted = (text, share, cfg, o) => {
    const boxH = Math.min(room, room * share);
    if (!text || boxH < sc(cfg.minSize) * cfg.leading) return emptyAt(colX, colW);
    const fit = fitBlock(text, { w: colW, h: boxH }, measure, Object.assign({
      maxSize: sc(cfg.maxSize), minSize: sc(cfg.minSize),
      maxLines: cfg.maxLines, leading: cfg.leading,
    }, o || {}));
    return textBlock(colX, colW, fit.lines, fit.size, fit.lineHeight,
      Object.assign({ clipped: fit.clipped, textW: fit.width }, o || {}));
  };

  /** One tracked line — the attribution and the tag row. Placed only if it fits. */
  const oneLine = (text, size, tracking) => {
    const h = size * 1.2;
    if (!text || room < h) return emptyAt(colX, colW);
    return textBlock(colX, colW,
      [ellipsize(text, { size, weight: 600, tracking }, colW, measure)],
      size, h, { weight: 600, face: 'display', tracking });
  };

  // 1 — body. Always the first thing off the bottom, and the first thing
  //     shortened when the frame is tight: it is the footnote, not the claim.
  if (body) {
    const bs = sc(C.body.size);
    const lh = bs * C.body.leading;
    const cap = Math.max(0, Math.min(C.body.maxLines, Math.floor((room * 0.42) / lh)));
    const lines = cap ? wrapLines(body, { size: bs, weight: 400 }, colW, cap, measure) : [];
    bodyBlock = textBlock(colX, colW, lines, bs, lh, { weight: 400, face: 'display' });
    place(bodyBlock, sc(C.body.gapAbove));
  }

  if (kind === 'quote') {
    // 2 — attribution, then the quote takes almost everything above it. Almost:
    //     0.82 leaves a band of clean art over the quote, which is the "room to
    //     breathe" and is also what gives the y-scrim a window to open in.
    attribBlock = oneLine(attrib, sc(C.attrib.size), C.attrib.tracking);
    place(attribBlock, sc(C.attrib.gapAbove));
    quoteBlock = fitted(quoteText ? `«${quoteText}»` : '', 0.82, C.quote,
      { face: 'serif', weight: 400, italic: true });
    place(quoteBlock, sc(C.quote.gapAbove));
  } else {
    // 2 — a pulled quote, if this memory has one (on-this-day usually does).
    if (kind !== 'stat') {
      pullBlock = fitted(quoteText ? `«${quoteText}»` : '', 0.42, C.pull,
        { face: 'serif', weight: 400, italic: true });
      place(pullBlock, sc(C.pull.gapAbove));
    }
    // 3 — tagline, the line under the title on on-this-day cards.
    if (kind === 'onthisday' || kind === 'award') {
      tagBlock = fitted(tagline, 0.34, C.tagline, { face: 'display', weight: 400 });
      place(tagBlock, sc(C.tagline.gapAbove));
    }
    // 4 — the headline. On a chart card it is the caption to the subject; on a
    //     stat card it explains the number; on on-this-day it IS the card.
    const share = kind === 'stat' ? 0.5 : kind === 'chart' ? 0.9 : 0.8;
    headBlock = fitted(headline, share, C.headline,
      { face: 'display', weight: 700, tracking: C.headline.tracking });
    place(headBlock, sc(C.headline.gapAbove));

    // 5 — the number, last placed and therefore topmost: on a stat card it is
    //     the subject and it gets whatever the frame has left.
    if (kind === 'stat' && stat && room > sc(C.stat.minSize) * 1.06) {
      statBlock = layoutStat(stat, colX, colW, room, C, sc, measure);
      if (statBlock.h) { statBlock.y = y - statBlock.h; y = statBlock.y - sc(C.stat.gapAbove); takeRoom(statBlock.h, sc(C.stat.gapAbove)); }
      else statBlock = null;
    }
  }

  /* the chart grows into whatever the copy did not need ----------------- */
  if (subject && subject.type === 'chart' && !wide && kind === 'chart') {
    // Reserving the chart's share BEFORE the copy is what stops a long headline
    // from squeezing it; expanding it AFTER is what stops a short one from
    // leaving a dead band across the middle of the card. "SuperAgent took 57% of
    // everything" is two lines, and the first draft of this file left 300px of
    // flat scrim between the donut and the words.
    const grown = clampNum(y - subject.y, subject.h, H * 0.62);
    if (grown > subject.h + 1) {
      subject.h = grown;
      chartBox = insetBox(subject, chartInset(chart.type));
    }
  }

  /* whatever is left between the eyebrow and the copy is art ------------ */
  if (!subject) {
    const gap = y - ceiling;
    subject = { x: colX, y: ceiling, w: colW, h: Math.max(0, gap), type: 'art' };
  }

  /* the scrim, sized to the ink it has to carry ------------------------- */
  const worst = worstArtColor(pal, theme);
  const ink = weakestInk([T.ink, T.muted, T.quiet], T.scrim, worst);
  // A chart card dims the art the way the feed's `.card--chart` does; every
  // other kind keeps a window of clean art where nothing is written.
  const mode = kind === 'chart' ? 'flat' : (wide && colFrac < 1 ? 'x' : 'y');
  const inkTop = Math.min(
    headBlock.h ? headBlock.y : Infinity,
    quoteBlock.h ? quoteBlock.y : Infinity,
    tagBlock.h ? tagBlock.y : Infinity,
    pullBlock.h ? pullBlock.y : Infinity,
    bodyBlock.h ? bodyBlock.y : Infinity,
    attribBlock.h ? attribBlock.y : Infinity,
    statBlock && statBlock.h ? statBlock.y : Infinity,
    metaBlock.h ? metaBlock.y : Infinity,
    rule.y,
  );
  const scrim = scrimPlan({
    mode, ink, scrimColor: T.scrim, worstArt: worst,
    capTo: (frame.y + eyeH + sc(10)) / H,
    holdFrom: (inkTop - H * 0.02) / H,
    holdTo: (colX + colW + sc(C.gutter) * 0.5) / W,
  });

  /* the chart panel: extra ground, only where the page scrim is thin ---- */
  let panel = null;
  if (subject && subject.type === 'chart' && chartBox) {
    // The panel hugs what the chart will actually occupy, not the box it was
    // offered — see `chartAspect`. Padding is proportional so a heat strip gets
    // a band and a clock gets a disc, both with the same visual margin.
    //
    // Measured off `subject` rather than `chartBox` on purpose: `chartBox` is
    // already inset for the labels that hang outside the geometry (the clock's
    // hour marks, the donut's on-arc names), and the panel has to contain those
    // too. Undoing the inset here is what guarantees it.
    const drawn = fitAspect(subject, chartAspect(chart));
    const padX = Math.max(sc(20), drawn.w * 0.09);
    const padY = Math.max(sc(20), drawn.h * 0.09);
    const rect = {
      x: drawn.x - padX, y: drawn.y - padY,
      w: drawn.w + padX * 2, h: drawn.h + padY * 2,
    };
    rect.x = Math.max(0, rect.x); rect.y = Math.max(0, rect.y);
    rect.w = Math.min(W - rect.x, rect.w); rect.h = Math.min(H - rect.y, rect.h);
    const page = groundOf(scrim, rect, W, H);
    const need = alphaToReach(page, scrim.alpha);
    panel = need > 0.02
      ? Object.assign(rect, { alpha: clampNum(Math.max(need, 0.34), 0, 0.97), radius: sc(22) })
      : null;
  }

  /* every block declares its ink and the ground it is guaranteed -------- */
  const chartGround = panel
    ? combineAlpha(groundOf(scrim, panel, W, H), panel.alpha)
    : (subject && subject.type === 'chart' ? groundOf(scrim, subject, W, H) : 0);
  const chartInkGround = blendOver(worst, T.scrim, chartGround);

  const INK_OF = {
    eyebrow: T.ink, headline: T.ink, tagline: T.muted, body: T.muted,
    quote: T.ink, pull: T.ink, attrib: T.quiet, stat: T.ink, statLabel: T.quiet,
    meta: T.quiet, wordmark: T.ink, cta: T.quiet, chart: T.quiet,
  };

  const blocks = [];
  const push = (name, b, inkOverride) => {
    if (!b || !b.h) return;
    const g = groundOf(scrim, b, W, H);
    blocks.push(Object.assign({ block: name, ink: inkOverride || INK_OF[name] || T.ink, ground: g }, pick(b)));
  };
  push('eyebrow', eyeBlock);
  push('headline', headBlock);
  push('tagline', tagBlock);
  push('quote', quoteBlock);
  push('pull', pullBlock);
  push('attrib', attribBlock);
  push('body', bodyBlock);
  if (statBlock && statBlock.h) {
    push('stat', { x: statBlock.x, y: statBlock.y, w: statBlock.w, h: statBlock.valueSize * 1.1 });
    if (statBlock.label) {
      push('statLabel', { x: statBlock.x, y: statBlock.labelY, w: statBlock.w, h: statBlock.labelSize * 1.2 });
    }
  }
  push('meta', metaBlock);
  push('wordmark', footer.wordmark);
  push('cta', footer.cta);
  if (subject && subject.type === 'chart') {
    blocks.push(Object.assign({ block: 'chart', ink: INK_OF.chart, ground: chartGround }, pick(subject)));
  }

  // The stat's unit rides the palette accent when the accent is legible on this
  // seed's ground, and muted ink when it is not. Measured, not assumed.
  if (statBlock) {
    const g = blendOver(worst, T.scrim, groundOf(scrim, { x: statBlock.x, y: statBlock.y, w: statBlock.w, h: statBlock.h }, W, H));
    statBlock.unitInk = pickInk([pal.accents[0], pal.accents[2], pal.accents[1]], g, T.muted);
  }

  return {
    preset: key, kind, width: W, height: H, scale: S, theme,
    delegate: kind === 'award' ? 'archetype-card' : null,
    frame,
    column: { x: colX, y: frame.y, w: colW, h: frame.h },
    subject,
    chart, chartBox, panel,
    ink: {
      primary: T.ink, muted: T.muted, quiet: T.quiet, rule: T.rule,
      inv: T.inv, accent: pal.accents[0], paper: pal.bg || T.paper, scrim: T.scrim,
      chartGround: chartInkGround,
    },
    palette: pal,
    seed: (s.seed || 0) >>> 0,
    eyebrow: eyeBlock,
    headline: headBlock,
    tagline: tagBlock,
    quote: quoteBlock,
    pull: pullBlock,
    attrib: attribBlock,
    body: bodyBlock,
    stat: statBlock,
    meta: metaBlock,
    rule, footer,
    scrim, worstArt: worst, weakestInk: ink,
    blocks,
  };
}

function insetBox(box, f) {
  if (f >= 1) return { x: box.x, y: box.y, w: box.w, h: box.h };
  const w = box.w * f;
  const h = box.h * f;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

/**
 * The number, its unit and its label. Values are short by construction ("3h 4m",
 * "57%", "18 902"); anything long enough to wrap is not a number, so the value
 * shrinks to fit rather than breaking.
 */
function layoutStat(st, x, w, room, C, sc, measure) {
  const labelSize = sc(C.stat.label);
  const floor = sc(C.stat.minSize) * 1.06;
  // The number is the subject. If the frame is so tight that keeping the label
  // would push the value under its floor, the label goes — a 52px "3h 4m" over
  // "LONGEST SITTING" is a caption; a 30px one is a footnote.
  let labelH = st.label ? labelSize * 1.2 + sc(C.stat.labelGap) : 0;
  if (room - labelH < floor) labelH = 0;
  const ceil = Math.max(floor, room - labelH);
  let size = Math.min(sc(C.stat.maxSize), ceil / 1.06);
  const unitW = (sz) => (st.unit ? measure(st.unit, { size: sz * C.stat.unit, weight: 600 }) + sz * 0.18 : 0);
  for (let i = 0; i < 200 && size > sc(C.stat.minSize); i++) {
    if (measure(st.value, { size, weight: 800 }) + unitW(size) <= w) break;
    size *= 0.94;
  }
  size = Math.max(sc(C.stat.minSize), size);
  const valueW = measure(st.value, { size, weight: 800 });
  const h = size * 1.06 + labelH;
  const label = labelH && st.label
    ? ellipsize(st.label, { size: labelSize, weight: 600, tracking: C.stat.tracking }, w, measure)
    : '';
  return {
    x, y: 0, w, h,
    value: st.value, valueSize: size, valueW,
    unit: st.unit, unitSize: size * C.stat.unit, unitX: x + valueW + size * 0.1,
    label, labelSize, labelTracking: C.stat.tracking,
    labelOffset: size * 1.06 + sc(C.stat.labelGap),
    get labelY() { return this.y + this.labelOffset; },
    get baseline() { return this.y + this.valueSize * ASCENT; },
    get labelBaseline() { return this.y + this.labelOffset + this.labelSize * ASCENT; },
  };
}

/** Values and labels go through the same gate the sentences do. */
function normalizeStat(st, red) {
  if (!st || st.value == null) return null;
  const value = safeText(String(st.value), red);
  if (!value || value.length > 14) return null;
  return {
    value,
    unit: safeText(st.unit == null ? '' : String(st.unit), red).slice(0, 8),
    label: safeText(st.label == null ? '' : String(st.label), red).toUpperCase().slice(0, 30),
  };
}

/**
 * The tag row from the foot of the feed card — project, agent, date — which is
 * also the line `hideProject` most obviously has to reach.
 *
 * `opts.noDate` drops the date for a card that already carries one in its quote
 * attribution. The row is never empty because of it: project and agent stay, and
 * a row that ends up with nothing simply is not drawn.
 */
function metaBits(s, red, opts) {
  const bits = [];
  if (s.project && !s.hideProject) {
    const p = safeText(s.project, { maxLen: 28 });
    if (p) bits.push(p);
  }
  if (s.agent) {
    const a = safeText(s.agent, red);
    if (a && a !== 'both') bits.push(a);
  }
  if (!(opts && opts.noDate)) {
    const d = dateText(s);
    if (d) bits.push(d);
  }
  return bits.join(' · ').toUpperCase();
}

function attribLine(s, red) {
  const q = s.quote || {};
  const who = q.who === 'agent' || q.who === 'it said' ? 'it said' : 'you said';
  const bits = [who];
  const d = dateText(s);
  if (d) bits.push(d);
  if (q.project && !s.hideProject) {
    const p = safeText(q.project, { maxLen: 28 });
    if (p) bits.push(p);
  }
  return bits.join(' · ').toUpperCase();
}

/**
 * `dateText` is preferred and is what a deterministic caller passes. Falling
 * back to Intl here is a convenience for the browser; the tests never take that
 * path, because ICU data differs between Node builds and a golden layout that
 * depends on it is a flake waiting to happen.
 */
function dateText(s) {
  if (s.dateText) return safeText(s.dateText, { maxLen: 28 });
  if (typeof s.date !== 'number' || !isFinite(s.date)) return '';
  try {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      .format(new Date(s.date));
  } catch (e) { return ''; }
}

/** `codepend-peak-day-tall.png` */
export function shareFilename(spec, preset) {
  const s = spec || {};
  const base = s.id || s.type || s.headline || s.kind || 'memory';
  const slug = String(base).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'memory';
  const p = SHARE_PRESETS[preset] ? preset : DEFAULT_PRESET;
  return `codepend-${slug}-${p}.png`;
}

/* ── drawing ──────────────────────────────────────────────────────────── */

/**
 * Paint the card.
 *
 * @param {CanvasRenderingContext2D} ctx sized to the preset already; any device
 *   pixel ratio must be applied as a transform by the caller — this function
 *   never touches the transform.
 * @param {object} spec see `shareLayout`
 * @param {string} preset 'wide' | 'tall'
 * @param {{artImage?:function, palette?:function, grainPattern?:function,
 *          markImage?:function, fonts?:object, paintChart?:function}} deps
 *
 *   `deps.paintChart(ctx, chart, box, opts)` is video.js's chart machinery,
 *   exposed for this card. `chart` is a normalised chart, `box` the rectangle it
 *   may use, and `opts` carries `{progress, accents, fields, seed, panel}` —
 *   `progress: 1` because a still is the end of the animation, and `panel:false`
 *   because this file has already computed and painted the ground the chart
 *   needs. If the dependency is missing the box is simply left empty: a card
 *   without its chart is a regression, but a card that throws is a dead button.
 *
 * @returns {Promise<object>} the layout that was painted
 */
export async function drawShareCard(ctx, spec, preset, deps) {
  const d = deps || {};
  const fonts = Object.assign({}, FONTS, d.fonts || {});
  const s = spec || {};
  const seed = (s.seed || 0) >>> 0;
  const theme = s.theme === 'light' ? 'light' : 'dark';

  let pal = null;
  try { if (typeof d.palette === 'function') pal = d.palette(seed, theme); } catch (e) { /* art is decoration */ }
  if (!pal || !Array.isArray(pal.accents) || pal.accents.length < 3) pal = FALLBACK_PALETTE;

  // The layout is pure, so it cannot normalise a chart itself. A caller that
  // already holds normalised charts (app.js caches them per memory) passes them
  // straight through; one holding a raw detector payload passes the normaliser
  // and gets the same card rather than a silently chartless one.
  let chart = s.chart;
  if (chart && !chartHasData(chart) && typeof d.normalizeChart === 'function') {
    try { chart = d.normalizeChart(chart); } catch (e) { chart = s.chart; }
  }

  const measure = makeMeasurer(ctx, fonts);
  const L = shareLayout(Object.assign({}, s, {
    chart, palette: pal, measure, theme, hasMark: typeof d.markImage === 'function',
  }), preset || s.preset);
  const { width: W, height: H } = L;

  ctx.save();

  /* 1 — ground */
  ctx.fillStyle = pal.bg || L.ink.paper;
  ctx.fillRect(0, 0, W, H);

  /* 2 — the art, full bleed, cover-fit. Same seed, same kind, same picture the
         feed card is wearing. */
  if (typeof d.artImage === 'function') {
    let img = null;
    try { img = await d.artImage(seed, L.kind, W, H); } catch (e) { img = null; }
    if (img) {
      const ar = (img.width || W) / (img.height || H);
      let dw = W;
      let dh = H;
      if (ar > W / H) { dh = H; dw = H * ar; } else { dw = W; dh = W / ar; }
      ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
    }
  }

  /* 3 — the computed scrim, along the axis the composition asked for */
  const [sr, sg, sb] = parseColor(L.ink.scrim);
  const rgba = (a) => `rgba(${sr},${sg},${sb},${round3(a)})`;
  if (L.scrim.mode === 'flat') {
    ctx.fillStyle = rgba(L.scrim.alpha);
  } else {
    const horiz = L.scrim.mode === 'x';
    const grad = ctx.createLinearGradient(0, 0, horiz ? W : 0, horiz ? 0 : H);
    for (const [p, a] of L.scrim.stops) grad.addColorStop(clampNum(p, 0, 1), rgba(a));
    ctx.fillStyle = grad;
  }
  ctx.fillRect(0, 0, W, H);

  /* 4 — the chart's own ground, where the page scrim alone is not enough */
  if (L.panel) {
    ctx.fillStyle = rgba(L.panel.alpha);
    roundRect(ctx, L.panel.x, L.panel.y, L.panel.w, L.panel.h, L.panel.radius);
    ctx.fill();
  }

  /* 5 — THE CHART. The whole reason this file replaced drawShare(). */
  if (L.chart && L.chartBox && typeof d.paintChart === 'function') {
    try {
      ctx.save();
      d.paintChart(ctx, L.chart, L.chartBox, {
        // A still is the end of the animation. This is the only thing that
        // separates the card from a frame of the clip.
        progress: 1,
        palette: pal.accents,
        // Not video.js's default ink: its `ink2` is the page's own `--ink-2`,
        // #827D75, which measures 3.59–4.58:1 on real pixels — under the bar
        // this file promises. The chart's axis and series labels are painted in
        // it, so the card hands over the ink the scrim was actually solved for.
        ink: {
          display: fonts.display,
          ink0: L.ink.primary, ink1: L.ink.muted, ink2: L.ink.quiet,
          inkInv: L.ink.inv, rule: L.ink.rule, scrim: `${sr},${sg},${sb}`,
        },
        labels: s.chartLabels == null ? true : s.chartLabels,
        // The ground is already down: `L.panel` is computed against the page
        // scrim and the seed's worst art, and letting video.js lay a second one
        // would double the alpha the contrast maths was solved for.
        panel: 0,
      });
    } catch (e) { /* a missing chart is a worse card, not a dead button */ } finally {
      ctx.restore();
      ctx.globalAlpha = 1;
    }
  }

  /* 6 — type */
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  if (L.eyebrow.h) {
    ctx.fillStyle = L.ink.primary;
    ctx.globalAlpha = 0.72;
    setFont(ctx, fonts, { size: L.eyebrow.size, weight: 600 });
    drawTracked(ctx, L.eyebrow.lines[0], L.eyebrow.x, baselinesOf(L.eyebrow)[0], L.eyebrow.tracking * L.eyebrow.size);
    ctx.globalAlpha = 1;
  }

  if (L.stat && L.stat.h) {
    ctx.fillStyle = L.ink.primary;
    setFont(ctx, fonts, { size: L.stat.valueSize, weight: 800 });
    ctx.fillText(L.stat.value, L.stat.x, L.stat.baseline);
    if (L.stat.unit) {
      ctx.fillStyle = L.stat.unitInk || L.ink.muted;
      setFont(ctx, fonts, { size: L.stat.unitSize, weight: 600 });
      ctx.fillText(L.stat.unit, L.stat.unitX, L.stat.baseline);
    }
    if (L.stat.label) {
      ctx.fillStyle = L.ink.quiet;
      setFont(ctx, fonts, { size: L.stat.labelSize, weight: 600 });
      drawTracked(ctx, L.stat.label, L.stat.x, L.stat.labelBaseline, L.stat.labelTracking * L.stat.labelSize);
    }
  }

  drawLines(ctx, fonts, L.quote, L.ink.primary, 0.94);
  drawLines(ctx, fonts, L.headline, L.ink.primary, 1);
  drawLines(ctx, fonts, L.tagline, L.ink.muted, 1);
  drawLines(ctx, fonts, L.pull, L.ink.primary, 0.9);
  drawLines(ctx, fonts, L.body, L.ink.muted, 1);

  if (L.attrib.h) {
    ctx.fillStyle = L.ink.quiet;
    setFont(ctx, fonts, { size: L.attrib.size, weight: 600 });
    drawTracked(ctx, L.attrib.lines[0], L.attrib.x, baselinesOf(L.attrib)[0], L.attrib.tracking * L.attrib.size);
  }
  if (L.meta.h) {
    ctx.fillStyle = L.ink.quiet;
    setFont(ctx, fonts, { size: L.meta.size, weight: 600 });
    drawTracked(ctx, L.meta.lines[0], L.meta.x, baselinesOf(L.meta)[0], L.meta.tracking * L.meta.size);
  }

  /* 7 — signature. Always present, on every kind, in both frames. */
  ctx.fillStyle = L.ink.rule;
  ctx.fillRect(L.rule.x, L.rule.y, L.rule.w, L.rule.h);

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

  /* 8 — the same grain the page wears */
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

function drawLines(ctx, fonts, block, fill, alpha) {
  if (!block || !block.h || !block.lines.length) return;
  ctx.fillStyle = fill;
  ctx.globalAlpha = alpha == null ? 1 : alpha;
  setFont(ctx, fonts, {
    size: block.size, weight: block.weight || 400,
    face: block.face, italic: block.italic,
  });
  const bl = baselinesOf(block);
  const track = (block.tracking || 0) * block.size;
  block.lines.forEach((line, i) => drawTracked(ctx, line, block.x, bl[i], track));
  ctx.globalAlpha = 1;
}

function setFont(ctx, fonts, o) {
  ctx.font = fontString(o, o.size, fonts);
}

/**
 * Tracked text. Canvas letter-spacing is recent; where it is missing we walk the
 * string and advance by hand, which is exact rather than the old trick of
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

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  if (typeof ctx.arcTo === 'function') {
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
  } else {
    ctx.rect(x, y, w, h);
  }
  ctx.closePath();
}

const round3 = (n) => Math.round(n * 1000) / 1000;

export default drawShareCard;
