/* ============================================================================
   codepend — app.js
   The three surfaces: the feed, Wrapped, and the share card.

   Runs as one inlined module script. Two globals are provided by
   src/render.js before this file:
     globalThis.CODEPEND_ART  = { coverArt, palette, familyFor }  (from src/art.js)
     globalThis.CODEPEND_DATA = payload from buildMemories()
   No imports, no network, no dependencies. Everything degrades: a broken
   memory object must never take the page down, so every card render is
   wrapped and a failed card is simply skipped.
   ========================================================================== */

const DATA = globalThis.CODEPEND_DATA || {};
const ART = globalThis.CODEPEND_ART || {};
const VIDEO = globalThis.CODEPEND_VIDEO || null;
const MEM = Array.isArray(DATA.memories) ? DATA.memories : [];
const PROFILE = DATA.profile || {};
const STATS = DATA.stats || {};
const TIMELINE = Array.isArray(DATA.timeline) ? DATA.timeline : [];
const META = DATA.meta || {};

const RM = matchMedia('(prefers-reduced-motion: reduce)');
const HOLD = 5000;

/* ── tiny helpers ─────────────────────────────────────────────────────── */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** Escape for HTML text/attribute context. */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** FNV-1a — the same hash detect.js and art.js use. */
function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/** Thin-space grouping above 10 000 — commas read like accounting. */
function groupNum(n) {
  const s = String(n);
  return s.length > 4 ? s.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') : s;
}

const CYR = /[Ѐ-ӿ]/;
const isCyr = (t) => CYR.test(String(t || ''));

/** Any of these in a string means it never reaches a share card. */
const RISKY = [
  /https?:\/\/\S+/i, /\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/, /\bsk-[A-Za-z0-9_-]{8,}/,
  /\bghp_[A-Za-z0-9]{8,}/, /\bAKIA[0-9A-Z]{8,}/, /\beyJ[A-Za-z0-9_-]{8,}\./,
  // Two alternatives, and the first one is the important one: `[~/][\w.-]+\/` alone required a
  // word character straight after the `~`, which a home path never has — `~/work/clients/acme`
  // sailed onto share cards untouched. `~` is precisely the form `--redact safe` leaves paths
  // in (docs/PRIVACY.md), so that was the most likely path to leak, not the least.
  //
  // It is also not anchored to a word boundary any more. Requiring whitespace before the `~`
  // let `@~/Downloads/<folder>/<file>.docx` — Cursor's own file-mention syntax, so one of the
  // commonest strings in a Cursor corpus — through onto a share card and into the exported
  // video. A home path is risky wherever it appears, not only after a space.
  /~\/[\w.\-/]+/,
  /(^|\s)[~/][\w.-]+\/[\w.\-/]+/,
  /\b[A-Za-z]:\\[\w\\.-]+/, /\b\d{1,3}(\.\d{1,3}){3}\b/,
  /```/,
];
const isRisky = (t) => !!t && RISKY.some((re) => re.test(t));

const themeNow = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

/* ── art bridge ───────────────────────────────────────────────────────── */

const FALLBACK_PAL = { bg: '#0B0F17', fg: '#F4F1EC', accents: ['#59AAF8', '#8771DE', '#A9C7F2'] };

function paletteOf(seed) {
  try {
    if (typeof ART.palette === 'function') {
      const p = ART.palette(seed >>> 0, themeNow());
      if (p && Array.isArray(p.accents) && p.accents.length >= 3) return p;
    }
  } catch (e) { /* art is decoration; never fatal */ }
  return FALLBACK_PAL;
}

function artSVG(seed, kind, opts) {
  try {
    if (typeof ART.coverArt === 'function') {
      const s = ART.coverArt(seed >>> 0, kind, Object.assign({ theme: themeNow() }, opts));
      if (typeof s === 'string' && s.indexOf('<svg') === 0) return s;
    }
  } catch (e) { /* fall through to the flat tint */ }
  return '';
}

/** Inline custom properties so the SVG and the card chrome share one identity. */
function paletteStyle(seed) {
  const p = paletteOf(seed);
  return `--a-1:${p.accents[0]};--a-2:${p.accents[1]};--a-3:${p.accents[2]};--a-bg:${p.bg}`;
}

const HUE_NAMES = [
  [15, 'ember'], [45, 'amber'], [70, 'gold'], [150, 'jade'], [175, 'teal'], [200, 'cyan'],
  [225, 'sky'], [250, 'blue'], [275, 'indigo'], [300, 'violet'], [330, 'magenta'], [360, 'rose'],
];
function hueName(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return 'blue';
  const v = parseInt(m[1], 16);
  const r = ((v >> 16) & 255) / 255, g = ((v >> 8) & 255) / 255, b = (v & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (d < 0.02) return 'silver';
  let h = 0;
  if (mx === r) h = 60 * (((g - b) / d) % 6);
  else if (mx === g) h = 60 * ((b - r) / d + 2);
  else h = 60 * ((r - g) / d + 4);
  if (h < 0) h += 360;
  for (const [lim, name] of HUE_NAMES) if (h <= lim) return name;
  return 'rose';
}

const FAMILY_WORD = {
  drift: 'drifting ribbons', orbit: 'orbital rings', constellation: 'a field of points',
  contour: 'contour lines', spectra: 'bands of light', dune: 'layered horizons',
};
function artLabel(seed, kind) {
  try {
    if (typeof ART.coverLabel === 'function') {
      const l = ART.coverLabel(seed >>> 0, kind, { theme: themeNow() });
      if (l) return l;
    }
  } catch (e) { /* fall through */ }
  let fam = 'dune';
  try { if (typeof ART.familyFor === 'function') fam = ART.familyFor(kind, seed >>> 0) || fam; } catch (e) { /* noop */ }
  const p = paletteOf(seed);
  return `Abstract cover: ${hueName(p.accents[0])} ${FAMILY_WORD[fam] || 'light in the dark'}`;
}

/** Describe a cover for screen readers — unless art.js already did it. */
function labelled(svg, seed, kind) {
  if (/\brole="img"/.test(svg)) return svg;
  return svg.replace('<svg', `<svg role="img" aria-label="${esc(artLabel(seed, kind))}"`);
}

/* ── memory normalization ─────────────────────────────────────────────── */

const KINDS = ['onthisday', 'stat', 'quote', 'chart', 'award'];

function norm(m, i) {
  const kind = KINDS.indexOf(m.kind) >= 0 ? m.kind : 'onthisday';
  const id = String(m.id || `${m.type || 'memory'}:${i}`);
  return {
    id,
    type: String(m.type || 'memory'),
    kind,
    date: typeof m.date === 'number' ? m.date : null,
    weight: typeof m.weight === 'number' ? m.weight : 50,
    eyebrow: m.eyebrow || '',
    title: m.title || '',
    body: m.body || null,
    stat: m.stat && m.stat.value != null ? m.stat : null,
    quote: m.quote && m.quote.text ? m.quote : null,
    chart: m.chart && m.chart.type ? m.chart : null,
    seed: (typeof m.seed === 'number' ? m.seed : hash32(id)) >>> 0,
    agent: m.agent || null,
    project: m.project || null,
    tags: Array.isArray(m.tags) ? m.tags : [],
    shareable: m.shareable !== false,
  };
}

const MEMORIES = MEM.map(norm);
const BY_ID = new Map(MEMORIES.map((m) => [m.id, m]));

/**
 * `agent: 'both'` means "this card is not about one agent" — it predates there being three.
 * Name the agents this corpus actually contains rather than hardcoding a pair, so a
 * Claude+Cursor user is not told their card is "claude + codex".
 */
const ALL_AGENTS_LABEL = (() => {
  const seen = [];
  for (const m of MEMORIES) {
    if (m.agent && m.agent !== 'both' && !seen.includes(m.agent)) seen.push(m.agent);
  }
  return seen.length > 1 ? seen.join(' + ') : 'all agents';
})();

/** The archetype card is synthesized here — detect.js ships it on the profile. */
function archetypeMemory() {
  const a = PROFILE.archetype;
  if (!a || !a.name) return null;
  const id = `archetype:${a.name}`;
  return {
    id, type: 'archetype', kind: 'award', date: null, weight: 100,
    eyebrow: 'WHAT YOU ARE',
    title: a.name,
    body: a.blurb || null,
    tagline: a.tagline || null,
    stat: null, quote: null, chart: null,
    seed: (typeof a.seed === 'number' ? a.seed : hash32(id)) >>> 0,
    agent: null, project: null, tags: ['archetype'], shareable: true,
    isArchetype: true,
  };
}
const ARCHETYPE = archetypeMemory();
if (ARCHETYPE) {
  BY_ID.set(ARCHETYPE.id, ARCHETYPE);
  // detect.js usually emits the archetype as an ordinary memory too, and
  // buildFeed() then declines to splice the synthesized one. That copy went
  // through norm(), which knows nothing about `isArchetype` or `tagline` — so
  // the card the feed actually showed was the archetype dressed as memory
  // number six, with the generic ⇪ on it. One identity, wherever it came from.
  for (const m of MEMORIES) {
    if (m.id !== ARCHETYPE.id && m.type !== 'archetype') continue;
    m.isArchetype = true;
    if (!m.tagline) m.tagline = ARCHETYPE.tagline || (m.stat && m.stat.label) || null;
    // The name and the line are the card; a stat block would set the name at
    // 130px twice over.
    m.stat = null;
  }
}

/* ── feed ordering (MEMORY-CATALOG §7) ────────────────────────────────── */

/**
 * Greedy ranking with rhythm penalties. The point is that the feed never
 * reads like a dashboard: no three stats in a row, never far from a quote.
 * @param {object[]} pool
 * @returns {object[]}
 */
function orderFeed(pool) {
  const left = pool.slice().sort((a, b) => b.weight - a.weight || hash32(a.id) - hash32(b.id));
  const out = [];
  const take = (pred) => {
    const i = left.findIndex(pred);
    if (i < 0) return null;
    return left.splice(i, 1)[0];
  };

  // Slot 1 — the anniversary card, else the first quote.
  const first = take((m) => m.type === 'on-this-day') || take((m) => m.kind === 'onthisday')
    || take((m) => m.kind === 'quote');
  if (first) out.push(first);
  // Slot 2 — the highest-weight quote.
  const q = take((m) => m.kind === 'quote');
  if (q) out.push(q);

  const typeCount = new Map();
  const countType = (m) => typeCount.set(m.type, (typeCount.get(m.type) || 0) + 1);
  out.forEach(countType);

  while (left.length) {
    const prev = out[out.length - 1] || {}, prev2 = out[out.length - 2] || {};
    const last4 = out.slice(-4).map((m) => m.kind);
    const last5 = out.slice(-5);
    const last6 = out.slice(-6);
    const last8 = out.slice(-8);
    const slot = out.length;

    // Rhythm rules are graded: if nothing at all can be placed we relax them
    // rather than truncate the album. A dropped memory is worse than two
    // charts within five slots of each other.
    let best = null, bestScore = -1e9, bestIdx = -1, level = 0;
    for (level = 0; level < 3 && !best; level++) {
    for (let i = 0; i < left.length; i++) {
      const m = left[i];
      // hard constraints
      if (m.type === prev.type) continue;
      if (m.kind === 'stat' && prev.kind === 'stat' && prev2.kind === 'stat') continue;
      if (level < 2 && (typeCount.get(m.type) || 0) >= 2) continue;
      if (level < 1 && m.kind === 'chart' && last5.some((x) => x.kind === 'chart')) continue;
      if (level < 1 && m.project && last8.filter((x) => x.project === m.project).length >= 3) continue;

      let s = m.weight
        - 20 * (m.kind === prev.kind)
        - 12 * (m.kind === prev2.kind)
        - 14 * (!!m.project && m.project === prev.project && m.project === prev2.project)
        - 8 * (m.agent === prev.agent && m.agent === prev2.agent && m.agent !== 'both')
        + 10 * (last4.indexOf(m.kind) < 0)
        + 14 * (slot % 7 === 0 && (m.kind === 'chart' || m.kind === 'quote'));
      // at least one quote per six cards
      if (m.kind === 'quote' && !last6.some((x) => x.kind === 'quote')) s += 26;
      if (s > bestScore) { bestScore = s; best = m; bestIdx = i; }
    }
    }
    if (!best) break;
    left.splice(bestIdx, 1);
    out.push(best);
    countType(best);
    if (out.length >= 40) break;
  }
  return { feed: out, rest: left };
}

/* ── DOM building ─────────────────────────────────────────────────────── */

function h(tag, attrs, html) {
  const el = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    if (attrs[k] == null || attrs[k] === false) continue;
    if (k === 'class') el.className = attrs[k];
    else el.setAttribute(k, attrs[k] === true ? '' : String(attrs[k]));
  }
  if (html != null) el.innerHTML = html;
  return el;
}

function tagRow(m) {
  const bits = [];
  if (m.project) bits.push(`<span class="tag">${esc(m.project)}</span>`);
  if (m.agent && m.agent !== 'both') bits.push(`<span class="tag tag--plain">${esc(m.agent)}</span>`);
  else if (m.agent === 'both') bits.push(`<span class="tag tag--plain">${esc(ALL_AGENTS_LABEL)}</span>`);
  const t = m.date ? fmtTime(m.date) : null;
  if (t) bits.push(`<span class="tag tag--plain">${esc(t)}</span>`);
  return bits.length ? `<div class="card__foot">${bits.join('')}</div>` : '';
}

function fmtTime(ts) {
  try {
    return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
      .format(new Date(ts));
  } catch (e) { return ''; }
}
function fmtDate(ts, opts) {
  try {
    return new Intl.DateTimeFormat('en-US', opts || { month: 'short', day: 'numeric', year: 'numeric' })
      .format(new Date(ts));
  } catch (e) { return ''; }
}

/** Split "2 026" / "$3,450" / "4h 12m" into [prefix, number, suffix] for the count-up. */
function splitNumeric(value) {
  const s = String(value);
  const m = /(\d[\d ,. ]*)/.exec(s);
  if (!m) return null;
  const raw = m[1].replace(/[\s ,]/g, '');
  const num = parseFloat(raw);
  if (!isFinite(num)) return null;
  return { pre: s.slice(0, m.index), num, text: m[1], post: s.slice(m.index + m[1].length) };
}

function statSizeClass(value) {
  const len = String(value).length;
  return len > 8 ? 'stat stat--xlong' : len > 5 ? 'stat stat--long' : 'stat';
}

function statMarkup(st) {
  const val = String(st.value);
  const sr = `${val}${st.unit ? ' ' + st.unit : ''}${st.label ? ' ' + st.label : ''}`;
  return `<div class="stat-lock">
      <span class="sr-only">${esc(sr)}</span>
      <div class="${statSizeClass(val)}" aria-hidden="true">
        <span class="stat__v" data-value="${esc(val)}">${esc(val)}</span>
        ${st.unit ? `<span class="stat__unit">${esc(st.unit)}</span>` : ''}
      </div>
      ${st.label ? `<div class="stat__label" aria-hidden="true">${esc(st.label)}</div>` : ''}
    </div>`;
}

/**
 * Build one card element. Art is not mounted here — see mountArt().
 * @param {object} m normalized memory
 * @param {number} i index in the feed (drives the stagger)
 */
function buildCard(m, i) {
  const artKind = m.isArchetype ? 'profile' : m.kind;
  const hasArt = m.kind !== 'flat';
  const cls = ['card'];
  if (m.kind === 'onthisday') cls.push('card--hero', 'card--art');
  else if (m.kind === 'stat') cls.push('card--stat');
  else if (m.kind === 'quote') cls.push('card--quote');
  else if (m.kind === 'chart') cls.push('card--chart');
  else if (m.kind === 'award') cls.push('card--award', 'card--art');
  if (m.isCover) cls.push('card--cover');
  // The archetype is the hook — in the feed it gets the tallest frame and the
  // biggest type, so it reads as the answer rather than as card six of thirty.
  if (m.isArchetype && !m.isCover) cls.push('card--archetype');

  const card = h('article', {
    class: cls.join(' '),
    style: `${paletteStyle(m.seed)};--i:${i}`,
    id: `m-${cssId(m.id)}`,
    'data-id': m.id,
    'data-kind': m.kind,
    'data-type': m.type,
    'data-project': m.project || '',
    'data-seed': m.seed,
    'data-artkind': artKind,
    'aria-labelledby': `t-${cssId(m.id)}`,
    tabindex: '-1',
  });
  if (isCyr(m.title) || isCyr(m.body) || (m.quote && isCyr(m.quote.text))) {
    card.setAttribute('data-script', 'cyr');
  }

  if (hasArt) card.appendChild(h('div', { class: 'card__art card__art--empty', 'data-art': '1' }));

  const body = h('div', { class: 'card__body' });
  const tid = `t-${cssId(m.id)}`;

  if (m.kind === 'quote') {
    const lang = isCyr(m.quote && m.quote.text) ? ' lang="ru"' : '';
    const who = m.quote && m.quote.who === 'agent' ? 'it said' : 'you said';
    const when = m.quote && m.quote.ts ? fmtDate(m.quote.ts) : (m.date ? fmtDate(m.date) : '');
    body.innerHTML = `
      ${m.eyebrow ? `<div class="eyebrow">${esc(m.eyebrow)}</div>` : ''}
      <div>
        <blockquote class="quote" id="${tid}"${lang}>«${esc(trimQuote(m.quote ? m.quote.text : m.title))}»</blockquote>
        <div class="quote__who">${esc(who)}${when ? ` · ${esc(when)}` : ''}${m.quote && m.quote.project ? ` · ${esc(m.quote.project)}` : ''}</div>
      </div>
      ${m.body ? `<p class="card__text">${esc(m.body)}</p>` : ''}`;
  } else if (m.kind === 'stat') {
    body.innerHTML = `
      <div class="card__head">${m.eyebrow ? `<div class="eyebrow">${esc(m.eyebrow)}</div>` : ''}</div>
      ${m.stat ? statMarkup(m.stat) : ''}
      <div>
        <h2 class="card__title" id="${tid}">${esc(m.title)}</h2>
        ${m.body ? `<p class="card__text">${esc(m.body)}</p>` : ''}
      </div>
      ${chartFigure(m)}`;
  } else if (m.kind === 'chart') {
    const fig = chartFigure(m);
    body.innerHTML = `
      <div class="card__head">
        ${m.eyebrow ? `<div class="eyebrow">${esc(m.eyebrow)}</div>` : ''}
        <h2 class="card__title" id="${tid}" style="margin-top:12px">${esc(m.title)}</h2>
        ${m.body ? `<p class="card__text">${esc(m.body)}</p>` : ''}
      </div>
      ${fig}`;
  } else {
    body.innerHTML = `
      <div class="card__head">${m.eyebrow ? `<div class="eyebrow">${esc(m.eyebrow)}</div>` : ''}</div>
      <div>
        <h2 class="card__title" id="${tid}">${esc(m.title)}</h2>
        ${m.tagline ? `<p class="tagline">${esc(m.tagline)}</p>` : ''}
        ${m.body ? `<p class="card__text">${esc(m.body)}</p>` : ''}
        ${m.quote ? `<blockquote class="pull"${isCyr(m.quote.text) ? ' lang="ru"' : ''}>«${esc(trimQuote(m.quote.text))}»</blockquote>` : ''}
        ${tagRow(m)}
      </div>`;
  }

  card.appendChild(body);

  // The archetype does not get the generic ⇪. Its image comes from one place —
  // the #/me screen — so the card carries a door instead of a duplicate.
  if (m.isArchetype) {
    const cta = h('a', {
      class: 'card__cta', href: '#/me',
      'aria-label': `Open ${m.title || 'your archetype'} full screen and save it`,
    }, `${m.isCover ? 'Open your archetype' : 'See it full screen'} <span aria-hidden="true">→</span>`);
    body.appendChild(cta);
  } else if (m.shareable) {
    const b = h('button', { class: 'card__share', type: 'button', 'aria-label': `Make a share card from “${m.title || m.type}”` }, '<span aria-hidden="true">⇪</span>');
    b.addEventListener('click', () => openShare(m));
    card.appendChild(b);
  }
  return card;
}

const cssId = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_');

function trimQuote(t) {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  if (s.length <= 180) return s;
  const cut = s.slice(0, 180);
  const sp = cut.lastIndexOf(' ');
  return (sp > 120 ? cut.slice(0, sp) : cut) + '…';
}

/* ── charts — hand-drawn inline SVG, no libraries ─────────────────────── */

const svgOpen = (vb, label) =>
  `<svg viewBox="${vb}" role="img" aria-label="${esc(label)}" preserveAspectRatio="xMidYMid meet">`;

/**
 * Every figure on this page reads the SAME normalised shape the video's canvas
 * renderers read — `normalizeChart()` in video.js. The detectors emit five
 * different payload shapes (a flat array for the clock, `[{date, v}]` for the
 * heat map, `[{label, v}]` for bars) and the readers below used to guess at
 * them; when the guess missed, `chartFigure()` returned an empty string and the
 * card simply had no chart in it. One shape, one place, both surfaces.
 */
const chartCache = new Map();

function normChart(m) {
  const raw = m && m.chart;
  if (!raw || !raw.type) return null;
  const key = (m.id || '') + ':' + raw.type;
  if (chartCache.has(key)) return chartCache.get(key);
  let out = null;
  try { out = CHARTS ? CHARTS.normalize(raw) : null; } catch (e) { out = null; }
  if (out && raw.note) out.note = raw.note;
  chartCache.set(key, out);
  return out;
}

function chartFigure(m) {
  const c = normChart(m);
  if (!c) return '';
  let inner = '', caption = '';
  try {
    if (c.type === 'clock') { inner = clockChart(c); caption = capClock(c); }
    else if (c.type === 'bars') { inner = barsChart(c); caption = capRows(c.rows); }
    else if (c.type === 'heat') { inner = heatChart(c); caption = capHeat(c); }
    else if (c.type === 'spark') { inner = sparkChart(c); caption = capSpark(c); }
    else if (c.type === 'donut') { inner = donutChart(c); caption = capRows(c.rows); }
  } catch (e) { inner = ''; }
  if (!inner) return '';
  return `<figure class="figure">${inner}<figcaption class="sr-only">${esc(caption)}</figcaption>
    ${c.note ? `<div class="figure__note">${esc(c.note)}</div>` : ''}</figure>`;
}

/** 24-spoke radial histogram, midnight at top. Night hours get --a-1. */
function clockChart(c) {
  const bins = c.bins;
  const max = Math.max(1, ...bins);
  const S = 320, cx = S / 2, cy = S / 2, r0 = 52, r1 = 142;
  let out = svgOpen(`0 0 ${S} ${S}`, 'Radial chart of messages by hour of day');
  out += `<circle cx="${cx}" cy="${cy}" r="${r0 - 8}" fill="none" stroke="var(--hairline)"/>`;
  out += `<circle cx="${cx}" cy="${cy}" r="${r1}" fill="none" stroke="var(--hairline)"/>`;
  const peak = c.peak;
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2 - Math.PI / 2;
    const len = r0 + (r1 - r0) * (bins[i] / max);
    const w = 7;
    const night = i < 6;
    const col = night ? 'var(--a-1)' : 'var(--a-2)';
    const op = bins[i] === 0 ? 0.16 : (i === peak ? 1 : night ? 0.9 : 0.6);
    const x1 = cx + Math.cos(a) * r0, y1 = cy + Math.sin(a) * r0;
    const x2 = cx + Math.cos(a) * len, y2 = cy + Math.sin(a) * len;
    out += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"
      stroke="${col}" stroke-width="${w}" stroke-linecap="round" opacity="${op}"/>`;
  }
  const marks = [[0, '00'], [6, '06'], [12, '12'], [18, '18']];
  for (const [i, lab] of marks) {
    const a = (i / 24) * Math.PI * 2 - Math.PI / 2;
    const x = cx + Math.cos(a) * (r1 + 16), y = cy + Math.sin(a) * (r1 + 16);
    out += `<text class="c-lab" x="${x.toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="middle">${lab}</text>`;
  }
  const pk = String(peak).padStart(2, '0');
  out += `<text class="c-big" x="${cx}" y="${cy + 2}" text-anchor="middle">${pk}</text>`;
  out += `<text class="c-sub" x="${cx}" y="${cy + 22}" text-anchor="middle">PEAK HOUR</text>`;
  return out + '</svg>';
}
function capClock(c) {
  return `Messages by hour of day. Peak at ${String(c.peak).padStart(2, '0')}:00 with ${c.bins[c.peak] || 0}.`;
}

function capRows(rows) {
  return rows.map((r) => `${r.label}: ${groupNum(r.value)}`).join('. ') + '.';
}

/** Horizontal bars, label left, value right. Max 8 rows. */
function barsChart(c) {
  const rows = c.rows;
  if (!rows.length) return '';
  const max = Math.max(1, ...rows.map((r) => r.value));
  const W = 520, BH = 30, GAP = 10;
  const H = rows.length * (BH + GAP) - GAP;
  let out = svgOpen(`0 0 ${W} ${H}`, 'Bar chart');
  rows.forEach((r, i) => {
    const y = i * (BH + GAP);
    const w = Math.max(3, (r.value / max) * W);
    const label = r.label.toUpperCase();
    // No text measurement in raw SVG, so approximate: the label only goes
    // inside the bar when the bar is comfortably wider than the glyphs.
    const labW = label.length * 6.6 + 26;
    const inside = w > labW;
    const valW = String(r.value).length * 7.2 + 22;
    const valInside = w > W - valW;
    out += `<rect x="0" y="${y}" width="${W}" height="${BH}" rx="4" fill="var(--a-1)" opacity=".07"/>`;
    out += `<rect x="0" y="${y}" width="${w.toFixed(1)}" height="${BH}" rx="4" fill="var(--a-1)" opacity="${(1 - i * 0.09).toFixed(2)}"/>`;
    out += `<text class="c-lab" x="${inside ? 12 : (w + 12).toFixed(1)}" y="${y + BH / 2 + 4}"${inside ? ' style="fill:var(--ink-inv)"' : ''}>${esc(label)}</text>`;
    out += `<text class="c-val" x="${W - 10}" y="${y + BH / 2 + 4}" text-anchor="end"${valInside ? ' style="fill:var(--ink-inv)"' : ''}>${esc(groupNum(r.value))}</text>`;
  });
  return out + '</svg>';
}

/** GitHub-shaped day grid. Five opacity steps of --a-1. Never green. */
function heatChart(c) {
  const values = c.values;
  if (!values.length) return '';
  const cols = Math.ceil(values.length / 7);
  const CS = 10, G = 3;
  const W = cols * (CS + G) - G, H = 7 * (CS + G) - G;
  const max = Math.max(1, ...values);
  const step = (v) => (v <= 0 ? 0 : v / max < 0.2 ? 1 : v / max < 0.45 ? 2 : v / max < 0.7 ? 3 : v / max < 0.9 ? 4 : 5);
  const OP = (CHARTS && CHARTS.heatOps) || [0.06, 0.12, 0.3, 0.52, 0.76, 1];
  let out = svgOpen(`0 0 ${W} ${H}`, 'Calendar heat map of active days');
  values.forEach((v, i) => {
    const x = Math.floor(i / 7) * (CS + G), y = (i % 7) * (CS + G);
    out += `<rect x="${x}" y="${y}" width="${CS}" height="${CS}" rx="2.5" fill="var(--a-1)" opacity="${OP[step(v)]}"/>`;
  });
  return out + '</svg>';
}
function capHeat(c) {
  const lit = c.values.filter((v) => v > 0).length;
  return `Calendar grid: ${lit} active days out of ${c.values.length}.`;
}

/** Area + line, no axes. */
function sparkChart(c) {
  const pts = c.points;
  if (pts.length < 2) return '';
  const W = 520, H = 140, max = Math.max(1, ...pts), min = Math.min(...pts);
  const span = Math.max(1e-6, max - min);
  const X = (i) => (i / (pts.length - 1)) * W;
  const Y = (v) => H - 6 - ((v - min) / span) * (H - 22);
  let line = '';
  pts.forEach((v, i) => { line += `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`; });
  const area = `${line}L${W},${H}L0,${H}Z`;
  let out = svgOpen(`0 0 ${W} ${H}`, 'Trend line');
  out += `<defs><linearGradient id="spg" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="var(--a-1)" stop-opacity=".38"/>
    <stop offset="1" stop-color="var(--a-1)" stop-opacity="0"/></linearGradient></defs>`;
  out += `<path d="${area}" fill="url(#spg)"/>`;
  out += `<path d="${line}" fill="none" stroke="var(--a-1)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  const li = pts.length - 1;
  out += `<circle cx="${X(li).toFixed(1)}" cy="${Y(pts[li]).toFixed(1)}" r="4" fill="var(--a-3)"/>`;
  return out + '</svg>';
}
function capSpark(c) {
  const pts = c.points;
  return `Trend across ${pts.length} points, from ${pts[0]} to ${pts[pts.length - 1]}.`;
}

/** ≤4 segments + other, 30px stroke, 3° gaps, number in the middle. */
function donutChart(c) {
  const rows = c.rows;
  if (!rows.length) return '';
  const total = rows.reduce((s, r) => s + r.value, 0) || 1;
  // Wider than tall so the on-mark labels have somewhere to live.
  const W = 460, H = 330, cx = W / 2, cy = H / 2, r = 104, SW = 28;
  const COLS = ['var(--a-1)', 'var(--a-2)', 'var(--a-3)', 'var(--a-1)', 'var(--a-2)'];
  const OPS = [1, 0.92, 0.85, 0.5, 0.32];
  let out = svgOpen(`0 0 ${W} ${H}`, 'Share of time by project');
  let ang = -90, labels = '';
  const rad = (a) => (a * Math.PI) / 180;
  rows.forEach((row, i) => {
    const sweep = (row.value / total) * 360;
    const a0 = ang + 1.5, a1 = ang + sweep - 1.5;
    const mid = ang + sweep / 2;
    ang += sweep;
    if (a1 <= a0) return;
    const x0 = cx + Math.cos(rad(a0)) * r, y0 = cy + Math.sin(rad(a0)) * r;
    const x1 = cx + Math.cos(rad(a1)) * r, y1 = cy + Math.sin(rad(a1)) * r;
    const large = a1 - a0 > 180 ? 1 : 0;
    out += `<path d="M${x0.toFixed(1)},${y0.toFixed(1)} A${r},${r} 0 ${large} 1 ${x1.toFixed(1)},${y1.toFixed(1)}"
      fill="none" stroke="${COLS[i % COLS.length]}" opacity="${OPS[i % OPS.length]}" stroke-width="${SW}" stroke-linecap="butt"/>`;
    // Label on the mark, not in a legend — but only where there's room for it.
    if (sweep >= 34) {
      const lx = cx + Math.cos(rad(mid)) * (r + SW / 2 + 14);
      const ly = cy + Math.sin(rad(mid)) * (r + SW / 2 + 14);
      const anchor = Math.cos(rad(mid)) > 0.25 ? 'start' : Math.cos(rad(mid)) < -0.25 ? 'end' : 'middle';
      labels += `<text class="c-lab" x="${lx.toFixed(1)}" y="${(ly + 3).toFixed(1)}" text-anchor="${anchor}">${esc(String(row.label).toUpperCase().slice(0, 14))}</text>`;
    }
  });
  out += labels;
  const top = rows[0];
  out += `<text class="c-big" x="${cx}" y="${cy - 2}" text-anchor="middle">${Math.round((top.value / total) * 100)}%</text>`;
  out += `<text class="c-sub" x="${cx}" y="${cy + 20}" text-anchor="middle">${esc(String(top.label).toUpperCase().slice(0, 16))}</text>`;
  return out + '</svg>';
}

/* ── art mounting + reveal + count-up ─────────────────────────────────── */

const mounted = new WeakMap();

function mountArt(card, lite) {
  const holder = card.querySelector('[data-art]');
  if (!holder) return;
  const seed = Number(card.dataset.seed) >>> 0;
  const kind = card.dataset.artkind || 'onthisday';
  const want = lite ? 'lite' : 'full';
  if (mounted.get(holder) === want + themeNow()) return;
  const svg = artSVG(seed, kind, { w: 1000, h: 1250, blur: !lite });
  if (svg) {
    holder.innerHTML = labelled(svg, seed, kind);
    holder.classList.remove('card__art--empty');
    mounted.set(holder, want + themeNow());
  }
}

function remountAllArt() {
  $$('.card').forEach((c) => { const hd = c.querySelector('[data-art]'); if (hd && hd.firstChild) { mounted.delete(hd); mountArt(c, false); } });
  $$('.wslide').forEach((s) => {
    const hd = s.querySelector('.wslide__art');
    if (hd && hd.dataset.seed) {
      hd.innerHTML = artSVG(Number(hd.dataset.seed) >>> 0, hd.dataset.artkind || 'profile', { w: 1000, h: 1780, blur: true });
    }
  });
  $$('.card, .wslide').forEach((el) => {
    const s = el.dataset.seed; if (s) el.style.cssText = el.style.cssText.replace(/--a-[13bg2]+:[^;]*;?/g, '') + ';' + paletteStyle(Number(s) >>> 0);
  });
  if (shareState.memory) drawShare();
  if (meEl && meEl.open) { $('#meart').textContent = ''; paintMe(); refreshMeCard(); }
  paintMark();
}

const easeOutExpo = (t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t));

function countUp(el) {
  const target = el.dataset.value;
  const parsed = splitNumeric(target);
  if (!parsed || RM.matches || parsed.num > 1e12) { el.textContent = target; return; }
  const dec = (parsed.text.split('.')[1] || '').replace(/\D/g, '').length;
  const thin = parsed.text.indexOf(' ') >= 0;
  const comma = parsed.text.indexOf(',') >= 0;
  const fmt = (v) => {
    let s = dec ? v.toFixed(dec) : String(Math.round(v));
    if (thin) s = s.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    else if (comma) s = s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return s;
  };
  const t0 = performance.now(), dur = 1100;
  let done = false;
  const finish = () => { if (!done) { done = true; el.textContent = target; } };
  const step = (t) => {
    if (done) return;
    const p = clamp((t - t0) / dur, 0, 1);
    if (p < 1) {
      el.textContent = parsed.pre + fmt(parsed.num * easeOutExpo(p)) + parsed.post;
      requestAnimationFrame(step);
    } else finish();
  };
  requestAnimationFrame(step);
  // rAF stops in a hidden or throttled tab. Without this the animation freezes
  // part-way and the card is left showing a number that is simply wrong — the
  // peak-day card sat at "13 messages" when the real answer was 53. A card that
  // lies is worse than no card, so the timer always lands the true value.
  setTimeout(finish, dur + 400);
}

/* ── the feed ─────────────────────────────────────────────────────────── */

const feedEl = $('#feed');
let FEED = [], REST = [], activeFilter = 'all';

function coverMemory() {
  if (!ARCHETYPE) return null;
  const c = Object.assign({}, ARCHETYPE, { id: ARCHETYPE.id + ':cover', isCover: true, kind: 'award' });
  const from = PROFILE.firstSeen ? fmtDate(PROFILE.firstSeen) : '';
  const to = PROFILE.lastSeen ? fmtDate(PROFILE.lastSeen) : '';
  c.eyebrow = from && to ? `${from} — ${to}` : 'YOUR ALBUM';
  c.body = ARCHETYPE.body;
  return c;
}

function closingCard() {
  const thin = (PROFILE.activeDays || 0) < 14;
  return {
    id: 'closing:card', type: 'closing', kind: 'flat', date: null, weight: 0,
    eyebrow: thin ? 'THE END, FOR NOW' : 'THE END',
    title: thin ? 'Come back in a month. This gets much weirder.'
      : 'That is the album, so far.',
    body: thin ? null : 'It keeps a record whether you look at it or not. Run it again whenever.',
    stat: null, quote: null, chart: null, seed: hash32('closing'), agent: null, project: null,
    tags: [], shareable: false,
  };
}

function buildFeed() {
  const ordered = orderFeed(MEMORIES.filter((m) => m.kind !== 'flat'));
  FEED = ordered.feed;
  REST = ordered.rest;

  const cover = coverMemory();
  if (cover) {
    // slot 5–6 gets the archetype in full; the cover opens the album.
    // detect.js already reserves that slot when the archetype made the feed, so
    // splicing unconditionally printed the same card three times in seven —
    // cover, then two identical copies.
    const already = FEED.some((m) => m && m.id === ARCHETYPE.id);
    if (!already) {
      const at = Math.min(5, FEED.length);
      FEED = FEED.slice(0, at).concat([ARCHETYPE], FEED.slice(at));
    }
    FEED.unshift(cover);
  }
  render();
}

function render() {
  feedEl.textContent = '';
  const list = FEED.filter(matchFilter);
  if (!list.length) {
    feedEl.appendChild(h('div', { class: 'blank' },
      '<h2>Nothing under that filter.</h2><p>Try “All”.</p>'));
    return;
  }
  const frag = document.createDocumentFragment();
  list.forEach((m, i) => {
    try { frag.appendChild(buildCard(m, i)); } catch (e) { console.warn('card skipped', m.id, e); }
  });
  const closing = closingCard();
  if (activeFilter === 'all') {
    try { frag.appendChild(buildCard(closing, list.length)); } catch (e) { /* noop */ }
  }
  feedEl.appendChild(frag);

  if (activeFilter === 'all' && REST.length) {
    const wrap = h('div', { class: 'tail' });
    const b = h('button', { class: 'tail__b', type: 'button' },
      `Show everything · ${REST.length} more memories`);
    b.addEventListener('click', () => {
      wrap.remove();
      const f = document.createDocumentFragment();
      REST.slice().sort((a, b2) => (b2.date || 0) - (a.date || 0))
        .forEach((m, i) => { try { f.appendChild(buildCard(m, i)); } catch (e) { /* noop */ } });
      feedEl.appendChild(f);
      observeAll();
    });
    wrap.appendChild(b);
    feedEl.after(wrap);
  }
  observeAll();
}

function matchFilter(m) {
  if (activeFilter === 'all') return true;
  if (activeFilter === 'onthisday') return m.kind === 'onthisday' || m.type === 'on-this-day';
  if (activeFilter === 'funny') return m.tags.indexOf('funny') >= 0 || FUNNY_TYPES.has(m.type) || m.kind === 'award';
  if (activeFilter === 'numbers') return m.kind === 'stat' || m.kind === 'chart';
  if (activeFilter === 'quotes') return m.kind === 'quote' || !!m.quote;
  if (activeFilter.indexOf('p:') === 0) return m.project === activeFilter.slice(2);
  return true;
}
const FUNNY_TYPES = new Set(['catchphrase-yours', 'catchphrase-its', 'the-shortest-word',
  'the-rage-quit', 'the-interruption', 'the-politeness', 'the-apology', 'deja-vu', 'spirit-tool',
  'two-tongues', 'the-swarm']);

/* observers: reveal, art mount, count-up */
let ioReveal, ioArt, ioStat;
function observeAll() {
  const cards = $$('.card');
  if (!ioReveal) {
    ioReveal = new IntersectionObserver((es) => {
      es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('is-in'); ioReveal.unobserve(e.target); } });
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.08 });
    ioArt = new IntersectionObserver((es) => {
      es.forEach((e) => { if (e.isIntersecting) { mountArt(e.target, false); ioArt.unobserve(e.target); } });
    }, { rootMargin: '600px 0px 900px 0px' });
    ioStat = new IntersectionObserver((es) => {
      es.forEach((e) => { if (e.isIntersecting) { countUp(e.target); ioStat.unobserve(e.target); } });
    }, { threshold: 0.6 });
  }
  cards.forEach((c) => {
    if (c.dataset.obs) return;
    c.dataset.obs = '1';
    ioReveal.observe(c);
    if (c.querySelector('[data-art]')) ioArt.observe(c);
    const sv = c.querySelector('.stat__v');
    if (sv) ioStat.observe(sv);
  });
  // The first screen is mounted eagerly — nothing should pop in on load.
  cards.slice(0, 2).forEach((c) => { mountArt(c, false); c.classList.add('is-in'); });
}

/* ── filters ──────────────────────────────────────────────────────────── */

function buildFilters() {
  const el = $('#filters');
  const projects = {};
  MEMORIES.forEach((m) => { if (m.project) projects[m.project] = (projects[m.project] || 0) + 1; });
  const top = Object.keys(projects).sort((a, b) => projects[b] - projects[a]).slice(0, 5);
  const defs = [
    ['all', 'All'],
    ['onthisday', 'This day'],
    ['funny', 'Funny'],
    ['numbers', 'Numbers'],
    ['quotes', 'Quotes'],
  ].concat(top.map((p) => ['p:' + p, p]));

  defs.forEach(([key, label]) => {
    const n = FEED.filter((m) => { const s = activeFilter; activeFilter = key; const r = matchFilter(m); activeFilter = s; return r; }).length;
    if (!n && key !== 'all') return;
    const b = h('button', { class: 'chip', type: 'button', 'aria-pressed': key === activeFilter },
      `${esc(label)}<span class="chip__n">${n}</span>`);
    b.addEventListener('click', () => {
      activeFilter = key;
      $$('.chip', el).forEach((c) => c.setAttribute('aria-pressed', 'false'));
      b.setAttribute('aria-pressed', 'true');
      render();
      window.scrollTo({ top: 0, behavior: RM.matches ? 'auto' : 'smooth' });
    });
    el.appendChild(b);
  });
}

/* ── the ember mark: last 9 active days ───────────────────────────────── */

function lastNineDays() {
  const set = new Set(TIMELINE.filter((d) => (d.sessions || d.humanTurns || d.minutes || 0) > 0).map((d) => d.date));
  const end = PROFILE.lastSeen || Date.now();
  const out = [];
  for (let i = 8; i >= 0; i--) {
    const d = new Date(end);
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    out.push(set.has(key));
  }
  if (!out.some(Boolean)) return [true, false, false, false, true, false, false, false, true];
  return out;
}

function markSVG(size) {
  const lit = lastNineDays();
  const D = 7, G = 5, S = D * 3 + G * 2;
  let out = `<svg viewBox="0 0 ${S} ${S}" width="${size}" height="${size}" aria-hidden="true">`;
  for (let i = 0; i < 9; i++) {
    const x = (i % 3) * (D + G), y = Math.floor(i / 3) * (D + G);
    out += `<rect x="${x}" y="${y}" width="${D}" height="${D}" rx="1.5" fill="${lit[i] ? 'var(--a-1)' : 'var(--ink-0)'}" opacity="${lit[i] ? 1 : 0.18}"/>`;
  }
  return out + '</svg>';
}
function paintMark() { const m = $('#mark'); if (m) m.innerHTML = markSVG(25); }

/* ── Wrapped ──────────────────────────────────────────────────────────── */

const WRAPPED_BEATS = [
  ['the-anniversary', 'first-day', 'the-ratio'],
  ['first-words', 'the-verb', 'catchphrase-yours'],
  ['the-ratio', 'the-bill', 'the-marathon'],
  ['deep-work-clock', 'the-heatmap', 'project-constellation'],
  ['catchphrase-yours', 'the-shortest-word', 'the-interruption'],
  ['the-interruption', 'the-compaction', 'the-streak'],
  ['the-long-night', 'the-apology', 'on-this-day', 'rediscovered'],
  ['the-bill', 'peak-day', 'the-marathon'],
];

const wrapEl = $('#wrapped');
const slidesEl = $('#wslides');
const progEl = $('#wprog');
let SLIDES = [], wi = 0, wTimer = null, wPaused = false, wOpener = null;

/* ── the opening card ─────────────────────────────────────────────────── */

/**
 * Nothing in Wrapped used to say who any of this was WITH, which is the first
 * thing anyone watching wants to know and the most personal fact in the file.
 * The split comes from `timeline[].agent` — messages you typed, per agent, per
 * day — so only agents that actually appear are ever named.
 */
let castMemo;
function castInfo() {
  if (castMemo === undefined) {
    let c = null;
    try { c = CHARTS ? CHARTS.cast(TIMELINE) : null; } catch (e) { c = null; }
    castMemo = c && c.agents.length && c.total > 0 ? c : null;
  }
  return castMemo;
}

/** Small counts read as words in a sentence — "and two more", not "and 2 more". */
const SMALL_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const smallWord = (n) => (n >= 0 && n < SMALL_WORDS.length ? SMALL_WORDS[n] : groupNum(n));

/** "Cursor, Codex and Claude Code" — named the way you'd name faces in a photo. */
function castNames(agents) {
  const all = (agents || []).map((a) => a.name).filter(Boolean);
  if (!all.length) return '';
  if (all.length === 1) return all[0];
  const shown = all.length > 4 ? all.slice(0, 3).concat([`${smallWord(all.length - 3)} more`]) : all;
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

/**
 * A share, said the way a person would say it.
 *
 * The ladder is only allowed to speak when the real number is genuinely near
 * one of its fractions (within 4.5 points, which is closer than any two rungs
 * are to each other); otherwise it falls back to the plain percentage. So
 * "four in every five" is never printed over a 68/32 split, and the card can
 * never flatter the data into a rounder story than it is.
 */
const SHARE_FRACTIONS = [
  [1 / 2, 'half'], [3 / 5, 'three in every five'], [2 / 3, 'two in every three'],
  [7 / 10, 'seven in every ten'], [3 / 4, 'three in every four'],
  [4 / 5, 'four in every five'], [5 / 6, 'five in every six'], [9 / 10, 'nine in every ten'],
];
function shareWords(s) {
  if (s >= 0.96) return 'almost all';
  let best = null, err = Infinity;
  for (const [f, w] of SHARE_FRACTIONS) {
    const e = Math.abs(s - f);
    if (e < err) { err = e; best = w; }
  }
  return err <= 0.045 ? best : `${Math.round(s * 100)}%`;
}

/**
 * The first beat of the story, and the only one most people will ever see.
 *
 * It used to be a legend: three percentages and a stacked bar above the words
 * "THE CAST — Cursor, Codex and Claude Code present". That is a chart with a
 * title, and it asked a stranger to read a ranking before they knew there was
 * a relationship here at all.
 *
 * The premise is that you and your agent are two of you. The joke — and the
 * fact — is that you are not. So the headline states the premise and takes it
 * away in the same breath, and the proportions come back as the sentence that
 * proves it. One agent gets the same sentence with the other half of the turn,
 * which is why the solo case reads as a punchline rather than a fallback.
 *
 * The runners-up, for the record:
 *
 *  B — THE GROUP PHOTO
 *      eyebrow  the group photo
 *      head     Cursor, Codex and Claude Code. And you, at every hour of it.
 *      body     5,766 messages over 207 days. Not one of them has a face.
 *               You kept typing anyway.
 *      Warmest of the four, and the names lead — but the headline is still a
 *      list, and a list of product names is a legend wearing a serif.
 *
 *  C — THE COMPANY YOU KEPT
 *      eyebrow  the company you kept
 *      head     You did not do this year on your own.
 *      body     Cursor, Codex and Claude Code, 5,766 messages over 207 days.
 *               Four in every five of them for Cursor.
 *      True and kind, but "you did not do this on your own" is the sort of
 *      thing a wellness app says, and the irony drains straight out of it.
 *
 *  D — THE ROLL CALL
 *      eyebrow  who showed up
 *      head     Three of them. 207 days. Not one no-show.
 *      body     Cursor took four in every five messages. Codex and Claude Code
 *               divided the rest between them.
 *      Best rhythm of the four and the most quotable — but it opens on a count
 *      and closes on a split, which is the dashboard again in a better suit.
 */
function castCopy() {
  const c = castInfo();
  if (!c) return null;
  const n = c.agents.length;
  const lead = c.agents[0];
  const msgs = `${groupNum(c.total)} ${c.total === 1 ? 'message' : 'messages'}`;
  const names = castNames(c.agents);

  // No day count here, deliberately. The card after this one opens on the span
  // and on `activeDays`, which counts days with anything on them at all — a
  // slightly larger number than the days with an attributed message. Printing
  // both, one beat apart, reads as the album contradicting itself. This beat is
  // who; the next beat is how long.
  if (n === 1) {
    return {
      eyebrow: 'who was in the room',
      headline: 'It really was just the two of you.',
      body: `${names}. ${msgs}, and nobody else ever got a word in.`,
    };
  }

  // The split, folded into the sentence — and only claimed when there is a
  // split to claim. Two agents within three points of even, or a lead too
  // small to be a favourite, get told the truth instead of a headline number.
  let tail;
  if (n === 2 && Math.abs(lead.share - 0.5) < 0.03) {
    tail = 'split almost exactly down the middle';
  } else if (lead.share < 0.45) {
    tail = 'and no clear favourite among them';
  } else {
    tail = `and ${shareWords(lead.share)} of them for ${lead.name} alone`;
  }

  return {
    eyebrow: 'who was in the room',
    headline: 'It was never just the two of you.',
    body: `${names}. ${msgs}, ${tail}.`,
  };
}

/** The seed is the archetype's, turned once, so the cast card is kin to the finale. */
const CAST_SEED = (((PROFILE.archetype && PROFILE.archetype.seed) || hash32('cast')) ^ 0x9E3779B9) >>> 0;

function pickSlides() {
  const used = new Set();
  const usedCharts = new Set();
  const pool = MEMORIES.slice().sort((a, b) => b.weight - a.weight);
  const out = [];
  const aseed = (PROFILE.archetype && PROFILE.archetype.seed) || hash32('finale');
  const chartTypeOf = (m) => { const c = normChart(m); return c ? c.type : null; };

  const castC = castCopy();
  if (castC) out.push({ cast: true, copy: castC, seed: CAST_SEED });
  out.push({ hello: true, seed: (PROFILE.archetype && PROFILE.archetype.seed) || hash32('hello') });
  for (const beat of WRAPPED_BEATS) {
    const cands = [];
    for (const type of beat) {
      const got = pool.find((m) => m.type === type && !used.has(m.id) && m.shareable !== false);
      if (got) cands.push(got);
    }
    let got = cands[0] || pool.find((m) => !used.has(m.id) && m.shareable !== false) || null;
    // Chart variety. A beat is a ranked list of interchangeable memories, so if
    // the first choice would draw a shape the story has already drawn and a
    // later one in the SAME beat brings a shape it hasn't, the later one wins.
    // The editorial order is otherwise untouched — this only breaks ties the
    // beat already declared acceptable.
    const t0 = got ? chartTypeOf(got) : null;
    if (t0 && usedCharts.has(t0)) {
      const alt = cands.find((m) => { const t = chartTypeOf(m); return t && !usedCharts.has(t); });
      if (alt) got = alt;
    }
    if (got) {
      used.add(got.id);
      const t = chartTypeOf(got);
      if (t) usedCharts.add(t);
      out.push(got);
    }
  }
  // The archetype used to be the second-to-last slide, next to a summary card
  // that repeated the same numbers. It is the thing people quote at each other,
  // so it is now the finale itself, with one beat of held breath before it.
  if (ARCHETYPE) out.push({ tease: true, seed: aseed });
  out.push({ finale: true, seed: aseed });
  return out;
}

/** The four numbers under the archetype name. Short labels, no paths. */
function finaleCells() {
  return [
    [groupNum(PROFILE.activeDays || 0), 'days'],
    [groupNum(PROFILE.totalSessions || STATS.totalSessions || 0), 'sessions'],
    [groupNum(STATS.humanTurns || STATS.totalHumanTurns || 0), 'messages'],
    [groupNum(Math.round(PROFILE.totalHours || STATS.totalHours || 0)), 'hours'],
  ].filter(([v]) => v && v !== '0');
}

/**
 * The exact split, for anyone reading with their ears.
 *
 * There is no chart on this card any more — the proportions are in the body
 * sentence, rounded to something a person would say out loud. This line is the
 * unrounded version, and it is the only place the per-agent counts survive.
 */
function castDetail() {
  const c = castInfo();
  if (!c || c.agents.length < 2) return '';
  const sr = c.agents.map((a) => `${a.name}: ${groupNum(a.messages)} messages`).join('. ');
  return `<span class="sr-only">${esc(sr)}.</span>`;
}

function slideMarkup(s) {
  if (s.cast) {
    const c = s.copy || {};
    return `<div class="wslide__in wslide__in--cast">
      ${castDetail()}
      <div class="eyebrow">${esc(c.eyebrow || 'who was in the room')}</div>
      <h2 class="wslide__title">${esc(c.headline || '')}</h2>
      ${c.body ? `<p class="wslide__text wslide__text--lede">${esc(c.body)}</p>` : ''}
    </div>`;
  }
  if (s.hello) {
    const from = PROFILE.firstSeen ? fmtDate(PROFILE.firstSeen) : '';
    const to = PROFILE.lastSeen ? fmtDate(PROFILE.lastSeen) : '';
    // "Hello. Here is the two of you." used to live here. The opening card has
    // taken that line over and made a joke of it, so this beat stops counting
    // heads and does the one job it is actually for: the span.
    return `<div class="wslide__in">
      <div class="eyebrow">codepend wrapped</div>
      <h2 class="wslide__title">Here is what you did together.</h2>
      <p class="wslide__text">${esc(from)} — ${esc(to)}${PROFILE.activeDays ? ` · ${PROFILE.activeDays} days with something on them` : ''}.</p>
    </div>`;
  }
  if (s.tease) {
    return `<div class="wslide__in wslide__in--tease">
      <div class="eyebrow">all of which means</div>
      <h2 class="wslide__title">There is a word for someone who works like that.</h2>
    </div>`;
  }
  if (s.finale) {
    const a = PROFILE.archetype || {};
    const cells = finaleCells();
    // The finale IS the archetype, so the primary verb here is the archetype's.
    // "Share card" used to sit in this slot and open the generic sheet; it now
    // hands off to the screen that owns the artifact.
    const vid = VIDEO_OK ? '<button class="btn js-wvideo" type="button">Save video</button>' : '';
    return `<div class="wslide__in wslide__in--finale">
      <div class="eyebrow">what that makes you</div>
      <h2 class="wslide__name">${esc(a.name || 'Your year with it')}</h2>
      ${a.tagline ? `<p class="wslide__tagline">${esc(a.tagline)}</p>` : ''}
      ${a.blurb ? `<p class="wslide__text">${esc(a.blurb)}</p>` : ''}
      <div class="wslide__grid">${cells.map(([b, l]) => `<div class="wslide__cell"><b>${esc(b)}</b><span>${esc(l)}</span></div>`).join('')}</div>
      <div class="wslide__cta">
        <button class="btn btn--solid js-wme" type="button">Save archetype</button>
        ${vid}
        <button class="btn js-wreplay" type="button">Replay</button>
      </div>
    </div>`;
  }
  const m = s;
  const lang = m.quote && isCyr(m.quote.text) ? ' lang="ru"' : '';
  let mid = '';
  if (m.kind === 'stat' && m.stat) mid = statMarkup(m.stat);
  else if (m.kind === 'quote' && m.quote) {
    mid = `<blockquote class="wslide__quote"${lang}>«${esc(trimQuote(m.quote.text))}»</blockquote>`;
  } else if (m.kind === 'chart') mid = chartFigure(m);
  // A story card says one thing. If the headline just restates the number
  // that is already set at 130px above it, the headline goes.
  const dupes = m.stat && m.title && m.title.indexOf(String(m.stat.value)) >= 0;
  const showTitle = m.kind !== 'quote' && !dupes;
  return `<div class="wslide__in">
    ${m.eyebrow ? `<div class="eyebrow">${esc(m.eyebrow)}</div>` : ''}
    ${mid}
    ${showTitle ? `<h2 class="wslide__title">${esc(m.title)}</h2>` : ''}
    ${m.tagline ? `<p class="wslide__text" style="font-style:italic">${esc(m.tagline)}</p>` : ''}
    ${m.body ? `<p class="wslide__text">${esc(m.body)}</p>` : ''}
  </div>`;
}

function buildWrapped() {
  SLIDES = pickSlides();
  slidesEl.textContent = '';
  progEl.textContent = '';
  SLIDES.forEach((s, i) => {
    const seed = (s.seed || 0) >>> 0;
    const profileish = s.isArchetype || s.hello || s.finale || s.tease || s.cast;
    const kind = profileish ? 'profile' : (s.kind || 'onthisday');
    const el = h('section', {
      class: 'wslide' + (s.finale ? ' wslide--finale' : s.tease ? ' wslide--tease' : s.cast ? ' wslide--cast' : ''),
      style: paletteStyle(seed),
      'aria-hidden': i !== 0, 'data-seed': seed,
    });
    if (s.quote && isCyr(s.quote.text)) el.setAttribute('data-script', 'cyr');
    const art = h('div', { class: 'wslide__art', 'data-seed': seed, 'data-artkind': kind });
    el.appendChild(art);
    el.insertAdjacentHTML('beforeend', slideMarkup(s));
    slidesEl.appendChild(el);
    progEl.appendChild(h('i', null, '<b></b>'));
  });
  slidesEl.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.classList.contains('js-wme')) { closeWrapped(); openMe(null); }
    if (t.classList.contains('js-wreplay')) goSlide(0, 1);
    if (t.classList.contains('js-wvideo')) exportVideo();
  });
}

function mountSlideArt(i) {
  for (const j of [i, i + 1]) {
    const el = slidesEl.children[j];
    if (!el) continue;
    const art = el.querySelector('.wslide__art');
    if (art && !art.firstChild) {
      const sd = Number(art.dataset.seed) >>> 0;
      art.innerHTML = labelled(artSVG(sd, art.dataset.artkind, { w: 1000, h: 1780, blur: true }), sd, art.dataset.artkind);
    }
  }
}

function goSlide(i, dir) {
  if (i < 0) return;
  if (i >= SLIDES.length) { closeWrapped(); return; }
  wrapEl.classList.toggle('is-back', dir < 0);
  wi = i;
  Array.from(slidesEl.children).forEach((el, j) => {
    el.classList.toggle('is-on', j === i);
    el.setAttribute('aria-hidden', j === i ? 'false' : 'true');
  });
  Array.from(progEl.children).forEach((el, j) => {
    el.classList.toggle('is-done', j < i);
    el.classList.remove('is-now');
    if (j === i) { void el.offsetWidth; el.classList.add('is-now'); }
  });
  progEl.setAttribute('aria-valuenow', String(i + 1));
  progEl.setAttribute('aria-valuetext', `Slide ${i + 1} of ${SLIDES.length}`);
  wrapEl.classList.toggle('is-last', i === SLIDES.length - 1);
  progEl.style.setProperty('--hold', holdFor(i) + 'ms');
  // The finale is the card people screenshot, so it carries the promise
  // instead of the counter.
  $('#whint').textContent = i === SLIDES.length - 1
    ? 'codepend · npx codepend · 100% local'
    : `${i + 1} / ${SLIDES.length}${RM.matches ? '' : ' · hold to pause'}`;
  mountSlideArt(i);
  const sv = slidesEl.children[i].querySelector('.stat__v');
  if (sv) countUp(sv);
  restartTimer();
  if (location.hash !== '#/wrapped') history.replaceState(null, '', '#/wrapped');
}

function holdFor(i) {
  const s = SLIDES[i] || {};
  // The tease is one line and one beat; sitting on it for five seconds kills
  // the drop into the archetype.
  return s.tease ? Math.round(HOLD * 0.62) : HOLD;
}

function restartTimer() {
  clearTimeout(wTimer);
  if (RM.matches || wPaused) return;
  const last = wi === SLIDES.length - 1;
  if (last) return;                       // the finale waits for a decision
  wTimer = setTimeout(() => goSlide(wi + 1, 1), holdFor(wi));
}

/**
 * @param {Element|null} from the button to return focus to on close
 * @param {{toFinale?:boolean, andExport?:boolean}} [opts] jump straight to the
 *   archetype and start recording — what the dock's Video button does, so that
 *   asking for the video does not mean sitting through the story first.
 */
function openWrapped(from, opts) {
  const o = opts || {};
  wOpener = from || null;
  if (!SLIDES.length) buildWrapped();
  if (!wrapEl.open) { try { wrapEl.showModal(); } catch (e) { wrapEl.setAttribute('open', ''); } }
  document.body.style.overflow = 'hidden';
  goSlide(o.toFinale ? SLIDES.length - 1 : 0, 1);
  if (o.andExport && VIDEO_OK) {
    wPaused = true;
    clearTimeout(wTimer);
    // Give the dialog one frame to lay out before the recorder measures anything
    // off the DOM — but do not *depend* on that frame arriving. A hidden tab
    // gets no requestAnimationFrame at all, so gating the start on it meant the
    // export silently never began: no recorder, no progress, no error. The frame
    // loop inside video.js already learned this lesson; the start had not.
    let started = false;
    const begin = () => { if (!started) { started = true; exportVideo(); } };
    requestAnimationFrame(begin);
    setTimeout(begin, 120);
  }
}
function closeWrapped() {
  clearTimeout(wTimer);
  if (wrapEl.open) wrapEl.close();
  document.body.style.overflow = '';
  if (location.hash === '#/wrapped') history.replaceState(null, '', location.pathname + location.search);
  if (wOpener && wOpener.focus) wOpener.focus();
}

function wireWrapped() {
  $('.js-wclose').addEventListener('click', closeWrapped);
  $('.js-wprev').addEventListener('click', () => goSlide(wi - 1, -1));
  $('.js-wnext').addEventListener('click', () => goSlide(wi + 1, 1));
  wrapEl.addEventListener('cancel', (e) => { e.preventDefault(); closeWrapped(); });
  // `close` is queued, not synchronous. Wrapped's finale closes the story and
  // opens #/me in the same tick, so this handler used to land *after* openMe()
  // had locked the body and quietly unlock it again — the album scrolled around
  // behind the archetype screen. Only release the lock if nothing still holds it.
  wrapEl.addEventListener('close', () => {
    if (!meEl.open) document.body.style.overflow = '';
    clearTimeout(wTimer);
  });

  const stage = $('#wstage');
  let holdT = null, sx = 0, sy = 0;
  const hold = () => { stage.classList.add('is-held'); clearTimeout(wTimer); };
  const release = () => { stage.classList.remove('is-held'); if (!wPaused) restartTimer(); };
  stage.addEventListener('pointerdown', (e) => { sx = e.clientX; sy = e.clientY; holdT = setTimeout(hold, 180); });
  stage.addEventListener('pointerup', (e) => {
    clearTimeout(holdT); release();
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy)) goSlide(wi + (dx < 0 ? 1 : -1), dx < 0 ? 1 : -1);
  });
  stage.addEventListener('pointercancel', () => { clearTimeout(holdT); release(); });

  document.addEventListener('keydown', (e) => {
    if (!wrapEl.open) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); goSlide(wi + 1, 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); goSlide(wi - 1, -1); }
    else if (e.key === ' ') {
      e.preventDefault();
      wPaused = !wPaused;
      $('#wstage').classList.toggle('is-paused', wPaused);
      if (wPaused) clearTimeout(wTimer); else restartTimer();
    }
  });
}

/* ── Wrapped, as a 9:16 video ─────────────────────────────────────────── */

/**
 * Wrapped only travels if it can be posted. A screenshot goes in a DM; a
 * vertical clip goes in a story, which is where Spotify Wrapped actually
 * spreads. Everything below draws that clip in this page — the file never
 * leaves the machine, same as the PNG.
 */
const VIDEO_API = VIDEO && typeof VIDEO.createExporter === 'function'
  ? VIDEO.createExporter({
    win: window,
    doc: document,
    artImage,
    markImage,
    paletteOf,
    grainPattern,
    splitNumeric,
  })
  : null;

const VIDEO_OK = !!(VIDEO_API && VIDEO_API.supported());

/**
 * The pure half of video.js: chart normalisation, chart geometry and the cast
 * derivation. It is reached through the exporter because render.js inlines
 * video.js as an IIFE with a fixed public surface — but none of it touches a
 * canvas, and the page's own SVG figures depend on it too. If it were ever
 * missing, charts would be absent rather than wrong.
 */
const CHARTS = (VIDEO_API && VIDEO_API.charts) || null;

/** The page obeys prefers-reduced-motion. The exported file does not — it is
 *  an artefact that will be autoplayed by someone else's app, not UI. */
function videoStyle() {
  const cs = getComputedStyle(document.documentElement);
  const get = (k, fb) => cs.getPropertyValue(k).trim() || fb;
  return {
    fonts: { display: F_DISPLAY, serif: F_SERIF },
    colors: {
      ink0: get('--ink-0', '#F4F1EC'),
      ink1: get('--ink-1', '#B9B4AC'),
      ink2: get('--ink-2', '#827D75'),
      inkInv: get('--ink-inv', '#06070A'),
      paper: get('--paper', '#06070A'),
      scrim: get('--scrim-color', '5 6 10').split(/\s+/).join(','),
      rule: themeNow() === 'light' ? 'rgba(0,0,0,.16)' : 'rgba(255,255,255,.20)',
    },
  };
}

/**
 * Storyboard source: the same slides Wrapped plays, run through the same
 * share-safety filter as the PNG, flattened to plain data the canvas can draw.
 *
 * Charts travel with the card. They used to be dropped — a chart memory was
 * told as its headline and the clip contained none of the five shapes this
 * product actually draws, which are the most distinctive thing in it. A scene
 * carries `chart` in the normalised shape and video.js turns it into geometry
 * once, at prepare time.
 */
function videoScenes() {
  if (!SLIDES.length) buildWrapped();
  const a = PROFILE.archetype || {};
  const aseed = (a.seed || hash32('finale')) >>> 0;
  const from = PROFILE.firstSeen ? fmtDate(PROFILE.firstSeen) : '';
  const to = PROFILE.lastSeen ? fmtDate(PROFILE.lastSeen) : '';
  const span = from && to ? `${from} — ${to}` : '';
  const days = PROFILE.activeDays ? `${PROFILE.activeDays} days with something on them.` : '';

  const scenes = [];
  // The opening card carries no figure — deliberately. It used to hand the
  // exporter a `cast` block and video.js drew the same stacked bar the page
  // did, which made the first frame of the clip a legend. The proportions are
  // in `body` now, so page and clip open on exactly the same sentence.
  const castC = castCopy();
  if (castC) {
    scenes.push({
      role: 'cast', seed: CAST_SEED, artKind: 'profile',
      eyebrow: castC.eyebrow, headline: castC.headline, body: castC.body,
    });
  }
  scenes.push({
    role: 'intro', seed: aseed, artKind: 'profile',
    eyebrow: 'codepend wrapped',
    headline: 'Here is what you did together.',
    body: [span, days].filter(Boolean).join(' · '),
  });

  for (const s of SLIDES) {
    if (s.hello || s.finale || s.tease || s.cast) continue;
    const copy = shareCopy(s, { hideProject: false });
    const scene = {
      role: 'mid', seed: (s.seed || 0) >>> 0, artKind: s.isArchetype ? 'profile' : (s.kind || 'onthisday'),
      eyebrow: copy.eyebrow || '',
      headline: copy.headline || '',
      body: copy.line || '',
      stat: copy.stat || null,
      quote: copy.quote || null,
      chart: normChart(s),
    };
    // A card with nothing left after redaction is worse than one card fewer.
    if (!scene.headline && !scene.body && !scene.stat && !scene.quote && !scene.chart) continue;
    if (!scene.headline && !scene.stat && !scene.quote) { scene.headline = scene.body; scene.body = ''; }
    scenes.push(scene);
  }

  scenes.push({
    role: 'finale', seed: aseed, artKind: 'profile',
    eyebrow: 'what that makes you',
    name: a.name || 'codepend',
    tagline: isRisky(a.tagline) ? '' : (a.tagline || ''),
    cells: finaleCells().slice(0, 2),
  });
  return scenes;
}

let vidBusy = false, vidCancel = false, vidUI = null;

function ensureVideoUI() {
  if (vidUI) return vidUI;
  vidUI = h('div', {
    class: 'vexport', id: 'wvid', hidden: true, role: 'status', 'aria-live': 'polite',
  }, `<div class="vexport__in">
        <div class="vexport__t" id="wvidt">Drawing the cards…</div>
        <div class="vexport__bar"><i id="wvidb"></i></div>
        <div class="vexport__n">1080 × 1920 · drawn in this page · nothing uploaded</div>
        <button class="btn js-vcancel" type="button">Cancel</button>
        <div class="vexport__done" id="wviddone" hidden>
          <video class="vexport__prev" id="wvidprev" playsinline muted loop></video>
          <a class="btn btn--solid js-vsave" id="wvidsave" download>Save the video</a>
          <button class="btn js-vclose" type="button">Close</button>
        </div>
      </div>`);
  vidUI.querySelector('.js-vcancel').addEventListener('click', () => {
    vidCancel = true;
    $('#wvidt', vidUI).textContent = 'Stopping…';
  });
  vidUI.querySelector('.js-vclose').addEventListener('click', () => { hideVideoUI(); });
  // The save link is a real <a download> the user clicks themselves. That is the
  // whole point of it — see showVideoResult.
  vidUI.querySelector('.js-vsave').addEventListener('click', () => {
    setTimeout(() => { $('#wvidt', vidUI).textContent = 'Saved. Post it as a story.'; }, 400);
  });
  $('#wstage').appendChild(vidUI);
  return vidUI;
}

/** Tear the result panel down and put the exporter back to a resting state. */
function hideVideoUI() {
  if (!vidUI) return;
  const v = $('#wvidprev', vidUI);
  const a = $('#wvidsave', vidUI);
  if (v && v.src) { try { v.pause(); } catch (e) { /* not playing */ } }
  if (a && a.href && a.href.startsWith('blob:')) URL.revokeObjectURL(a.href);
  if (v) v.removeAttribute('src');
  if (a) a.removeAttribute('href');
  $('#wviddone', vidUI).hidden = true;
  vidUI.hidden = true;
  vidUI.classList.remove('is-done');
}

/**
 * Hand the finished clip over.
 *
 * The old code called `a.click()` on a generated anchor and then told the user
 * "Saved." It never checked, and on Safari it was usually a lie: the download
 * fires ~15 seconds after the button press, by which time the user gesture that
 * would authorise it has long expired, so the click is ignored silently. The
 * recording had worked, the file went nowhere, and the UI reported success —
 * which is the worst of the three possible outcomes.
 *
 * So the anchor is real, visible, and clicked by the person. Their click is a
 * fresh gesture, which every browser honours. The automatic attempt still runs
 * for the browsers where it works, but nothing claims the file was saved until
 * the user has actually asked for it.
 *
 * @param {{blob: Blob, filename: string, duration: number}} result
 */
function showVideoResult(result) {
  const ui = ensureVideoUI();
  const url = URL.createObjectURL(result.blob);
  const a = $('#wvidsave', ui);
  const v = $('#wvidprev', ui);
  a.href = url;
  a.download = result.filename;
  if (v) { v.src = url; v.play().catch(() => { /* autoplay refused; the poster is enough */ }); }
  $('#wviddone', ui).hidden = false;
  ui.classList.add('is-done');
  const mb = (result.blob.size / 1048576).toFixed(1);
  vidProgress(1, `${Math.round(result.duration / 1000)} seconds, ${mb} MB. Ready.`);
  // Free browsers that allow it; the visible link is what the rest rely on.
  try { a.click(); } catch (e) { /* blocked — the user can still click it */ }
}

function vidProgress(p, label) {
  const ui = ensureVideoUI();
  const bar = $('#wvidb', ui);
  if (bar) bar.style.transform = `scaleX(${clamp(p, 0, 1)})`;
  if (label) $('#wvidt', ui).textContent = label;
}

async function exportVideo() {
  if (vidBusy || !VIDEO_API) return null;
  vidBusy = true; vidCancel = false;
  const wasPaused = wPaused;
  wPaused = true; clearTimeout(wTimer);
  const ui = ensureVideoUI();
  ui.hidden = false;
  vidProgress(0.02, 'Drawing the cards…');
  let result = null;
  try {
    const plan = await VIDEO_API.prepare(videoScenes(), Object.assign(videoStyle(), {
      onPrepare: (p) => vidProgress(0.02 + p * 0.2, 'Drawing the cards…'),
    }));
    if (vidCancel) throw new Error('cancelled');
    vidProgress(0.22, 'Recording · about 15 seconds');
    result = await VIDEO_API.record(plan, {
      name: (PROFILE.archetype || {}).name,
      onProgress: (p) => vidProgress(0.22 + p * 0.76, 'Recording · about 15 seconds'),
      cancelled: () => vidCancel,
    });
    if (result && result.blob) {
      vidProgress(1, 'Saving…');
      globalThis.CODEPEND_LAST_VIDEO = {
        size: result.blob.size, type: result.mimeType,
        filename: result.filename, duration: result.duration,
      };
      showVideoResult(result);
    } else if (result && result.cancelled) {
      vidProgress(0, 'Cancelled.');
    } else {
      vidProgress(0, 'Your browser would not record this. The share card still works.');
    }
  } catch (e) {
    vidProgress(0, vidCancel ? 'Cancelled.' : 'That did not record. The share card still works.');
    result = { error: (e && e.message) || 'failed' };
  }
  vidBusy = false;
  wPaused = wasPaused;
  setTimeout(() => { ui.hidden = true; }, result && result.blob ? 1800 : 2600);
  return result;
}

/* A small hook so the export can be driven from the console (and from a test
   harness) without clicking through the story. Read-only status, no uploads. */
globalThis.codependVideo = {
  supported: () => VIDEO_OK,
  export: exportVideo,
  get last() { return globalThis.CODEPEND_LAST_VIDEO || null; },
};

/* ── share card ───────────────────────────────────────────────────────── */

const SHEET = $('#share');
const CANVAS = $('#scanvas');
const PRESETS = { wide: [1200, 675], tall: [1080, 1350] };
const shareState = { memory: null, preset: 'wide', hideProject: false, opener: null };

const F_DISPLAY = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const F_SERIF = '"Iowan Old Style", Georgia, "Times New Roman", serif';

/**
 * The generic sheet, for quotes, stats and charts.
 *
 * It used to take the archetype as well — one composition trying to serve five
 * card shapes and the thing people actually post. The archetype has its own
 * screen now, so anything that still asks the sheet for it is redirected rather
 * than given a second, worse version of the same image.
 */
function openShare(m) {
  const mem = m || ARCHETYPE || MEMORIES[0];
  if (mem && mem.isArchetype) { openMe(document.activeElement); return; }
  shareState.memory = mem;
  shareState.opener = document.activeElement;
  if (!SHEET.open) { try { SHEET.showModal(); } catch (e) { SHEET.setAttribute('open', ''); } }
  drawShare();
}
function closeShare() {
  if (SHEET.open) SHEET.close();
  if (shareState.opener && shareState.opener.focus) shareState.opener.focus();
}

/** Resolve custom properties inside an SVG string — an <img> has no CSS context. */
function resolveVars(svg, seed) {
  const p = paletteOf(seed);
  const cs = getComputedStyle(document.documentElement);
  const map = {
    '--a-1': p.accents[0], '--a-2': p.accents[1], '--a-3': p.accents[2], '--a-bg': p.bg,
    '--ink-0': cs.getPropertyValue('--ink-0').trim() || '#F4F1EC',
    '--ink-1': cs.getPropertyValue('--ink-1').trim() || '#B9B4AC',
    '--ink-2': cs.getPropertyValue('--ink-2').trim() || '#827D75',
    '--scrim-color': cs.getPropertyValue('--scrim-color').trim() || '5 6 10',
    '--paper': cs.getPropertyValue('--paper').trim() || '#06070A',
    '--surface-1': cs.getPropertyValue('--surface-1').trim() || '#0E1014',
    '--surface-2': cs.getPropertyValue('--surface-2').trim() || '#171A20',
    '--hairline': cs.getPropertyValue('--hairline').trim() || '#ffffff14',
  };
  // art.js declares its own properties on the root <svg> (e.g. --sc). Harvest
  // them, then resolve repeatedly because those definitions nest var() calls.
  (svg.match(/style="[^"]*"/g) || []).forEach((decl) => {
    decl.replace(/(--[a-z0-9-]+)\s*:\s*([^;"]+)/gi, (a, name, val) => {
      if (map[name] == null) map[name] = val.trim();
      return a;
    });
  });
  let out = svg;
  for (let pass = 0; pass < 4; pass++) {
    const next = out.replace(/var\(\s*(--[a-z0-9-]+)\s*(?:,\s*([^)]*))?\)/gi,
      (all, name, fb) => (map[name] != null ? map[name] : (fb != null ? fb : '#888')));
    if (next === out) break;
    out = next;
  }
  return out;
}

function artImage(seed, kind, w, h) {
  let svg = artSVG(seed, kind, { w, h, blur: true });
  if (!svg) return Promise.resolve(null);
  // The canvas paints its own scrim, so drop the SVG's to avoid doubling it.
  svg = svg.replace(/<rect[^>]*url\(#s[0-9a-z]+\)[^>]*\/>/gi, '');
  svg = resolveVars(svg, seed);
  if (!/xmlns=/.test(svg)) svg = svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  const img = new Image();
  img.width = w; img.height = h;
  return new Promise((res) => {
    img.onload = () => res(img);
    img.onerror = () => res(null);
    img.src = url;
  });
}

function wrapText(ctx, text, maxW, maxLines) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const t = line ? line + ' ' + w : w;
    if (ctx.measureText(t).width > maxW && line) {
      lines.push(line); line = w;
      if (lines.length === maxLines) { line = ''; break; }
    } else line = t;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) lines.length = maxLines;
  const last = lines[lines.length - 1];
  if (last && words.join(' ').length > lines.join(' ').length) lines[lines.length - 1] = last.replace(/[.,;:]?$/, '…');
  return lines;
}

/** Deterministic 180×180 grain tile — same texture as the page. */
function grainPattern(ctx, seed) {
  const c = document.createElement('canvas');
  c.width = c.height = 180;
  const g = c.getContext('2d');
  const img = g.createImageData(180, 180);
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 90 + rnd() * 165;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return ctx.createPattern(c, 'repeat');
}

/**
 * Pull the share-safe copy out of a memory. Never paths, code, or URLs.
 * The video export calls this too, so the two assets can never disagree about
 * what is safe to put in front of a stranger.
 * @param {object} m
 * @param {{hideProject?:boolean}} [opts] defaults to the sheet's own toggle
 */
function shareCopy(m, opts) {
  const hide = opts ? !!opts.hideProject : shareState.hideProject;
  const clean = (t) => {
    if (!t) return '';
    let s = String(t);
    if (hide && m.project) s = s.split(m.project).join('a project');
    return isRisky(s) ? '' : s;
  };
  const out = { eyebrow: clean(m.eyebrow) || 'codepend', line: '', stat: null, quote: null };
  if (m.stat && m.stat.value != null) {
    out.stat = { value: String(m.stat.value), unit: m.stat.unit || '', label: m.stat.label || '' };
    // One number per card. If the headline only restates it, take the body.
    const title = clean(m.title);
    const dupes = title && title.indexOf(String(m.stat.value)) >= 0;
    out.line = (dupes ? clean(m.body) : title) || clean(m.body) || title;
  } else if (m.quote && m.quote.text) {
    const q = clean(trimQuote(m.quote.text));
    if (q) {
      out.quote = { text: q, who: m.quote.who === 'agent' ? 'it said' : 'you said' };
      // The body is the punchline on quote cards ("The tools changed. You
      // didn't.", "Sometimes you were."). The feed always shows it, so dropping
      // it from the exported PNG turns the joke into an unexplained quotation.
      out.line = clean(m.body) || clean(m.title);
    } else out.line = clean(m.title) || clean(m.body);
  } else {
    out.headline = clean(m.title);
    out.line = clean(m.tagline) || clean(m.body);
  }
  if (out.line.length > 150) out.line = out.line.slice(0, 148).replace(/\s\S*$/, '') + '…';
  return out;
}

let drawSeq = 0;

async function drawShare() {
  const m = shareState.memory;
  if (!m) return;
  // Two draws can be in flight (open the sheet, immediately switch preset) and
  // they share one canvas. Only the newest is allowed to paint.
  const mine = ++drawSeq;
  const stale = () => mine !== drawSeq;
  const [W, H] = PRESETS[shareState.preset];
  const R = 2;                                   // retina
  CANVAS.width = W * R; CANVAS.height = H * R;
  CANVAS.style.aspectRatio = `${W} / ${H}`;
  const ctx = CANVAS.getContext('2d');
  ctx.setTransform(R, 0, 0, R, 0, 0);
  const pal = paletteOf(m.seed);
  const theme = themeNow();
  const cs = getComputedStyle(document.documentElement);
  const ink0 = cs.getPropertyValue('--ink-0').trim() || '#F4F1EC';
  const ink2 = cs.getPropertyValue('--ink-2').trim() || '#827D75';
  const scrim = (cs.getPropertyValue('--scrim-color').trim() || '5 6 10').split(/\s+/).join(',');
  const paper = cs.getPropertyValue('--paper').trim() || '#06070A';
  const wideMode = shareState.preset === 'wide';

  ctx.fillStyle = pal.bg || paper;
  ctx.fillRect(0, 0, W, H);

  const img = await artImage(m.seed >>> 0, m.kind, wideMode ? 900 : 1080, wideMode ? 675 : 1350);
  if (stale()) return;
  if (img) {
    ctx.save();
    // cover-fit
    const ar = img.width / img.height, tar = W / H;
    let dw = W, dh = H, dx = 0, dy = 0;
    if (ar > tar) { dh = H; dw = H * ar; dx = (W - dw) / 2; }
    else { dw = W; dh = W / ar; dy = (H - dh) / 2; }
    if (wideMode) { dw = W * 0.62; dh = dw / ar; dx = W - dw; dy = (H - dh) / 2; }
    ctx.drawImage(img, dx, dy, dw, dh);
    ctx.restore();
  }

  // scrim
  const sideScrim = wideMode;
  const g = sideScrim ? ctx.createLinearGradient(0, 0, W, 0) : ctx.createLinearGradient(0, 0, 0, H);
  if (sideScrim) {
    g.addColorStop(0, `rgba(${scrim},0.97)`);
    g.addColorStop(0.52, `rgba(${scrim},0.92)`);
    g.addColorStop(0.78, `rgba(${scrim},0.35)`);
    g.addColorStop(1, `rgba(${scrim},0.12)`);
  } else {
    g.addColorStop(0, `rgba(${scrim},0.42)`);
    g.addColorStop(0.34, `rgba(${scrim},0.12)`);
    g.addColorStop(0.56, `rgba(${scrim},0.62)`);
    g.addColorStop(0.74, `rgba(${scrim},0.90)`);
    g.addColorStop(1, `rgba(${scrim},0.95)`);
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  const S = W / (wideMode ? 1200 : 1080);          // one scale factor for the lockup
  const PAD = (wideMode ? 76 : 88) * S;
  const colW = (wideMode ? W * 0.58 : W) - PAD * 2;
  const copy = shareCopy(m);

  // mark + wordmark
  const markImg = await markImage(Math.round(38 * S));
  if (stale()) return;
  if (markImg) ctx.drawImage(markImg, PAD, PAD, 34 * S, 34 * S);
  ctx.fillStyle = ink0;
  ctx.textBaseline = 'alphabetic';
  ctx.font = `700 ${30 * S}px ${F_DISPLAY}`;
  ctx.fillText('codepend', PAD + 48 * S, PAD + 26 * S);

  // body block, bottom-anchored
  let y = H - PAD - 44 * S;
  ctx.textBaseline = 'alphabetic';

  // footer rule + line
  ctx.strokeStyle = theme === 'light' ? 'rgba(0,0,0,.14)' : 'rgba(255,255,255,.16)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(PAD + colW, y); ctx.stroke();
  ctx.fillStyle = ink2;
  ctx.font = `600 ${22 * S}px ${F_DISPLAY}`;
  ctx.fillText('npx codepend', PAD, y + 34 * S);
  const rightTxt = '100% local';
  ctx.fillText(rightTxt, PAD + colW - ctx.measureText(rightTxt).width, y + 34 * S);

  y -= 44 * S;

  if (copy.line) {
    ctx.fillStyle = ink0;
    ctx.globalAlpha = 0.78;
    ctx.font = `400 ${30 * S}px ${F_DISPLAY}`;
    const lines = wrapText(ctx, copy.line, colW, 3);
    for (let i = lines.length - 1; i >= 0; i--) { ctx.fillText(lines[i], PAD, y); y -= 40 * S; }
    ctx.globalAlpha = 1;
    y -= 18 * S;
  }

  if (copy.stat) {
    if (copy.stat.label) {
      ctx.fillStyle = ink2;
      ctx.font = `600 ${24 * S}px ${F_DISPLAY}`;
      ctx.fillText(copy.stat.label.toUpperCase(), PAD, y);
      y -= 46 * S;
    }
    const vs = String(copy.stat.value);
    let size = (vs.length > 8 ? 96 : vs.length > 5 ? 128 : 168) * S;
    ctx.font = `800 ${size}px ${F_DISPLAY}`;
    while (ctx.measureText(vs).width > colW * 0.98 && size > 40 * S) {
      size *= 0.92; ctx.font = `800 ${size}px ${F_DISPLAY}`;
    }
    ctx.fillStyle = ink0;
    ctx.fillText(vs, PAD, y);
    if (copy.stat.unit) {
      const w = ctx.measureText(vs).width;
      ctx.fillStyle = pal.accents[0];
      ctx.font = `600 ${44 * S}px ${F_DISPLAY}`;
      ctx.fillText(copy.stat.unit, PAD + w + 14 * S, y);
    }
    y -= size * 0.86;
  } else if (copy.quote) {
    ctx.fillStyle = ink0;
    ctx.font = `italic 400 ${(shareState.preset === 'wide' ? 46 : 52) * S}px ${F_SERIF}`;
    const lines = wrapText(ctx, '«' + copy.quote.text + '»', colW, 5);
    for (let i = lines.length - 1; i >= 0; i--) { ctx.fillText(lines[i], PAD, y); y -= 62 * S; }
    y -= 6 * S;
    ctx.fillStyle = ink2;
    ctx.font = `600 ${22 * S}px ${F_DISPLAY}`;
    ctx.fillText(copy.quote.who.toUpperCase(), PAD, y);
    y -= 40 * S;
  } else if (copy.headline) {
    ctx.fillStyle = ink0;
    ctx.font = `700 ${(wideMode ? 62 : 72) * S}px ${F_DISPLAY}`;
    const lines = wrapText(ctx, copy.headline, colW, 3);
    for (let i = lines.length - 1; i >= 0; i--) { ctx.fillText(lines[i], PAD, y); y -= 76 * S; }
    y -= 8 * S;
  }

  if (copy.eyebrow) {
    ctx.fillStyle = ink0;
    ctx.globalAlpha = 0.62;
    ctx.font = `600 ${20 * S}px ${F_DISPLAY}`;
    const track = 'letterSpacing' in ctx;
    if (track) ctx.letterSpacing = `${2.8 * S}px`;
    ctx.fillText(track ? copy.eyebrow.toUpperCase() : spaced(copy.eyebrow.toUpperCase()), PAD, y);
    if (track) ctx.letterSpacing = '0px';
    ctx.globalAlpha = 1;
  }

  grainOver(ctx, W, H, m.seed >>> 0);
}

/** The last pass on any share asset: the same grain the page wears. */
function grainOver(ctx, W, H, seed) {
  try {
    const pat = grainPattern(ctx, seed >>> 0);
    ctx.save();
    ctx.globalAlpha = 0.055;
    ctx.globalCompositeOperation = 'overlay';
    ctx.fillStyle = pat;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  } catch (e) { /* pattern is cosmetic */ }
}

/** Canvas has no letter-spacing in older engines; fake the eyebrow tracking. */
function spaced(s) { return s.split('').join(' '); }

function markImage(px) {
  const svg = resolveVars(markSVG(px), (PROFILE.archetype && PROFILE.archetype.seed) || 1)
    .replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  const img = new Image();
  return new Promise((res) => {
    img.onload = () => res(img);
    img.onerror = () => res(null);
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
}

function shareFilename() {
  const m = shareState.memory || {};
  const slug = String(m.type || 'memory').replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  return `codepend-${slug}-${shareState.preset}.png`;
}

function wireShare() {
  $('.js-sclose').addEventListener('click', closeShare);
  SHEET.addEventListener('cancel', (e) => { e.preventDefault(); closeShare(); });
  $$('.seg', SHEET).forEach((b) => b.addEventListener('click', () => {
    $$('.seg', SHEET).forEach((x) => x.classList.remove('is-on'));
    b.classList.add('is-on');
    shareState.preset = b.dataset.preset;
    drawShare();
  }));
  $('#hideproj').addEventListener('change', (e) => { shareState.hideProject = e.target.checked; drawShare(); });

  $('.js-dl').addEventListener('click', () => {
    const note = $('#snote');
    const done = (blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = shareFilename();
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      note.textContent = 'Saved. Nothing was uploaded — the image was drawn in this page.';
    };
    try {
      CANVAS.toBlob((b) => {
        if (b) done(b);
        else note.textContent = 'Your browser blocked the download. Right-click or long-press the preview to save it.';
      }, 'image/png');
    } catch (e) {
      note.textContent = 'Your browser blocked the download. Right-click or long-press the preview to save it.';
    }
  });

  $('.js-copy').addEventListener('click', async () => {
    const note = $('#snote');
    try {
      const blob = await new Promise((res, rej) => CANVAS.toBlob((b) => (b ? res(b) : rej(new Error('no blob'))), 'image/png'));
      if (!navigator.clipboard || !window.ClipboardItem) throw new Error('unsupported');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      note.textContent = 'Copied. Paste it anywhere.';
    } catch (e) {
      note.textContent = 'Copying images is not available here — use Download PNG, or long-press the preview.';
    }
  });
}

/* ── #/me — the archetype, and the one button that takes it away ───────────

   The archetype is the sentence people repeat at each other ("I'm The Swarm
   Lord, what are you?"), and it used to be card six of thirty with the same ⇪
   every quote card carries. It has a screen now, routed at `#/me` so the URL
   can be sent on its own, and exactly one verb: Save archetype.

   Everything below draws in this page. Nothing is uploaded, and what lands on
   the image is deliberately smaller than what is on the screen: the name, the
   line, round numbers, the wordmark. No project names, no quotes, no paths.
   ------------------------------------------------------------------------ */

/**
 * Project names are the one thing the archetype copy can leak on its own: The
 * Serial Monogamist's blurb is built out of `topProject`, and redaction leaves
 * directory names alone because they are not paths. `shareCopy` already does
 * this substitution for ordinary memories; the archetype needs its own list
 * because it carries no `project` field to substitute against.
 */
const PROJECT_NAMES = (() => {
  const seen = new Set();
  const add = (p) => { const s = String(p == null ? '' : p).trim(); if (s.length > 2) seen.add(s); };
  add(PROFILE.topProject);
  for (const m of MEMORIES) { add(m.project); if (m.quote) add(m.quote.project); }
  return Array.from(seen).sort((a, b) => b.length - a.length);
})();

function deproject(t) {
  let s = String(t == null ? '' : t);
  for (const p of PROJECT_NAMES) if (s.indexOf(p) >= 0) s = s.split(p).join('one project');
  return s;
}

/**
 * The share-safe archetype. `--redact paranoid` has already emptied the risky
 * inputs upstream; this is the last filter, and it must still leave a card
 * worth posting — the name alone is the point, the rest is supporting cast.
 */
function archetypeCopy() {
  const a = PROFILE.archetype || {};
  const safe = (t) => { const s = deproject(t); return isRisky(s) ? '' : s; };
  return {
    name: a.name || 'codepend',
    tagline: safe(a.tagline),
    blurb: safe(a.blurb),
    seed: (typeof a.seed === 'number' ? a.seed : hash32('archetype')) >>> 0,
    stats: finaleCells().map(([value, label]) => {
      // Tuple and record at once. archetype-card.js is being written to a
      // contract that names `stats` but not its shape, and a cell that answers
      // to both `[v, l]` and `{value, label}` costs nothing and cannot be the
      // reason the card comes out blank.
      const cell = [String(value), String(label)];
      cell.value = String(value);
      cell.label = String(label);
      return cell;
    }),
  };
}

/* The dedicated card renderer, when render.js has inlined it. Same bridge
   video.js gets: one global, one factory-shaped object, no imports — app.js is
   inlined as a single module script and a static import would have nothing to
   resolve against from file://. If it is absent, the local fallback below draws
   the card and the button behaves identically. */
const CARD_API = globalThis.CODEPEND_ARCHETYPE_CARD || null;
const ME_PRESETS = (CARD_API && CARD_API.ARCHETYPE_PRESETS)
  || { square: [1080, 1080], story: [1080, 1920], wide: [1200, 675] };
const ME_ORDER = ['square', 'story', 'wide'];

const meEl = $('#me');
const meState = { preset: 'square', url: null, blob: null, opener: null, seq: 0, busy: false };

/**
 * Draw one archetype card and hand back a PNG blob.
 * @param {'square'|'story'|'wide'} preset
 * @returns {Promise<Blob|null>}
 */
async function renderArchetypePNG(preset) {
  const dims = ME_PRESETS[preset] || ME_PRESETS.square;
  const W = dims[0], H = dims[1];
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  if (!ctx) return null;
  const c = archetypeCopy();
  const spec = {
    name: c.name, tagline: c.tagline, blurb: c.blurb, stats: c.stats,
    seed: c.seed, preset, theme: themeNow(),
  };
  const deps = {
    artImage,
    palette: paletteOf,
    grainPattern,
    markImage,                     // the ember, for the card's own wordmark
    fonts: { display: F_DISPLAY, serif: F_SERIF },
  };
  // One composition, or none. There used to be a built-in fallback here, and it
  // was the more dangerous of the two failure modes: the module went missing
  // from the bundle once already, and the page quietly drew a different,
  // unaudited picture with no error and no visual tell. A card that does not
  // appear is a bug someone reports; a card that appears and was never reviewed
  // is a bug that ships on somebody's timeline.
  if (!CARD_API || typeof CARD_API.drawArchetypeCard !== 'function') {
    throw new Error('archetype-card.js is missing from this build');
  }
  await CARD_API.drawArchetypeCard(ctx, spec, deps);
  return new Promise((res) => {
    try { cv.toBlob((b) => res(b || null), 'image/png'); } catch (e) { res(null); }
  });
}


function archetypeFilename() {
  const slug = String((PROFILE.archetype && PROFILE.archetype.name) || 'archetype')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'archetype';
  return `codepend-${slug}-${meState.preset}.png`;
}

/** Drop the previous blob before a new one replaces it. */
function releaseMe() {
  if (meState.url) { try { URL.revokeObjectURL(meState.url); } catch (e) { /* already gone */ } }
  meState.url = null;
  meState.blob = null;
}

/**
 * Draw the card and attach it to the button.
 *
 * The download is a real `<a download>` with the file already on it, clicked by
 * the person. Nothing here calls `a.click()` and reports success — that is what
 * the video export shipped once, and on Safari the click lands after the user
 * gesture has expired, so the UI said "Saved" while nothing had been.
 */
async function refreshMeCard() {
  const mine = ++meState.seq;
  const a = $('#mesave');
  const label = $('#mesavet');
  const note = $('#menote');
  const prev = $('#meprev');
  meState.busy = true;
  a.removeAttribute('href');
  a.setAttribute('aria-disabled', 'true');
  if (label) label.textContent = 'Drawing your card…';
  note.textContent = 'Drawing your card in this page. Nothing is uploaded.';

  let blob = null;
  try { blob = await renderArchetypePNG(meState.preset); }
  catch (e) { console.warn('archetype card failed', e); blob = null; }
  if (mine !== meState.seq) return null;               // a preset switch overtook us
  meState.busy = false;

  if (!blob) {
    if (label) label.textContent = 'Save archetype';
    note.textContent = 'This browser would not draw the image. Wrapped and the video export still work.';
    return null;
  }

  releaseMe();
  meState.blob = blob;
  meState.url = URL.createObjectURL(blob);
  a.href = meState.url;
  a.download = archetypeFilename();
  a.removeAttribute('aria-disabled');
  if (label) label.textContent = 'Save archetype';
  if (prev) { prev.src = meState.url; prev.hidden = false; }
  const dims = ME_PRESETS[meState.preset] || ME_PRESETS.square;
  const kb = blob.size < 1048576
    ? `${Math.round(blob.size / 1024)} KB`
    : `${(blob.size / 1048576).toFixed(1)} MB`;
  note.textContent = `${dims[0]} × ${dims[1]} PNG, ${kb}. Drawn here, never uploaded — the image carries the name, the line, the numbers and the wordmark, nothing else.`;
  globalThis.CODEPEND_LAST_ARCHETYPE = {
    size: blob.size, type: blob.type, preset: meState.preset,
    width: dims[0], height: dims[1], filename: a.download,
  };
  return blob;
}

function paintMe() {
  const c = archetypeCopy();
  meEl.setAttribute('style', paletteStyle(c.seed));
  // One source of truth for the framing copy. The screen is a preview of the
  // image, so it cannot say something different from the image — it did, and
  // the change to the card was invisible on the page it is exported from.
  const eyebrow = (CARD_API && CARD_API.EYEBROW) || 'what you are';
  const sub = (CARD_API && CARD_API.WORDMARK_SUB) || '';
  $('.me__eyebrow', meEl).textContent = eyebrow;
  const foot = $('.me__foot', meEl);
  if (foot) {
    foot.innerHTML = `<code>npx codepend</code>${sub ? ' · ' + esc(sub) : ''} · computed on your machine`;
  }
  $('#mename').textContent = c.name;
  const tg = $('#metag');
  tg.textContent = c.tagline; tg.hidden = !c.tagline;
  const bl = $('#meblurb');
  bl.textContent = c.blurb; bl.hidden = !c.blurb;
  $('#mestats').innerHTML = c.stats
    .map((s) => `<div class="me__cell"><b>${esc(s.value)}</b><span>${esc(s.label)}</span></div>`).join('');
  const art = $('#meart');
  if (!art.firstChild) {
    art.innerHTML = labelled(artSVG(c.seed, 'profile', { w: 1000, h: 1600, blur: true }), c.seed, 'profile');
  }
}

/** @param {Element|null} from the control to hand focus back to on close */
function openMe(from) {
  if (!ARCHETYPE) return;
  // boot() runs route() three times (once now, twice more after the DOM has
  // settled, for deep links into the feed). Re-opening would throw away a card
  // already drawn and reset the format back to square under the user.
  if (meEl.open) return;
  meState.opener = from || document.activeElement;
  if (wrapEl.open) closeWrapped();
  if (SHEET.open) closeShare();
  paintMe();
  if (!meEl.open) { try { meEl.showModal(); } catch (e) { meEl.setAttribute('open', ''); } }
  document.body.style.overflow = 'hidden';
  if (location.hash !== '#/me') history.replaceState(null, '', '#/me');
  // Draw immediately, so the button has the file on it before anyone reaches
  // for it. One click, their own gesture, no second step.
  refreshMeCard();
}

function closeMe() {
  if (meEl.open) meEl.close();
  document.body.style.overflow = '';
  if (location.hash === '#/me') history.replaceState(null, '', location.pathname + location.search);
  if (meState.opener && meState.opener.focus) meState.opener.focus();
}

async function copyArchetype() {
  const note = $('#menote');
  try {
    // The blob is kept rather than re-read off its own object URL. Reading a
    // `blob:` address back is still a request, and this page makes none.
    if (!meState.blob) throw new Error('not ready');
    if (!navigator.clipboard || !window.ClipboardItem) throw new Error('unsupported');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': meState.blob })]);
    note.textContent = 'Copied. Paste it anywhere.';
  } catch (e) {
    note.textContent = 'Copying images is not available here — use Save archetype, or long-press the preview.';
  }
}

function wireMe() {
  $$('.js-me').forEach((b) => b.addEventListener('click', () => openMe(b)));
  if (!ARCHETYPE) {
    $$('.js-me').forEach((b) => { b.hidden = true; });
    return;
  }
  $$('.js-meclose', meEl).forEach((b) => b.addEventListener('click', closeMe));
  meEl.addEventListener('cancel', (e) => { e.preventDefault(); closeMe(); });
  meEl.addEventListener('close', () => { if (!wrapEl.open) document.body.style.overflow = ''; });
  $('.js-mewrapped', meEl).addEventListener('click', () => { closeMe(); openWrapped(null); });
  $$('.seg', meEl).forEach((b) => b.addEventListener('click', () => {
    const p = b.dataset.mepreset;
    if (!p || !ME_PRESETS[p]) return;
    $$('.seg', meEl).forEach((x) => x.classList.toggle('is-on', x === b));
    meState.preset = p;
    refreshMeCard();
  }));
  $('#mesave').addEventListener('click', (e) => {
    const a = $('#mesave');
    if (!a.getAttribute('href')) {
      e.preventDefault();
      $('#menote').textContent = 'Still drawing — one moment.';
      if (!meState.busy) refreshMeCard();
      return;
    }
    // The browser is doing the saving from here; say so only after it was asked.
    setTimeout(() => { $('#menote').textContent = 'Asked your browser to save it. Post it as it is.'; }, 400);
  });
  $('.js-mecopy', meEl).addEventListener('click', copyArchetype);
}

/* Drivable from a console or a test harness without clicking through the page.
   Read-only status; nothing here uploads. */
globalThis.codependArchetype = {
  presets: () => Object.assign({}, ME_PRESETS),
  order: () => ME_ORDER.slice(),
  copy: () => archetypeCopy(),
  render: (preset) => renderArchetypePNG(preset || 'square'),
  open: () => openMe(null),
  get last() { return globalThis.CODEPEND_LAST_ARCHETYPE || null; },
};

/* ── theme, dock, routing, boot ───────────────────────────────────────── */

function setTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('codepend.theme', t); } catch (e) { /* private mode */ }
  remountAllArt();
}

function wireChrome() {
  $$('.js-theme').forEach((b) => b.addEventListener('click', () => {
    const next = themeNow() === 'dark' ? 'light' : 'dark';
    if (document.startViewTransition && !RM.matches) document.startViewTransition(() => setTheme(next));
    else setTheme(next);
  }));
  $$('.js-wrapped').forEach((b) => b.addEventListener('click', () => openWrapped(b)));

  // The video export used to live only on the last card of Wrapped — eleven
  // taps from the feed, which is a good way to ship a feature nobody finds.
  // The dock is always there once you scroll, so it goes here too. Hidden
  // entirely where the browser cannot record, rather than failing on click.
  if (VIDEO_OK) {
    $$('.js-dockvideo, .js-dockvideo-sep').forEach((el) => { el.hidden = false; });
    // Open on the FIRST card, not the last. Jumping to the finale was meant to
    // save the user the story; what it actually did was yank the view somewhere
    // they did not ask to go, which reads as the button misfiring. The recorder
    // draws its own frames and does not care which slide is on screen, so there
    // was never a reason to move.
    $$('.js-dockvideo').forEach((b) => b.addEventListener('click', () => {
      openWrapped(b, { andExport: true });
    }));
  }

  const dock = $('#dock');
  const bar = $('#scrollbar');
  let away = null;
  const onScroll = () => {
    const max = document.documentElement.scrollHeight - innerHeight;
    bar.style.transform = `scaleX(${max > 0 ? clamp(scrollY / max, 0, 1) : 0})`;
    const show = scrollY > innerHeight * 0.5;
    dock.hidden = !show;
    dock.classList.add('is-away');
    clearTimeout(away);
    away = setTimeout(() => dock.classList.remove('is-away'), 240);
    if (show && !dock.dataset.seen) { dock.dataset.seen = '1'; dock.classList.remove('is-away'); }
  };
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  const fm = $('#footmeta');
  const bits = [];
  if (META.generatedAt) bits.push(`Built ${fmtDate(META.generatedAt)}`);
  if (META.version) bits.push(`codepend ${META.version}`);
  if (META.redact) bits.push(`redaction: ${META.redact}`);
  if (STATS.sessionsScanned || PROFILE.totalSessions) bits.push(`${groupNum(STATS.sessionsScanned || PROFILE.totalSessions)} sessions read`);
  fm.textContent = bits.join(' · ');
}

function route() {
  const hh = location.hash;
  // `#/me` is a real address — it is the URL somebody sends when they host this
  // page, so it has to survive a cold load, the back button and a link from
  // inside the feed. Anything else closes the screen again.
  if (hh === '#/me') { openMe(null); return; }
  if (meEl && meEl.open) closeMe();
  if (hh === '#/wrapped') { openWrapped(null); return; }
  const m = /^#\/m\/(.+)$/.exec(hh);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const el = document.getElementById('m-' + cssId(id));
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: RM.matches ? 'auto' : 'smooth' });
      el.classList.add('is-in', 'is-target');
      mountArt(el, false);
      setTimeout(() => el.classList.remove('is-target'), 2600);
    }
  }
}

function boot() {
  paintMark();
  buildFeed();
  buildFilters();
  wireChrome();
  wireWrapped();
  wireShare();
  wireMe();
  addEventListener('hashchange', route);
  route();
  // Deep links to a card need the DOM settled first.
  requestAnimationFrame(() => requestAnimationFrame(route));
}

try {
  if (!MEMORIES.length) {
    // Not an empty state — an error state. It should still be worth looking at.
    const seed = hash32('codepend:nothing-found');
    const blank = h('div', { class: 'blank', style: paletteStyle(seed) },
      `<div class="blank__art">${labelled(artSVG(seed, 'profile', { w: 1000, h: 1250, blur: true }), seed, 'profile')}</div>
       <div class="blank__in">
         <h2>We couldn't find any agent history on this machine.</h2>
         <p>codepend looked in:</p>
         <code>~/.claude/projects</code><code>~/.codex/sessions</code><code>Cursor/User/globalStorage</code>
         <p style="margin-top:18px">Point it somewhere else with <code style="display:inline">--claude-dir</code>, <code style="display:inline">--codex-dir</code> or <code style="display:inline">--cursor-dir</code>.</p>
       </div>`);
    feedEl.appendChild(blank);
    $('#filters').hidden = true;
    $$('.js-wrapped, .js-me').forEach((b) => { b.hidden = true; });
    paintMark();
    wireChrome();
  } else {
    boot();
  }
} catch (err) {
  console.error('codepend failed to boot', err);
  feedEl.appendChild(h('div', { class: 'blank' },
    `<h2>This page broke, which is embarrassing.</h2><p>${esc(err && err.message)}</p>`));
}
