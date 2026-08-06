# codepend — Visual Design System

> Owner: design. This document is the contract for `src/app/app.css`, `src/app/app.js`, and
> `src/art.js`. Numbers here are normative. Where a value is marked **INVARIANT**, changing it
> breaks a contrast or determinism guarantee — don't.

---

## 0. Art direction

codepend is a photo album for a relationship nobody admits to having. The mood is a phone screen
at 2 a.m. — the room is dark, the screen is the only light source, and the light is *colored*.
Everything sits on near-black paper (`#06070A`) with a fine film grain over the whole page, so
the blacks read as exposed film rather than as an unlit `<div>`. Type is editorial and confident:
a small uppercase eyebrow with wide tracking, then an enormous ranged headline, then quiet muted
body — the rhythm of a magazine spread, not a dashboard. Every memory carries a **cover image**,
and because we have no photographs we synthesize them: deterministic seeded SVG, one of six
families, each a different way for light to behave in the dark — ribbons drifting through a flow
field, orbital rings around an absent body, dune horizons at last light, a constellation of
particles, a spectral band, a topographic contour. Color is never picked by hand; it is derived in
OKLCH from the memory's own seed, so the same memory is the same color forever, on any machine.
The art is beautiful but *subordinate*: it lives behind a scrim, out of focus, the way a photo
looks under a caption. Light mode is not an afterthought — it is the same album printed on warm
paper stock (`#F7F4EF`), inks darkened, grain kept. Nothing anywhere is corporate. Nothing anywhere
scolds. The tone of the pixels matches the tone of the copy: affectionate, a little wry, and
occasionally — when the memory is *"a year ago tonight you two shipped it at 04:12"* — quietly
moving.

**Three rules that settle most arguments:**

1. **The art never competes with the type.** If you can't read it, the art is wrong, not the text.
2. **No chrome.** No borders, no card shadows, no gradients-as-decoration, no icons-as-decoration.
   Depth comes from luminance and blur, never from a `box-shadow` ring.
3. **Screenshot-first.** Every surface must look finished when cropped to a 390×844 phone frame
   with no browser UI. If a design only works at 1440px, it's a desktop dashboard. Delete it.

---

## 1. Tokens

All tokens live on `:root`. Theme switches by `[data-theme="light"]` on `<html>`; default is dark,
and `prefers-color-scheme` sets the initial value before first paint via an inline script.

```css
:root {
  color-scheme: dark;

  /* ── surfaces ───────────────────────────────────────────────── */
  --paper:        #06070A;  /* page canvas — the darkest thing in the app */
  --surface-1:    #0E1014;  /* card body where no art shows */
  --surface-2:    #171A20;  /* chips, inline stat blocks, chart plot area */
  --hairline:     #ffffff14; /* 8% white — the ONLY divider treatment */

  /* ── ink ────────────────────────────────────────────────────── */
  --ink-0:        #F4F1EC;  /* 17.9:1 on paper — headlines, stat numbers */
  --ink-1:        #B9B4AC;  /*  9.8:1 — body copy */
  --ink-2:        #827D75;  /*  4.9:1 — eyebrows, metadata, captions. FLOOR. */
  --ink-inv:      #06070A;  /* ink on light accent fills */

  /* ── seeded, overwritten per-card by art.js ─────────────────── */
  --a-1:          #59AAF8;  /* primary accent   (OKLCH L.72 C.14) */
  --a-2:          #8771DE;  /* secondary accent (OKLCH L.62 C.16) */
  --a-3:          #A9C7F2;  /* tint             (OKLCH L.80 C.09) */
  --a-bg:         #030E1C;  /* card tint        (OKLCH L.16 C.035) */

  /* ── scrim (see §3.4 — INVARIANT) ───────────────────────────── */
  --scrim-color:  5 6 10;   /* #05060A as space-separated rgb */
  --scrim-max:    0.88;     /* INVARIANT: alpha over the text band */

  /* ── geometry ───────────────────────────────────────────────── */
  --col:          min(100vw - 32px, 560px); /* the one column */
  --r-card:       22px;
  --r-chip:       999px;
  --gap:          14px;     /* intra-card */
  --stack:        clamp(20px, 5vw, 34px);   /* between cards */
  --pad:          clamp(20px, 5.5vw, 32px); /* card inner padding */
  --safe-b:       env(safe-area-inset-bottom, 0px);

  /* ── motion (see §6) ────────────────────────────────────────── */
  --e-out:        cubic-bezier(0.16, 1, 0.30, 1);  /* reveals, the house curve */
  --e-inout:      cubic-bezier(0.65, 0, 0.35, 1);  /* wrapped slide changes */
  --e-snap:       cubic-bezier(0.34, 1.56, 0.64, 1); /* chips, toggles only */
  --t-fast:       160ms;
  --t-base:       320ms;
  --t-reveal:     620ms;
  --t-slide:      420ms;
}

[data-theme="light"] {
  color-scheme: light;
  --paper:     #F7F4EF;
  --surface-1: #FFFDFA;
  --surface-2: #EFEBE3;
  --hairline:  #0000001a;
  --ink-0:     #12100D;  /* 17.3:1 */
  --ink-1:     #4A453D;  /*  8.7:1 */
  --ink-2:     #6E6860;  /*  5.0:1 — FLOOR */
  --ink-inv:   #FFFDFA;
  --scrim-color: 250 247 242; /* #FAF7F2 */
  --scrim-max: 0.90;
}
```

**Contrast ledger** (measured, WCAG 2.1 relative luminance):

| pair | dark | light |
|---|---|---|
| `--ink-0` on `--paper` | 17.88 | 17.31 |
| `--ink-1` on `--paper` | 9.77 | 8.66 |
| `--ink-2` on `--paper` | 4.93 | 5.02 |
| `--ink-0` on `--surface-1` | 16.90 | 16.4 |
| `--ink-2` on `--surface-1` | 4.66 ⚠︎ | 5.1 |

⚠︎ `--ink-2` on `--surface-1` is 4.66 — passes, but with no headroom. **Rule: `--ink-2` is only
ever used at ≥13px on `--paper` or over a scrim.** Never on `--surface-2`.

### 1.1 Grain — one rasterization for the whole page

`feTurbulence` is the most expensive thing in this app. It is generated **exactly once**, as a
page-level fixed overlay tiled by the compositor. Never per card.

```css
.grain {
  position: fixed; inset: 0; z-index: 9999; pointer-events: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.82' numOctaves='1' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='180' height='180' filter='url(%23n)'/%3E%3C/svg%3E");
  opacity: .16;                 /* dark */
  mix-blend-mode: overlay;
  will-change: transform;       /* promote once; never animated */
}
[data-theme="light"] .grain { opacity: .085; mix-blend-mode: multiply; }
@media (prefers-reduced-transparency: reduce) { .grain { display: none; } }
```

`baseFrequency 0.82 / numOctaves 1 / 180px tile` — **INVARIANT**. Lower frequency or more octaves
turns 180×180 into a multi-millisecond rasterize on low-end hardware.

### 1.2 Performance budget

| thing | budget |
|---|---|
| page-level `feTurbulence` | **1**, ever |
| `feGaussianBlur` per card | **≤1**, `stdDeviation ≤ 24`, applied to a group of ≤6 shapes |
| SVG nodes per cover | **≤ 90** (families are specified to stay under; §2 caps per family) |
| cover SVG string | **≤ 6 KB** before gzip |
| offscreen cards | must not rasterize — see below |
| first meaningful paint, 200 memories, M1 | **< 400 ms** |

```css
.card {
  content-visibility: auto;
  contain-intrinsic-size: auto 520px; /* prevents scrollbar thrash */
  contain: layout paint style;
}
```

Blur is the only per-card filter, and it is *baked into the SVG* (`<filter>` in the card's own
`<defs>`), not applied via CSS `filter:` — CSS filters on a scrolling element force a new raster
layer per card.

---

## 2. Generative cover art — the spec `src/art.js` implements

### 2.0 Signature and determinism

```js
/**
 * @param {number} seed  uint32 from the Memory
 * @param {'onthisday'|'stat'|'quote'|'chart'|'award'|'profile'} kind
 * @param {{w?:number,h?:number,theme?:'dark'|'light',blur?:boolean}} [opts]
 * @returns {string} a complete `<svg>…</svg>` string
 */
export function coverArt(seed, kind, opts) {}
```

Default canvas is `w=1000, h=1250` (4:5). Families must be **aspect-agnostic**: compose in a
normalized unit box and multiply by `w`/`h` at emit time, because the same seed is re-rendered at
1200×675 for the share card.

**Determinism — INVARIANT.** The contract says *same seed ⇒ byte-identical SVG*, and `art.js` runs
in Node at build time and in the browser on re-render. `Math.sin/cos/pow` are **not** bit-identical
across engines. Therefore:

```js
/** Every number emitted into the SVG goes through this. 2 dp kills cross-engine ULP drift. */
const n = (v) => { const r = Math.round(v * 100) / 100; return Object.is(r, -0) ? '0' : String(r); };

/** mulberry32 — Math.imul is spec-exact, division by 2^32 is exact. Safe across engines. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick  = (r, arr) => arr[Math.floor(r() * arr.length)];
const lerp  = (r, a, b) => a + (b - a) * r();
```

No `Math.random`, no `Date.now`, no `Intl`, no Node APIs. A unit test must assert
`coverArt(s,k) === coverArt(s,k)` across a 1000-seed sweep and that the string matches a
committed hash for 20 golden seeds.

### 2.1 Family assignment

```js
const FAMILY = {
  onthisday: 'drift',   stat: 'orbit',   quote: 'constellation',
  chart:     'contour', award: 'spectra', profile: 'dune',
};
const ALT = { drift:'dune', orbit:'spectra', constellation:'drift',
              contour:'orbit', spectra:'constellation', dune:'contour' };

/** 1-in-8 deterministic swap so a long feed never looks templated. */
export function familyFor(kind, seed) {
  const f = FAMILY[kind] || 'dune';
  return (seed >>> 29) === 7 ? ALT[f] : f;
}
```

### 2.2 Composition safe-zones — **INVARIANT, all families**

The unit box is `[0,1]×[0,1]`, y down.

| zone | y range | rule |
|---|---|---|
| **crown** | 0 → 0.10 | eyebrow sits here. Keep gradient magnitude low; no shape edge crossing. |
| **stage** | 0.10 → 0.56 | the focal mass. Brightest values, highest frequency, all detail. |
| **fade** | 0.56 → 0.70 | transition. Amplitude tapers by `a *= 1 - smoothstep(0.56, 0.70, y)`. |
| **floor** | 0.70 → 1.00 | headline + body. **Low frequency only**: no stroke thinner than 3 units, no shape whose luminance delta to its neighbour exceeds 0.25, no more than 2 shapes. |

Every family implements a shared `taper(y)` and multiplies opacity/amplitude by it. This is what
makes the scrim math in §3.4 hold in practice rather than only in the worst case.

### 2.3 The six families

Each is `family(r, P, W, H) -> string`, where `r` is the seeded rng and `P` the palette (§3).

---

#### ① `drift` — flow-field ribbons · `onthisday`
*Long ribbons of light bent by an invisible field. Reads as time passing.*

- **Geometry.** A curl-ish field `θ(x,y) = TAU * (fbm2(x*fx, y*fy) )` approximated with three
  seeded sine terms (no noise lib): `θ = A₁sin(k₁x + φ₁) + A₂sin(k₂y + φ₂) + A₃sin(k₃(x+y) + φ₃)`.
  Seed `N = 5..9` ribbons. Each ribbon starts at `x₀ ∈ [-0.1, 0.25]`, `y₀ ∈ [0.14, 0.52]` and is
  integrated for 48 steps of `h = 0.028`, emitted as a single cubic-smoothed `<path>` (Catmull-Rom
  → Bézier). Ribbon *width* is a tapered `stroke-width` — emit as two paths (outer at width
  `w`, inner at `w*0.35` in `--a-3` at 0.5α) rather than a filled outline; cheaper, prettier.
- **Seed drive.** `k₁,k₂,k₃ ∈ [1.6, 4.2]`, `φ ∈ [0, TAU)`, `A ∈ [0.5, 1.4]`, ribbon width
  `∈ [10, 34]` units, `N` from `1 + (seed % 5) + 4`.
- **Beauty guard.** Ribbons are sorted by y and stroke-opacity ramps `0.85 → 0.25` back-to-front,
  so they never read as spaghetti. Reject-and-resample any ribbon whose bounding box is < 0.25 W
  (stubs look like mistakes). Hard cap 9 ribbons × 2 paths = **18 nodes**.
- **Blur.** The back 40% of ribbons go in a `<g filter="url(#bl)">` with `stdDeviation=18`.

---

#### ② `orbit` — orbital rings · `stat`
*Ellipses around a body that isn't there. Reads as a single number with weight.*

- **Geometry.** A common focus `c = (0.5 ± 0.08, 0.36 ± 0.06)`. `N = 3..6` concentric ellipses,
  radius `rᵢ = r₀ · 1.34^i`, `r₀ ∈ [0.10, 0.16]`, each with its own eccentricity
  `e ∈ [0.55, 0.95]` and rotation `ρᵢ = ρ₀ + i·δ`, `δ ∈ [-14°, 14°]`. Rings are *dashed arcs*, not
  closed: `stroke-dasharray` with a seeded gap pattern and a `stroke-dashoffset` so each ring has a
  visible "opening" — closed circles look like a loading spinner. One filled `<circle>` at the
  focus, r ≈ 4–9 units, `--a-3`, with the bloom filter: the implied star.
- **Seed drive.** `N`, `r₀`, `e`, `ρ₀`, `δ`, dash pattern, and 1–3 "moons" (small filled circles
  placed on a ring at seeded parametric `t`).
- **Beauty guard.** Ring stroke-width falls `2.5 → 1.0` outward; outer rings clip against the
  fade/floor via `taper`. Ensure `rₙ · (1+e) < 0.62` in y so nothing enters the floor zone.
  **≤ 26 nodes.**

---

#### ③ `constellation` — particle field · `quote`
*Scattered points, a few faint links. Reads as a thought, not a chart.*

- **Geometry.** Poisson-ish scatter: `M = 40..80` points via seeded jittered grid (grid of
  `g×g`, `g = ceil(sqrt(M))`, each cell gets one point at cell-center + jitter `±0.42` cell) —
  cheap, deterministic, and avoids the clumping of pure random. Radius
  `∈ [0.8, 3.4]` units, opacity `∈ [0.25, 1.0]`, both weighted by `taper(y)` and by distance from a
  seeded "attractor" so density is non-uniform. Links: for each point, connect to its nearest
  neighbour **only if** `d < 0.085` and only for the top 30% brightest points → ~10–18 hairlines at
  `0.6` stroke, 0.22α.
- **Seed drive.** `M`, attractor position, jitter phase, link threshold, and which 2–4 points are
  "bright" (r ≈ 4–6, full `--a-1`, bloomed).
- **Beauty guard.** Points emit as **one `<path>` of `M…a` arcs** or a single `<g>` of circles with
  shared attrs — but node budget is the binding constraint: emit circles, cap `M ≤ 80`, links ≤ 18.
  **≤ 86 nodes** (the ceiling of the whole system).

---

#### ④ `contour` — isoline topography · `chart`
*Nested contour lines of a seeded height field. Reads as data without being a chart.*

- **Geometry.** Height `f(x,y) = Σ_{i=1..3} aᵢ · exp(-((x-cxᵢ)² + (y-cyᵢ)²)/σᵢ²)` — 3 seeded
  Gaussian bumps (one may be negative → a basin). Extract `L = 7..12` isolines by marching a
  coarse `56×70` grid with marching-squares, emit each as a polyline `<path>`, simplified with a
  1.2-unit Douglas–Peucker. No filled bands (fills at this node count get muddy).
- **Seed drive.** Bump centers (constrained to stage zone: `cy ∈ [0.16, 0.50]`), `σ ∈ [0.12, 0.30]`,
  amplitudes, `L`, and the level spacing (linear vs. `pow(t, 1.4)` — the latter crowds lines near
  the peak, which looks better ~half the time).
- **Beauty guard.** Line opacity ramps `0.7` at the peak → `0.18` at the outermost. Drop any
  isoline with < 12 vertices (specks). Contours entering the floor zone drop to 0.10α and
  `stroke-width 1`. **≤ 12 paths + 1 bg = 13 nodes.** The cheapest family; use it for the empty
  state.

---

#### ⑤ `spectra` — spectral bands · `award`
*A prism split. Vertical bands of graded color. Reads as ceremony.*

- **Geometry.** `B = 5..9` vertical bands spanning full height, widths from a seeded Dirichlet-ish
  split (normalize `B` uniforms) so widths are irregular but sum to 1. Each band is a `<rect>`
  filled with its own `linearGradient` running top→bottom from a hue-shifted accent to `--a-bg`.
  Overlay 1–2 wide horizontal "flare" rects with `mix-blend-mode: screen` at 0.10–0.18α crossing
  the stage zone.
- **Seed drive.** `B`, widths, per-band hue offset `∈ [-16°, +16°]` from `--a-1`'s hue **only**
  (never a free hue — this is the family most at risk of looking like a pride flag by accident),
  per-band L offset `∈ [-0.10, +0.06]`, flare y positions.
- **Beauty guard.** Bands must alternate L by at least 0.05 but no more than 0.22 between
  neighbours. The whole group gets `filter: url(#bl)` at `stdDeviation = 26` scaled to width — the
  bands should read as *light through glass*, hard edges are wrong. All gradients terminate in
  `--a-bg` by y=0.70, which auto-satisfies the floor rule. **≤ 22 nodes.**

---

#### ⑥ `dune` — layered horizons · `profile`, empty state, Wrapped chrome
*Stacked hills at last light. Reads as landscape, memory, distance.*

- **Geometry.** `K = 4..7` layers, back to front. Layer `i` is a filled path: a horizon line
  `y = base_i + Σ_{j=1..3} aⱼ sin(kⱼ x + φⱼ)` closed to the bottom. `base_i` descends
  `0.30 → 0.74`; amplitude shrinks `0.075 → 0.018` with depth. Fill L steps *down* toward the
  viewer (`L_back` bright → `L_front` near `--a-bg`) — inverted aerial perspective, which is what
  makes it read as dusk. Optional seeded sun: a circle at `y ∈ [0.20, 0.30]` behind layer 2,
  bloomed, 1-in-3.
- **Seed drive.** `K`, `base` jitter, wave `k ∈ [1.2, 3.6]`, `φ`, sun presence/position, and a
  1-in-4 "haze" band (a soft rect at the back horizon, 0.12α).
- **Beauty guard.** Adjacent layer L delta ∈ [0.045, 0.12] — smaller and layers merge, larger and it
  stripes. The frontmost layer must reach `base ≥ 0.70` so the floor zone is a single flat dark
  mass. **≤ 12 nodes.** Naturally the most legible under text — hence the profile/hero default.

---

### 2.4 Shared `<defs>` emitted per cover

```xml
<defs>
  <linearGradient id="s{id}" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0"    stop-color="rgb(var(--scrim-color))" stop-opacity="0.34"/>
    <stop offset="0.42" stop-color="rgb(var(--scrim-color))" stop-opacity="0.10"/>
    <stop offset="0.62" stop-color="rgb(var(--scrim-color))" stop-opacity="0.56"/>
    <stop offset="0.78" stop-color="rgb(var(--scrim-color))" stop-opacity="0.88"/>
    <stop offset="1"    stop-color="rgb(var(--scrim-color))" stop-opacity="0.94"/>
  </linearGradient>
  <filter id="bl{id}" x="-25%" y="-25%" width="150%" height="150%">
    <feGaussianBlur stdDeviation="18"/>
  </filter>
</defs>
```

`{id}` is `seed.toString(36)` so multiple covers in one document never collide on filter IDs — a
real bug class in inline-SVG feeds. The scrim rect is emitted **inside** the cover SVG as the last
child, full-bleed, `fill="url(#s{id})"`.

---

## 3. Palette system

### 3.1 OKLCH → sRGB (exact, reference implementation)

```js
/** OKLCH → linear sRGB. Björn Ottosson's matrices. */
function oklchToLinear(L, C, H) {
  const h = H * Math.PI / 180, a = C * Math.cos(h), b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
  return [
     4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}
const encode = (c) => c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
const inGamut = (v) => v.every((c) => c >= -1e-4 && c <= 1 + 1e-4);

/** Chroma-reduce until in sRGB gamut (18-step bisection), then hex. Deterministic. */
export function oklch(L, C, H) {
  let lo = 0, hi = C;
  if (inGamut(oklchToLinear(L, C, H))) lo = C;
  else for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(oklchToLinear(L, mid, H))) lo = mid; else hi = mid;
  }
  const v = oklchToLinear(L, lo, H)
    .map((c) => Math.round(Math.min(1, Math.max(0, encode(c))) * 255));
  return '#' + v.map((x) => x.toString(16).padStart(2, '0')).join('');
}
```

Bisection depth is fixed at 18 (not "until converged") so the result is bit-identical everywhere.

### 3.2 Hue anchors — the muddy-zone guard

Free hue selection produces olive/khaki disasters around OKLCH H ≈ 85–135 at mid lightness
(`oklch(0.72 0.14 100)` → `#b9a624`). Hues are therefore snapped to 14 curated anchors:

```js
const ANCHORS = [16, 34, 52, 68, 148, 168, 190, 212, 236, 258, 280, 302, 326, 348];
//               ember  amber  gold │ jade  teal  cyan  sky  blue  indigo violet magenta rose
```

`H₀ = ANCHORS[seed % 14] + (r() * 10 - 5)` — ±5° of jitter so two memories on the same anchor
aren't identical, but never enough to walk into the dead zone.

### 3.3 `palette(seed)`

```js
/** @returns {{bg:string, fg:string, accents:string[]}} */
export function palette(seed, theme = 'dark') {
  const r = rng(seed ^ 0x9E3779B9);           // decorrelate from geometry rng
  const H0 = ANCHORS[seed % ANCHORS.length] + (r() * 10 - 5);
  const scheme = pick(r, ['analogous', 'split', 'duo', 'triadNarrow']);
  const d = { analogous: [0, 22, -18], split: [0, 156, 204],
              duo: [0, 180, 12], triadNarrow: [0, 96, -96] }[scheme];
  const H = d.map((x) => (H0 + x + 360) % 360);

  const dark = theme === 'dark';
  const L = dark ? [0.74, 0.63, 0.82] : [0.56, 0.46, 0.66];  // light mode darkens accents
  const C = [0.135, 0.160, 0.085].map((c) => c * (0.86 + r() * 0.28));

  return {
    bg:      oklch(dark ? 0.16 : 0.965, dark ? 0.035 : 0.012, H0),
    fg:      dark ? '#F4F1EC' : '#12100D',
    accents: [oklch(L[0], C[0], H[0]), oklch(L[1], C[1], H[1]), oklch(L[2], C[2], H[2])],
  };
}
```

**Guardrails (assert in tests over a 1000-seed sweep):**

| guard | rule |
|---|---|
| chroma ceiling | `C ≤ 0.185` before gamut clamp — above that it's neon, not cinema |
| lightness band | accents `L ∈ [0.44, 0.84]`. Never brighter than `--ink-0`'s perceptual L (0.94). |
| hue spread | max pairwise hue distance ≤ 210° — wider and the card has no identity |
| bg tint | `L ∈ [0.14, 0.19]` dark / `[0.955, 0.975]` light, `C ≤ 0.04`. It is a *tinted black*, not a color. |
| accent vs bg | ΔL ≥ 0.34 in OKLCH between every accent and `bg` |
| light-mode parity | same seed, same hues, only L/C shift — a memory keeps its identity across themes |

The palette is written onto the card element as inline custom properties
(`style="--a-1:…;--a-2:…;--a-3:…;--a-bg:…"`), so the art SVG and the card's own chrome (chips,
underlines, chart strokes) share one color identity without a second computation.

### 3.4 The scrim — how text stays readable over anything

**The guarantee, arithmetically.** Text sits in the floor zone where scrim alpha ≥ `--scrim-max`
(0.88 dark). Composite the *worst possible* art — pure white, Y=1.0 — under it:

```
Y_composited = (1 − 0.88)·1.0 + 0.88·Y(#05060A)
             = 0.12 + 0.88·0.00215 = 0.1219
contrast(--ink-0)  = (0.8726 + 0.05) / (0.1219 + 0.05) = 5.37 : 1  ✓
contrast(--ink-1)  = (0.4537 + 0.05) / (0.1719)        = 2.93 : 1  ✗
```

So: **over cover art, only `--ink-0` and `--ink-1`-at-≥18px are permitted.** `--ink-2` over art is
banned; eyebrows over art use `--ink-0` at 62% opacity, which composites to
`0.62·0.8726 + 0.38·0.1219 = 0.587` → **4.98:1** ✓.

Light mode, worst case art = pure black under `#FAF7F2` at α 0.90:
`Y = 0.90·0.9073 = 0.8166` → contrast to `--ink-0` = **15.9:1** ✓ (light mode is never the problem).

Three layers make this hold, in order:

1. **`taper(y)`** in every art family suppresses amplitude in the floor zone (§2.2).
2. **The gradient scrim** inside the cover SVG (§2.4) — carries the guarantee alone.
3. **A 1px bottom-edge vignette** on the card: `box-shadow: inset 0 -60px 60px -40px rgb(var(--scrim-color)/.7)` — belt and braces at the crop line.

A CI check renders 200 seeds × 6 families to SVG, rasterizes nothing (we can't, zero deps), and
instead **statically asserts** that no emitted fill/stroke in the floor zone has computed
`Y > 0.55` and that the scrim rect is present with the correct stop opacities. That's the testable
form of the guarantee.

---

## 4. Typography

### 4.1 Stacks — system only, no network

```css
:root {
  --f-display: ui-sans-serif, -apple-system, BlinkMacSystemFont,
               "Segoe UI Variable Display", "Segoe UI", Roboto,
               "Helvetica Neue", Arial, sans-serif;
  --f-text:    ui-sans-serif, -apple-system, BlinkMacSystemFont,
               "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --f-quote:   ui-serif, "Iowan Old Style", "Palatino Linotype",
               Georgia, Cambria, "Times New Roman", serif;
  --f-mono:    ui-monospace, SFMono-Regular, "SF Mono", Menlo,
               Consolas, "Liberation Mono", monospace;
}
```

**Cyrillic.** The corpus is Russian and English. `Iowan Old Style` has no Cyrillic, so a Russian
quote in `--f-quote` falls back glyph-by-glyph and looks broken. `src/detect.js` tags quotes whose
text matches `/[Ѐ-ӿ]/` and the renderer sets `data-script="cyr"`:

```css
[data-script="cyr"] { --f-quote: "PT Serif", Georgia, "Times New Roman", serif; }
```

Also: never `text-transform: uppercase` Cyrillic body text (it destroys legibility and some
descenders), and eyebrows in Cyrillic use letter-spacing `0.08em` instead of `0.14em` — Cyrillic
uppercase is already wide.

### 4.2 Scale

Fluid, clamped, mobile-first. `1rem = 16px`.

| token | clamp | weight / tracking / leading | use |
|---|---|---|---|
| `--t-mega` | `clamp(72px, 22vw, 148px)` | 800 · `-0.045em` · 0.82 | the stat number |
| `--t-d1` | `clamp(32px, 8.2vw, 46px)` | 700 · `-0.028em` · 1.06 | hero headline |
| `--t-d2` | `clamp(25px, 6.2vw, 33px)` | 700 · `-0.022em` · 1.10 | card headline |
| `--t-quote` | `clamp(22px, 5.6vw, 30px)` | 400 italic · `-0.005em` · 1.34 | pull quote |
| `--t-body` | `clamp(15px, 3.9vw, 17px)` | 400 · `0` · 1.52 | body |
| `--t-meta` | `13px` | 500 · `0.005em` · 1.4 | metadata |
| `--t-eyebrow` | `11px` | 600 · **`0.14em`** · 1 · uppercase | "6 MONTHS AGO TODAY" |
| `--t-micro` | `10px` | 600 · `0.10em` · 1 · uppercase | chips, footer |

```css
body { font: 400 var(--t-body)/1.52 var(--f-text);
       -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
h1, h2, .stat { font-family: var(--f-display); font-weight: 700; text-wrap: balance; }
p  { text-wrap: pretty; hanging-punctuation: first allow-end; }
```

### 4.3 Setting a giant number

The single most screenshot-worthy element. It is not "big text", it is a composed lockup.

```css
.stat {
  font: 800 var(--t-mega)/0.82 var(--f-display);
  letter-spacing: -0.045em;
  font-variant-numeric: tabular-nums lining-nums;  /* count-up must not reflow */
  font-feature-settings: "ss01" 1;                 /* SF alt digits where available */
  color: var(--ink-0);
  display: flex; align-items: baseline; gap: 0.06em;
  margin-block: 0.06em -0.10em;   /* negative bottom trims the descender gap */
}
.stat__unit {
  font-size: 0.26em; font-weight: 600; letter-spacing: 0.02em;
  color: var(--a-1); align-self: baseline; translate: 0 -0.06em;
}
.stat__label {
  font: 600 var(--t-eyebrow)/1 var(--f-text);
  letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-2);
}
```

Rules: **negative tracking scales with size** (`-0.045em` at mega, `0` at body — never track body
text tighter). The unit (`h`, `prompts`, `×`) is always accent-colored and baseline-aligned, never
same-size. Numbers ≥ 4 digits get a thin-space group separator (`21 910`, `U+2009`) — commas look
like accounting, thin spaces look like design.

---

## 5. Card anatomy

### 5.1 The grid

One column. `--col: min(100vw - 32px, 560px)`, centered. That's it — no 2-up, no masonry, no
sidebar. At ≥1100px the column stays 560px and the extra space is *deliberately empty*, with the
Wrapped/Share/Theme controls docked bottom-center. A phone screenshot is the viral unit; desktop is
a phone in a dark room.

```css
.feed { display: grid; justify-content: center; gap: var(--stack);
        padding: clamp(56px,14vh,120px) 16px calc(120px + var(--safe-b)); }
.card { width: var(--col); border-radius: var(--r-card); position: relative;
        overflow: clip; background: var(--surface-1); isolation: isolate; }
```

### 5.2 Hero card (`kind: 'onthisday'`) — full-bleed

```
┌─────────────────────────── 4:5 ───────────────────────────┐
│  ▓▓▓ cover art, full bleed, absolutely positioned, z:0  ▓ │
│                                                           │
│  ┌ pad 32 ┐                                               │
│  │ EYEBROW · 11/0.14em · ink-0@62%          ← y ≈ 32px    │
│  │                                                        │
│  │                     (stage — art breathes)             │
│  │                                                        │
│  │                                          ← floor start │
│  │ Headline                                               │
│  │ up to 3 lines · --t-d1 · ink-0 · balance               │
│  │                                                        │
│  │ Body, 2 lines max, --t-body, ink-1                     │
│  │                                                        │
│  │ ⬤ orchard     ·   codex   ·   04:12          ← chips   │
│  └────────────────────────────────────────── pad 32 ──────┘
└───────────────────────────────────────────────────────────┘
```

- Aspect `4/5` on mobile, `3/4` at ≥560px (a taller card wastes desktop viewport).
- Content is a flex column with `justify-content: space-between`; the eyebrow pins top, the
  headline block pins bottom. **Minimum 108px of art visible between them** — if the headline is
  long enough to violate that, the headline clamps to 2 lines.
- Chips: `--t-micro`, `--ink-1`, `--surface-2` at 55%, `backdrop-filter: blur(10px)`, radius
  `--r-chip`, padding `5px 10px`. The leading dot is the seeded `--a-1`.

```css
.card--hero { aspect-ratio: 4/5; }
@media (min-width: 560px) { .card--hero { aspect-ratio: 3/4; } }
.card__art { position: absolute; inset: -6% 0 -6% 0; z-index: 0;  /* -6% = parallax headroom */
             width: 100%; height: 112%; }
.card__art svg { width: 100%; height: 100%; display: block; }
.card__body { position: relative; z-index: 1; height: 100%;
              display: flex; flex-direction: column; justify-content: space-between;
              padding: var(--pad); }
.card__title { font: 700 var(--t-d1)/1.06 var(--f-display); letter-spacing: -.028em;
               color: var(--ink-0);
               display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3;
               overflow: hidden; }
```

### 5.3 Stat card (`kind: 'stat'`) — 1:1

Art is **not** full-bleed; it's a `radial-gradient`-masked bleed from the top-right corner at 55%
opacity, so the number owns the frame. Layout: eyebrow top-left, giant number optically centered
(shifted up 4% — visual center is above geometric center), label under it, one sentence of context
at the bottom in `--ink-1`.

```css
.card--stat { aspect-ratio: 1/1; background: var(--a-bg); }
.card--stat .card__art { mask-image: radial-gradient(120% 90% at 100% 0%, #000 0%, #0000 72%);
                         opacity: .55; }
```

### 5.4 Quote card (`kind: 'quote'`) — auto height, min 4:5

The quote is the hero. Art drops to 30% opacity and is blurred an extra 8px. Serif, italic,
hanging open-quote, 22–30px. Attribution line below with a 24px accent rule.

```css
.card--quote { min-height: calc(var(--col) * 1.25); background: var(--a-bg); display: grid;
               align-content: center; padding: calc(var(--pad) * 1.4) var(--pad); gap: 20px; }
.card--quote .card__art { opacity: .30; filter: blur(8px) saturate(1.1); }
.quote { font: 400 italic var(--t-quote)/1.34 var(--f-quote); color: var(--ink-0);
         text-indent: -0.42em;                       /* hang the open quote */
         max-inline-size: 22ch; }                     /* measure — never wider */
.quote__who { font: 600 var(--t-micro)/1 var(--f-text); letter-spacing: .10em;
              text-transform: uppercase; color: var(--ink-2);
              display: flex; align-items: center; gap: 10px; }
.quote__who::before { content: ""; width: 24px; height: 1.5px; background: var(--a-1); }
```

**Quote length policy:** ≤ 180 chars. Longer quotes are truncated at a word boundary with `…`.
Quotes shorter than 4 words are never promoted to a quote card (they're not interesting) — that's
a `detect.js` rule but it's a design constraint, so it's stated here.

### 5.5 Chart card (`kind: 'chart'`) — 4:3, art recedes to a wash

Five chart types, all inline SVG, all using `--a-1/--a-2/--a-3`, all with `--ink-2` axis labels on
`--surface-1` (never on art):

| type | form | notes |
|---|---|---|
| `clock` | 24-spoke radial bar, midnight at top | the "when do you two talk" chart. Spokes are rounded rects; 02:00–05:00 spokes get `--a-1`, rest `--a-2` at 60% |
| `bars` | horizontal, label-left, value-right | max 8 rows, sorted desc, bar height 26px, gap 8px, radius 4px |
| `heat` | 53×7 GitHub-style, cell 10px, gap 3px | 5 opacity steps of `--a-1` (0.12 / 0.3 / 0.52 / 0.76 / 1.0). **Never green.** |
| `spark` | 1px-stroke area + line, no axes | for a single trend inside a stat card |
| `donut` | ≤4 segments, 30px stroke, gap 3° | model share. Center holds a small number. |

Chart plot area sits on `--surface-2` at radius 14px with `--pad*0.7` inset. Grid lines are
`--hairline`, never solid. No legends — label directly on the mark.

### 5.6 Responsive

| width | change |
|---|---|
| < 360px | `--pad` floor 20px, `--t-mega` floor 72px, chips wrap to 2 rows |
| 360–559 | canonical mobile. Design here first. |
| ≥ 560 | column locks at 560px, hero goes 3:4, `--stack` grows to 34px |
| ≥ 1100 | column unchanged; dock appears bottom-center; ambient `--a-bg` glow behind the focused card at 6% |
| print | `@media print` → light theme forced, art at 100% opacity, no grain, page-break-inside: avoid |

---

## 6. Motion

Everything below is inside `@media (prefers-reduced-motion: no-preference)`. The reduced-motion
path is not "faster" — it's **absent**: elements start at their final state, count-ups render the
final number, Wrapped auto-advance is disabled and becomes tap-only.

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 1ms !important; animation-iteration-count: 1 !important;
    transition-duration: 1ms !important; scroll-behavior: auto !important;
  }
  .card { opacity: 1 !important; transform: none !important; }
}
```

### 6.1 Scroll reveal

`IntersectionObserver`, `rootMargin: "0px 0px -12% 0px"`, `threshold: 0.08`, `unobserve` on first
fire (reveal once — re-animating on scroll-up is nauseating).

```css
.card { opacity: 0; transform: translateY(24px) scale(.985);
        transition: opacity var(--t-reveal) var(--e-out),
                    transform var(--t-reveal) var(--e-out); }
.card.is-in { opacity: 1; transform: none; }
```

Stagger: only within a visible group, `transition-delay: calc(var(--i) * 60ms)`, capped at 180ms.
Never stagger a long feed by index — item 40 must not wait 2.4s.

### 6.2 Parallax on cover art

Native scroll-driven animation where supported, zero JS:

```css
@supports (animation-timeline: view()) {
  .card__art { animation: para linear both; animation-timeline: view();
               animation-range: cover 0% cover 100%; }
  @keyframes para { from { transform: translateY(-3.5%); } to { transform: translateY(3.5%); } }
}
```

Fallback: a single shared `rAF` loop that reads `getBoundingClientRect()` for cards with
`is-in`, writes `translate3d(0, Ypx, 0)`. **One loop for all cards**, batched read-then-write, and
it exits when nothing is in view. Never a scroll listener per card.

### 6.3 Number count-up

1100ms, `easeOutExpo` (`t => t===1 ? 1 : 1 - 2**(-10*t)`), starts on reveal, `tabular-nums`
prevents reflow. Values > 1000 count in a non-linear digit cadence (the last 12% of the animation
covers the last 2% of the value) so the final number *lands* instead of ticking. Durations
(`4h 12m`) count the larger unit only.

### 6.4 Wrapped transitions

| element | spec |
|---|---|
| slide enter | `opacity 0→1` + `scale 1.04→1`, 420ms `--e-inout` |
| slide exit | `opacity 1→0` + `scale 1→0.98`, 260ms `--e-inout`, overlapping by 160ms |
| art crossfade | 620ms `--e-out` (slower than content — the background should lag) |
| content stagger | eyebrow 0ms → headline 70ms → stat 140ms → body 210ms |
| progress bar | `transform: scaleX()` 0→1, **linear**, 5000ms, `transform-origin: left` |
| tap feedback | 90ms scale to 0.995 on the whole stage |
| direction | forward slides content up 18px; backward slides down 18px |

### 6.5 Micro-interactions

- Chips/buttons: `transform: scale(0.97)` on `:active`, 90ms.
- Theme toggle: `view-transition-name` on `<html>` with a 320ms circular reveal from the button,
  wrapped in `@supports (view-transition-name: x)` — cosmetic, fully optional.
- Share sheet: bottom sheet, `translateY(100%)→0`, 380ms `--e-out`, backdrop `blur(20px)` fading in
  over 240ms.
- **Never**: bounce, spring on layout, parallax on text, anything that runs while idle. There is no
  looping animation anywhere in this product except the Wrapped progress bar.

---

## 7. The three surfaces

### 7.1 Feed

Vertical scroll, one column, `scroll-behavior: smooth`, no snap (snap fights screenshotting).

Order of the first five cards is **fixed** — it's the opening of the album and it has to land:

1. **Cover** — the archetype card. `dune` art, full-bleed, the archetype name at `--t-d1`, the
   tagline, and `firstSeen → lastSeen` as a small date range. This is the card people screenshot.
2. **The headline stat** — highest-weight `stat` memory (usually total hours together).
3. **An `onthisday`** — the emotional hook, as early as possible.
4. **The clock chart** — "when you two talk". Universally interesting.
5. **A quote** — preferably the user's own, preferably at an absurd hour.

After that: weight-ordered, with a hard rule that **no two adjacent cards share a `kind`** and no
three consecutive cards share a family. `detect.js` returns weight-sorted; the renderer does the
interleave.

Header: sticky, 52px, `backdrop-filter: blur(24px)` over `rgb(6 7 10 / .72)`, containing the
wordmark left and a scroll-progress hairline at the bottom edge (`--a-1`, 1.5px, `scaleX`).

Dock (bottom center, `position: fixed`): `[ ▶ Wrapped ] [ ⇪ Share ] [ ◐ ]` — pill,
`--surface-2/.7`, `blur(20px)`, `--hairline` border, 44px tall (touch target), fades out while
scrolling and returns 240ms after scroll ends.

Footer: the offline promise, in `--t-meta`/`--ink-2`, centered:

> **Everything here was computed on your machine.** No network requests, no telemetry, nothing
> uploaded. This file works with your Wi-Fi off. — `npx codepend`

### 7.2 Wrapped — full-screen story mode

```
┌───────────────────────────────────────┐
│ ▬▬▬ ▬▬▬ ▬▬░ ─── ─── ─── ─── ───  ×    │  progress: 3px, gap 4px, top 12px, inset 12px
│                                       │
│              cover art                │  full-bleed, scrim-heavy (0.94 floor)
│              (family per slide)       │
│                                       │
│                                       │
│                                       │
│  EYEBROW                              │
│  The headline, up to 3 lines          │  content pinned bottom, 15% of height above bottom
│  one line of body                     │
│                                       │
│         codepend · npx codepend         │  --t-micro, ink-2, 0.5 opacity
└───────────────────────────────────────┘
   ← tap 35%          tap 65% →
```

- Full viewport, `100dvh`, `overscroll-behavior: none`, `<dialog>` with a real focus trap.
- **Slides:** 8–12, selected as the top-weighted `shareable` memories, always ending on the
  archetype card, always opening on a "hello" slide (`{firstSeen} → {lastSeen} · {activeDays} days`).
- Auto-advance 5000ms; **pause on `pointerdown`/hold** (Instagram grammar), resume on release.
- Tap zones: left 35% = back, right 65% = forward. `Esc` closes, `←/→` navigate, `Space` pauses.
- Content is bottom-pinned, not centered — leaves the art room and matches every story format
  people already know how to read.
- The last slide swaps the tap-right zone for a **Share** button and a **Replay** link.
- Reduced motion: no auto-advance, no scale transitions, progress bars render filled/unfilled.

### 7.3 Share Card — the viral unit

Two canvases, rendered client-side, no dependencies:

| preset | size | for |
|---|---|---|
| `wide` | **1200 × 675** | X/Twitter, LinkedIn, OG image |
| `tall` | **1080 × 1350** | Instagram feed, Threads |

**Rendering method — this matters, get it right.** Do *not* rasterize the whole card as SVG-in-image
(fonts inside an SVG-as-image render in an isolated context and can silently fall back). Instead:

1. Serialize **only the art SVG** (no text in it) to a `data:image/svg+xml;charset=utf-8,…` URL,
   `new Image()`, await `decode()`, `drawImage` at 2× the preset for retina.
2. Draw the scrim as a `createLinearGradient` in canvas — same stops as §2.4.
3. Draw **all text with `ctx.fillText`** using the same system stack string. Crisp, correct,
   Cyrillic-safe, no font loading.
4. Draw grain last: a deterministic 180×180 `ImageData` noise tile (seeded from the memory seed),
   `putImageData` to an offscreen canvas, then `createPattern(..., 'repeat')` fill at
   `globalAlpha = 0.055`, `globalCompositeOperation = 'overlay'`.
5. `canvas.toBlob('image/png')` → download + `navigator.clipboard.write` when available.

Data-URL SVG images do not taint the canvas (no `foreignObject`, no external refs — both banned
here). If `toBlob` throws anyway, fall back to showing the canvas inline with the caption
*"long-press / right-click to save"* — never fail silently.

**Layout, `tall` (1080×1350), all values at 1×:**

```
padding 88px
┌────────────────────────────────────────────┐
│  ▓ art, full bleed, scrim from y=740       │
│                                            │
│  ⬤⬜⬜                                      │  the ember mark, 88,88, 34px
│  ⬜⬤⬜   codepend                            │  wordmark 30px/700/-0.02em, ink-0
│  ⬜⬜⬤                                      │
│                                            │
│                                     y=760  │
│  EYEBROW · 20px/0.14em/ink-0@62%           │
│  2 026                                     │  --t-mega equivalent: 168px/800/-0.045em
│  hours together              ← unit 44px accent
│                                            │
│  One line of context, 30px, ink-1          │
│                                            │
│  ────────────────────────────────  hairline│
│  npx codepend          ·   100% local       │  22px/600/0.10em/ink-2
└────────────────────────────────────────────┘
```

`wide` (1200×675) is the same lockup rotated: mark + wordmark top-left, the stat lockup on the
left 58%, art unmasked on the right 42% with a horizontal scrim.

**On the share card, ALWAYS:** the wordmark + ember mark, exactly one number or one quote (never
both, never a list), the `npx codepend` footer, the `100% local` claim.

**On the share card, NEVER:**

- absolute or relative **file paths**, file names, or directory names
- **git branch names** (they leak ticket IDs and client names constantly)
- any **code**, diff, or command from the corpus
- **URLs, emails, tokens, IP addresses** — the redactor runs, but the share card additionally
  refuses to render any string matching the redactor's detectors, even at `--redact off`
- **client or company names** — unresolvable automatically, so: **project names are shown but the
  share sheet has a prominent `Hide project names` toggle**, defaulted OFF, and the sheet renders a
  live preview so nothing is ever posted unseen. At `--redact paranoid`, project names are replaced
  with `a project` and quotes are replaced by their word count.
- timestamps more precise than the hour
- anything the user hasn't seen in the preview. **The preview is the artifact.** No "we'll generate
  it on download."

**The ember mark.** A 3×3 grid of 7px dots, 5px gap, radius 1.5px. Dots are lit according to the
user's last 9 active days (active = `--a-1` at 1.0α, idle = `--ink-0` at 0.18α). Deterministic,
personal, and it makes the mark different in every screenshot — which is exactly why people repost
it. Falls back to the diagonal (3 lit) when there's no data.

---

## 8. Empty / new-user state

Someone who installed Claude Code yesterday must still get something worth screenshotting. The
design target is **2 days of history, 6 prompts** — and it should feel like the *beginning* of an
album, not a broken one.

**Copy shifts from retrospective to prospective.** Never "not enough data". Never a percentage of
completion. Never a progress bar toward "unlocking" anything.

Guaranteed minimum feed (5 cards, always renderable from a single session):

1. **Cover** — archetype still computes; with thin data it resolves to `The New Arrival`,
   *"Two days in. The album's just been opened."* `dune` art, sun present (forced), warm anchor
   hues (16–68) — the palette biases warm for new users because dawn is the right metaphor.
2. **"Your opening line"** — a quote card with the very first human prompt, verbatim. This is
   almost always funny or endearing on its own (`"hey can you look at this repo"`), and it's the
   card new users post.
3. **"First contact"** — `onthisday` styled card with the exact timestamp of the first prompt,
   headline `You met on Tuesday at 21:47`.
4. **One honest stat** — whatever is largest and true: `6 prompts`, `41 minutes`, `1 project`. Small
   numbers set at `--t-mega` are charming, not embarrassing — the typography carries it.
5. **`contour` chart of the two days** — the cheapest family, and a 2-point sparkline set as a
   topographic line reads as *potential* rather than as an empty chart.

**Degradation rules:**

| condition | behavior |
|---|---|
| `activeDays < 7` | no `heat` chart (a 2-cell heatmap looks broken) → `spark` instead |
| `humanTurns < 20` | no "top quotes" section; the single first-prompt quote card only |
| one project | project chip becomes the git branch, or is dropped entirely |
| one model | donut becomes a stat card |
| zero sessions found | **not an empty state — an error state.** Full-viewport `dune` art, "We couldn't find any agent history on this machine," then the two paths it looked in, in `--f-mono`/`--ink-2`, and a line about `--claude-dir` / `--codex-dir`. Still beautiful. Still shareable, honestly. |

A closing card in every thin-data feed: *"Come back in a month. This gets much weirder."* —
`--t-d2`, centered, on plain `--paper`, no art. The restraint is the joke.

---

## 9. Accessibility

Non-negotiable, all of it.

**Contrast.** Every pair in the ledger (§1) is ≥4.5:1; large display type is ≥3:1 by a wide margin.
Over art, only `--ink-0` and `--ink-0@62%` (§3.4). Accent-on-surface is decorative only — never the
sole carrier of meaning, and never used for text below 18px.

```css
@media (prefers-contrast: more) {
  :root { --ink-1: #DAD6D0; --ink-2: #ADA79E; --scrim-max: .94; --hairline: #ffffff2e; }
  .card__art { opacity: .55; }
}
```

**Motion.** §6 — reduced-motion removes rather than shortens. Auto-advance in Wrapped is *disabled*
under reduced motion (an unstoppable 5s timer is a vestibular and a cognitive problem).

**Keyboard.** Wrapped is a `<dialog>` with a focus trap: `Tab` cycles [close, prev, next, share],
`←/→` navigate, `Space` pause/resume, `Esc` close and return focus to the invoking button. The feed
is navigable with `Tab`; each card is a landmark, not a button (cards aren't clickable — nothing to
activate), with the share affordance as a real `<button>` inside.

```css
:where(a, button, [tabindex]):focus-visible {
  outline: 2px solid var(--a-1); outline-offset: 3px; border-radius: 6px;
  box-shadow: 0 0 0 5px rgb(var(--scrim-color) / .9);  /* halo so the ring reads over art */
}
```

**Screen readers.**

- Each cover: `<svg role="img" aria-label="…">` with a generated description from family + palette
  hue name + kind — e.g. `"Abstract cover: teal orbital rings"`. `aria-hidden` is *wrong* here;
  a described decorative image is better than a silent one in a product that is entirely images.
- Stat lockups: `<span class="sr-only">` carries the full sentence (`"2,026 hours together"`) and
  the visual parts are `aria-hidden`, so the reader doesn't announce `"2026"` then `"hours"` then
  `"together"` as three fragments.
- Charts: each gets a `<figure>` with a `<figcaption class="sr-only">` containing the same data as a
  sentence or a compact table. No chart is ever the only route to a fact.
- Wrapped: `aria-live="polite"` on the slide container announces each slide's headline once;
  progress announced as `"Slide 4 of 11"`.
- Language: `<html lang="en">`, and any element containing a Cyrillic quote gets `lang="ru"` so
  screen readers switch voice instead of spelling Latin phonemes over Russian.

**Other.**

- Touch targets ≥ 44×44 including the Wrapped tap zones (they're full-height, fine).
- `prefers-reduced-transparency` → grain off, `backdrop-filter` replaced with solid `--surface-2`.
- Works at 200% browser zoom and at `font-size: 24px` root — every size is `rem`/`em`/`clamp`, no
  fixed-px containers except the share canvas.
- `<noscript>`: a plain, styled text summary (archetype, top 5 stats, date range) rendered into the
  document at build time, so the file is never a blank page.
- Never conveys anything by color alone — every accent-colored element is redundant with a label.

---

## 10. Implementation checklist

For whoever writes `src/app/app.css`:

- [ ] Tokens verbatim from §1, including the ledger comment values
- [ ] `.grain` overlay, one instance, exactly the data-URI in §1.1
- [ ] `content-visibility: auto` + `contain-intrinsic-size` on `.card`
- [ ] No `box-shadow` used as a border anywhere; `--hairline` only
- [ ] Reduced-motion block present and *first* in the motion section

For `src/art.js`:

- [ ] `n()` 2-dp formatter on **every** emitted number
- [ ] mulberry32, no `Math.random`
- [ ] Unique `{id}` suffix on all `<defs>` ids
- [ ] `taper(y)` applied in all six families
- [ ] Node-count caps enforced (§1.2, §2.3)
- [ ] Golden-seed hash test + 1000-seed palette guardrail sweep

For `src/render.js`:

- [ ] Theme bootstrap script inlined **before** the stylesheet (no FOUC)
- [ ] `<noscript>` summary block
- [ ] Per-card inline `--a-1..--a-bg` from `palette(seed)`
- [ ] Feed opening order and the no-adjacent-duplicate-kind interleave
