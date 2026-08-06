/**
 * test/archetype-card.test.mjs
 *
 * The archetype card is the most-posted asset in the product, and almost all of
 * its failure modes are silent: a name that overflows the frame, a blurb that
 * lands on top of the numbers, ink at 3:1 over a bright seed, a project name
 * that survives onto someone's timeline. None of those throw. So the geometry
 * is pure (`archetypeLayout`) and this file exercises it directly, against the
 * twelve REAL archetype names imported from the detector — not a fixture that
 * can drift away from what ships.
 *
 * The contrast tests run against real seeded palettes from src/art.js, so
 * "clears 4.5:1" is a measurement, not a claim.
 *
 * Zero dependencies, Node stdlib only.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ARCHETYPE_PRESETS, DEFAULT_PRESET, THEMES, MIN_CONTRAST, EYEBROW, WORDMARK, CTA,
  archetypeLayout, drawArchetypeCard, archetypeFilename,
  fitName, balanceLines, wrapLines, ellipsize, estimateWidth, makeMeasurer, baselinesOf,
  safeText, isRisky, contrastRatio, relLuminance, blendOver, requiredScrimAlpha,
  worstArtColor, scrimPlan, parseColor,
} from '../src/app/archetype-card.js';

import { ARCHETYPES } from '../src/detectors/_archetypes.js';
import { palette } from '../src/art.js';

const PRESETS = Object.keys(ARCHETYPE_PRESETS);
const NAMES = ARCHETYPES.map((a) => a.name);

const SPEC = {
  name: 'The Swarm Lord',
  tagline: 'You don’t use an agent. You run a department.',
  blurb: '100 sub-agents spawned, 25 of them in a single sitting on July 14. You stopped '
    + 'doing the work and started assigning it, and nobody noticed the transition.',
  stats: [
    { value: '128', label: 'days' },
    { value: '1 204', label: 'sessions' },
    { value: '18 902', label: 'messages' },
    { value: '361', label: 'hours' },
  ],
  seed: 0x5eed1e,
};

const spec = (over) => Object.assign({}, SPEC, over || {});

/* ── helpers ───────────────────────────────────────────────────────────── */

const overlap = (a, b) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const inside = (b, f) =>
  b.x >= f.x - 0.5 && b.y >= f.y - 0.5
  && b.x + b.w <= f.x + f.w + 0.5 && b.y + b.h <= f.y + f.h + 0.5;

/** A canvas context stub good enough to drive a real draw and record it. */
function fakeCtx() {
  const calls = [];
  const rec = (op) => (...args) => { calls.push({ op, args, font: ctx.font, alpha: ctx.globalAlpha }); };
  const ctx = {
    calls,
    font: '10px sans-serif',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    textBaseline: 'alphabetic',
    textAlign: 'left',
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    letterSpacing: '0px',
    save: rec('save'),
    restore: rec('restore'),
    fillRect: rec('fillRect'),
    fillText: rec('fillText'),
    drawImage: rec('drawImage'),
    setTransform: rec('setTransform'),
    beginPath: rec('beginPath'),
    stroke: rec('stroke'),
    createPattern: () => ({ pattern: true }),
    createLinearGradient: () => ({ stops: [], addColorStop(p, c) { this.stops.push([p, c]); } }),
    measureText(t) {
      const m = /(\d+(?:\.\d+)?)px/.exec(ctx.font);
      const size = m ? +m[1] : 10;
      const weight = /(\d00)\s/.exec(ctx.font);
      const face = /Georgia|Iowan|serif/.test(ctx.font) && !/sans-serif/.test(ctx.font) ? 'serif' : 'display';
      return { width: estimateWidth(t, { size, face, weight: weight ? +weight[1] : 400 }) };
    },
  };
  return ctx;
}

const textOf = (ctx) => ctx.calls.filter((c) => c.op === 'fillText').map((c) => c.args[0]).join(' ');

/* ── 1. the three frames ───────────────────────────────────────────────── */

test('three presets, three shapes — square is the default', () => {
  assert.deepEqual(ARCHETYPE_PRESETS.square, [1080, 1080]);
  assert.deepEqual(ARCHETYPE_PRESETS.story, [1080, 1920]);
  assert.deepEqual(ARCHETYPE_PRESETS.wide, [1200, 675]);
  assert.equal(DEFAULT_PRESET, 'square');
  assert.equal(ARCHETYPE_PRESETS.story[0] / ARCHETYPE_PRESETS.story[1], 9 / 16);
  // An unknown or missing preset must never produce a zero-sized frame.
  for (const p of [undefined, null, 'portrait', 42]) {
    const L = archetypeLayout(spec(), p);
    assert.equal(L.preset, 'square');
    assert.equal(L.width, 1080);
  }
});

test('each preset is a re-composition, not a rescale', () => {
  const L = PRESETS.map((p) => archetypeLayout(spec(), p));
  const [sq, story, wide] = L;
  // wide puts the numbers beside the name; the stacked presets put them under it
  assert.equal(wide.stats.flow, 'rows');
  assert.equal(sq.stats.flow, 'cols');
  assert.equal(story.stats.flow, 'cols');
  assert.ok(wide.stats.x > wide.name.x + wide.name.w, 'wide: numbers sit right of the name column');
  assert.ok(sq.stats.y > sq.name.y + sq.name.h, 'square: numbers sit under the name');
  assert.ok(wide.cols && wide.divider, 'wide has two columns and a rule between them');
  assert.equal(sq.cols, null);
  // the story frame buys air above the name, it does not just stretch it
  const airStory = story.name.y / story.height;
  const airSquare = sq.name.y / sq.height;
  assert.ok(airStory > airSquare, 'the story frame opens more room above the name');
  assert.ok(story.frame.y > 200, 'story keeps clear of the platform UI at the top');
  assert.ok(story.height - (story.frame.y + story.frame.h) > 200, '…and at the bottom');
});

/* ── 2. everything lands inside the frame, nothing overlaps ────────────── */

test('every box is inside its frame and nothing overlaps anything', () => {
  for (const p of PRESETS) {
    for (const s of [spec(), spec({ tagline: '', blurb: '' }), spec({ stats: [] })]) {
      const L = archetypeLayout(s, p);
      const page = { x: 0, y: 0, w: L.width, h: L.height };

      for (const b of L.blocks) {
        assert.ok(b.w > 0 && b.h > 0, `${p}/${b.block}: degenerate box`);
        assert.ok(inside(b, L.frame), `${p}/${b.block} escapes the frame: ${JSON.stringify(b)}`);
        assert.ok(inside(b, page), `${p}/${b.block} escapes the page`);
      }
      for (let i = 0; i < L.blocks.length; i++) {
        for (let j = i + 1; j < L.blocks.length; j++) {
          const a = L.blocks[i];
          const b = L.blocks[j];
          assert.ok(!overlap(a, b), `${p}: ${a.block} overlaps ${b.block}`);
        }
      }
      if (L.divider) {
        assert.ok(inside(L.divider, L.frame), `${p}: divider escapes the frame`);
      }
    }
  }
});

test('the numbers along the base never collide with each other', () => {
  for (const p of PRESETS) {
    const L = archetypeLayout(spec(), p);
    assert.equal(L.stats.cells.length, 4);
    for (let i = 1; i < L.stats.cells.length; i++) {
      const a = L.stats.cells[i - 1];
      const b = L.stats.cells[i];
      assert.ok(!overlap(a, b), `${p}: stat cells ${i - 1}/${i} overlap`);
      assert.ok(inside(b, L.frame), `${p}: stat cell ${i} escapes the frame`);
      // the value must fit its own cell, shrinking if it has to
      const w = estimateWidth(b.value, { size: b.valueSize, weight: 800 });
      assert.ok(w <= b.w, `${p}: value "${b.value}" overruns its cell`);
    }
    // value above label inside every cell, in that order
    for (const c of L.stats.cells) {
      assert.ok(c.labelBaseline > c.valueBaseline, 'the label sits under the value');
      assert.ok(c.labelSize < c.valueSize, 'the label is the quieter of the two');
    }
  }
});

test('the wordmark and `npx codepend` share the footer without touching', () => {
  for (const p of PRESETS) {
    const L = archetypeLayout(spec(), p);
    const { wordmark, cta } = L.footer;
    assert.equal(cta.text, CTA);
    assert.equal(wordmark.text, WORDMARK);
    assert.ok(wordmark.x + wordmark.w < cta.x, `${p}: the wordmark runs into the CTA`);
    assert.ok(cta.x + cta.w <= L.frame.x + L.frame.w + 0.5, `${p}: the CTA escapes the frame`);
    assert.equal(wordmark.baseline, cta.baseline, 'both sit on one baseline');
    assert.ok(L.footer.y + L.footer.h <= L.height, 'the footer is on the page');
  }
});

/* ── 3. the name, which is the artifact ────────────────────────────────── */

test('all twelve real archetype names fit their box, in every preset', () => {
  for (const name of NAMES) {
    for (const p of PRESETS) {
      const L = archetypeLayout(spec({ name }), p);
      const n = L.name;
      assert.ok(n.lines.length > 0, `${name}/${p}: no name`);
      assert.equal(n.lines.join(' '), name, `${name}/${p}: the name was altered`);
      assert.ok(!n.clipped, `${name}/${p}: had to be trimmed to fit`);
      for (const line of n.lines) {
        const w = estimateWidth(line, { size: n.size, weight: 800, tracking: n.tracking });
        assert.ok(w <= n.w + 0.5, `${name}/${p}: "${line}" is ${Math.round(w)}px in a ${Math.round(n.w)}px column`);
      }
      assert.ok(n.h <= n.box.h + 0.5, `${name}/${p}: the name block is taller than its box`);
      assert.ok(n.y >= n.box.y - 0.5, `${name}/${p}: the name pushed past its ceiling`);
    }
  }
});

test('the widest and the narrowest name are both set deliberately', () => {
  const width1 = (s) => estimateWidth(s, { size: 100, weight: 800 });
  const sorted = NAMES.slice().sort((a, b) => width1(a) - width1(b));
  const narrowest = sorted[0];
  const widest = sorted[sorted.length - 1];
  // Pinned so a change to the twelve names shows up here rather than on a card.
  assert.equal(narrowest, 'The Sampler');                       // 11 chars, the narrowest set
  assert.equal(widest, 'The Everyday Companion');               // the widest set…
  assert.equal(NAMES.slice().sort((a, b) => b.length - a.length)[0],
    'The Midnight Interrogator');                               // …and the longest by count

  for (const p of PRESETS) {
    // Every one of the twelve must be set at a comparable size. A name that is
    // set at a fraction of its neighbour is the difference between a poster and
    // a wrapped paragraph, and nobody posts the paragraph.
    const sizes = NAMES.map((n) => archetypeLayout(spec({ name: n }), p).name.size);
    const lo = Math.min(...sizes);
    const hi = Math.max(...sizes);
    assert.ok(lo >= hi * 0.65, `${p}: the twelve names range ${lo.toFixed(0)}–${hi.toFixed(0)}px`);

    const a = archetypeLayout(spec({ name: narrowest }), p).name;
    const b = archetypeLayout(spec({ name: widest }), p).name;
    assert.ok(b.size >= a.size * 0.6, `${p}: "${widest}" is set at ${Math.round((b.size / a.size) * 100)}% of "${narrowest}"`);
    // Both fill their column: the fit is width-bound or height-bound, never lazy.
    for (const n of [a, b]) {
      const widestLine = Math.max(...n.lines.map((l) => estimateWidth(l, { size: n.size, weight: 800, tracking: n.tracking })));
      const fillsW = widestLine >= n.w * 0.86;
      const fillsH = n.h >= n.box.h * 0.9;
      const atCap = n.size >= archetypeLayout(spec({ name: 'X' }), p).name.size - 0.001;
      assert.ok(fillsW || fillsH || atCap, `${p}/${n.lines.join(' ')}: the name settled for a size that fits nothing tightly`);
    }
  }
});

test('the name is still legible at 200px — thumbnail size in a feed', () => {
  for (const name of NAMES) {
    for (const p of PRESETS) {
      const L = archetypeLayout(spec({ name }), p);
      const atThumb = (L.name.size / L.width) * 200;
      assert.ok(atThumb >= 11, `${name}/${p}: ${atThumb.toFixed(1)}px at a 200px thumbnail`);
      // and it is unambiguously the loudest thing on the card
      assert.ok(L.name.size > L.tagline.size * 2.2, `${name}/${p}: the name does not dominate the tagline`);
      assert.ok(L.name.size > L.stats.valueSize * 2, `${name}/${p}: the numbers compete with the name`);
    }
  }
});

test('lines break where the words allow, balanced, never mid-word', () => {
  const w = (t) => estimateWidth(t, { size: 100, weight: 800 });
  assert.deepEqual(balanceLines(['The', 'Midnight', 'Interrogator'], 2, w),
    ['The Midnight', 'Interrogator']);
  // "The Swarm" is narrower than "Swarm Lord", so that is where the break goes —
  // the point of the minimax is that it does not care where you'd have guessed.
  assert.deepEqual(balanceLines(['The', 'Swarm', 'Lord'], 2, w), ['The Swarm', 'Lord']);
  assert.ok(w('The Swarm') < w('Swarm Lord'));
  assert.deepEqual(balanceLines(['The', 'Sampler'], 1, w), ['The Sampler']);
  assert.deepEqual(balanceLines(['The', 'Sampler'], 5, w), ['The', 'Sampler']);
  assert.deepEqual(balanceLines([], 3, w), []);
  // the balanced break beats the greedy one: greedy would leave "The" alone
  const bal = balanceLines(['The', 'Patient', 'Architect'], 2, w);
  assert.ok(Math.max(...bal.map(w)) <= w('The Patient Architect'));
  // every partition keeps word order and loses nothing
  for (const name of NAMES) {
    const words = name.split(' ');
    for (let k = 1; k <= words.length; k++) {
      assert.equal(balanceLines(words, k, w).join(' '), name);
    }
  }
});

test('fitName measures, it does not guess: size scales with the box', () => {
  const box = (w, h) => ({ w, h });
  const one = fitName('The Swarm Lord', box(900, 400), estimateWidth, {});
  const half = fitName('The Swarm Lord', box(450, 200), estimateWidth, {});
  assert.ok(Math.abs(one.size / half.size - 2) < 0.05, 'halving the box halves the type');
  // a wider box lets the same name go up a line count or up a size, never down
  const wider = fitName('The Swarm Lord', box(1200, 400), estimateWidth, {});
  assert.ok(wider.size >= one.size);
  // the reported height is the height it will actually occupy
  assert.ok(Math.abs(one.height - one.lines.length * one.lineHeight) < 1e-9);
  assert.ok(one.height <= 400.5);
});

/* ── 4. missing pieces still compose ───────────────────────────────────── */

test('a missing blurb, tagline, name or stat array still lays out', () => {
  const cases = [
    ['no blurb', spec({ blurb: '' })],
    ['no tagline', spec({ tagline: null })],
    ['no blurb and no tagline', spec({ blurb: '', tagline: '' })],
    ['no stats', spec({ stats: [] })],
    ['no stats at all', spec({ stats: undefined })],
    ['one stat', spec({ stats: [{ value: '3', label: 'days' }] })],
    ['nothing but a name', { name: 'The Sampler' }],
    ['empty spec', {}],
    ['garbage stats', spec({ stats: [null, {}, { value: '' }, { value: '7', label: '' }] })],
  ];
  for (const [what, s] of cases) {
    for (const p of PRESETS) {
      const L = archetypeLayout(s, p);
      assert.ok(L.name.lines.length > 0, `${what}/${p}: lost the name`);
      assert.ok(L.name.size > 0 && Number.isFinite(L.name.size), `${what}/${p}: bad name size`);
      assert.equal(L.footer.cta.text, CTA, `${what}/${p}: lost the CTA`);
      for (const b of L.blocks) {
        assert.ok(Number.isFinite(b.x + b.y + b.w + b.h), `${what}/${p}: NaN in ${b.block}`);
        assert.ok(inside(b, L.frame), `${what}/${p}: ${b.block} escapes the frame`);
      }
      for (let i = 0; i < L.blocks.length; i++) {
        for (let j = i + 1; j < L.blocks.length; j++) {
          assert.ok(!overlap(L.blocks[i], L.blocks[j]),
            `${what}/${p}: ${L.blocks[i].block} overlaps ${L.blocks[j].block}`);
        }
      }
    }
  }
});

test('the name block grows into the room a missing tagline leaves behind', () => {
  const full = archetypeLayout(spec(), 'square').name;
  const bare = archetypeLayout(spec({ tagline: '', blurb: '' }), 'square').name;
  assert.ok(bare.box.h > full.box.h, 'the empty room goes to the name');
  assert.ok(bare.size >= full.size);
});

test('more than four numbers is four numbers', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ value: String(i + 1), label: `l${i}` }));
  for (const p of PRESETS) {
    assert.equal(archetypeLayout(spec({ stats: many }), p).stats.cells.length, 4);
  }
});

test('an absurd name is clamped, not allowed to overflow', () => {
  const silly = 'The ' + 'Supercalifragilistic '.repeat(12) + 'Tyrant';
  for (const p of PRESETS) {
    const L = archetypeLayout(spec({ name: silly }), p);
    assert.ok(L.name.h <= L.name.box.h + 0.5, `${p}: overflowed vertically`);
    for (const line of L.name.lines) {
      const w = estimateWidth(line, { size: L.name.size, weight: 800, tracking: L.name.tracking });
      assert.ok(w <= L.name.w + 0.5, `${p}: "${line}" overflowed horizontally`);
    }
    assert.ok(inside({ x: L.name.x, y: L.name.y, w: L.name.w, h: L.name.h }, L.frame));
  }
});

/* ── 5. contrast is measured, not assumed ──────────────────────────────── */

test('contrast maths agrees with the WCAG reference values', () => {
  assert.ok(Math.abs(contrastRatio('#000000', '#ffffff') - 21) < 1e-6);
  assert.ok(Math.abs(contrastRatio('#ffffff', '#ffffff') - 1) < 1e-9);
  assert.ok(Math.abs(relLuminance('#ffffff') - 1) < 1e-9);
  assert.ok(Math.abs(relLuminance('#000000')) < 1e-9);
  assert.equal(contrastRatio('#000', '#ffffff'), contrastRatio('#ffffff', '#000'));
  // the CSS custom-property form app.css uses for the scrim
  assert.deepEqual(parseColor('5 6 10'), [5, 6, 10]);
  assert.deepEqual(parseColor('#F4F1EC'), [244, 241, 236]);
  // blending is monotonic and hits both ends exactly
  assert.equal(blendOver('#ffffff', '#000000', 0), '#ffffff');
  assert.equal(blendOver('#ffffff', '#000000', 1), '#000000');
});

test('requiredScrimAlpha returns the smallest alpha that clears the ratio', () => {
  const ink = THEMES.dark.ink;
  const scrim = THEMES.dark.scrim;
  const a = requiredScrimAlpha(ink, scrim, '#ffffff', MIN_CONTRAST);
  assert.ok(a > 0 && a < 1);
  assert.ok(contrastRatio(ink, blendOver('#ffffff', scrim, a)) >= MIN_CONTRAST, 'the answer works');
  assert.ok(contrastRatio(ink, blendOver('#ffffff', scrim, Math.max(0, a - 0.02))) < MIN_CONTRAST,
    'and nothing smaller does');
  // already legible → no scrim needed
  assert.equal(requiredScrimAlpha(ink, scrim, '#000000', MIN_CONTRAST), 0);
});

test('every ink clears 4.5:1 over every seeded palette, in both themes', () => {
  let worst = Infinity;
  let worstAt = '';
  for (const theme of ['dark', 'light']) {
    const scrim = THEMES[theme].scrim;
    // Each block is checked against the ink it is actually painted with. The
    // header promises contrast is computed and never assumed; checking `ink`
    // alone left the blurb and the stat labels assumed, and the stat labels
    // were shipping below the bar on real pixels.
    for (let seed = 0; seed < 600; seed++) {
      const pal = palette(seed, theme);
      for (const p of PRESETS) {
        const L = archetypeLayout(spec({ seed, palette: pal, theme }), p);
        // Check at the top edge of every box that carries ink, which is where
        // the gradient is at its weakest under that box.
        for (const b of L.blocks) {
          if (b.block === 'rule') continue;
          const alpha = L.scrim.alphaAt(b.y);
          const bg = blendOver(L.worstArt, scrim, alpha);
          const ink = b.ink;
          assert.ok(ink, `${b.block} does not declare its ink`);
          const r = contrastRatio(ink, bg);
          if (r < worst) { worst = r; worstAt = `${theme}/${p}/${b.block}/${ink}/seed ${seed}`; }
          assert.ok(r >= MIN_CONTRAST - 1e-9,
            `${theme}/${p}/${b.block} ${ink} seed ${seed}: ${r.toFixed(2)}:1 at alpha ${alpha.toFixed(2)}`);
        }
      }
    }
  }
  assert.ok(worst >= MIN_CONTRAST, `worst measured contrast ${worst.toFixed(2)}:1 at ${worstAt}`);
});

test('the art is the ground: the scrim is a whisper above the copy', () => {
  for (const p of PRESETS) {
    const L = archetypeLayout(spec(), p);
    assert.ok(L.scrim.alphaAt(0) < 0.2, `${p}: the top of the frame is smothered`);
    assert.ok(L.scrim.alphaAt(L.height - 1) >= L.scrim.alpha - 1e-9, `${p}: the base is not covered`);
    assert.ok(L.scrim.alphaAt(L.group.y) >= L.scrim.alpha - 1e-9, `${p}: the copy starts before the scrim does`);
    // monotonic, so the gradient never brightens as it descends
    let prev = -1;
    for (let y = 0; y <= L.height; y += 8) {
      const a = L.scrim.alphaAt(y);
      assert.ok(a >= prev - 1e-9, `${p}: the scrim brightens at y=${y}`);
      prev = a;
    }
  }
});

test('worstArtColor takes the extreme of the palette, per theme', () => {
  const pal = { bg: '#101014', fg: '#fff', accents: ['#223344', '#eeddcc', '#445566'] };
  assert.ok(relLuminance(worstArtColor(pal, 'dark')) > relLuminance('#eeddcc'), 'dark: brighter than the brightest accent');
  assert.ok(relLuminance(worstArtColor(pal, 'light')) < relLuminance('#101014'), 'light: darker than the darkest');
  const plan = scrimPlan({ height: 1080, groupTop: 500, ink: '#fff', scrimColor: '#000', worstArt: '#ffffff' });
  assert.ok(plan.alpha >= plan.required);
  assert.deepEqual(plan.stops[0][0], 0);
  assert.equal(plan.stops[plan.stops.length - 1][0], 1);
});

/* ── 6. privacy — the non-negotiable one ───────────────────────────────── */

test('nothing risky ever reaches the card', () => {
  const leaks = [
    'Working in ~/work/clients/acme all week.',
    'You spent 40 hours in /Users/alex/src/secret-thing this month.',
    'See https://internal.corp.example/dashboards/42 for the breakdown.',
    'Ping alex@employer.com about it.',
    'Your token sk-abcdefghijklmnop is in there somewhere.',
    'The box at 10.4.221.19 never sleeps.',
    'It said ```rm -rf``` and you let it.',
    'Opened @~/Downloads/board-deck/Q3.docx eleven times.',
    'C:\\Users\\alex\\projects\\merger was busy.',
  ];
  for (const bad of leaks) {
    assert.ok(isRisky(bad), `not flagged: ${bad}`);
    assert.equal(safeText(bad), '', `not dropped: ${bad}`);
    for (const p of PRESETS) {
      const L = archetypeLayout(spec({ blurb: bad, tagline: bad, name: 'The Sampler' }), p);
      const painted = [...L.name.lines, ...L.tagline.lines, ...L.blurb.lines,
        ...L.stats.cells.map((c) => c.value + ' ' + c.label)].join(' ');
      assert.ok(!isRisky(painted), `${p}: risky text was painted`);
      assert.equal(L.blurb.lines.length, 0, `${p}: the unsafe blurb was kept`);
      assert.equal(L.tagline.lines.length, 0, `${p}: the unsafe tagline was kept`);
      assert.ok(L.name.lines.length > 0, `${p}: dropping the blurb must not cost the name`);
    }
  }
});

test('project names are substituted, and a run of them reads as English', () => {
  const blurb = 'You start things. That is the skill. acme-billing, orbit-web and pkg-cli '
    + 'are all still sitting there with the lights on.';
  const names = ['acme-billing', 'orbit-web', 'pkg-cli'];
  const out = safeText(blurb, { redactNames: names });
  for (const n of names) assert.ok(!out.toLowerCase().includes(n), `${n} survived`);
  assert.ok(out.includes('a few projects'), `run not collapsed: ${out}`);
  assert.ok(!/one project, one project/.test(out));

  const single = safeText('78% of everything you have ever said went to acme-billing.', { redactNames: names });
  assert.equal(single, '78% of everything you have ever said went to one project.');

  // and through the layout, where it actually matters
  const L = archetypeLayout(spec({ blurb, redactNames: names }), 'square');
  const painted = L.blurb.lines.join(' ');
  for (const n of names) assert.ok(!painted.toLowerCase().includes(n), `${n} was painted`);
});

test('--redact paranoid still produces a card worth posting', () => {
  // Under paranoid the Two-Word Tyrant loses its quoted tagline (no quotes
  // leave the machine) and the detector falls back — the card must not notice.
  const L = archetypeLayout({
    name: 'The Two-Word Tyrant',
    tagline: null,
    blurb: '61% of your prompts are under five words, and they move mountains: 24 100 tool '
      + 'calls off a median of 3 words.',
    stats: SPEC.stats,
    seed: 3,
  }, 'square');
  assert.equal(L.tagline.lines.length, 0);
  assert.ok(L.name.size > 100, 'the name is still the artifact');
  assert.equal(L.stats.cells.length, 4, 'the evidence is still there');
  assert.equal(L.eyebrow.lines[0], EYEBROW);
  assert.equal(L.footer.cta.text, CTA);
});

test('stat values and labels go through the same gate', () => {
  const L = archetypeLayout(spec({
    stats: [
      { value: '128', label: '~/work/acme' },
      { value: 'https://x.example', label: 'days' },
      { value: '9 001', label: 'sub-agents' },
    ],
  }), 'square');
  const cells = L.stats.cells;
  assert.equal(cells.length, 2, 'the unsafe value was dropped entirely');
  assert.equal(cells[0].label, '', 'the unsafe label was dropped, the number kept');
  assert.equal(cells[1].value, '9 001');
});

/* ── 7. determinism ────────────────────────────────────────────────────── */

test('the same spec always lays out identically', () => {
  for (const p of PRESETS) {
    const a = archetypeLayout(spec(), p);
    const b = archetypeLayout(spec(), p);
    assert.deepEqual(JSON.parse(JSON.stringify(a.blocks)), JSON.parse(JSON.stringify(b.blocks)));
    assert.deepEqual(a.scrim.stops, b.scrim.stops);
    assert.deepEqual(a.name.lines, b.name.lines);
  }
});

test('filenames are slugs of the archetype and the frame', () => {
  assert.equal(archetypeFilename('The Swarm Lord', 'story'), 'codepend-the-swarm-lord-story.png');
  assert.equal(archetypeFilename('The Ctrl-C Cowboy', 'wide'), 'codepend-the-ctrl-c-cowboy-wide.png');
  assert.equal(archetypeFilename('', 'nonsense'), 'codepend-archetype-square.png');
  for (const n of NAMES) assert.ok(/^codepend-[a-z0-9-]+-square\.png$/.test(archetypeFilename(n)));
});

/* ── 8. measurement and wrapping ───────────────────────────────────────── */

test('the fallback measurer behaves like a font', () => {
  assert.ok(estimateWidth('W', { size: 100 }) > estimateWidth('i', { size: 100 }) * 3);
  assert.ok(estimateWidth('The Midnight Interrogator', { size: 100 })
    > estimateWidth('The Sampler', { size: 100 }));
  assert.equal(estimateWidth('', { size: 100 }), 0);
  const a = estimateWidth('codepend', { size: 50 });
  const b = estimateWidth('codepend', { size: 100 });
  assert.ok(Math.abs(b / a - 2) < 1e-9, 'advance width is linear in size');
  assert.ok(estimateWidth('AAA', { size: 100, tracking: 0.2 })
    > estimateWidth('AAA', { size: 100 }), 'tracking counts');
  assert.ok(estimateWidth('AAA', { size: 100, weight: 800 })
    > estimateWidth('AAA', { size: 100, weight: 400 }), 'bold is wider, not just darker');
  // a canvas-backed measurer is a drop-in for it
  const m = makeMeasurer(fakeCtx());
  assert.ok(m('The Sampler', { size: 100, weight: 800 }) > 0);
});

test('wrapping respects the line cap and marks what it dropped', () => {
  const m = estimateWidth;
  const o = { size: 20, weight: 400 };
  const long = 'one two three four five six seven eight nine ten eleven twelve thirteen';
  const two = wrapLines(long, o, 200, 2, m);
  assert.equal(two.length, 2);
  assert.ok(two[1].endsWith('…'), 'the cut is visible');
  for (const l of two) assert.ok(estimateWidth(l, o) <= 200);
  assert.deepEqual(wrapLines('', o, 200, 3, m), []);
  assert.deepEqual(wrapLines('short', o, 2000, 3, m), ['short']);
  assert.ok(!wrapLines('short', o, 2000, 3, m)[0].endsWith('…'), 'nothing dropped, no ellipsis');
  assert.equal(ellipsize('abcdefghij', o, 10000, m), 'abcdefghij');
  assert.ok(ellipsize('abcdefghij', o, 40, m).endsWith('…'));
});

test('baselines march down the block at the line height', () => {
  const L = archetypeLayout(spec({ name: 'The Midnight Interrogator' }), 'square');
  const bl = baselinesOf(L.name);
  assert.equal(bl.length, L.name.lines.length);
  for (let i = 1; i < bl.length; i++) {
    assert.ok(Math.abs((bl[i] - bl[i - 1]) - L.name.lineHeight) < 1e-9);
  }
  assert.ok(bl[0] > L.name.y, 'the first baseline is below the box top');
  assert.ok(bl[bl.length - 1] <= L.name.y + L.name.h, 'the last baseline is inside the block');
  assert.deepEqual(baselinesOf({ lines: [] }), []);
  assert.deepEqual(baselinesOf(null), []);
});

/* ── 9. the draw itself ────────────────────────────────────────────────── */

test('drawArchetypeCard paints the name, the numbers and the CTA', async () => {
  const ctx = fakeCtx();
  const L = await drawArchetypeCard(ctx, spec({ preset: 'square' }), {
    palette: (seed, theme) => palette(seed, theme),
    artImage: async () => ({ width: 1080, height: 1080 }),
    grainPattern: () => ({}),
  });
  const painted = textOf(ctx);
  assert.ok(painted.includes('Swarm'), 'the name');
  assert.ok(painted.includes(EYEBROW), 'the eyebrow');
  assert.ok(painted.includes(WORDMARK), 'the wordmark');
  assert.ok(painted.includes(CTA), 'the CTA');
  assert.ok(painted.includes('18 902'), 'the numbers');
  assert.ok(ctx.calls.some((c) => c.op === 'drawImage'), 'the art is drawn');
  assert.ok(ctx.calls.filter((c) => c.op === 'fillRect').length >= 2, 'ground and scrim');
  assert.ok(!ctx.calls.some((c) => c.op === 'setTransform'), 'the caller owns the transform');
  assert.equal(ctx.globalAlpha, 1, 'alpha is left as it was found');
  assert.equal(ctx.globalCompositeOperation, 'source-over', 'compositing is left as it was found');
  assert.equal(L.preset, 'square');
  assert.equal(L.name.lines.join(' '), 'The Swarm Lord');
});

test('a broken dependency degrades to a card, never to an exception', async () => {
  const broken = {
    palette: () => { throw new Error('no art'); },
    artImage: () => Promise.reject(new Error('decode failed')),
    grainPattern: () => { throw new Error('no pattern'); },
    markImage: () => Promise.reject(new Error('no mark')),
  };
  for (const p of PRESETS) {
    const ctx = fakeCtx();
    const L = await drawArchetypeCard(ctx, spec({ preset: p }), broken);
    assert.ok(textOf(ctx).includes(CTA), `${p}: lost the CTA`);
    assert.ok(textOf(ctx).includes('Swarm'), `${p}: lost the name`);
    assert.equal(L.preset, p);
  }
  // and with no deps at all
  const ctx = fakeCtx();
  await drawArchetypeCard(ctx, spec(), {});
  assert.ok(textOf(ctx).includes(WORDMARK));
  await drawArchetypeCard(fakeCtx(), {}, undefined);
});

test('the drawn layout is the layout the geometry promised', async () => {
  const ctx = fakeCtx();
  const L = await drawArchetypeCard(ctx, spec({ preset: 'story' }), {});
  const pure = archetypeLayout(spec({ palette: L.palette, hasMark: false }), 'story');
  assert.deepEqual(L.name.lines, pure.name.lines);
  assert.ok(Math.abs(L.name.size - pure.name.size) < 1e-6);
  assert.deepEqual(L.scrim.stops, pure.scrim.stops);
});
