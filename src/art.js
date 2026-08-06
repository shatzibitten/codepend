/**
 * codepend — generative cover art.
 *
 * Every memory card gets a "photograph" it never had: a deterministic SVG synthesized from the
 * memory's own uint32 seed. Six families, one per memory kind, each a different way for light to
 * behave in the dark (docs/DESIGN.md §2).
 *
 * Hard rules this module lives by:
 *   - Pure ESM. No Node APIs, no DOM APIs, no `Math.random`, no `Date`. It runs at build time in
 *     Node and again in the browser when the theme flips, and both must agree byte-for-byte.
 *   - Every emitted number goes through a rounding formatter. `Math.sin`/`cos`/`pow` are not
 *     bit-identical across JS engines, so we never let their low bits reach the output: coordinates
 *     round to whole canvas units (~1/1000 of the width), which is ~12 orders of magnitude coarser
 *     than any cross-engine ULP drift.
 *   - Anything that makes a *topological* decision (marching-squares case selection, ring counts,
 *     point rejection) is computed with +,-,*,/ and Math.sqrt only — all exactly specified by
 *     IEEE-754 — so a transcendental's last bit can never flip a branch. That is why `contour`
 *     uses rational bumps instead of Gaussians and why `orbit` grows radii by repeated
 *     multiplication instead of `Math.pow`.
 *   - The bottom-left of the frame is where the headline goes. The safe zone is enforced in the
 *     geometry (§2.2 taper + a bottom-left calm factor), not just by the scrim on top of it.
 */

/* ────────────────────────────── math + rng ────────────────────────────── */

const TAU = Math.PI * 2;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;

/** Hermite smoothstep, clamped. */
const ss = (a, b, t) => {
  const x = clamp((t - a) / (b - a), 0, 1);
  return x * x * (3 - 2 * x);
};

/**
 * mulberry32. `Math.imul` is spec-exact and division by 2^32 is exact, so this is one of the very
 * few PRNGs that is genuinely bit-identical across engines.
 * @param {number} seed uint32
 * @returns {() => number} uniform in [0,1)
 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (r, arr) => arr[Math.floor(r() * arr.length) % arr.length];
/** Uniform in [a,b). */
const between = (r, a, b) => a + (b - a) * r();
/** Integer in [a,b] inclusive. */
const int = (r, a, b) => a + Math.floor(r() * (b - a + 1));

/* ────────────────────────────── formatting ────────────────────────────── */

/** 2-dp formatter for non-coordinate numbers. Kills cross-engine ULP drift. */
const n = (v) => {
  const x = Math.round(v * 100) / 100;
  return Object.is(x, -0) ? '0' : String(x);
};

/** Opacity: 2 dp, leading zero stripped (`.62`). Saves ~1 byte × a few thousand attributes. */
const op = (v) => {
  const x = Math.round(clamp(v, 0, 1) * 100) / 100;
  if (x >= 1) return '1';
  if (x <= 0) return '0';
  return String(x).replace('0.', '.');
};

/** Coordinate formatter, precision chosen by canvas size. See `ctx.prec`. */
const fixed = (v, prec) => {
  if (prec === 0) {
    const x = Math.round(v);
    return Object.is(x, -0) ? '0' : String(x);
  }
  const p = Math.pow(10, prec);
  const x = Math.round(v * p) / p;
  return Object.is(x, -0) ? '0' : String(x);
};

/* ──────────────────────────── OKLCH → sRGB ──────────────────────────── */

/** OKLCH → linear sRGB. Björn Ottosson's matrices. */
function oklchToLinear(L, C, H) {
  const h = (H * Math.PI) / 180;
  // Quantize a/b right after the only trig call so nothing downstream compounds engine drift.
  const a = Math.round(C * Math.cos(h) * 1e12) / 1e12;
  const b = Math.round(C * Math.sin(h) * 1e12) / 1e12;
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const encode = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const decode = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const inGamut = (v) => v.every((c) => c >= -1e-4 && c <= 1 + 1e-4);

/**
 * OKLCH → `#rrggbb`, chroma-reduced into the sRGB gamut by a fixed-depth bisection.
 * Depth is pinned at 18 (not "until converged") so the result is bit-identical everywhere.
 * @param {number} L 0..1
 * @param {number} C 0..~0.37
 * @param {number} H degrees
 * @returns {string} hex
 */
export function oklch(L, C, H) {
  let lo = 0;
  let hi = C;
  if (inGamut(oklchToLinear(L, C, H))) lo = C;
  else {
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinear(L, mid, H))) lo = mid;
      else hi = mid;
    }
  }
  const v = oklchToLinear(L, lo, H).map((c) => Math.round(clamp(encode(c), 0, 1) * 255));
  return '#' + v.map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** `#rrggbb` → [r,g,b] 0..1 gamma-encoded. */
function hexRgb(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

/** WCAG 2.1 relative luminance of a hex color. */
function luminance(hex) {
  const [r, g, b] = hexRgb(hex).map(decode);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** sRGB hex → OKLab {L,C,H}. Used by the guardrail tests, not by rendering. */
function oklabOf(hex) {
  const [r, g, b] = hexRgb(hex).map(decode);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.sqrt(A * A + B * B), H: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
}

/* ────────────────────────────── palette ────────────────────────────── */

/**
 * Curated hue anchors. Free hue selection walks into the olive/khaki dead zone around OKLCH
 * H ≈ 85–135 at mid lightness (`oklch(0.72 0.14 100)` → a muddy `#b9a624`), so we never sample
 * hue continuously — we snap to these and jitter ±5°.
 */
const ANCHORS = [16, 34, 52, 68, 148, 168, 190, 212, 236, 258, 280, 302, 326, 348];
const HUE_NAMES = [
  'ember', 'amber', 'gold', 'brass', 'jade', 'emerald', 'teal',
  'cyan', 'sky', 'indigo', 'violet', 'orchid', 'magenta', 'rose',
];

/**
 * Chroma damping for the ground, by hue. (Replaces the old `mudGuard`, which only defended the
 * 60°–150° khaki band.)
 *
 * The olive band was never the whole problem. At `bgL ≈ 0.15` there is not enough luminance to
 * carry *any* hue as a colour: a warm anchor at that lightness comes out as brown, which the eye
 * reads as a stain on the paper rather than as depth. Reviewing rendered cards, the amber/gold/
 * brass anchors were as muddy as the olives.
 *
 * The exception is the cool quadrant. Deep blue-indigo at low lightness is what a night sky
 * actually looks like, so those hues keep their chroma; everything else is pulled most of the way
 * to a neutral. The hue still shows — it just shows in the *glow* and the accents, which sit at a
 * lightness that can hold it, instead of in the darkest region.
 */
function groundGuard(H) {
  const h = ((H % 360) + 360) % 360;
  let d = Math.abs(h - 250); // 250° — the one hue a dark ground can carry honestly
  if (d > 180) d = 360 - d;
  return 0.32 + 0.68 * (1 - ss(40, 150, d));
}

const SCHEMES = {
  analogous: [0, 22, -18],
  split: [0, 156, 204],
  duo: [0, 180, 12],
  triadNarrow: [0, 96, -96],
};

/**
 * Full palette record — hues, OKLCH coordinates and derived hex. Families need the OKLCH
 * coordinates (dune steps lightness between layers, spectra shifts hue per band), so the exported
 * `palette()` is a thin projection of this.
 */
function paletteFull(seed, theme) {
  const s = seed >>> 0;
  const r = rng(s ^ 0x9e3779b9); // decorrelate from the geometry rng
  const H0 = ANCHORS[s % ANCHORS.length] + (r() * 10 - 5);
  const scheme = pick(r, ['analogous', 'split', 'duo', 'triadNarrow']);
  const d = SCHEMES[scheme];
  const H = d.map((x) => (H0 + x + 360) % 360);

  const dark = theme !== 'light';
  // Light mode darkens the accents rather than re-picking them: a memory keeps its identity
  // across themes. The tint (index 2) sits at 0.62 rather than DESIGN's 0.66 so that it still
  // clears the ΔL ≥ 0.34 floor against the 0.965 paper.
  const L = dark ? [0.74, 0.63, 0.82] : [0.54, 0.44, 0.62];
  const C = [0.135, 0.16, 0.085].map((c) => c * (0.86 + r() * 0.28)); // ceiling 0.1824 < 0.185

  // Dark ground dropped 0.16 → 0.15. Two reasons: it buys ~0.01 of ΔL against every accent (the
  // whole family of cards was reading under-contrasted at thumbnail size), and a deeper base makes
  // the vignette at the frame edge land somewhere believable instead of on top of the tint.
  const bgL = dark ? 0.15 : 0.965;
  // …and the tint's chroma dropped 0.035 → 0.030 before the guard, because the ground is no longer
  // the thing carrying the hue — `bgRect`'s focal glow is, at a lightness that can hold it.
  const bgC = (dark ? 0.03 : 0.012) * groundGuard(H0);

  const accents = [oklch(L[0], C[0], H[0]), oklch(L[1], C[1], H[1]), oklch(L[2], C[2], H[2])];

  // Angular distance from the primary hue, per accent.
  const gap = (i) => {
    let d = Math.abs(H[i] - H[0]) % 360;
    if (d > 180) d = 360 - d;
    return d;
  };
  // A second ink that may share a frame with `accents[0]` without the card reading as two
  // photographs stitched together. `analogous` and `duo` both put a hue neighbour within 40°, and
  // that neighbour is a gift — it gives a composition a second voice for nothing. `split` and
  // `triadNarrow` do not: their secondaries sit 96°–204° away, which is how a magenta card ended up
  // with a teal focal core and a green ring. When the scheme offers no neighbour, the companion
  // falls back to a *dimmer tone of the primary* and the picture stays monochrome, which is the
  // version that always works.
  const ci = gap(1) <= 40 ? 1 : gap(2) <= 40 ? 2 : -1;

  return {
    dark,
    scheme,
    H0,
    H,
    L,
    C,
    bgL,
    bgC,
    hueName: HUE_NAMES[s % ANCHORS.length],
    bg: oklch(bgL, bgC, H0),
    fg: dark ? '#F4F1EC' : '#12100D',
    accents,
    /** The brightest point of light this palette can make while staying on its own hue. */
    hot: oklch(dark ? 0.9 : 0.58, C[0] * 0.45, H[0]),
    /** See `ci` above: a hue neighbour when the scheme has one, a dim primary tone when it does not. */
    companion: ci >= 0 ? accents[ci] : oklch(dark ? 0.6 : 0.46, C[0] * 0.6, H[0]),
    /** A tone on this palette's own axis — used for layer/band ramps. */
    tone(l, c, hueIndex = 0) {
      return oklch(clamp(l, 0, 1), Math.max(0, c), this.H[hueIndex]);
    },
  };
}

/**
 * Seeded palette for a memory.
 * @param {number} seed uint32
 * @param {'dark'|'light'} [theme='dark']
 * @returns {{bg:string, fg:string, accents:string[]}}
 */
export function palette(seed, theme = 'dark') {
  const p = paletteFull(seed, theme);
  return { bg: p.bg, fg: p.fg, accents: p.accents };
}

/* ────────────────────────── family assignment ────────────────────────── */

const FAMILY = {
  onthisday: 'drift',
  stat: 'orbit',
  quote: 'constellation',
  chart: 'contour',
  award: 'spectra',
  profile: 'dune',
};
const ALT = {
  drift: 'dune',
  orbit: 'spectra',
  constellation: 'drift',
  contour: 'orbit',
  spectra: 'constellation',
  dune: 'contour',
};

/**
 * Which art family renders a given memory kind. A deterministic 1-in-8 swap keeps a 40-card feed
 * from looking templated.
 * @param {string} kind
 * @param {number} seed uint32
 * @returns {string} family slug
 */
export function familyFor(kind, seed) {
  const f = FAMILY[kind] || 'dune';
  return (seed >>> 29) === 7 ? ALT[f] : f;
}

export const FAMILIES = ['drift', 'orbit', 'constellation', 'contour', 'spectra', 'dune'];

/* ──────────────────────── composition safe zones ──────────────────────── */
/*
 * Unit box [0,1]², y down.
 *   crown 0    → 0.10  eyebrow
 *   stage 0.10 → 0.56  the focal mass
 *   fade  0.56 → 0.70  taper
 *   floor 0.70 → 1.00  headline + body. Low frequency only.
 */

/** Amplitude/opacity multiplier that empties the floor zone. */
const taper = (y) => 1 - ss(0.54, 0.72, y);
/** The crown holds the eyebrow — keep magnitude low but not zero, or the top reads as a bald band. */
const crownK = (y) => 0.4 + 0.6 * ss(0, 0.11, y);
/**
 * The headline hangs bottom-left. Beyond the floor taper, we drain detail out of the lower-left
 * ~60% through the fade band, so the calm region is a property of the geometry rather than a
 * promise the scrim has to keep on its own.
 */
const calmBL = (x, y) => 1 - 0.55 * ss(0.5, 0.74, y) * (1 - ss(0.44, 0.74, x));
/** Composite safe-zone weight for a point. */
const zone = (x, y) => taper(y) * crownK(y) * calmBL(x, y);

/* ────────────────────────────── path builders ────────────────────────── */

/**
 * Quadratic smoothing through a polyline: on-curve at the midpoints, control at the data points.
 * Chosen over Catmull-Rom cubics for two reasons — it cannot overshoot (no cusps on tight turns),
 * and it costs 2 coordinate pairs per point instead of 3.
 */
function smooth(ctx, pts) {
  if (pts.length < 3) return poly(ctx, pts);
  const { X, Y } = ctx;
  let d = `M${X(pts[0][0])} ${Y(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    d += `Q${X(pts[i][0])} ${Y(pts[i][1])} ${X(mx)} ${Y(my)}`;
  }
  const last = pts[pts.length - 1];
  d += `L${X(last[0])} ${Y(last[1])}`;
  return d;
}

function poly(ctx, pts) {
  const { X, Y } = ctx;
  if (!pts.length) return '';
  let d = `M${X(pts[0][0])} ${Y(pts[0][1])}`;
  for (let i = 1; i < pts.length; i++) d += `L${X(pts[i][0])} ${Y(pts[i][1])}`;
  return d;
}

/**
 * A centreline with a half-width per sample, emitted as a *filled outline* rather than a stroke.
 *
 * This is the one technique that most reliably stops drawn geometry from reading as a primitive.
 * A stroked arc has the same width everywhere and terminates in a cap; the cap is a little flat
 * (or round) full-width stub hanging in mid-air, and the eye reads it instantly as "a shape
 * function stopped here". An outline whose width swells through the belly and goes to zero at both
 * ends reads as a brushstroke, or as the lit edge of something — it has a direction and a source.
 *
 * Cost is the reason this is not used everywhere: an outline is 2 points per sample where a stroke
 * is 1, so it roughly doubles the path data. It is spent on the marks that are wide enough for the
 * variation to be visible, and hairlines stay stroked (below ~5 canvas units the outer and inner
 * offsets round onto the same integer coordinate anyway, which would emit a zero-area path).
 *
 * Normals come from the neighbour difference, which is exact arithmetic — no transcendental makes
 * a branch here, and every emitted number goes through `ctx.F`.
 *
 * `from`/`to` emit only part of the centreline while the normals are still computed over *all* of
 * it. That distinction is not cosmetic. `orbit` cuts each ring at the ring-plane horizon so the far
 * half can be drawn behind the body, and those two cuts land at the ring's extreme left and right —
 * out in the open, not hidden. Deriving the boundary point's normal from a one-sided difference
 * inside each run gave the two runs slightly different normals at the *same* point, and every
 * split ring grew a visible step at 9 and 3 o'clock. Shared normals make the halves meet exactly.
 *
 * @param {object} ctx
 * @param {number[][]} pts centreline in canvas px
 * @param {number[]} hw half-width in canvas px, one per point
 * `nrm` overrides the tangent-derived normals. `contour` supplies the height field's own gradient
 * direction, which is both the true normal of an isoline and — unlike a tangent difference —
 * independent of which way the polyline happens to have been walked. That matters for a closed
 * loop: derived normals disagree between the first and last point of the same coordinate and leave
 * a nick in every ring.
 *
 * @param {number} [from=0] first index to emit
 * @param {number} [to=pts.length] one past the last index to emit
 * @param {number[][]} [nrm] unit normals in canvas space, one per point
 * @returns {string} a closed `d` subpath
 */
function ribbon(ctx, pts, hw, from, to, nrm) {
  const m = pts.length;
  const a0 = from || 0;
  const a1 = to === undefined ? m : to;
  if (m < 2 || a1 - a0 < 2) return '';
  const nx = new Array(m);
  const ny = new Array(m);
  for (let i = 0; i < m; i++) {
    if (nrm) {
      nx[i] = nrm[i][0];
      ny[i] = nrm[i][1];
      continue;
    }
    const a = pts[i > 0 ? i - 1 : 0];
    const b = pts[i < m - 1 ? i + 1 : m - 1];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const L = Math.sqrt(dx * dx + dy * dy);
    if (L < 1e-9) {
      nx[i] = 0;
      ny[i] = 0;
    } else {
      nx[i] = -dy / L;
      ny[i] = dx / L;
    }
  }
  const { F } = ctx;
  let d = '';
  for (let i = a0; i < a1; i++) {
    d += `${i === a0 ? 'M' : 'L'}${F(pts[i][0] + nx[i] * hw[i])} ${F(
      pts[i][1] + ny[i] * hw[i],
    )}`;
  }
  for (let i = a1 - 1; i >= a0; i--) {
    d += `L${F(pts[i][0] - nx[i] * hw[i])} ${F(pts[i][1] - ny[i] * hw[i])}`;
  }
  return d + 'Z';
}

/**
 * Width profile along a mark, in [0,1]. Zero at both ends, one somewhere in the middle.
 *
 * `skew` slides the belly off centre — a perfectly symmetric lens is still a shape function, just
 * a subtler one. `swell` adds a single low-frequency ripple so the edge is not a clean conic.
 * Both are seeded per mark; both are gentle on purpose (this is a taper, not a doodle).
 */
function widthProfile(t, skew, ends, swell, swellF, swellP) {
  // Monotone warp of t: pushes the widest point toward one end without folding the parameter.
  const tw = clamp(t + skew * t * (1 - t), 0, 1);
  const s = Math.sin(Math.PI * tw);
  // Blend sin and sin² — `ends` near 0 gives long, needle-fine tips; near 1 a fuller lens.
  const base = s * (ends + (1 - ends) * s);
  return clamp(base * (1 + swell * Math.sin(TAU * (tw * swellF + swellP))), 0, 1.35);
}

/* ──────────────────────────────── families ──────────────────────────── */

/**
 * ① drift — flow-field ribbons · `onthisday`
 * Long ribbons of light bent by an invisible field. Reads as time passing.
 */
function drift(ctx) {
  const { r, P, U } = ctx;
  const N = 6 + (ctx.seed % 4);

  // Three seeded sine terms stand in for a curl field. Normalizing by ΣA pins the angular swing
  // at exactly ±SWING radians regardless of the amplitudes drawn, which is what keeps ribbons
  // sweeping instead of knotting.
  const k = [between(r, 1.6, 4.2), between(r, 1.6, 4.2), between(r, 1.6, 4.2)];
  const ph = [r() * TAU, r() * TAU, r() * TAU];
  const A = [between(r, 0.5, 1.4), between(r, 0.5, 1.4), between(r, 0.5, 1.4)];
  const sumA = A[0] + A[1] + A[2];
  const base = between(r, -0.3, 0.3);
  const SWING = 0.86;
  const field = (x, y) =>
    base +
    (SWING *
      (A[0] * Math.sin(k[0] * x + ph[0]) +
        A[1] * Math.sin(k[1] * y + ph[1]) +
        A[2] * Math.sin(k[2] * (x + y) + ph[2]))) /
      sumA;

  const H = 0.028;
  // 64 steps × 0.028 = 1.79 units of arc, which is enough for a ribbon launched at x = −0.3 to
  // cross the frame and leave by the far edge. At 42 the integration simply ran out of budget in
  // mid-frame and left a round cap hanging there — the "arcs end badly" complaint, and it was a
  // loop bound, not a design decision. Costs nothing in bytes: the path is resampled to ~15
  // control points either way.
  const STEPS = 64;

  const ribbons = [];
  for (let i = 0; i < N; i++) {
    let pts = null;
    // Stratify the launch points across the stage instead of sampling them independently: with a
    // shared field, independent starts collapse into one bundle and the card reads as a scratch.
    const lane = 0.1 + (0.5 * i) / N;
    // Stubby ribbons read as mistakes, not as composition. Resample until one earns its place.
    for (let attempt = 0; attempt < 8 && !pts; attempt++) {
      // Launch off the left edge, not just inside it. A ribbon that begins at x ≈ 0.05 shows the
      // viewer its round cap sitting in mid-air a few pixels into the frame, which reads as a
      // truncation; one that begins at x = −0.25 has already been travelling when we meet it.
      let x = between(r, -0.32, -0.02);
      let y = lane + between(r, -0.04, 0.08);
      const path = [[x, y]];
      for (let s = 0; s < STEPS; s++) {
        const th = field(x, y);
        let vx = Math.cos(th);
        let vy = Math.sin(th);
        // Bend the flow back toward horizontal near the stage edges. Without this a steep field
        // walks the ribbon off the top or into the floor within a dozen steps and leaves a stub in
        // the corner — the single ugliest failure this family had.
        // Damped, not clamped: a hard stop makes every ribbon flatten onto the same invisible
        // shelf and the card grows a horizon it never asked for.
        vy *= vy > 0 ? 1 - 0.86 * ss(0.44, 0.66, y) : 1 - 0.9 * ss(0.18, 0.04, y);
        const len = Math.sqrt(vx * vx + vy * vy) || 1;
        x += (H * vx) / len;
        y += (H * vy) / len;
        // Let a ribbon leave through the top edge rather than stopping short of it. crownK already
        // dims whatever passes through the eyebrow band, and an exit is always better than a stop.
        if (y > 0.7 || y < -0.06 || x > 1.2 || x < -0.36) break;
        path.push([x, y]);
      }
      let minX = 1e9;
      let maxX = -1e9;
      for (const p of path) {
        if (p[0] < minX) minX = p[0];
        if (p[0] > maxX) maxX = p[0];
      }
      // Crossing 45% of the frame, not 25%: below that a ribbon is a mark rather than a movement.
      if (path.length >= 14 && maxX - minX >= 0.45) pts = path;
    }
    if (!pts) continue;
    // Sample down to ~12 control points. Each one now costs four emitted coordinates rather than
    // one (an outline has an outer and an inner side, and both are walked), so the resample that
    // was free under `<use>` of a stroked path is the family's whole byte budget under outlines.
    // At 1000 units wide, 12 segments across a flow line keeps the chord error under a device
    // pixel at every size this renders at.
    const step = Math.max(1, Math.round(pts.length / 12));
    const s = [];
    for (let j = 0; j < pts.length; j += step) s.push(pts[j]);
    if (s[s.length - 1] !== pts[pts.length - 1]) s.push(pts[pts.length - 1]);

    let zy = 0;
    let my = 0;
    for (const p of s) {
      zy += zone(p[0], p[1]);
      my += p[1];
    }
    ribbons.push({ pts: s, z: zy / s.length, my: my / s.length, j: between(r, 0.8, 1.25) });
  }

  // Back-to-front by mean y: higher ribbons sit further away, get blurred and dimmed.
  ribbons.sort((a, b) => a.my - b.my);
  const backCount = Math.max(1, Math.round(ribbons.length * 0.4));

  const backUses = [];
  const frontUses = [];
  ribbons.forEach((rb, i) => {
    const t = ribbons.length > 1 ? i / (ribbons.length - 1) : 1;
    // Weight now *follows* depth instead of being an independent random. Far ribbons are broad and
    // soft — that is what a blurred, distant band of light looks like — and near ribbons are
    // narrower, brighter and crisp. Randomising the two independently is what flattened the stack
    // into a set of equal wires.
    const w = lerp(38, 11, t) * rb.j * U;
    const o = clamp(lerp(0.26, 0.92, t) * rb.z, 0.05, 0.94);
    const target = i < backCount ? backUses : frontUses;

    /**
     * Ribbons are outlines now, not `<use>` of a stroked path.
     *
     * The old economy was real — one `<path>` definition served both the body and its highlight —
     * but it bought the one thing this family could not afford: both marks were the same width from
     * the moment they entered the frame to the moment they left it. A band of light does not have
     * a constant section. It swells where it turns toward you and it thins away to nothing; that
     * variation is the whole difference between a ribbon and a piece of wire.
     *
     * The `smooth()` quadratic is dropped with it — the outline is built from the same resampled
     * control points as straight segments, which at ~15 points across a 1000-unit canvas is under a
     * device pixel of chord error and costs a third less than emitting curves twice.
     */
    const px = rb.pts.map((p) => [p[0] * ctx.W, p[1] * ctx.H]);
    const m = px.length;
    const skew = between(r, -0.45, 0.45);
    const ends = between(r, 0.3, 0.62);
    const swell = between(r, 0.06, 0.2);
    const swellF = between(r, 0.7, 1.7);
    const swellP = r();
    const prof = [];
    for (let j = 0; j < m; j++) {
      prof.push(widthProfile(j / (m - 1), skew, ends, swell, swellF, swellP));
    }
    // The taper reaches zero at the ends, and a ribbon that leaves through the frame edge should
    // not be tapering as it goes: the visible result is a band that mysteriously narrows at the
    // margin. `hold` lifts the floor so a ribbon crossing an edge still has body when it gets there.
    const hold = 0.5;
    const bodyHw = prof.map((v) => 0.5 * w * (hold + (1 - hold) * v));

    // One gradient per ribbon, running along its own length: light that arrives from somewhere
    // rather than ink of one value laid down evenly. Far ribbons start further toward the ground
    // colour at both ends — optical falloff, not just a lower alpha.
    const k = (1 - t) * 0.4;
    const rl = lerp(P.L[0], P.bgL + (P.dark ? 0.3 : -0.3), k);
    const rc = lerp(P.C[0], Math.max(P.bgC * 1.8, P.C[0] * 0.5), k);
    const gid = `dg${ctx.id}_${i}`;
    ctx.defs.push(
      `<linearGradient id="${gid}" gradientUnits="userSpaceOnUse" x1="${ctx.F(
        px[0][0],
      )}" y1="${ctx.F(px[0][1])}" x2="${ctx.F(px[m - 1][0])}" y2="${ctx.F(
        px[m - 1][1],
      )}"><stop stop-color="${P.tone(clamp(rl - 0.05, 0, 1), rc * 0.8, 0)}"/><stop offset="${n(
        between(r, 0.4, 0.66),
      )}" stop-color="${P.tone(clamp(rl + 0.07, 0, 1), rc, 0)}"/><stop offset="1" stop-color="${P.tone(
        clamp(rl - 0.08, 0, 1),
        rc * 0.72,
        0,
      )}"/></linearGradient>`,
    );
    target.push(
      `<path d="${ribbon(ctx, px, bodyHw)}" fill="url(#${gid})" opacity="${ctx.op(
        ctx.lite && i < backCount ? o * 0.55 : o,
      )}"/>`,
    );

    // The specular core. This is the only place a second hue is allowed in — as a thin highlight
    // riding a ribbon, never as the mass of one. A full-width stroke in the complementary accent
    // put a green band across a magenta card and it read as two photographs, not one.
    //
    // It rides *off centre*, pushed a quarter of the band's width toward one edge. A highlight down
    // the middle of a band is a racing stripe; a highlight up against one edge is the light catching
    // a curved surface, and it is the same one line of arithmetic either way.
    const coreW = w * lerp(0.2, 0.34, t);
    const off = between(r, -0.34, 0.34);
    //
    // Sampled at every second control point. The highlight is a fraction of the band's width, so
    // half the resolution is invisible on it and it is the cheapest 25% this family gives back.
    const corePts = [];
    const coreHw = [];
    for (let j = 0; j < m; j += 2) {
      const a = px[j > 0 ? j - 1 : 0];
      const b = px[j < m - 1 ? j + 1 : m - 1];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const L = Math.sqrt(dx * dx + dy * dy) || 1;
      corePts.push([px[j][0] + (-dy / L) * off * bodyHw[j], px[j][1] + (dx / L) * off * bodyHw[j]]);
      // Sharper ends than the body: a highlight dies before the surface carrying it does.
      coreHw.push(0.5 * coreW * (0.18 + 0.82 * prof[j]));
    }
    target.push(
      `<path d="${ribbon(ctx, corePts, coreHw)}" fill="${
        i % 3 === 1 ? P.companion : P.hot
      }" opacity="${ctx.op(o * lerp(0.4, 0.85, t))}"/>`,
    );
  });

  const back = backUses.length
    ? ctx.lite
      ? `<g>${backUses.join('')}</g>`
      : `<g filter="url(#bl${ctx.id})">${backUses.join('')}</g>`
    : '';
  return `${ctx.bgRect('radial', 0.42, 0.3)}<g>${back}${frontUses.join('')}</g>`;
}

/**
 * ② orbit — a ringed body · `stat`
 * Rings around something with mass. Reads as a single number with weight.
 *
 * The previous version drew N stroked ellipses and a flat dot. Every stroke was the same width
 * from end to end, every ring lay in the same plane as every other, and nothing ever passed behind
 * anything — so however good the arc rhythm got, the card still read as *circles*. Four changes,
 * in descending order of how much they buy:
 *
 *   1. **Occlusion.** The rings are split at the ring-plane horizon: the far half is drawn, then
 *      the body, then the near half. A ring that vanishes behind the body and re-emerges below it
 *      is three-dimensional space for free — no mask, no filter, one extra path on the rings that
 *      actually cross the body. This is the single change that stopped it reading as clip-art.
 *   2. **Variable width.** The wide rings are emitted as filled outlines (see `ribbon`) whose width
 *      swells through the belly and goes to nothing at both ends. Round caps were the loudest tell
 *      left in the frame: an arc that *stops* is a shape function, an arc that *thins away* is a
 *      band of lit dust. Hairlines stay stroked — below ~5 canvas units the two offsets round onto
 *      the same coordinate and there is nothing to see anyway.
 *   3. **A light model on the body.** One offset radial gradient turns the flat dot into a sphere
 *      with a terminator, and a tapered rim arc on the shadow limb lifts it off the ground. The
 *      same gradient (objectBoundingBox units, so it costs one definition) lights the moons from
 *      the same direction, which is what makes them read as part of the same photograph.
 *   4. **Optical falloff and wobble.** Far rings lose chroma *toward the ground colour* as well as
 *      contrast, so distance reads as atmosphere rather than as a lowered alpha; and every ring
 *      radius carries two slow seeded sine terms, so the curve is drawn rather than computed.
 */
function orbit(ctx) {
  const { r, P, U } = ctx;
  // Nudged right of centre: the headline hangs bottom-left, so the focal mass leans the other way.
  const cx = 0.55 + (r() - 0.5) * 0.14;
  const cy = 0.34 + (r() - 0.5) * 0.12;
  const N = int(r, 3, 6);
  const e = between(r, 0.55, 0.95);
  const ecc = Math.sqrt(1 - e * e); // ry/rx
  /**
   * Tilt, bounded so the ring plane never stands up.
   *
   * The old range let the outermost ring reach ±140°, which swings the ellipse's *long* axis to
   * vertical. In a 4:5 frame with a calm floor the vertical budget is a little over half the
   * horizontal one, so the fit then shrank the whole system to a narrow sliver: the worst seeds in
   * the grid were all the same failure, a tall thin scratch in an empty card, and no amount of
   * lighting rescues a composition that small. `dRho` is derived rather than drawn independently
   * so the *outer* ring lands inside the bound however many rings there are — with a steep base
   * tilt the rings precess less, which is the trade that keeps every seed on the stage.
   */
  const rho0 = between(r, -40, 40);
  const dRho = between(r, -1, 1) * ((48 - Math.abs(rho0)) / Math.max(1, N - 1));
  // The ring that owns the frame. Kept off the innermost slot most of the time — a heavy innermost
  // ring just reads as a thick halo on the body, whereas a heavy middle ring reads as a system.
  const hero = N > 2 ? int(r, 1, N - 1) : int(r, 0, N - 1);
  const spanFar = Math.max(hero, N - 1 - hero) || 1;

  // One light direction for the whole card. Every gradient — the rings', the body's, the moons' —
  // is oriented off this, which is the difference between a lit photograph and a set of coloured
  // shapes that happen to share a palette.
  const lightA = r() * TAU;
  const lx = Math.cos(lightA);
  const ly = Math.sin(lightA);

  // Radii grow ×1.34 per ring, by repeated multiplication rather than Math.pow so ring geometry
  // is exactly reproducible.
  const growth = [];
  let g = 1;
  for (let i = 0; i < N; i++) {
    growth.push(g);
    g *= 1.34;
  }
  const gMax = growth[N - 1];

  // Fit the whole system between the crown and the top of the fade band: nothing from this family
  // is ever allowed into the floor zone, so `taper` never has to rescue it.
  let r0 = between(r, 0.1, 0.16);
  // Rotation happens in canvas space, so the vertical reach of a rotated ellipse mixes the
  // horizontal semi-axis (measured in width units) with the vertical one — convert before fitting.
  const yExtUnits = (rad, rot) => {
    const s = Math.sin((rot * Math.PI) / 180);
    const c = Math.cos((rot * Math.PI) / 180);
    const rxPx = rad * 1.15 * ctx.W;
    const ryPx = rad * ecc * ctx.H;
    return Math.sqrt(rxPx * rxPx * s * s + ryPx * ryPx * c * c) / ctx.H;
  };
  const xExtUnits = (rad, rot) => {
    const s = Math.sin((rot * Math.PI) / 180);
    const c = Math.cos((rot * Math.PI) / 180);
    const rxPx = rad * 1.15 * ctx.W;
    const ryPx = rad * ecc * ctx.H;
    return Math.sqrt(rxPx * rxPx * c * c + ryPx * ryPx * s * s) / ctx.W;
  };
  const rotMax = rho0 + dRho * (N - 1);
  // Fit *and* fill. Scaling only when the system overflows leaves flat, high-eccentricity seeds
  // as a small smudge in the middle of an empty frame; normalising both ways makes every seed
  // occupy the stage with the same confidence.
  const budgetY = Math.min(cy - 0.05, 0.62 - cy);
  const budgetX = Math.min(cx, 1 - cx) * 0.88;
  const scale = Math.min(
    budgetY / yExtUnits(r0 * gMax, rotMax),
    budgetX / xExtUnits(r0 * gMax, rotMax),
  );
  // …but do not fill it *every* time. Normalising hard to the budget made every seed the same
  // size, and the biggest of them swept the outer ring right through the lower-left calm zone.
  // A seeded fill fraction gives the feed some cards that are intimate and some that are grand.
  // The ceiling came down from 0.95 to 0.9 because the rings now have real width and the outline
  // sits half a stroke outside the centreline the fit was computed on.
  const fillK = between(r, 0.72, 0.94);
  r0 *= scale * fillK;
  // How much of the frame the system ended up occupying. Stroke weight rides this: 18 units on a
  // ring of radius 400 is a confident line, and the same 18 units on a radius of 90 is a doughnut.
  const swK = clamp(r0 * gMax * 3.4, 0.72, 1.05);

  const CX = cx * ctx.W;
  const CY = cy * ctx.H;

  /**
   * The body's radius, as a fraction of the innermost ring's semi-major axis.
   *
   * Two ceilings, and the smaller wins.
   *
   * The first is against the *innermost ring* and is what makes the occlusion happen: at 0.72 the
   * inner ring is deeply wrapped around the body, at 0.4 it clears it and only the body's own glow
   * touches it. The second is against the *whole system*, and it is there because sizing on the
   * inner ring alone is a trap: a three-ring seed has a big r0 (the fit spreads three rings over
   * the same stage six would fill), so the same fraction produced a body that filled the card — a
   * gumball with a hoop, in which the rings stopped being the subject. Held to a fifth of the
   * outer radius, the body is a focal point in a system rather than the system itself.
   */
  const bR = r0 * 1.15 * ctx.W * Math.min(between(r, 0.42, 0.74), gMax * between(r, 0.2, 0.3));

  const back = [];
  const front = [];

  for (let i = 0; i < N; i++) {
    const rad = r0 * growth[i];
    const RX = rad * 1.15 * ctx.W;
    const RY = rad * ecc * ctx.H;
    const rot = ((rho0 + dRho * i) * Math.PI) / 180;
    const cr = Math.cos(rot);
    const sr = Math.sin(rot);
    // Depth is measured from the hero ring, not from the centre outward, so weight falls away in
    // both directions and the composition has a near, a middle and a far.
    const u = 1 - Math.abs(i - hero) / spanFar;
    const u2 = u * u;

    // Peak width. ~4 → 24 canvas units, a 6:1 spread where the old one was 4.4:1 — with a taper
    // doing the work at the ends, the hero can be a band rather than a thick wire. The falloff is
    // squared, not cubed: cubed put every ring but the hero under 5 units, and the card stopped
    // being a *system* and became a single hoop. The hairlines are the context that makes the
    // hero mean something.
    const sw = (1.55 + 7.5 * u2 * swK) * U * 2.6;
    const o = clamp((0.42 + 0.52 * u2) * zone(cx, cy + rad * ecc), 0.28, 0.96);

    // Three registers, not one range. The hero runs nearly closed; the others are either a long
    // sweep or a short tick. That is what makes a gap read as rhythm rather than as damage.
    const span =
      i === hero
        ? between(r, 0.82, 0.96)
        : r() < 0.42
          ? between(r, 0.1, 0.24)
          : between(r, 0.4, 0.7);
    // Openings walk around the system on a golden-ratio sequence: any fixed offset lines every gap
    // up on the same side and the rings read as one bitten-out crescent.
    const a0 = TAU * ((i * 0.618 + 0.21 + r() * 0.12) % 1);
    const a1 = a0 + span * TAU;

    // Two slow terms on the radius. Amplitude is deliberately tiny — at 2% of the radius this is
    // not a wobble you can name, it is only the reason the curve stops looking machined.
    const wA = between(r, 0.008, 0.026);
    const wB = between(r, 0.005, 0.018);
    const wPa = r() * TAU;
    const wPb = r() * TAU;

    // Sample count follows arc length: a 10% tick needs a dozen points, a nearly-closed hero needs
    // enough that the chord sagitta stays under a device pixel at feed size.
    const K = Math.max(12, Math.min(44, Math.round(span * 42) + 10));
    const skew = between(r, -0.5, 0.5);
    const ends = between(r, 0.18, 0.5);
    const swell = between(r, 0.08, 0.24);
    const swellF = between(r, 0.8, 1.9);
    const swellP = r();

    const pts = [];
    const hw = [];
    const bk = [];
    for (let j = 0; j < K; j++) {
      const t = j / (K - 1);
      const th = a0 + (a1 - a0) * t;
      const wob = 1 + wA * Math.sin(2 * th + wPa) + wB * Math.sin(3 * th + wPb);
      const ax = RX * wob * Math.cos(th);
      const ay = RY * wob * Math.sin(th);
      pts.push([CX + ax * cr - ay * sr, CY + ax * sr + ay * cr]);
      hw.push(0.5 * sw * widthProfile(t, skew, ends, swell, swellF, swellP));
      // Depth side, decided in ring-local space so it is independent of the screen rotation. The
      // test is on the *angle*, not on sin(θ): θ comes from +,−,× on seeded values and Math.PI, so
      // the comparison is exact everywhere, where a sign test on a transcendental near zero is the
      // kind of thing that redraws a card on a different engine.
      const ph = ((th % TAU) + TAU) % TAU;
      bk.push(ph >= Math.PI);
    }

    // Falloff. Distance takes lightness *toward the ground* and drains chroma with it, so a far
    // ring reads as atmosphere between us and it rather than as the same ink at a lower alpha.
    //
    // Capped at 0.62 rather than run to 1. Taken all the way, the outermost ring landed on
    // L ≈ 0.41 at chroma 0.05 — a grey wire, optically absent at feed size and, worse, off the
    // card's hue. Aerial perspective is a *shift* toward the ground, not an arrival at it; the
    // chroma floor keeps every ring recognisably this memory's colour.
    const k = 0.62 * (1 - u) * (0.45 + 0.55 * (1 - u));
    const rl = lerp(P.L[0], P.bgL + (P.dark ? 0.3 : -0.3), k);
    const rc = lerp(P.C[0], Math.max(P.bgC * 1.8, P.C[0] * 0.45), k);
    const gid = `og${ctx.id}_${i}`;
    // A hairline of flat colour is inert; the same hairline with the light coming from one side has
    // somewhere to be brighter. Direction is the card's, not the ring's.
    //
    // `P.hot` was the obvious light-side stop and is wrong here: at L 0.9 / C 0.06 it is nearly
    // white, and since the lit half is most of what you see of a ring, the whole band came out
    // grey and the card lost the hue it had just been given. The light stop is a *brighter tone of
    // the ring's own colour*; nothing in this family whitens.
    const reach = Math.max(RX, RY);
    ctx.defs.push(
      `<linearGradient id="${gid}" gradientUnits="userSpaceOnUse" x1="${ctx.F(
        CX + lx * reach,
      )}" y1="${ctx.F(CY + ly * reach)}" x2="${ctx.F(CX - lx * reach)}" y2="${ctx.F(
        CY - ly * reach,
      )}"><stop stop-color="${P.tone(
        clamp(rl + (i === hero ? 0.11 : 0.07), 0, 1),
        rc * 0.98,
        0,
      )}"/><stop offset="1" stop-color="${P.tone(
        clamp(rl - 0.16, 0, 1),
        rc * 0.66,
        0,
      )}"/></linearGradient>`,
    );

    // Every ring is split at the horizon, not only the ones that cross the body.
    //
    // Splitting the crossers is what buys the occlusion. Splitting the rest buys something else and
    // nearly as valuable: the far half of the ring is seen *through* the body's atmosphere, because
    // the glow is painted between the two halves. On a face-on seed no ring ever passes behind
    // anything — there is nothing to occlude — and without this those cards fell straight back to
    // reading flat. It costs one extra path per ring and no new definitions.
    // Wide marks earn an outline; hairlines stay stroked. Below ~5 units the outer and inner
    // offsets round onto the same integer coordinate and the outline would be a zero-area path.
    const solid = sw >= 5 * U;
    // Two `d` accumulators, not two lists of elements. An arc long enough to cross both horizons
    // comes back as three runs — near, far, near — and giving each its own <path> is how this
    // family went from 18 nodes to the 26-node cap in one change. Runs on the same side share a
    // fill and an opacity, so they are subpaths of one element and cost only their coordinates.
    const dd = ['', ''];
    const add = (side, from, to) => {
      if (to - from < 2) return;
      dd[side] += solid
        ? ribbon(ctx, pts, hw, from, to)
        : poly(
            ctx,
            pts.slice(from, to).map((p) => [p[0] / ctx.W, p[1] / ctx.H]),
          );
    };

    // Runs of constant side, with a one-sample overlap so the two halves meet along a shared edge
    // instead of leaving a hairline of ground showing through the join.
    let s = 0;
    for (let j = 1; j <= K; j++) {
      if (j === K || bk[j] !== bk[s]) {
        add(bk[s] ? 1 : 0, s, Math.min(K, j + 1));
        s = j;
      }
    }
    for (const side of [0, 1]) {
      if (!dd[side]) continue;
      (side ? back : front).push(
        solid
          ? `<path d="${dd[side]}" fill="url(#${gid})" opacity="${ctx.op(o)}"/>`
          : `<path d="${dd[side]}" fill="none" stroke="url(#${gid})" stroke-width="${n(
              sw,
            )}" opacity="${ctx.op(o)}"/>`,
      );
    }
  }

  const hid = ctx.halo();

  /**
   * The lit-body gradient. objectBoundingBox units, so this one definition serves the body and
   * every moon at whatever size each of them is — and lights them all from the same side, which is
   * the whole point. The offset centre *is* the terminator: a plain concentric radial is a glow,
   * an offset one is a sphere.
   *
   * The shadow stop sits a little above the ground lightness rather than at it. A body that goes
   * all the way down to the background is a hole punched in the card; a body that bottoms out just
   * above it is a sphere in ambient light, which is what a ringed planet in a dark frame is.
   *
   * The body is *mostly in shadow* on purpose. The first pass put `P.hot` at offset 0 with the
   * accent right behind it, and the result was a glossy render-ball — technically three-dimensional
   * and every bit as primitive as the flat dot it replaced, just in a different genre. A crescent
   * of lit colour on a dark mass is both more photographic and less literal, and it lets the rings
   * stay the subject of the card instead of orbiting a headlight.
   */
  const bid = `bd${ctx.id}`;
  const shadow = P.tone(clamp(P.bgL + (P.dark ? 0.05 : -0.14), 0, 1), P.bgC * 2.2, 0);
  ctx.defs.push(
    `<radialGradient id="${bid}" cx="${n(0.5 + 0.34 * lx)}" cy="${n(
      0.5 + 0.34 * ly,
    )}" r=".62"><stop stop-color="${P.tone(clamp(P.L[0] + 0.1, 0, 1), P.C[0] * 0.9, 0)}"/><stop offset=".46" stop-color="${P.tone(
      clamp(P.L[0] - 0.26, 0, 1),
      P.C[0] * 0.8,
      0,
    )}"/><stop offset="1" stop-color="${shadow}"/></radialGradient>`,
  );

  // The rim. A tapered arc hugging the *shadow* limb, in the palette's brightest tone: light that
  // has come round the back of the body. It is what separates a silhouette from the ground, and
  // it is the cheapest three-dimensionality in the file — one path, no filter.
  const rimA = lightA + Math.PI;
  const rimSpan = between(r, 1.9, 2.7);
  const rimK = Math.max(10, Math.round(rimSpan * 7));
  const rp = [];
  const rh = [];
  const rimW = clamp(bR * between(r, 0.05, 0.085), 1.6 * U, 11 * U);
  const rimSkew = between(r, -0.4, 0.4);
  for (let j = 0; j < rimK; j++) {
    const t = j / (rimK - 1);
    const th = rimA - rimSpan / 2 + rimSpan * t;
    rp.push([CX + bR * 0.985 * Math.cos(th), CY + bR * 0.985 * Math.sin(th)]);
    rh.push(rimW * widthProfile(t, rimSkew, 0.3, 0, 1, 0));
  }
  const rim = `<path d="${ribbon(ctx, rp, rh)}" fill="${P.tone(
    P.dark ? 0.88 : 0.58,
    P.C[0] * 0.62,
    0,
  )}" opacity="${ctx.op(between(r, 0.4, 0.62))}"/>`;

  /**
   * Limb darkening. One concentric overlay, transparent across the middle and shading to the body's
   * own shadow tone at the edge.
   *
   * Without it the body is a Lambert sphere — which is to say a *different* primitive, a shader
   * preview rather than a circle, and at card size it reads as a gumball. Real bodies lose light at
   * the limb faster than the cosine falloff predicts, and adding that back is what turns the shape
   * from "sphere" into "thing with an atmosphere". Both stops carry the same colour so the fade is
   * pure alpha and cannot shift the hue as it goes.
   */
  const lid = `lm${ctx.id}`;
  ctx.defs.push(
    `<radialGradient id="${lid}"><stop offset=".52" stop-color="${shadow}" stop-opacity="0"/><stop offset=".87" stop-color="${shadow}" stop-opacity=".34"/><stop offset="1" stop-color="${shadow}" stop-opacity=".82"/></radialGradient>`,
  );

  const body =
    `<circle cx="${ctx.F(CX)}" cy="${ctx.F(CY)}" r="${ctx.F(bR)}" fill="url(#${bid})"/>` +
    `<circle cx="${ctx.F(CX)}" cy="${ctx.F(CY)}" r="${ctx.F(bR)}" fill="url(#${lid})"/>` +
    rim;

  // 1–2 moons riding the rings, lit by the same gradient as the body. A moon on the hero ring is
  // near and gets real size; one on a hairline is far and stays small — the dots inherit the depth
  // of the ring they sit on, and a moon on the far side of its ring goes behind the body with it.
  const moons = int(r, 1, 2);
  const dotsBack = [];
  const dotsFront = [];
  for (let i = 0; i < moons; i++) {
    const ring = int(r, 0, N - 1);
    const rad = r0 * growth[ring];
    const th = r() * TAU;
    const rot = ((rho0 + dRho * ring) * Math.PI) / 180;
    const mlx = rad * 1.15 * Math.cos(th);
    const mly = rad * ecc * Math.sin(th) * (ctx.H / ctx.W);
    const px = cx + mlx * Math.cos(rot) - mly * Math.sin(rot);
    const py = cy + (mlx * Math.sin(rot) + mly * Math.cos(rot)) * (ctx.W / ctx.H);
    // A moon half-off the frame edge reads as a rendering error, not as a crop, because its halo
    // gets sliced with it. Keep the whole thing inside, and out of the lower-left calm zone.
    if (py > 0.58 || py < 0.05 || px < 0.13 || px > 0.85) continue;
    const ph = ((th % TAU) + TAU) % TAU;
    const isBack = ph >= Math.PI;
    const dx = px * ctx.W - CX;
    const dy = py * ctx.H - CY;
    // Behind the body and inside its silhouette: it is simply not visible. Skipping it is both
    // correct and free, and it is the detail that sells the occlusion on the rings.
    if (isBack && dx * dx + dy * dy < bR * bR) continue;
    const u = 1 - Math.abs(ring - hero) / spanFar;
    // Never more than 0.42 of the body. A moon that rivals the thing it orbits inverts the
    // hierarchy the rest of this family just spent its budget establishing.
    const mr = bR * lerp(0.13, 0.42, u) * between(r, 0.85, 1.15);
    const z = zone(px, py);
    (isBack ? dotsBack : dotsFront).push(
      `<circle cx="${ctx.X(px)}" cy="${ctx.Y(py)}" r="${n(mr * 3.2)}" fill="url(#${hid})" opacity="${ctx.op(
        (0.34 + 0.34 * u) * z,
      )}"/><circle cx="${ctx.X(px)}" cy="${ctx.Y(py)}" r="${n(
        mr,
      )}" fill="url(#${bid})" opacity="${ctx.op(0.96 * z)}"/>`,
    );
  }

  /**
   * The atmosphere, and where it sits in the stack, is the whole depth cue on a face-on seed.
   *
   * It is painted *after* the far half of every ring and *before* the body, so the far arcs are
   * seen through it and the near ones are not. That is a continuous, physically-shaped falloff —
   * the arcs lose contrast and gain the glow's colour as they approach the body — where dimming
   * the far half by a flat multiplier would have put a visible step at 9 and 3 o'clock, which is
   * exactly where the horizon lands and exactly where a step would be read as a defect.
   *
   * It is a *shell*, not a disc, and that is not a detail. The shared `halo()` gradient is at its
   * brightest in the middle — which is precisely where the body is about to be painted over it, so
   * the card threw away the light it was paying for and every seed came out dimmer at feed size
   * than the flat-dot version it replaced. Peaking the gradient at the body's own limb puts the
   * light where it can be seen, and forward-scattered light hugging the limb is what a lit
   * atmosphere actually looks like.
   */
  const airR = bR * between(r, 2.3, 3.3);
  const bo = bR / airR;
  const aid = `at${ctx.id}`;
  ctx.defs.push(
    `<radialGradient id="${aid}"><stop stop-color="${P.hot}" stop-opacity="0"/><stop offset="${n(
      bo * 0.8,
    )}" stop-color="${P.hot}" stop-opacity=".1"/><stop offset="${n(bo)}" stop-color="${
      P.hot
    }" stop-opacity=".5"/><stop offset="${n(bo + (1 - bo) * 0.36)}" stop-color="${
      P.accents[0]
    }" stop-opacity=".22"/><stop offset="1" stop-color="${P.accents[0]}" stop-opacity="0"/></radialGradient>`,
  );
  const air = `<circle cx="${ctx.F(CX)}" cy="${ctx.F(CY)}" r="${ctx.F(
    airR,
  )}" fill="url(#${aid})"/>`;

  return (
    `${ctx.bgRect('radial', cx, cy)}` +
    `<g stroke-linecap="round">${back.join('')}${dotsBack.join('')}</g>` +
    air +
    body +
    `<g stroke-linecap="round">${front.join('')}${dotsFront.join('')}</g>`
  );
}

/**
 * ③ constellation — particle field · `quote`
 * Scattered points, a few faint links. Reads as a thought, not a chart.
 */
function constellation(ctx) {
  const { r, P, U } = ctx;
  // Fewer points than before (was 44–70). Seventy specks at nearly one size is dust, not a thought;
  // the budget those extra points cost is better spent making the ones that remain differ from
  // each other. It also buys back the node headroom the star halos need.
  const M = int(r, 40, 54);
  const g = Math.ceil(Math.sqrt(M));
  const ax = between(r, 0.34, 0.86);
  const ay = between(r, 0.16, 0.44);
  const spread = between(r, 0.4, 0.72);

  const pts = [];
  for (let i = 0; i < M; i++) {
    const gx = i % g;
    const gy = Math.floor(i / g);
    // Jittered grid rather than pure random: same cost, no clumps, no holes.
    const x = (gx + 0.5 + (r() - 0.5) * 0.84) / g;
    const y = 0.03 + ((gy + 0.5 + (r() - 0.5) * 0.84) / g) * 0.82;
    const dx = x - ax;
    const dy = (y - ay) * 1.2;
    const d = Math.sqrt(dx * dx + dy * dy);
    const dens = clamp(1 - d / spread, 0, 1);
    const o = clamp((0.32 + 0.68 * dens * dens) * zone(x, y) * between(r, 0.7, 1.15), 0, 1);
    // DESIGN specifies r ∈ [0.8, 3.4] units; on a 1000-unit canvas rendered into a 300px card
    // that is a sub-pixel speck and the whole family vanished in review. Scaled up, and the range
    // widened from 3.4:1 to 7:1 — near points are now unmistakably nearer, and the falloff is
    // cubed so the field has a few large points rather than a plateau of medium ones.
    // Squared, not cubed. Cubed put almost the whole field on the minimum radius, and a minimum
    // of 1.5 units is a third of a pixel in a 300px thumbnail — the far dust was mathematically
    // present and optically absent, which is how a seed with a tight cluster ended up as three
    // dots on an empty card.
    const k = dens * dens;
    const rad = lerp(3, 11, k * between(r, 0.55, 1)) * U;
    if (o < 0.09) continue;
    // Two inks. The near third of the field takes the brightest accent; everything behind it takes
    // the pale tint. Depth in a particle field has to be carried by *something* other than size,
    // or the small points just read as the same points further away.
    pts.push({ x, y, o, r: rad, near: dens > 0.58 });
  }

  // The far ink. Deliberately a *tone of the primary hue* rather than `accents[2]`: under a
  // `split` scheme accents[2] lands 204° away, and a field of teal dust behind magenta stars reads
  // as two overlaid pictures. This family is a thought, not a diagram — it can afford to be
  // monochrome and spend all of its variety on size and brightness.
  const dim = P.tone(P.dark ? 0.72 : 0.5, P.C[0] * 0.5, 0);

  // Bucket opacity so points can share a <g opacity>: cuts ~25% of the string with no visible
  // change, since the eye cannot resolve 0.51 from 0.55 through a scrim.
  const buckets = new Map();
  for (const p of pts) {
    const b = Math.max(1, Math.round(p.o * 6)) * 2 + (p.near ? 1 : 0);
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b).push(p);
  }
  const groups = [...buckets.keys()]
    .sort((a, b) => a - b)
    .map((b) => {
      const body = buckets
        .get(b)
        .map((p) => `<circle cx="${ctx.X(p.x)}" cy="${ctx.Y(p.y)}" r="${n(p.r)}"/>`)
        .join('');
      return `<g fill="${b % 2 ? P.accents[0] : dim}" opacity="${ctx.op(
        Math.floor(b / 2) / 6,
      )}">${body}</g>`;
    })
    .join('');

  // Links only between the brightest third, only when genuinely close — otherwise it stops being
  // a thought and becomes a network diagram.
  const bright = pts.filter((p) => p.o > 0.45).sort((a, b) => b.o - a.o);
  // Scaled to the grid pitch, not fixed. The old constant 0.06–0.1 was tuned against a 7×7 grid;
  // once the point count came down the pitch grew past it and every link silently disappeared,
  // which is exactly the kind of thing a fixed threshold does when the thing it measures moves.
  const thresh = between(r, 0.95, 1.4) / g;
  let links = '';
  let count = 0;
  for (let i = 0; i < bright.length && count < 18; i++) {
    let best = -1;
    let bd = 1e9;
    for (let j = 0; j < bright.length; j++) {
      if (i === j) continue;
      const dx = bright[i].x - bright[j].x;
      const dy = bright[i].y - bright[j].y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < bd) {
        bd = d;
        best = j;
      }
    }
    if (best > i && bd < thresh) {
      /**
       * A link is a lens, not a line segment.
       *
       * Stroked with round caps, every link was the same width from one point to the other and
       * finished in a little bead at each end — which reads as a diagram edge, a thing drawn to
       * connect two nodes. Tapered to nothing at both ends it reads as what it is meant to be: the
       * eye's own inference of a relation between two points, strongest between them and absent at
       * either. Same node, a handful more bytes, entirely different sentence.
       */
      const ax = bright[i].x * ctx.W;
      const ay = bright[i].y * ctx.H;
      const bx2 = bright[best].x * ctx.W;
      const by2 = bright[best].y * ctx.H;
      const lp = [];
      const lh = [];
      const LK = 7;
      for (let s = 0; s < LK; s++) {
        const tt = s / (LK - 1);
        lp.push([lerp(ax, bx2, tt), lerp(ay, by2, tt)]);
        lh.push(1.9 * U * widthProfile(tt, 0, 0.45, 0, 1, 0));
      }
      links += ribbon(ctx, lp, lh);
      count++;
    }
  }

  // The brightest points get a real halo instead of a blur pass, and they are graded: the first is
  // the subject of the card, the rest are its company. Equal-sized stars read as a UI legend.
  const hid = ctx.halo();
  const starCount = Math.min(bright.length, int(r, 2, 3));

  // The disc of a star is a ramp, not a flat fill: hot in the middle, the accent at the edge, and
  // a last stop that lets the rim melt into its own halo instead of ending on a hard circle. A flat
  // circle with a soft glow behind it is a UI dot with a box-shadow, and that is exactly what this
  // family's focal points looked like.
  const sid = `st${ctx.id}`;
  ctx.defs.push(
    `<radialGradient id="${sid}"><stop stop-color="${P.hot}"/><stop offset=".45" stop-color="${P.accents[0]}"/><stop offset="1" stop-color="${P.accents[0]}" stop-opacity=".45"/></radialGradient>`,
  );

  /**
   * Diffraction spikes on the subject star.
   *
   * This is the one mark in the file that is borrowed from the *camera* rather than from the
   * subject, and it earns its place for that reason: spikes are what a bright point does when it is
   * photographed, and nothing says "this is an image of a light" faster. Two crossed lenses, each
   * tapering to nothing, in one path — the shape has no constant width anywhere and no end to cap.
   *
   * Only the first star gets them. On all three it would be a sticker set.
   */
  const spikeOf = (p, sr) => {
    const a0 = r() * TAU;
    let d = '';
    for (const a of [a0, a0 + Math.PI / 2]) {
      const len = sr * between(r, 4.2, 7);
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const sp = [];
      const sh = [];
      const SK = 9;
      for (let s = 0; s < SK; s++) {
        const tt = s / (SK - 1);
        const u2 = (tt - 0.5) * 2 * len;
        sp.push([p.x * ctx.W + ca * u2, p.y * ctx.H + sa * u2]);
        sh.push(sr * 0.3 * widthProfile(tt, 0, 0.04, 0, 1, 0));
      }
      d += ribbon(ctx, sp, sh);
    }
    return d;
  };

  const stars = bright
    .slice(0, starCount)
    .map((p, i) => {
      const sr = (i === 0 ? between(r, 13, 17) : between(r, 7.5, 11)) * U;
      const spikes =
        i === 0
          ? `<path d="${spikeOf(p, sr)}" fill="${P.hot}" opacity="${ctx.op(
              between(r, 0.3, 0.5) * zone(p.x, p.y),
            )}"/>`
          : '';
      return (
        `<circle cx="${ctx.X(p.x)}" cy="${ctx.Y(p.y)}" r="${n(sr * 5.2)}" fill="url(#${hid})"${
          i ? ` opacity="${ctx.op(0.6)}"` : ''
        }/>` +
        spikes +
        `<circle cx="${ctx.X(p.x)}" cy="${ctx.Y(p.y)}" r="${n(sr)}" fill="url(#${sid})"/>`
      );
    })
    .join('');

  const linkPath = links
    ? `<path d="${links}" fill="${dim}" opacity="${ctx.op(0.62)}"/>`
    : '';
  return `${ctx.bgRect('radial', ax, ay)}<g>${groups}</g>${linkPath}${stars}`;
}

/**
 * ④ contour — isoline topography · `chart`
 * Nested contour lines of a seeded height field. Reads as data without being a chart.
 */
function contour(ctx) {
  const { r, P, U } = ctx;

  // Rational bumps, not Gaussians: `Math.exp` is implementation-defined and marching squares makes
  // a *topological* decision from these values, so one differing low bit could redraw the card on
  // another engine. +,-,*,/ are exactly specified; this shape is visually indistinguishable.
  const bumps = [];
  const count = 3;
  for (let i = 0; i < count; i++) {
    bumps.push({
      cx: between(r, 0.18, 0.86),
      cy: between(r, 0.14, 0.5),
      s: between(r, 0.12, 0.3),
      a: i === 2 && r() < 0.5 ? -between(r, 0.5, 0.85) : between(r, 0.6, 1),
    });
  }
  const f = (x, y) => {
    let v = 0;
    for (const b of bumps) {
      const dx = x - b.cx;
      const dy = y - b.cy;
      const q = (dx * dx + dy * dy) / (b.s * b.s);
      v += b.a / (1 + q + 0.6 * q * q);
    }
    return v;
  };

  const GX = 48;
  const GY = 60;
  const X0 = -0.05;
  const X1 = 1.05;
  const Y0 = -0.05;
  const Y1 = 1.05;
  const grid = new Float64Array(GX * GY);
  let fmin = Infinity;
  let fmax = -Infinity;
  for (let j = 0; j < GY; j++) {
    const y = Y0 + ((Y1 - Y0) * j) / (GY - 1);
    for (let i = 0; i < GX; i++) {
      const x = X0 + ((X1 - X0) * i) / (GX - 1);
      const v = f(x, y);
      grid[j * GX + i] = v;
      if (v < fmin) fmin = v;
      if (v > fmax) fmax = v;
    }
  }

  const L = int(r, 7, 12);
  const crowd = r() < 0.5;
  const lines = [];
  for (let li = 1; li <= L; li++) {
    let t = li / (L + 1);
    // t^1.5 via sqrt (IEEE-exact) instead of DESIGN's t^1.4 via Math.pow (engine-defined).
    if (crowd) t = t * Math.sqrt(t);
    const level = lerp(fmin, fmax, t);
    for (const pl of isolines(grid, GX, GY, level, X0, X1, Y0, Y1)) {
      if (pl.length < 12) continue; // specks look like dust on the lens
      lines.push({ pts: simplify(pl, 0.0035), t });
    }
  }

  // Longest first, then trim to the node budget — the cheapest family stays the cheapest.
  lines.sort((a, b) => b.pts.length - a.pts.length);
  const kept = lines.slice(0, 11);

  /**
   * The summit, as a filled mass rather than one more ring.
   *
   * Everything else in this family is a line, and a picture made only of lines has no figure and no
   * ground — which is a large part of why it read as a trace of something rather than as a thing.
   * One low-alpha fill under the highest closed loop gives the terrain a body for the contours to
   * describe, and the lines that cross it are suddenly *on* a surface.
   *
   * Closedness is tested by exact endpoint identity, which is safe here: the marching-squares
   * chaining walks back to the coordinate it started from, and both copies come from the same
   * interpolation of the same pair of corner values.
   */
  let capD = '';
  let capT = -1;
  for (const ln of kept) {
    const a = ln.pts[0];
    const b = ln.pts[ln.pts.length - 1];
    if (a[0] === b[0] && a[1] === b[1] && ln.t > capT && ln.pts.length >= 6) {
      let lowY = 0;
      for (const p of ln.pts) if (p[1] > lowY) lowY = p[1];
      // Never under the headline: a filled shape in the floor zone is exactly what the calm region
      // exists to prevent, and unlike a hairline it cannot be argued away.
      if (lowY < 0.62) {
        capT = ln.t;
        capD = poly(ctx, ln.pts) + 'Z';
      }
    }
  }

  // Index contours. A real topographic sheet draws every fifth line heavy and labels it; that is
  // the whole reason a contour map reads as terrain rather than as a nest of wire. The old version
  // drew every line at 2–3.7 units — under a pixel at thumbnail size, which is why this family
  // greyed out entirely in the feed. Now the heavy lines are ~5× the hairlines.
  const every = int(r, 2, 3);
  // Low ground: a dimmer tone of the *same* hue. `accents[2]` was the obvious reach and is wrong
  // for the same reason it is wrong in `constellation` — under a `split` scheme it is 204° away,
  // so a ridge came out teal next to a magenta one and aerial perspective turned into a flag.
  const low = P.tone(P.dark ? 0.68 : 0.46, P.C[0] * 0.55, 0);

  /**
   * A light direction, and the field's own gradient to catch it.
   *
   * This family was the most primitive of the six and for one reason: an isoline drawn at constant
   * width in constant colour is a *trace*, and the eye reads it as machine output no matter how
   * good the underlying field is. A real contour sheet does not have this problem because it is
   * printed; a rendered ridge does not have it because it is lit.
   *
   * ∇f at a point is, by definition, normal to the isoline through it and points uphill. Dotting
   * it with a seeded light vector says how much that stretch of slope faces the light, and that
   * one number drives both the width and — through a gradient shared by every line — the colour.
   * The result is that each ring is heavy and bright where the hill turns toward the light and
   * thins to a hairline where it turns away: a lit surface rather than a nest of wire.
   *
   * ∇f is also the correct offset direction for the outline, which is what lets a closed loop be
   * emitted without a seam. See `ribbon`'s `nrm`.
   */
  const lightA = r() * TAU;
  const Lx = Math.cos(lightA);
  const Ly = Math.sin(lightA);
  const EPS = 0.006;
  const grad = (x, y) => {
    const gx = (f(x + EPS, y) - f(x - EPS, y)) / (2 * EPS);
    // The field is defined in unit space but drawn on a canvas that is taller than it is wide, so
    // the y component has to be converted before it can be compared with the x one — otherwise the
    // light lands on the wrong side of every slope on a non-square card.
    const gy = ((f(x, y + EPS) - f(x, y - EPS)) / (2 * EPS)) * (ctx.W / ctx.H);
    const m = Math.sqrt(gx * gx + gy * gy);
    return m < 1e-9 ? [0, 0, 0] : [gx / m, gy / m, m];
  };

  // Two gradients, one per ink, both running along the light. Shared by every line on the card, so
  // the whole sheet is lit from one place for the price of two definitions.
  const ramp = (id, l, c) => {
    ctx.defs.push(
      `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${ctx.F(
        (0.5 + Lx * 0.6) * ctx.W,
      )}" y1="${ctx.F((0.5 + Ly * 0.6) * ctx.H)}" x2="${ctx.F(
        (0.5 - Lx * 0.6) * ctx.W,
      )}" y2="${ctx.F((0.5 - Ly * 0.6) * ctx.H)}"><stop stop-color="${P.tone(
        clamp(l + 0.1, 0, 1),
        c,
        0,
      )}"/><stop offset="1" stop-color="${P.tone(clamp(l - 0.07, 0, 1), c * 0.78, 0)}"/></linearGradient>`,
    );
    return id;
  };
  const gHi = ramp(`ch${ctx.id}`, P.L[0], P.C[0]);
  const gLo = ramp(`cl${ctx.id}`, P.dark ? 0.68 : 0.46, P.C[0] * 0.55);

  const body = kept
    .map((ln, i) => {
      let z = 0;
      for (const p of ln.pts) z += zone(p[0], p[1]);
      z /= ln.pts.length;
      const inFloor = ln.pts.some((p) => p[1] > 0.7);
      const index = i % every === 0;
      const o = clamp(lerp(0.58, 0.96, ln.t) * z * (index ? 1 : 0.72), 0.24, 0.96) * (inFloor ? 0.5 : 1);
      const sw = (inFloor ? 1 : index ? lerp(6.4, 9.6, ln.t) : lerp(1.1, 1.7, ln.t)) * U * 1.7;
      // One hue, two lightnesses. Height reads through weight and lightness — the same discipline
      // `dune` already documents for its layers.
      const gid = ln.t > 0.5 ? gHi : gLo;
      // Hairlines stay stroked: below ~5 units the two offsets round onto the same coordinate, and
      // a 2-unit line has no room to vary anyway. They still take the lit gradient.
      if (sw < 5 * U) {
        return `<path d="${poly(ctx, ln.pts)}" stroke="url(#${gid})" stroke-width="${n(
          sw,
        )}" opacity="${ctx.op(o)}"/>`;
      }
      const px = [];
      const hwv = [];
      const nrm = [];
      for (const p of ln.pts) {
        const [gx, gy] = grad(p[0], p[1]);
        px.push([p[0] * ctx.W, p[1] * ctx.H]);
        nrm.push([gx, gy]);
        // 0.42 … 1.32 of the nominal weight around the loop. The first attempt ran 0.34 … 1.0,
        // which *only ever removed* weight: the average line came out two thirds of what it had
        // been and the whole sheet went dimmer instead of lit. Lighting adds on one side as much
        // as it takes on the other.
        hwv.push(0.5 * sw * (0.42 + 0.9 * (0.5 + 0.5 * (gx * Lx + gy * Ly))));
      }
      return `<path d="${ribbon(
        ctx,
        px,
        hwv,
        0,
        px.length,
        nrm,
      )}" fill="url(#${gid})" stroke="none" opacity="${ctx.op(o)}"/>`;
    })
    .join('');

  // Filled with the low ink's own light ramp, not a flat tone. A flat fill at `bgL + 0.16` landed
  // within a hair of what the background glow was already doing under it, so the summit came out
  // *darker* than its surroundings on the seeds where the glow was strongest — a hole, which is the
  // opposite of the mass it was added to provide. Lit from the card's light direction it rises.
  const cap = capD
    ? `<path d="${capD}" fill="url(#${gLo})" opacity="${ctx.op(between(r, 0.17, 0.27))}"/>`
    : '';

  return `${ctx.bgRect(
    'radial',
    bumps[0].cx,
    bumps[0].cy,
  )}${cap}<g fill="none" stroke-linecap="round" stroke-linejoin="round">${body}</g>`;
}

/**
 * Marching squares over a scalar grid → chained polylines in unit space.
 * Edge crossings are interpolated from the same pair of corner values in both adjacent cells, so
 * shared endpoints are bit-identical and the chaining hash always matches.
 */
function isolines(grid, GX, GY, level, X0, X1, Y0, Y1) {
  const px = (i) => X0 + ((X1 - X0) * i) / (GX - 1);
  const py = (j) => Y0 + ((Y1 - Y0) * j) / (GY - 1);
  const segs = [];

  const interpX = (i, j, i2) => {
    const a = grid[j * GX + i];
    const b = grid[j * GX + i2];
    const t = (level - a) / (b - a);
    return [px(i) + (px(i2) - px(i)) * t, py(j)];
  };
  const interpY = (i, j, j2) => {
    const a = grid[j * GX + i];
    const b = grid[j2 * GX + i];
    const t = (level - a) / (b - a);
    return [px(i), py(j) + (py(j2) - py(j)) * t];
  };

  for (let j = 0; j < GY - 1; j++) {
    for (let i = 0; i < GX - 1; i++) {
      const a = grid[j * GX + i];
      const b = grid[j * GX + i + 1];
      const c = grid[(j + 1) * GX + i + 1];
      const d = grid[(j + 1) * GX + i];
      let code = 0;
      if (a > level) code |= 8;
      if (b > level) code |= 4;
      if (c > level) code |= 2;
      if (d > level) code |= 1;
      if (code === 0 || code === 15) continue;
      const T = () => interpX(i, j, i + 1);
      const B = () => interpX(i, j + 1, i + 1);
      const Lf = () => interpY(i, j, j + 1);
      const R = () => interpY(i + 1, j, j + 1);
      switch (code) {
        case 1: case 14: segs.push([Lf(), B()]); break;
        case 2: case 13: segs.push([B(), R()]); break;
        case 3: case 12: segs.push([Lf(), R()]); break;
        case 4: case 11: segs.push([T(), R()]); break;
        case 6: case 9: segs.push([T(), B()]); break;
        case 7: case 8: segs.push([T(), Lf()]); break;
        case 5: // saddle — resolve with the cell average
        case 10: {
          const avg = (a + b + c + d) / 4;
          if ((code === 5) === avg > level) {
            segs.push([T(), R()]);
            segs.push([Lf(), B()]);
          } else {
            segs.push([T(), Lf()]);
            segs.push([B(), R()]);
          }
          break;
        }
      }
    }
  }
  if (!segs.length) return [];

  // Chain segments into polylines by exact endpoint identity.
  const key = (p) => `${p[0]},${p[1]}`;
  const map = new Map();
  segs.forEach((s, idx) => {
    for (const p of s) {
      const k = key(p);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(idx);
    }
  });
  const used = new Uint8Array(segs.length);
  const out = [];

  const walk = (start, fromEnd) => {
    const line = fromEnd ? [segs[start][1], segs[start][0]] : [segs[start][0], segs[start][1]];
    used[start] = 1;
    for (;;) {
      const tail = line[line.length - 1];
      const cand = map.get(key(tail)) || [];
      let next = -1;
      for (const idx of cand) {
        if (!used[idx]) {
          next = idx;
          break;
        }
      }
      if (next < 0) break;
      used[next] = 1;
      const s = segs[next];
      line.push(key(s[0]) === key(tail) ? s[1] : s[0]);
    }
    return line;
  };

  // Open contours first (endpoints with degree 1), then whatever loops remain.
  for (let idx = 0; idx < segs.length; idx++) {
    if (used[idx]) continue;
    for (const e of [0, 1]) {
      const k = key(segs[idx][e]);
      if ((map.get(k) || []).length === 1) {
        out.push(walk(idx, e === 1));
        break;
      }
    }
  }
  for (let idx = 0; idx < segs.length; idx++) {
    if (!used[idx]) out.push(walk(idx, false));
  }
  return out;
}

/** Douglas–Peucker, iterative (a 3000-point contour would blow a recursive stack). */
function simplify(pts, eps) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    if (hi - lo < 2) continue;
    const ax = pts[lo][0];
    const ay = pts[lo][1];
    const bx = pts[hi][0];
    const by = pts[hi][1];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.sqrt(dx * dx + dy * dy);
    let far = -1;
    let fd = eps;
    for (let i = lo + 1; i < hi; i++) {
      const px = pts[i][0];
      const py = pts[i][1];
      const d =
        len < 1e-9
          ? Math.sqrt((px - ax) * (px - ax) + (py - ay) * (py - ay))
          : Math.abs(dy * px - dx * py + bx * ay - by * ax) / len;
      if (d > fd) {
        fd = d;
        far = i;
      }
    }
    if (far > 0) {
      keep[far] = 1;
      stack.push([lo, far], [far, hi]);
    }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

/**
 * ⑤ spectra — a prism fan · `award`
 * Beams thrown from a point just off the top edge, split into hues off one axis. Reads as ceremony.
 *
 * Full-height bands were tried first (and are what DESIGN §2.3⑤ describes). Blurred, they read as
 * an out-of-focus bookshelf; unblurred, as a stacked bar chart. Rays keep the "light through
 * glass" idea and add the one thing bands never had — a source.
 */
function spectra(ctx) {
  const { r, P } = ctx;
  const B = int(r, 5, 9);

  // The beams originate above the frame, so the crown holds the *narrow* end: least area, least
  // luminance variance, exactly where the eyebrow sits.
  const ox = between(r, 0.28, 0.72);
  // Pulled up from [−0.34, −0.10]. Below −0.22 the source and its halo sat so far off the top that
  // no trace of them reached the frame, and the fan read as a crop out of a larger picture — the
  // one thing this composition was written to avoid.
  const oy = between(r, -0.22, -0.04);
  const spread = between(r, 0.9, 1.5); // total fan angle, radians
  const aim = Math.PI / 2 + between(r, -0.28, 0.28); // straight down, give or take

  // Dirichlet-ish split: normalized uniforms give irregular angular widths that still tile the
  // fan — irregular is what stops this reading as a chart. The exponent range widened from
  // [0.45,1.45] to [0.18,1.5]: at the old spread every beam came out roughly the same width and
  // the fan had no rhythm. A few narrow blades among broad washes is what light through glass
  // actually does.
  const raw = [];
  let sum = 0;
  for (let i = 0; i < B; i++) {
    const v = r() < 0.4 ? between(r, 0.18, 0.4) : between(r, 0.8, 1.5);
    raw.push(v);
    sum += v;
  }

  let prevL = null;
  let a = aim - spread / 2;
  const rays = [];
  for (let i = 0; i < B; i++) {
    const wA = (raw[i] / sum) * spread;
    // Hue stays inside ±16° of the palette's own hue. This is the family most at risk of turning
    // into a flag by accident, so a free hue is never drawn here.
    const hue = P.H[0] + between(r, -16, 16);
    let l = P.L[0] + between(r, -0.1, 0.06);
    // Neighbours must differ enough to separate but not enough to stripe.
    if (prevL !== null) {
      const d = l - prevL;
      const mag = Math.abs(d) < 1e-9 ? 0.1 : Math.abs(d);
      l = clamp(prevL + (d < 0 ? -1 : 1) * clamp(mag, 0.06, 0.22), 0.44, 0.88);
    }
    prevL = l;
    const col = oklch(P.dark ? l : clamp(l - 0.2, 0.3, 0.7), P.C[0] * between(r, 0.7, 1.05), hue);

    // Reach is capped so the widest part of every beam has already faded before the floor.
    const len = between(r, 1.05, 1.45);
    /**
     * Beam edges bow instead of running dead straight.
     *
     * A perfectly straight-sided wedge is defensible physics — light does travel in straight lines
     * — and it is still the thing that made this fan read as a diagram of a fan. Real shafts are
     * seen through moving air and through glass that is not flat, and they wander by a degree or
     * two over their length. Four samples an edge and a seeded angular bow of a couple of degrees
     * is enough: nothing you can point at, but the silhouette stops being a polygon.
     */
    const bow = between(r, -0.055, 0.055);
    const bow2 = between(r, -0.055, 0.055);
    const EK = 4;
    const edge = (a0, bw, rev) => {
      let d = '';
      for (let j = 1; j <= EK; j++) {
        const tt = rev ? (EK - j + 1) / EK : j / EK;
        const th = a0 + bw * Math.sin(Math.PI * tt);
        d += `L${ctx.X(ox + len * tt * Math.cos(th))} ${ctx.Y(oy + len * tt * Math.sin(th))}`;
      }
      return d;
    };
    const gid = `sp${ctx.id}_${i}`;
    // A narrow beam is a blade of light and carries nearly full opacity; a broad one is a wash and
    // has to sit back or it floods the frame. Tying alpha to the *inverse* of angular width is what
    // gives the fan a foreground — before, every beam ran at the same 0.42–0.68 midpoint and the
    // whole family read as one flat sheet.
    const narrow = clamp(1 - (wA / spread) * B * 0.62, 0, 1);
    const head = lerp(0.72, 1, narrow);
    const mid = lerp(0.42, 0.9, narrow);
    ctx.defs.push(
      `<linearGradient id="${gid}" x2="0" y2="1"><stop offset="${n(
        clamp(oy + 0.06, 0, 1),
      )}" stop-color="${col}" stop-opacity="${op(head)}"/><stop offset="${n(
        between(r, 0.24, 0.4),
      )}" stop-color="${col}" stop-opacity="${op(mid * between(r, 0.85, 1.15))}"/><stop offset=".68" stop-color="${col}" stop-opacity="0"/></linearGradient>`,
    );
    rays.push(
      `<path d="M${ctx.X(ox)} ${ctx.Y(oy)}${edge(a, bow, false)}${edge(
        a + wA,
        bow2,
        true,
      )}Z" fill="url(#${gid})"/>`,
    );
    a += wA;
  }

  // The source: a small bright core where the beams meet, plus a halo that reaches into the frame.
  // Without it the fan looks like it was cropped out of a larger picture. The halo is the shared
  // palette gradient rather than part of the blur pass, so the source stays a *point* — under the
  // old 20-unit blur the core spread into the beams and the whole card lost its origin.
  const hid = ctx.halo();
  const coreW = between(r, 46, 86) * ctx.U;
  const scid = `sc${ctx.id}`;
  ctx.defs.push(
    `<radialGradient id="${scid}"><stop stop-color="${P.tone(
      P.dark ? 0.97 : 0.8,
      P.C[0] * 0.2,
      0,
    )}"/><stop offset=".5" stop-color="${P.tone(
      P.dark ? 0.9 : 0.72,
      P.C[0] * 0.42,
      0,
    )}"/><stop offset="1" stop-color="${P.tone(
      P.dark ? 0.84 : 0.66,
      P.C[0] * 0.55,
      0,
    )}" stop-opacity="0"/></radialGradient>`,
  );
  const core =
    `<ellipse cx="${ctx.X(ox)}" cy="${ctx.Y(oy + 0.05)}" rx="${n(coreW * 3.6)}" ry="${n(
      coreW * 2.6,
    )}" fill="url(#${hid})"/>` +
    // The source disc is a ramp, not a flat tone. Everything else in this family is a soft gradient,
    // and a single flat ellipse sitting at the origin of all of it was the one hard-edged primitive
    // left in the frame — the eye went to it and read "shape" instead of "source".
    `<ellipse cx="${ctx.X(ox)}" cy="${ctx.Y(oy + 0.03)}" rx="${n(coreW)}" ry="${n(
      coreW * 0.52,
    )}" fill="url(#${scid})" opacity=".85"/>`;

  // One lens flare across the stage. It has to feather in *both* axes — a rect feathered only
  // left-to-right still lands two hard horizontal edges on the frame and reads as a UI element.
  const fy = between(r, 0.22, 0.46);
  ctx.defs.push(
    `<radialGradient id="fl${ctx.id}"><stop offset="0" stop-color="${P.hot}"/><stop offset="1" stop-color="${P.hot}" stop-opacity="0"/></radialGradient>`,
  );
  const flare = `<ellipse cx="${ctx.X(between(r, 0.36, 0.64))}" cy="${ctx.Y(fy)}" rx="${n(
    0.46 * ctx.W,
  )}" ry="${n(between(r, 0.06, 0.11) * ctx.H)}" fill="url(#fl${ctx.id})" opacity="${op(
    between(r, 0.12, 0.22),
  )}" style="mix-blend-mode:screen"/>`;

  // The blur is a softener, not the picture. At stdDeviation 20 the beam edges dissolved entirely
  // and the card read as out-of-focus fabric; at 11 the edges survive and the gradients carry the
  // falloff, which is what they were written to do. The core sits outside the filter so the source
  // stays sharp against the soft beams — that contrast is the whole subject.
  const fan = ctx.lite
    ? `<g>${rays.join('')}</g>`
    : `<g filter="url(#bw${ctx.id})">${rays.join('')}</g>`;
  return `${ctx.bgRect('radial', ox, 0.1)}${fan}${core}${flare}`;
}

/**
 * ⑥ dune — layered horizons · `profile`, empty state, Wrapped chrome
 * Stacked hills at last light. Reads as landscape, memory, distance.
 */
function dune(ctx) {
  const { r, P } = ctx;
  const K = int(r, 5, 7);

  // Lightness converges on the card tint at the front layer in BOTH themes — that is what keeps
  // the floor zone a single flat mass whether the paper is black or warm white.
  const far = clamp(P.bgL + (P.dark ? 0.3 : -0.32), 0.04, 0.96);

  const out = [];
  const sun = r() < 0.34;
  const sunX = between(r, 0.24, 0.78);
  const sunY = between(r, 0.2, 0.3);
  const sunR = between(r, 0.05, 0.1);
  const haze = r() < 0.25;

  for (let i = 0; i < K; i++) {
    const t = K > 1 ? i / (K - 1) : 1;
    const b = lerp(0.3, 0.75, t);
    const amp = lerp(0.095, 0.02, t);
    const k = [between(r, 1.2, 3.6), between(r, 1.2, 3.6), between(r, 1.2, 3.6)];
    const ph = [r() * TAU, r() * TAU, r() * TAU];
    const a = [between(r, 0.4, 1), between(r, 0.2, 0.8), between(r, 0.1, 0.5)];
    const sa = a[0] + a[1] + a[2];
    const pts = [];
    const S = 22;
    for (let j = 0; j <= S; j++) {
      const x = -0.03 + (1.06 * j) / S;
      const y =
        b +
        (amp *
          (a[0] * Math.sin(k[0] * x + ph[0]) +
            a[1] * Math.sin(k[1] * x + ph[1]) +
            a[2] * Math.sin(k[2] * x + ph[2]))) /
          sa;
      pts.push([x, y]);
    }
    // One hue for every layer. Alternating hues turns aerial perspective into a flag: the layers
    // must differ in lightness only, which is exactly what makes distance read as distance.
    const L = lerp(far, P.bgL, t);
    const C = lerp(P.C[0] * 0.58, P.bgC, t);
    /**
     * Each layer is a *ramp*, not a flat fill.
     *
     * Flat colour is the thing that made this family read as cut paper: six bands of solid tone
     * stacked up, and the only event anywhere in the frame is the edge between two of them. Real
     * ground catches more light where it faces the sky at the crest and falls away below, and one
     * linearGradient per layer — bounded to the layer's own box, so it costs no node and about 120
     * bytes — is enough to say so. The swing is deliberately small (~0.05 in L). Any more and the
     * layers stop reading as one material.
     */
    // The ramp runs the same way in both themes, and deliberately so. On black, "up in L" is more
    // light; on paper it is *less ink*, which the eye reads as more light just the same. Flipping
    // the sign for the light theme — the first instinct — put the shadow at the crest and the
    // highlight in the hollow, which is a landscape lit from underneath.
    const topL = clamp(L + lerp(0.055, 0.018, t), 0, 1);
    const botL = clamp(L - lerp(0.045, 0.014, t), 0, 1);
    const topC = P.tone(topL, C, 0);
    const botC = P.tone(botL, C * 0.92, 0);
    // Layers are opaque and every one is closed to the bottom edge, so only the last two are ever
    // visible below y=0.70 — the rest are painted over. Registering them all would make the floor
    // audit fail on colours nobody can see. Both ends of the ramp are registered: the audit has to
    // see the brightest thing the layer can put under the headline, not its average.
    if (i >= K - 2) {
      ctx.floorColor(topC, 1);
      ctx.floorColor(botC, 1);
    }
    const lid = `dl${ctx.id}_${i}`;
    ctx.defs.push(
      `<linearGradient id="${lid}" x2="0" y2="1"><stop stop-color="${topC}"/><stop offset="1" stop-color="${botC}"/></linearGradient>`,
    );
    const crest = smooth(ctx, pts);
    const d = `${crest}L${ctx.X(1.03)} ${ctx.Y(1.1)}L${ctx.X(-0.03)} ${ctx.Y(1.1)}Z`;
    out.push(`<path d="${d}" fill="url(#${lid})"/>`);

    // Rim light. Adjacent layers differ by only ~0.06 in L, which is honest aerial perspective and
    // also why the middle of the stack mushed together at thumbnail size — the edges had nothing
    // to separate them. A line of the accent along the crest is what a real ridge does with a low
    // sun, and it is the cheapest possible way to give this family an edge to read.
    //
    // It is emitted as a filled outline rather than a stroke so it can be *brightest under the
    // sun and gone at the far end of the ridge*. A rim of constant width running the full width of
    // the frame is the giveaway that no light is involved: it says the edge was stroked, not lit.
    // Only ridges whose whole crest stays above the fade band get one — a lit line running under
    // the headline is exactly the thing the floor zone exists to prevent.
    if (i > 0 && i < K - 1) {
      let lowest = 0;
      for (const p of pts) if (p[1] > lowest) lowest = p[1];
      if (lowest < 0.6) {
        const rw = lerp(5.4, 2.2, t) * ctx.U;
        const rp = pts.map((p) => [p[0] * ctx.W, p[1] * ctx.H]);
        const rh = pts.map(
          (p) => 0.5 * rw * (0.1 + 0.9 * (1 - ss(0.06, 0.46, Math.abs(p[0] - sunX)))),
        );
        out.push(
          `<path d="${ribbon(ctx, rp, rh)}" fill="${P.accents[0]}" opacity="${ctx.op(
            lerp(0.62, 0.26, t) * taper(lowest),
          )}"/>`,
        );
      }
    }

    if (i === 0 && haze) {
      ctx.defs.push(
        `<linearGradient id="hz${ctx.id}" x2="0" y2="1"><stop offset="0" stop-color="${P.hot}" stop-opacity="0"/><stop offset="1" stop-color="${P.hot}" stop-opacity=".22"/></linearGradient>`,
      );
      out.push(
        `<rect x="0" y="${ctx.Y(b - 0.16)}" width="${n(ctx.W)}" height="${n(
          0.16 * ctx.H,
        )}" fill="url(#hz${ctx.id})" opacity=".55"/>`,
      );
    }
    if (i === 1 && sun) {
      // The sun stays on the landscape's own hue, just far brighter. A secondary-hue disc reads as
      // a sticker on the photograph — a blue sun over ochre dunes is the one thing that broke this
      // family in review.
      //
      // Filled with a ramp rather than a flat tone, and slightly flattened. A disc of one colour is
      // a sticker whatever hue it is; a hot core falling through the palette to a soft edge is a
      // light source. The flattening is what a low sun does through the thicker air near the
      // horizon — it costs one attribute and it is the kind of detail the eye believes without
      // being able to name.
      const sid = `sn${ctx.id}`;
      ctx.defs.push(
        `<radialGradient id="${sid}"><stop stop-color="${P.tone(
          P.dark ? 0.97 : 0.88,
          P.C[0] * 0.22,
          0,
        )}"/><stop offset=".5" stop-color="${P.tone(
          P.dark ? 0.9 : 0.78,
          P.C[0] * 0.45,
          0,
        )}"/><stop offset=".85" stop-color="${P.tone(
          P.dark ? 0.83 : 0.72,
          P.C[0] * 0.6,
          0,
        )}" stop-opacity=".88"/><stop offset="1" stop-color="${P.tone(
          P.dark ? 0.8 : 0.7,
          P.C[0] * 0.62,
          0,
        )}" stop-opacity="0"/></radialGradient>`,
      );
      const s = `<ellipse cx="${ctx.X(sunX)}" cy="${ctx.Y(sunY)}" rx="${n(
        sunR * ctx.W,
      )}" ry="${n(sunR * ctx.W * 0.88)}" fill="url(#${sid})" opacity=".92"/>`;
      // Splice the sun behind this layer so the horizon eats its lower edge.
      out.splice(out.length - 1, 0, ctx.lite ? s : `<g filter="url(#bm${ctx.id})">${s}</g>`);
    }
  }

  return `${ctx.bgRect('sky', 0.5, 0.24)}${out.join('')}`;
}

const RENDERERS = { drift, orbit, constellation, contour, spectra, dune };

const FAMILY_WORDS = {
  drift: 'ribbons of light',
  orbit: 'orbital rings',
  constellation: 'scattered particles',
  contour: 'topographic contours',
  spectra: 'spectral bands',
  dune: 'layered horizons',
};

/* ──────────────────────────────── assembly ──────────────────────────── */

/**
 * Build a cover and everything the tests want to know about it.
 * @returns {{svg:string, family:string, palette:object, floor:Array, label:string}}
 */
function build(seed, kind, opts = {}) {
  const s = seed >>> 0;
  const W = opts.w || 1000;
  const H = opts.h || 1250;
  const theme = opts.theme === 'light' ? 'light' : 'dark';
  const lite = opts.quality === 'lite' || opts.blur === false;
  const fam = RENDERERS[opts.family] ? opts.family : familyFor(kind, s);
  const P = paletteFull(s, theme);
  const id = s.toString(36);
  // Coordinates round to whole units on a normal canvas: at 1000 units wide that is finer than a
  // device pixel at every size we render, and integers are the most drift-proof output there is.
  const prec = W >= 500 ? 0 : 1;

  const ctx = {
    seed: s,
    r: rng(s),
    P,
    W,
    H,
    U: W / 1000,
    id,
    lite,
    theme,
    prec,
    defs: [],
    floor: [],
    X: (u) => fixed(u * W, prec),
    Y: (u) => fixed(u * H, prec),
    /** Same rounding as X/Y, for values already in canvas px (outline offsets, radii). */
    F: (px) => fixed(px, prec),
    /**
     * Opacity, with a light-mode boost. A half-transparent bright accent over near-black still
     * reads as light; the same alpha of a dark accent over warm paper reads as nothing. Same
     * geometry, same identity — the ink just has to press harder on white.
     */
    op: (v) => op(v * (P.dark ? 1 : 1.34)),
    /** Register a color that is knowingly painted into the floor zone (y > 0.70). */
    floorColor(hex, alpha) {
      ctx.floor.push({ hex, alpha });
    },
    /**
     * The shared halo. A radialGradient in objectBoundingBox units, so one definition serves a
     * focal core and a 6-unit speck at whatever size each of them is.
     *
     * This replaces the feGaussianBlur+feMerge bloom the bright families used to run. A blurred
     * bright fill washes toward white and reads as a generic lens glow pasted on top of the
     * picture — the "focal dots are unmodulated specks with a white glow" complaint. A gradient
     * built from the card's own accents reads as light that belongs to this palette instead. It is
     * also cheaper than a filter, and — unlike a filter — it survives `quality:'lite'`, so the
     * below-the-fold cards keep their focal points instead of going flat.
     */
    halo() {
      const hid = `hl${id}`;
      if (!ctx._halo) {
        ctx._halo = 1;
        // Every stop is on the *primary* hue — a pale tint of it at the centre, the accent itself
        // at the shoulder. `accents[2]` was tried here and is wrong: under a `split` scheme it sits
        // 204° away, so a magenta core got a teal glow. A halo has to be the same light as the
        // thing making it.
        ctx.defs.push(
          `<radialGradient id="${hid}"><stop offset="0" stop-color="${P.hot}" stop-opacity=".82"/><stop offset=".3" stop-color="${P.accents[0]}" stop-opacity=".32"/><stop offset="1" stop-color="${P.accents[0]}" stop-opacity="0"/></radialGradient>`,
        );
      }
      return hid;
    },
    /**
     * The ground. `radial` puts a *tight* glow on the family's focal point and lets the frame fall
     * away into a vignette; `sky` runs the ramp vertically for the horizon families; `flat` is the
     * bare tint.
     *
     * The previous version was a single two-stop wash at r=.78 with 2.2× chroma, which covered the
     * whole card in one soft coloured blob — the "muddy background" complaint. Three changes:
     *   1. Three stops, not two. The glow is spent by 40% of the radius, the tint holds the middle,
     *      and the last stop goes *below* the tint. Corners darker than the middle is what makes a
     *      frame read as depth rather than as a stained page.
     *   2. The glow is off-centre by construction (it sits on the family's focal point), so the
     *      falloff is asymmetric — light dying away from a source, which is how a photograph
     *      behaves and a UI gradient does not.
     *   3. Chroma is spent on the glow, where the lightness can hold it, and drained from the
     *      darkest region. See `groundGuard`.
     */
    bgRect(mode, fx = 0.5, fy = 0.35) {
      ctx.floorColor(P.bg, 1);
      if (mode === 'flat') {
        return `<rect width="${n(W)}" height="${n(H)}" fill="${P.bg}"/>`;
      }
      // The ground stays on the primary hue in *both* modes. `sky` always did, because it sits
      // directly above large flat fills on that hue. `radial` used to run on the secondary, which
      // is how a card ended up with pink rings standing on a green floor — two photographs
      // stitched together. Same hue, separated by lightness, is the version that reads as one
      // picture, and it is also the version that leaves the accents all the contrast in the frame.
      const gh = 0;
      // The sky sits directly against the back horizon, so it has to climb most of the way to it;
      // a dark sky under a lit ridge reads as two images pasted together.
      const dL = mode === 'sky' ? 0.17 : 0.14;
      const glow = P.tone(clamp(P.bgL + (P.dark ? dL : -dL * 0.42), 0, 1), P.bgC * 3.2, gh);
      // The vignette edge. Dark theme drops below the tint and sheds most of what chroma is left;
      // light theme only leans on it, because paper that darkens at the corners past a whisper
      // stops looking like paper.
      const edge = P.tone(
        clamp(P.bgL + (P.dark ? -0.055 : -0.028), 0, 1),
        P.bgC * (P.dark ? 0.45 : 0.9),
        gh,
      );
      ctx.floorColor(edge, 1);
      const gid = `bg${id}`;
      if (mode === 'sky') {
        ctx.defs.push(
          `<linearGradient id="${gid}" x2="0" y2="1"><stop offset="0" stop-color="${glow}"/><stop offset="${n(
            fy + 0.3,
          )}" stop-color="${P.bg}"/><stop offset="1" stop-color="${edge}"/></linearGradient>`,
        );
      } else {
        ctx.defs.push(
          `<radialGradient id="${gid}" cx="${n(clamp(fx, 0.18, 0.84))}" cy="${n(
            clamp(fy, 0.1, 0.5),
          )}" r=".92"><stop offset="0" stop-color="${glow}"/><stop offset=".4" stop-color="${
            P.bg
          }"/><stop offset="1" stop-color="${edge}"/></radialGradient>`,
        );
      }
      return `<rect width="${n(W)}" height="${n(H)}" fill="url(#${gid})"/>`;
    },
  };

  const body = RENDERERS[fam](ctx);

  // Filters live in the card's own <defs> rather than in CSS: a CSS `filter` on a scrolling
  // element forces a fresh raster layer per card, which is exactly what the feed cannot afford.
  if (!lite) {
    if (fam === 'drift') {
      ctx.defs.push(
        `<filter id="bl${id}" x="-25%" y="-25%" width="150%" height="150%"><feGaussianBlur stdDeviation="${n(
          18 * ctx.U,
        )}"/></filter>`,
      );
    } else if (fam === 'spectra') {
      ctx.defs.push(
        `<filter id="bw${id}" x="-15%" y="-15%" width="130%" height="130%"><feGaussianBlur stdDeviation="${n(
          11 * ctx.U,
        )}"/></filter>`,
      );
    } else if (fam === 'dune') {
      ctx.defs.push(
        `<filter id="bm${id}" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="${n(
          22 * ctx.U,
        )}" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`,
      );
    }
  }

  // The scrim. `--sc` is declared once on the root and inherited by every stop, so the five stops
  // cost 30 bytes each instead of 84. In a document the CSS variable wins; serialized into a
  // data: URL for the share card the fallback takes over, and either way the alpha ramp — the
  // thing the contrast guarantee actually rests on — is identical.
  const scrimRgb = theme === 'light' ? '250 247 242' : '5 6 10';
  ctx.defs.push(
    `<linearGradient id="s${id}" x2="0" y2="1">` +
      SCRIM_STOPS.map(
        (st) => `<stop offset="${st[0]}" style="stop-color:var(--sc)" stop-opacity="${st[1]}"/>`,
      ).join('') +
      `</linearGradient>`,
  );

  const label = `Abstract cover: ${P.hueName} ${FAMILY_WORDS[fam]}`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(W)} ${n(
      H,
    )}" preserveAspectRatio="xMidYMid slice" role="img" aria-label="${label}" style="--sc:rgb(var(--scrim-color,${scrimRgb}))">` +
    `<defs>${ctx.defs.join('')}</defs>` +
    body +
    `<rect width="${n(W)}" height="${n(H)}" fill="url(#s${id})"/>` +
    `</svg>`;

  return { svg, family: fam, palette: P, floor: ctx.floor, label };
}

/** Scrim stops — INVARIANT (docs/DESIGN.md §2.4 / §3.4). The contrast proof is built on these. */
const SCRIM_STOPS = [
  ['0', '.34'],
  ['.42', '.1'],
  ['.62', '.56'],
  ['.78', '.88'],
  ['1', '.94'],
];

/**
 * Deterministic generative cover art for a memory.
 *
 * @param {number} seed uint32 from the Memory
 * @param {'onthisday'|'stat'|'quote'|'chart'|'award'|'profile'} kind
 * @param {{w?:number, h?:number, theme?:'dark'|'light', quality?:'full'|'lite',
 *          blur?:boolean, family?:string}} [opts]
 *   `quality:'lite'` drops every SVG filter — used for the long tail of the feed, where the cards
 *   are rasterized during scroll and a blur costs more than it gives.
 * @returns {string} a complete `<svg>…</svg>` string
 */
export function coverArt(seed, kind, opts) {
  return build(seed, kind, opts).svg;
}

/** Screen-reader description of a cover, for callers that render the `<svg>` themselves. */
export function coverLabel(seed, kind, opts) {
  return build(seed, kind, opts).label;
}

/** Test/diagnostic surface. Not part of the module contract; do not depend on it from the app. */
export const _internals = { build, paletteFull, oklabOf, luminance, SCRIM_STOPS };
