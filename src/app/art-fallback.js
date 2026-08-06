/* ============================================================================
   codepend — art-fallback.js

   A complete, spec-shaped implementation of the cover-art contract, used ONLY
   when `src/art.js` is not present on disk at render time (src/render.js
   prefers the real module and never loads this one if it exists).

   It follows docs/DESIGN.md §2–§3: mulberry32, 2-dp number formatting, OKLCH
   palettes snapped to the 14 hue anchors, taper(y) in every family, unique
   defs ids, and the gradient scrim as the last child.
   ========================================================================== */

/** 2 dp kills cross-engine ULP drift in the emitted string. */
const n = (v) => { const r = Math.round(v * 100) / 100; return Object.is(r, -0) ? '0' : String(r); };

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const lerp = (r, a, b) => a + (b - a) * r();
const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
/** Amplitude/opacity multiplier that keeps the floor zone quiet (§2.2). */
const taper = (y) => 1 - 0.92 * smooth(0.56, 0.78, y);

/* ── OKLCH → sRGB ─────────────────────────────────────────────────────── */

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
const encode = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const inGamut = (v) => v.every((c) => c >= -1e-4 && c <= 1 + 1e-4);

export function oklch(L, C, H) {
  let lo = 0, hi = C;
  if (inGamut(oklchToLinear(L, C, H))) lo = C;
  else for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(oklchToLinear(L, mid, H))) lo = mid; else hi = mid;
  }
  const v = oklchToLinear(L, lo, H).map((c) => Math.round(Math.min(1, Math.max(0, encode(c))) * 255));
  return '#' + v.map((x) => x.toString(16).padStart(2, '0')).join('');
}

const ANCHORS = [16, 34, 52, 68, 148, 168, 190, 212, 236, 258, 280, 302, 326, 348];

/**
 * @param {number} seed
 * @param {'dark'|'light'} [theme]
 * @returns {{bg:string, fg:string, accents:string[]}}
 */
export function palette(seed, theme = 'dark') {
  const r = rng((seed ^ 0x9E3779B9) >>> 0);
  const H0 = ANCHORS[seed % ANCHORS.length] + (r() * 10 - 5);
  const scheme = pick(r, ['analogous', 'split', 'duo', 'triadNarrow']);
  const d = { analogous: [0, 22, -18], split: [0, 156, 204], duo: [0, 180, 12], triadNarrow: [0, 96, -96] }[scheme];
  const H = d.map((x) => (H0 + x + 360) % 360);
  const dark = theme !== 'light';
  const L = dark ? [0.74, 0.63, 0.82] : [0.56, 0.46, 0.66];
  const C = [0.135, 0.160, 0.085].map((c) => c * (0.86 + r() * 0.28));
  return {
    bg: oklch(dark ? 0.16 : 0.965, dark ? 0.035 : 0.012, H0),
    fg: dark ? '#F4F1EC' : '#12100D',
    accents: [oklch(L[0], C[0], H[0]), oklch(L[1], C[1], H[1]), oklch(L[2], C[2], H[2])],
  };
}

const FAMILY = {
  onthisday: 'drift', stat: 'orbit', quote: 'constellation',
  chart: 'contour', award: 'spectra', profile: 'dune',
};
const ALT = {
  drift: 'dune', orbit: 'spectra', constellation: 'drift',
  contour: 'orbit', spectra: 'constellation', dune: 'contour',
};

/** 1-in-8 deterministic swap so a long feed never looks templated. */
export function familyFor(kind, seed) {
  const f = FAMILY[kind] || 'dune';
  return (seed >>> 29) === 7 ? ALT[f] : f;
}

/* ── families ─────────────────────────────────────────────────────────── */

function drift(r, P, W, H, id) {
  const k = [lerp(r, 1.6, 4.2), lerp(r, 1.6, 4.2), lerp(r, 1.6, 4.2)];
  const ph = [r() * 6.283, r() * 6.283, r() * 6.283];
  const A = [lerp(r, 0.5, 1.4), lerp(r, 0.5, 1.4), lerp(r, 0.5, 1.4)];
  const N = 5 + Math.floor(r() * 5);
  const theta = (x, y) => A[0] * Math.sin(k[0] * x + ph[0]) + A[1] * Math.sin(k[1] * y + ph[1])
    + A[2] * Math.sin(k[2] * (x + y) + ph[2]);
  let back = '', front = '';
  for (let i = 0; i < N; i++) {
    let x = lerp(r, -0.1, 0.25), y = lerp(r, 0.14, 0.52);
    const w = lerp(r, 10, 34);
    let d = `M${n(x * W)},${n(y * H)}`;
    for (let s = 0; s < 48; s++) {
      const t = theta(x, y);
      x += Math.cos(t) * 0.028; y += Math.sin(t) * 0.028 * 0.7;
      if (x < -0.2 || x > 1.2 || y < -0.1 || y > 1.1) break;
      d += `L${n(x * W)},${n(y * H)}`;
    }
    const op = (0.85 - (i / N) * 0.6) * taper(y);
    const acc = i % 3 === 0 ? P.accents[1] : P.accents[0];
    const path = `<path d="${d}" fill="none" stroke="${acc}" stroke-width="${n(w)}" stroke-linecap="round" opacity="${n(Math.max(0.06, op))}"/>`
      + `<path d="${d}" fill="none" stroke="${P.accents[2]}" stroke-width="${n(w * 0.35)}" stroke-linecap="round" opacity="${n(Math.max(0.04, op * 0.5))}"/>`;
    if (i < N * 0.4) back += path; else front += path;
  }
  return `<g filter="url(#bl${id})">${back}</g>${front}`;
}

function orbit(r, P, W, H, id) {
  const cx = (0.5 + lerp(r, -0.08, 0.08)) * W, cy = (0.36 + lerp(r, -0.06, 0.06)) * H;
  const N = 3 + Math.floor(r() * 4);
  const r0 = lerp(r, 0.10, 0.16), rot0 = r() * 180, dRot = lerp(r, -14, 14);
  let out = '';
  for (let i = 0; i < N; i++) {
    const rr = r0 * Math.pow(1.34, i);
    const e = lerp(r, 0.55, 0.95);
    const rx = rr * W, ry = rr * H * e;
    const rot = rot0 + i * dRot;
    const dash = `${n(lerp(r, 40, 160))} ${n(lerp(r, 14, 46))}`;
    const op = (0.72 - i * 0.09) * taper(0.36 + rr * e);
    out += `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(rx)}" ry="${n(ry)}" fill="none"
      stroke="${i % 2 ? P.accents[1] : P.accents[0]}" stroke-width="${n(2.5 - i * 0.3)}"
      stroke-dasharray="${dash}" stroke-dashoffset="${n(r() * 200)}"
      opacity="${n(Math.max(0.08, op))}" transform="rotate(${n(rot)} ${n(cx)} ${n(cy)})"/>`;
    if (i > 0 && r() > 0.55) {
      const t = r() * 6.283;
      out += `<circle cx="${n(cx + Math.cos(t) * rx)}" cy="${n(cy + Math.sin(t) * ry)}" r="${n(lerp(r, 3, 7))}" fill="${P.accents[2]}" opacity="0.9"/>`;
    }
  }
  out += `<g filter="url(#bl${id})"><circle cx="${n(cx)}" cy="${n(cy)}" r="${n(lerp(r, 12, 26))}" fill="${P.accents[2]}" opacity="0.5"/></g>`;
  out += `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(lerp(r, 4, 9))}" fill="${P.accents[2]}"/>`;
  return out;
}

function constellation(r, P, W, H, id) {
  const M = 40 + Math.floor(r() * 41);
  const g = Math.ceil(Math.sqrt(M));
  const ax = lerp(r, 0.25, 0.75), ay = lerp(r, 0.18, 0.5);
  const pts = [];
  for (let i = 0; i < M; i++) {
    const cx = ((i % g) + 0.5) / g, cy = (Math.floor(i / g) + 0.5) / g;
    const x = cx + (r() - 0.5) * 0.84 / g, y = cy + (r() - 0.5) * 0.84 / g;
    const dist = Math.hypot(x - ax, y - ay);
    const bright = Math.max(0.1, 1 - dist * 1.6) * taper(y);
    pts.push({ x, y, b: bright, rad: lerp(r, 0.8, 3.4) });
  }
  let out = '';
  let links = 0;
  for (let i = 0; i < pts.length && links < 18; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
      if (d < 0.085 && pts[i].b > 0.5 && pts[j].b > 0.5) {
        out += `<line x1="${n(pts[i].x * W)}" y1="${n(pts[i].y * H)}" x2="${n(pts[j].x * W)}" y2="${n(pts[j].y * H)}" stroke="${P.accents[2]}" stroke-width="0.6" opacity="0.22"/>`;
        links++; break;
      }
    }
  }
  pts.forEach((p, i) => {
    const big = i % 19 === 3 && p.b > 0.55;
    out += `<circle cx="${n(p.x * W)}" cy="${n(p.y * H)}" r="${n(big ? p.rad + 2.6 : p.rad)}" fill="${big ? P.accents[0] : P.accents[i % 3]}" opacity="${n(Math.max(0.12, Math.min(1, p.b)))}"/>`;
  });
  return `<g filter="url(#bl${id})"><circle cx="${n(ax * W)}" cy="${n(ay * H)}" r="${n(W * 0.22)}" fill="${P.accents[1]}" opacity="0.16"/></g>${out}`;
}

function contour(r, P, W, H, id) {
  const bumps = [];
  for (let i = 0; i < 3; i++) {
    bumps.push({
      cx: lerp(r, 0.2, 0.8), cy: lerp(r, 0.16, 0.5),
      s: lerp(r, 0.12, 0.30), a: (i === 2 && r() > 0.6 ? -1 : 1) * lerp(r, 0.5, 1),
    });
  }
  const f = (x, y) => bumps.reduce((s, b) =>
    s + b.a * Math.exp(-(((x - b.cx) ** 2 + (y - b.cy) ** 2) / (b.s * b.s))), 0);
  const L = 7 + Math.floor(r() * 6);
  const cx = bumps[0].cx, cy = bumps[0].cy;
  let out = '';
  for (let i = 0; i < L; i++) {
    const t = (i + 1) / (L + 1);
    const base = 0.06 + Math.pow(t, 1.25) * 0.46;
    let d = '';
    const STEPS = 84;
    for (let s = 0; s <= STEPS; s++) {
      const a = (s / STEPS) * Math.PI * 2;
      // radius modulated by the height field — cheap isolines that read as topography
      const probeX = cx + Math.cos(a) * base, probeY = cy + Math.sin(a) * base * 0.9;
      const rr = base * (0.82 + 0.34 * f(probeX, probeY));
      const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr * 0.92;
      d += `${s ? 'L' : 'M'}${n(x * W)},${n(y * H)}`;
    }
    d += 'Z';
    const yLow = cy + base;
    const op = (0.7 - (i / L) * 0.5) * taper(yLow);
    out += `<path d="${d}" fill="none" stroke="${i % 3 === 0 ? P.accents[0] : P.accents[2]}" stroke-width="${n(i < 2 ? 1.8 : 1.2)}" opacity="${n(Math.max(0.08, op))}"/>`;
  }
  return `<g filter="url(#bl${id})"><ellipse cx="${n(cx * W)}" cy="${n(cy * H)}" rx="${n(W * 0.3)}" ry="${n(H * 0.16)}" fill="${P.accents[1]}" opacity="0.14"/></g>${out}`;
}

function spectra(r, P, W, H, id) {
  const B = 5 + Math.floor(r() * 5);
  const raw = [], out = [];
  let sum = 0;
  for (let i = 0; i < B; i++) { const v = 0.4 + r(); raw.push(v); sum += v; }
  let x = 0, defs = '', body = '';
  for (let i = 0; i < B; i++) {
    const w = (raw[i] / sum) * W;
    const gid = `sp${id}_${i}`;
    const c = P.accents[i % 3];
    defs += `<linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${c}" stop-opacity="${n(0.5 + (i % 2) * 0.28)}"/>
      <stop offset="0.62" stop-color="${c}" stop-opacity="0.16"/>
      <stop offset="1" stop-color="${P.bg}" stop-opacity="1"/></linearGradient>`;
    body += `<rect x="${n(x)}" y="0" width="${n(w + 1)}" height="${n(H)}" fill="url(#${gid})"/>`;
    x += w;
    out.push(w);
  }
  let flare = '';
  const fl = 1 + Math.floor(r() * 2);
  for (let i = 0; i < fl; i++) {
    const fy = lerp(r, 0.16, 0.5) * H;
    flare += `<rect x="0" y="${n(fy)}" width="${n(W)}" height="${n(lerp(r, 20, 70))}" fill="${P.accents[2]}" opacity="${n(lerp(r, 0.10, 0.18))}"/>`;
  }
  return `<defs>${defs}</defs><g filter="url(#bl${id})">${body}${flare}</g>`;
}

/** Blend two hexes in sRGB. Good enough for a depth ramp, and cheap. */
function mixHex(a, b, t) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [r1, g1, b1] = p(a), [r2, g2, b2] = p(b);
  const c = [r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t];
  return '#' + c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');
}

function dune(r, P, W, H, id) {
  const K = 4 + Math.floor(r() * 4);
  let out = `<defs><linearGradient id="sky${id}" x1="0" y1="0" x2="0" y2="1">`
    + `<stop offset="0" stop-color="${mixHex(P.bg, P.accents[2], 0.30)}"/>`
    + `<stop offset="0.55" stop-color="${mixHex(P.bg, P.accents[0], 0.16)}"/>`
    + `<stop offset="1" stop-color="${P.bg}"/></linearGradient></defs>`
    + `<rect width="${W}" height="${H}" fill="url(#sky${id})"/>`;
  if (r() > 0.66) {
    const sy = lerp(r, 0.20, 0.30) * H, sx = lerp(r, 0.25, 0.75) * W;
    out += `<g filter="url(#bl${id})"><circle cx="${n(sx)}" cy="${n(sy)}" r="${n(W * lerp(r, 0.10, 0.17))}" fill="${P.accents[2]}" opacity="0.55"/></g>`;
  }
  for (let i = 0; i < K; i++) {
    const t = i / (K - 1);
    const base = 0.30 + t * 0.44;
    const amp = 0.075 - t * 0.057;
    const k = [lerp(r, 1.2, 3.6), lerp(r, 1.2, 3.6), lerp(r, 1.2, 3.6)];
    const ph = [r() * 6.283, r() * 6.283, r() * 6.283];
    const a = [amp, amp * 0.5, amp * 0.28];
    let d = `M0,${n(H)}`;
    for (let s = 0; s <= 40; s++) {
      const x = s / 40;
      const y = base + a[0] * Math.sin(k[0] * x * 6.283 + ph[0])
        + a[1] * Math.sin(k[1] * x * 6.283 + ph[1]) + a[2] * Math.sin(k[2] * x * 6.283 + ph[2]);
      d += `L${n(x * W)},${n(y * H)}`;
    }
    d += `L${n(W)},${n(H)}Z`;
    // Inverted aerial perspective on ONE hue: bright at the back, --a-bg at the
    // front. Mixing separate accents per layer is what makes dunes look muddy.
    const baseCol = i % 3 === 1 ? P.accents[1] : P.accents[0];
    const col = mixHex(mixHex(baseCol, P.accents[2], i === 0 ? 0.5 : 0), P.bg, 0.18 + t * 0.74);
    out += `<path d="${d}" fill="${col}"/>`;
  }
  return out;
}

const FAMILIES = { drift, orbit, constellation, contour, spectra, dune };

/**
 * @param {number} seed uint32
 * @param {'onthisday'|'stat'|'quote'|'chart'|'award'|'profile'} kind
 * @param {{w?:number,h?:number,theme?:'dark'|'light',blur?:boolean}} [opts]
 * @returns {string} complete `<svg>…</svg>`
 */
export function coverArt(seed, kind, opts) {
  const o = opts || {};
  const W = o.w || 1000, H = o.h || 1250;
  const theme = o.theme === 'light' ? 'light' : 'dark';
  const P = palette(seed >>> 0, theme);
  const id = (seed >>> 0).toString(36);
  const fam = familyFor(kind, seed >>> 0);
  const r = rng(seed >>> 0);
  const sd = o.blur === false ? 6 : 18;
  const body = (FAMILIES[fam] || dune)(r, P, W, H, id);
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">`
    + `<defs>`
    + `<linearGradient id="s${id}" x1="0" y1="0" x2="0" y2="1">`
    + `<stop offset="0" stop-color="rgb(var(--scrim-color))" stop-opacity="0.34"/>`
    + `<stop offset="0.42" stop-color="rgb(var(--scrim-color))" stop-opacity="0.10"/>`
    + `<stop offset="0.62" stop-color="rgb(var(--scrim-color))" stop-opacity="0.56"/>`
    + `<stop offset="0.78" stop-color="rgb(var(--scrim-color))" stop-opacity="0.88"/>`
    + `<stop offset="1" stop-color="rgb(var(--scrim-color))" stop-opacity="0.94"/>`
    + `</linearGradient>`
    + `<filter id="bl${id}" x="-25%" y="-25%" width="150%" height="150%"><feGaussianBlur stdDeviation="${sd}"/></filter>`
    + `</defs>`
    + `<rect width="${W}" height="${H}" fill="${P.bg}"/>`
    + body
    + `<rect width="${W}" height="${H}" fill="url(#s${id})"/>`
    + `</svg>`;
}
