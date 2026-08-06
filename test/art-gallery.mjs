#!/usr/bin/env node
/**
 * Dev harness — eyeball the generative art.
 *
 * Writes a standalone page with 60 seeds × 6 families (+ a light-theme strip and a `lite`
 * quality strip), plus per-family size stats, so the worst-looking seed is one scroll away.
 *
 *   node test/art-gallery.mjs [--seeds 60] [--out /tmp/codepend-art-gallery.html] [--only drift]
 */
import { writeFileSync } from 'node:fs';
import { coverArt, palette, FAMILIES, _internals } from '../src/art.js';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const SEEDS = Number(arg('--seeds', 60));
const OUT = arg('--out', '/tmp/codepend-art-gallery.html');
const ONLY = arg('--only', null); // render a single family, for close inspection

/** Spread seeds across the uint32 range so we exercise every hue anchor and the 1-in-8 alt swap. */
const seeds = [];
for (let i = 0; i < SEEDS; i++) {
  seeds.push(((i * 2654435761 + 0x9e3779b9) >>> 0) ^ (i * 977));
}

const bytes = (s) => Buffer.byteLength(s, 'utf8');

/**
 * Make one cover's element ids unique to its cell.
 *
 * art.js scopes ids by seed, which is exactly right in the product: a feed renders each memory
 * once. This page does not — it draws the same seed in the family grid, the legibility strip, the
 * lite strip and the light strip, so ten `<radialGradient id="bg17wdrqx">` end up in one document
 * and every `url(#bg17wdrqx)` after the first resolves to the *first* one. That silently made
 * every strip below the fold render with another strip's gradients and filters, which is a
 * spectacular way for a review harness to lie to you: the light-theme row came out dark because
 * it was wearing the dark row's scrim.
 *
 * Rewriting ids per cell is the harness's problem to solve, not the module's — art.js stays
 * seed-deterministic and this stays a display concern.
 */
let cellNo = 0;
const uniquify = (svg) => {
  const tag = `_${(cellNo++).toString(36)}`;
  return svg
    .replace(/ id="([^"]+)"/g, ` id="$1${tag}"`)
    .replace(/url\(#([^)]+)\)/g, `url(#$1${tag})`)
    .replace(/href="#([^"]+)"/g, `href="#$1${tag}"`);
};

const stats = {};
const cells = [];

const shown = ONLY ? FAMILIES.filter((f) => f === ONLY) : FAMILIES;

for (const fam of shown) {
  stats[fam] = [];
  for (const seed of seeds) {
    const svg = coverArt(seed >>> 0, 'onthisday', { family: fam });
    const size = bytes(svg);
    stats[fam].push(size);
    const p = palette(seed >>> 0);
    const nodes = (svg.match(/<(circle|path|rect|ellipse|use|line|polyline|g)\b/g) || []).length;
    cells.push(
      `<figure class="c" style="--a-1:${p.accents[0]};--a-bg:${p.bg}" data-fam="${fam}">` +
        `<div class="art">${uniquify(svg)}</div>` +
        `<figcaption>${fam} · ${(seed >>> 0).toString(36)} · ${(size / 1024).toFixed(
          1,
        )}kb · ${nodes}n</figcaption>` +
        `</figure>`,
    );
  }
}

const pct = (a, q) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const all = Object.values(stats).flat();

const rows = shown.map((f) => {
  const a = stats[f];
  return `<tr><td>${f}</td><td>${(pct(a, 0.5) / 1024).toFixed(1)}</td><td>${(
    pct(a, 0.95) / 1024
  ).toFixed(1)}</td><td>${(Math.max(...a) / 1024).toFixed(1)}</td></tr>`;
}).join('');

// A few extra strips: light theme, lite quality, and the share-card aspect.
const strip = (title, make) =>
  `<h2>${title}</h2><div class="grid">` +
  seeds
    .slice(0, 12)
    .map((s) => {
      const svg = make(s >>> 0);
      return `<figure class="c"><div class="art">${uniquify(svg)}</div><figcaption>${(s >>> 0).toString(
        36,
      )} · ${(bytes(svg) / 1024).toFixed(1)}kb</figcaption></figure>`;
    })
    .join('') +
  `</div>`;

const kinds = ['onthisday', 'stat', 'quote', 'chart', 'award', 'profile'];

const html = `<!doctype html><meta charset="utf-8"><title>codepend art gallery</title>
<style>
:root{--scrim-color:5 6 10;color-scheme:dark}
body{margin:0;background:#06070A;color:#F4F1EC;
 font:400 14px/1.5 ui-sans-serif,-apple-system,system-ui,sans-serif;padding:28px}
h1{font-size:22px;letter-spacing:-.02em;margin:0 0 6px}
h2{font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#827D75;margin:38px 0 12px}
table{border-collapse:collapse;font:500 12px/1.4 ui-monospace,monospace;margin:14px 0 0}
td,th{padding:3px 14px 3px 0;text-align:left;color:#B9B4AC}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(${ONLY ? 300 : 190}px,1fr));gap:14px}
.c{margin:0;border-radius:16px;overflow:clip;background:var(--a-bg,#0E1014);position:relative}
.art{aspect-ratio:4/5}
.art svg{width:100%;height:100%;display:block}
figcaption{position:absolute;left:10px;right:10px;bottom:9px;
 font:600 9px/1.3 ui-monospace,monospace;letter-spacing:.06em;color:#F4F1EC;opacity:.72}
.overlay{position:absolute;inset:auto 0 0 0;padding:14px 12px 30px;pointer-events:none}
.eyebrow{font:600 8px/1 ui-sans-serif,sans-serif;letter-spacing:.14em;text-transform:uppercase;
 color:#F4F1EC;opacity:.62;position:absolute;top:12px;left:12px}
.hl{font:700 17px/1.05 ui-sans-serif,sans-serif;letter-spacing:-.028em;color:#F4F1EC}
.light{--scrim-color:250 247 242;background:#F7F4EF}
.light .c{background:#FFFDFA}
.light figcaption{color:#12100D}
.wide .art{aspect-ratio:16/9}
</style>
<h1>codepend · generative cover art</h1>
<div style="color:#827D75">${seeds.length} seeds × ${shown.length} families · p50 ${(
  pct(all, 0.5) / 1024
).toFixed(1)}kb · p95 ${(pct(all, 0.95) / 1024).toFixed(1)}kb · max ${(
  Math.max(...all) / 1024
).toFixed(1)}kb</div>
<table><tr><th>family</th><th>p50 kb</th><th>p95 kb</th><th>max kb</th></tr>${rows}</table>

<h2>text legibility check — headline over the floor zone</h2>
<div class="grid">${seeds
  .slice(0, 12)
  .map((s) => {
    const svg = coverArt(s >>> 0, 'onthisday', ONLY ? { family: ONLY } : {});
    return `<figure class="c"><div class="art">${uniquify(svg)}</div><div class="eyebrow">6 months ago today</div><div class="overlay"><div class="hl">You two shipped it at 04:12</div></div><figcaption>&nbsp;</figcaption></figure>`;
  })
  .join('')}</div>

${shown.map(
  (f) =>
    `<h2>${f}</h2><div class="grid">${cells.filter((c) => c.includes(`data-fam="${f}"`)).join('')}</div>`,
).join('')}

${strip('kind mapping (familyFor incl. 1-in-8 alt swap)', (s) =>
  coverArt(s, kinds[s % kinds.length], {}),
)}
${strip('quality: lite (no filters)', (s) => coverArt(s, 'onthisday', { quality: 'lite' }))}

<div class="light" style="margin:38px -28px -28px;padding:28px">
<h2 style="color:#6E6860">light theme</h2>
<div class="grid">${seeds
  .slice(0, 18)
  .map((s) => {
    const svg = coverArt(s >>> 0, kinds[s % kinds.length], { theme: 'light' });
    return `<figure class="c"><div class="art">${uniquify(svg)}</div><div class="overlay"><div class="hl" style="color:#12100D">You two shipped it at 04:12</div></div><figcaption>&nbsp;</figcaption></figure>`;
  })
  .join('')}</div>
</div>

<h2>share-card aspect 1200×675</h2>
<div class="grid wide">${seeds
  .slice(0, 6)
  .map((s) => {
    const svg = coverArt(s >>> 0, kinds[s % kinds.length], { w: 1200, h: 675 });
    return `<figure class="c"><div class="art">${uniquify(svg)}</div><figcaption>&nbsp;</figcaption></figure>`;
  })
  .join('')}</div>
`;

writeFileSync(OUT, html);

const floorMax = seeds
  .flatMap((s) =>
    shown.map((f) => {
      const b = _internals.build(s >>> 0, 'onthisday', { family: f });
      return b.floor.reduce(
        (m, c) => Math.max(m, c.alpha * _internals.luminance(c.hex)),
        0,
      );
    }),
  )
  .reduce((a, b) => Math.max(a, b), 0);

process.stdout.write(
  `wrote ${OUT}\n` +
    `p50 ${(pct(all, 0.5) / 1024).toFixed(2)}kb  p95 ${(pct(all, 0.95) / 1024).toFixed(
      2,
    )}kb  max ${(Math.max(...all) / 1024).toFixed(2)}kb\n` +
    shown.map(
      (f) =>
        `  ${f.padEnd(14)} p50 ${(pct(stats[f], 0.5) / 1024).toFixed(2)}  p95 ${(
          pct(stats[f], 0.95) / 1024
        ).toFixed(2)}  max ${(Math.max(...stats[f]) / 1024).toFixed(2)}`,
    ).join('\n') +
    `\nfloor-zone max composited luminance: ${floorMax.toFixed(4)}\n`,
);
