import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { coverArt, coverLabel, palette, oklch, familyFor, FAMILIES, _internals } from '../src/art.js';

const { build, paletteFull, oklabOf, luminance, SCRIM_STOPS } = _internals;

const KINDS = ['onthisday', 'stat', 'quote', 'chart', 'award', 'profile'];

/** Seeds spread across the uint32 range: hits every hue anchor and the 1-in-8 alt-family swap. */
const seeds = (count) => {
  const out = [];
  for (let i = 0; i < count; i++) out.push((((i * 2654435761) >>> 0) ^ (i * 977) ^ (i << 13)) >>> 0);
  return out;
};

const bytes = (s) => Buffer.byteLength(s, 'utf8');
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const pct = (arr, q) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

/** WCAG contrast between two relative luminances. */
const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

const INK_0 = { dark: luminance('#F4F1EC'), light: luminance('#12100D') };
const SCRIM = { dark: luminance('#05060A'), light: luminance('#FAF7F2') };
const SCRIM_MAX = { dark: 0.88, light: 0.9 };

/* ───────────────────────────── determinism ───────────────────────────── */

test('same seed and kind produce byte-identical SVG', () => {
  for (const s of seeds(300)) {
    for (const k of KINDS) {
      assert.equal(coverArt(s, k), coverArt(s, k), `seed ${s} kind ${k}`);
    }
  }
});

test('no state leaks between calls — interleaved order does not change output', () => {
  const list = seeds(60);
  const straight = list.map((s) => coverArt(s, 'onthisday'));
  // Render the same seeds again, but with unrelated work interleaved. A shared rng, a module-level
  // accumulator or a reused array would show up here and nowhere else.
  const interleaved = list.map((s, i) => {
    coverArt(list[(i * 7 + 3) % list.length], 'award', { theme: 'light', quality: 'lite' });
    palette(s ^ 0xabcdef);
    return coverArt(s, 'onthisday');
  });
  assert.deepEqual(interleaved, straight);
});

test('opts variants are each internally deterministic', () => {
  const variants = [
    { theme: 'light' },
    { quality: 'lite' },
    { w: 1200, h: 675 },
    { w: 1080, h: 1350, theme: 'light' },
    { w: 400, h: 500 },
  ];
  for (const s of seeds(40)) {
    for (const v of variants) {
      assert.equal(coverArt(s, 'stat', v), coverArt(s, 'stat', v));
    }
  }
});

test('palette is deterministic and independent of theme call order', () => {
  for (const s of seeds(200)) {
    const a = palette(s);
    palette(s ^ 1, 'light');
    assert.deepEqual(palette(s), a);
  }
});

/**
 * Golden hashes pin the *exact* output for a fixed set of seeds, so an accidental change to the
 * geometry, the palette or the emit format cannot land unnoticed — and so a future engine or
 * refactor that quietly perturbs a float gets caught. A deliberate art change is expected to
 * update the table: regenerate with `node test/art.golden.mjs --write`.
 */
test('golden seeds match their committed hashes', () => {
  const golden = JSON.parse(readFileSync(new URL('./art.golden.json', import.meta.url), 'utf8'));
  const keys = Object.keys(golden);
  assert.ok(keys.length >= 20, 'expected at least 20 golden seeds');
  for (const key of keys) {
    const [seedStr, kind, variant, family] = key.split('|');
    const opts = variant === 'light' ? { theme: 'light' } : variant === 'lite' ? { quality: 'lite' } : {};
    if (family) opts.family = family;
    assert.equal(sha(coverArt(Number(seedStr), kind, opts)), golden[key], `golden drift: ${key}`);
  }
  // …and the table must actually reach every family in every variant. The kind-driven rows alone
  // do not: 6 kinds against 3 variants advance in lockstep, so a third of the family × variant
  // grid was never pinned at all and a change to it could land with this test still green.
  for (const f of FAMILIES) {
    for (const v of ['', 'light', 'lite']) {
      assert.ok(
        keys.some((k) => k.endsWith(`|${v}|${f}`)),
        `golden table has no explicit ${f} row for variant "${v || 'dark'}"`,
      );
    }
  }
});

/* ───────────────────────────── size budget ───────────────────────────── */

test('cover SVGs stay inside the size budget', () => {
  const all = [];
  const perFamily = {};
  for (const f of FAMILIES) perFamily[f] = [];
  for (const s of seeds(200)) {
    for (const f of FAMILIES) {
      const size = bytes(coverArt(s, 'onthisday', { family: f }));
      all.push(size);
      perFamily[f].push(size);
    }
  }
  const max = Math.max(...all);
  // Hard cap from the task brief; DESIGN §1.2 asks for ≤ 6 KB, which the p95 holds.
  assert.ok(max <= 25 * 1024, `max ${max} exceeds the 25 KB hard cap`);
  assert.ok(pct(all, 0.95) <= 8 * 1024, `p95 ${pct(all, 0.95)} exceeds 8 KB`);
  assert.ok(pct(all, 0.5) <= 6 * 1024, `p50 ${pct(all, 0.5)} exceeds the 6 KB DESIGN budget`);
  for (const f of FAMILIES) {
    assert.ok(
      Math.max(...perFamily[f]) <= 12 * 1024,
      `${f} max ${Math.max(...perFamily[f])} exceeds 12 KB`,
    );
  }
});

test('node counts stay inside the per-family caps', () => {
  // DESIGN §2.3 caps, plus the shared background rect, the scrim rect and grouping elements.
  const CAP = { drift: 34, orbit: 26, constellation: 86, contour: 16, spectra: 24, dune: 16 };
  const re = /<(circle|path|rect|ellipse|use|line|polyline|polygon|image|g)\b/g;
  for (const s of seeds(200)) {
    for (const f of FAMILIES) {
      const svg = coverArt(s, 'onthisday', { family: f });
      const count = (svg.match(re) || []).length;
      assert.ok(count <= CAP[f], `${f} emitted ${count} nodes (cap ${CAP[f]}) for seed ${s}`);
    }
  }
});

/* ─────────────────────────── palette guardrails ─────────────────────── */

test('palette guardrails hold across 400 seeds in both themes', () => {
  for (const theme of ['dark', 'light']) {
    for (const s of seeds(400)) {
      const P = paletteFull(s, theme);

      for (const c of P.C) {
        assert.ok(c <= 0.185, `chroma ${c} above the 0.185 ceiling (seed ${s})`);
      }

      const bg = oklabOf(P.bg);
      if (theme === 'dark') {
        assert.ok(bg.L >= 0.13 && bg.L <= 0.2, `dark bg L ${bg.L} outside band (seed ${s})`);
      } else {
        assert.ok(bg.L >= 0.95 && bg.L <= 0.98, `light bg L ${bg.L} outside band (seed ${s})`);
      }
      assert.ok(bg.C <= 0.04, `bg chroma ${bg.C} — the tint must stay a tinted neutral (seed ${s})`);

      for (const hex of P.accents) {
        const a = oklabOf(hex);
        assert.ok(a.L >= 0.42 && a.L <= 0.86, `accent L ${a.L} outside band (seed ${s})`);
        // Never brighter than --ink-0's perceptual lightness (0.94).
        assert.ok(a.L < 0.94, `accent L ${a.L} rivals the headline ink (seed ${s})`);
        assert.ok(
          Math.abs(a.L - bg.L) >= 0.3,
          `accent/bg ΔL ${Math.abs(a.L - bg.L)} too low (seed ${s}, ${theme})`,
        );
      }

      // Hue spread: wider than 210° and the card has no identity.
      const hues = P.H;
      let spread = 0;
      for (let i = 0; i < hues.length; i++) {
        for (let j = i + 1; j < hues.length; j++) {
          let d = Math.abs(hues[i] - hues[j]) % 360;
          if (d > 180) d = 360 - d;
          if (d > spread) spread = d;
        }
      }
      assert.ok(spread <= 210, `hue spread ${spread}° too wide (seed ${s})`);
    }
  }
});

test('a memory keeps its hue identity across themes', () => {
  for (const s of seeds(200)) {
    const d = paletteFull(s, 'dark');
    const l = paletteFull(s, 'light');
    assert.deepEqual(l.H, d.H, `hues drifted between themes for seed ${s}`);
    assert.equal(l.hueName, d.hueName);
    // Only lightness/chroma move.
    assert.ok(oklabOf(l.accents[0]).L < oklabOf(d.accents[0]).L);
  }
});

test('oklch clamps into gamut and is stable', () => {
  for (let h = 0; h < 360; h += 7) {
    for (const L of [0.16, 0.44, 0.63, 0.74, 0.86, 0.965]) {
      const hex = oklch(L, 0.32, h); // deliberately out of gamut
      assert.match(hex, /^#[0-9a-f]{6}$/);
      assert.equal(hex, oklch(L, 0.32, h));
      assert.ok(Math.abs(oklabOf(hex).L - L) < 0.02, `L drifted for ${L}/${h}: ${hex}`);
    }
  }
});

/* ──────────────────────── the readability guarantee ──────────────────── */

test('nothing bright is painted into the floor zone', () => {
  for (const theme of ['dark', 'light']) {
    for (const s of seeds(200)) {
      for (const f of FAMILIES) {
        const { floor } = build(s, 'onthisday', { family: f, theme });
        for (const c of floor) {
          // Composite the registered fill over its own tint, as it lands on screen.
          const y = c.alpha * luminance(c.hex);
          if (theme === 'dark') {
            assert.ok(y <= 0.55, `${f} paints Y=${y} into the floor (seed ${s})`);
          } else {
            assert.ok(y >= 0.45, `${f} paints Y=${y} into the light floor (seed ${s})`);
          }
        }
      }
    }
  }
});

test('headline ink clears 4.5:1 over the worst floor composite', () => {
  for (const theme of ['dark', 'light']) {
    let worst = Infinity;
    for (const s of seeds(200)) {
      for (const f of FAMILIES) {
        const { floor } = build(s, 'onthisday', { family: f, theme });
        for (const c of floor) {
          const art = c.alpha * luminance(c.hex);
          // Scrim over art, at the alpha the floor stops guarantee.
          const composite = SCRIM_MAX[theme] * SCRIM[theme] + (1 - SCRIM_MAX[theme]) * art;
          worst = Math.min(worst, contrast(INK_0[theme], composite));
        }
      }
    }
    assert.ok(worst >= 4.5, `${theme}: headline contrast falls to ${worst.toFixed(2)}:1`);
  }
});

test('every cover carries the scrim with the invariant stops', () => {
  for (const s of seeds(60)) {
    for (const f of FAMILIES) {
      const svg = coverArt(s, 'onthisday', { family: f });
      const id = `s${(s >>> 0).toString(36)}`;
      const grad = svg.match(new RegExp(`<linearGradient id="${id}"[^>]*>(.*?)</linearGradient>`));
      assert.ok(grad, `scrim gradient missing for seed ${s}`);
      const stops = [...grad[1].matchAll(/offset="([^"]+)"[^>]*stop-opacity="([^"]+)"/g)].map((m) => [
        m[1],
        m[2],
      ]);
      assert.deepEqual(stops, SCRIM_STOPS, `scrim stops altered for ${f}`);
      // …and it is the last thing drawn, over everything else.
      assert.ok(svg.endsWith(`fill="url(#${id})"/></svg>`), 'scrim must be the final child');
    }
  }
});

test('the scrim colour follows the theme, with a working fallback for data: URLs', () => {
  const dark = coverArt(7, 'onthisday');
  const light = coverArt(7, 'onthisday', { theme: 'light' });
  assert.match(dark, /--sc:rgb\(var\(--scrim-color,5 6 10\)\)/);
  assert.match(light, /--sc:rgb\(var\(--scrim-color,250 247 242\)\)/);
});

/* ─────────────────────────── structural safety ──────────────────────── */

test('ids are seed-scoped so covers can share one document', () => {
  const a = coverArt(1234, 'onthisday');
  const b = coverArt(5678, 'stat');
  const idsOf = (svg) => [...svg.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  const ia = new Set(idsOf(a));
  const ib = idsOf(b);
  assert.ok(ia.size > 0);
  for (const id of ib) assert.ok(!ia.has(id), `id collision on "${id}"`);
});

test('every url(#…) reference resolves inside its own cover', () => {
  for (const s of seeds(120)) {
    for (const f of FAMILIES) {
      const svg = coverArt(s, 'onthisday', { family: f });
      const declared = new Set([...svg.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
      for (const m of svg.matchAll(/url\(#([^)]+)\)/g)) {
        assert.ok(declared.has(m[1]), `${f} references undeclared #${m[1]} (seed ${s})`);
      }
      for (const m of svg.matchAll(/href="#([^"]+)"/g)) {
        assert.ok(declared.has(m[1]), `${f} references undeclared #${m[1]} (seed ${s})`);
      }
    }
  }
});

test('output is a single well-formed svg root with no NaN or undefined leaking in', () => {
  for (const s of seeds(120)) {
    for (const k of KINDS) {
      const svg = coverArt(s, k);
      assert.ok(svg.startsWith('<svg '), 'must start with the root element');
      assert.ok(svg.endsWith('</svg>'), 'must end with the root element');
      assert.equal(svg.split('<svg ').length, 2, 'exactly one root');
      assert.doesNotMatch(svg, /NaN|undefined|null|Infinity/);
      assert.doesNotMatch(svg, /="\s*"/, 'empty attribute value');
      // Every element opened is closed: SVG has no implicit closing.
      const opens = (svg.match(/<[a-zA-Z]/g) || []).length;
      const selfClose = (svg.match(/\/>/g) || []).length;
      const closes = (svg.match(/<\//g) || []).length;
      assert.equal(opens, selfClose + closes, `unbalanced tags for seed ${s} kind ${k}`);
    }
  }
});

test('covers are aspect-agnostic', () => {
  for (const [w, h] of [
    [1000, 1250],
    [1200, 675],
    [1080, 1350],
    [560, 560],
    [390, 844],
  ]) {
    const svg = coverArt(99, 'chart', { w, h });
    assert.ok(svg.includes(`viewBox="0 0 ${w} ${h}"`), `viewBox missing for ${w}×${h}`);
    assert.ok(svg.includes('preserveAspectRatio="xMidYMid slice"'));
    assert.ok(bytes(svg) <= 25 * 1024);
  }
});

test('quality:lite drops every filter', () => {
  for (const s of seeds(80)) {
    for (const f of FAMILIES) {
      const lite = coverArt(s, 'onthisday', { family: f, quality: 'lite' });
      assert.doesNotMatch(lite, /<filter|filter="url/, `${f} kept a filter in lite mode`);
      // …and blur:false is the same escape hatch.
      assert.equal(lite, coverArt(s, 'onthisday', { family: f, blur: false }));
    }
  }
  // Full quality uses at most one blur primitive per card (DESIGN §1.2).
  for (const s of seeds(80)) {
    for (const f of FAMILIES) {
      const full = coverArt(s, 'onthisday', { family: f });
      assert.ok((full.match(/<feGaussianBlur/g) || []).length <= 1, `${f} has more than one blur`);
    }
  }
});

test('family assignment maps kinds and swaps 1-in-8', () => {
  assert.equal(familyFor('onthisday', 0), 'drift');
  assert.equal(familyFor('stat', 0), 'orbit');
  assert.equal(familyFor('quote', 0), 'constellation');
  assert.equal(familyFor('chart', 0), 'contour');
  assert.equal(familyFor('award', 0), 'spectra');
  assert.equal(familyFor('profile', 0), 'dune');
  assert.equal(familyFor('nonsense', 0), 'dune');
  // Top three bits === 7 → the alternate family.
  assert.equal(familyFor('onthisday', 0xf0000000), 'dune');

  let swapped = 0;
  const N = 4000;
  for (let i = 0; i < N; i++) {
    if (familyFor('stat', (i * 2654435761) >>> 0) !== 'orbit') swapped++;
  }
  const rate = swapped / N;
  assert.ok(rate > 0.08 && rate < 0.17, `alt-swap rate ${rate} is not ~1/8`);
});

test('covers describe themselves for screen readers', () => {
  const label = coverLabel(0, 'stat');
  assert.match(label, /^Abstract cover: \w+ [\w ]+$/);
  for (const s of seeds(40)) {
    for (const k of KINDS) {
      assert.match(coverArt(s, k), /role="img" aria-label="Abstract cover: /);
    }
  }
});

test('handles hostile seeds without throwing', () => {
  for (const s of [0, 1, -1, 2 ** 32 - 1, 2 ** 32, 2 ** 31, 0.5, -(2 ** 31)]) {
    for (const k of KINDS) {
      const svg = coverArt(s, k);
      assert.ok(svg.startsWith('<svg '), `seed ${s} produced nothing`);
      assert.doesNotMatch(svg, /NaN/);
    }
  }
  // Negative and out-of-range seeds normalise to the same uint32 as their coerced form.
  assert.equal(coverArt(-1, 'stat'), coverArt(4294967295, 'stat'));
});

/* ─────────────────────────── environment purity ─────────────────────── */

test('the module touches nothing outside plain ES', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/art.js', import.meta.url)), 'utf8');
  // Strip comments so prose about these names cannot fail the check.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const banned of [
    'Math.random',
    'Date.now',
    'new Date',
    'require(',
    'process.',
    'document.',
    'window.',
    'globalThis',
    'node:',
    'performance.',
    'Intl.',
  ]) {
    assert.ok(!code.includes(banned), `src/art.js must not use ${banned}`);
  }
  assert.ok(!/\bimport\s/.test(code), 'src/art.js must have zero imports');
});

test('the contract surface is exported', () => {
  assert.equal(typeof coverArt, 'function');
  assert.equal(typeof palette, 'function');
  const p = palette(42);
  assert.deepEqual(Object.keys(p).sort(), ['accents', 'bg', 'fg']);
  assert.equal(p.accents.length, 3);
  for (const hex of [p.bg, p.fg, ...p.accents]) assert.match(hex, /^#[0-9a-fA-F]{6}$/);
});
