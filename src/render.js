/* ============================================================================
   codepend — render.js
   Turns the buildMemories() payload into ONE self-contained HTML file.

   Everything is inlined: the payload JSON, app.css, app.js, src/art.js, and the
   three modules app.js reaches through a global — video.js, archetype-card.js
   and share-card.js.
   No external requests of any kind — no CDN, no fonts, no analytics. The file
   must open from file:// with the network off. That promise is also printed
   in the footer, so it has to be literally true.
   ========================================================================== */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, 'app');

/**
 * ES modules can't be inlined side-by-side (duplicate top-level bindings, and
 * `export` is illegal outside a module record we control). So the art module is
 * stripped of its export keywords and wrapped in an IIFE that hands its public
 * surface back as an object. This is why art.js must stay dependency-free.
 * @param {string} src
 * @returns {string}
 */
function stripExports(src) {
  return src
    .replace(/^[ \t]*export\s+default\s+/gm, 'const __artDefault = ')
    .replace(/^[ \t]*export\s*\{[^}]*\}\s*;?[ \t]*$/gm, '')
    .replace(/^([ \t]*)export\s+(?=(async\s+)?function\b|const\b|let\b|var\b|class\b)/gm, '$1');
}

/** JSON that is safe inside <script type="application/json">. */
function safeJSON(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const groupNum = (n) => {
  const s = String(n);
  return s.length > 4 ? s.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') : s;
};

function fmtDate(ts) {
  if (!ts) return '';
  try {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      .format(new Date(ts));
  } catch (e) { return ''; }
}

/**
 * The no-JS view. It is not an apology — it's the same facts, set in type.
 * @param {object} payload
 * @returns {string}
 */
function noscriptHTML(payload) {
  const p = payload.profile || {};
  const a = p.archetype || {};
  const s = payload.stats || {};
  const rows = [
    ['Days with something on them', p.activeDays],
    ['Sessions', p.totalSessions != null ? p.totalSessions : s.totalSessions],
    ['Messages you typed', s.humanTurns != null ? s.humanTurns : s.totalHumanTurns],
    ['Hours together', p.totalHours != null ? Math.round(p.totalHours) : s.totalHours],
    ['Favourite project', p.topProject],
    ['Most-used tool', p.spiritTool],
  ].filter(([, v]) => v != null && v !== '');

  return `<h1>${esc(a.name || 'codepend')}</h1>
    ${a.tagline ? `<p><em>${esc(a.tagline)}</em></p>` : ''}
    <p>${esc(fmtDate(p.firstSeen))} — ${esc(fmtDate(p.lastSeen))}</p>
    <ul>${rows.map(([k, v]) =>
      `<li><span>${esc(k)}</span> <b>${esc(typeof v === 'number' ? groupNum(v) : v)}</b></li>`).join('')}</ul>
    <p>This page needs JavaScript for the album itself — the memories, the charts and the
    share cards are all drawn in your browser. Nothing is ever uploaded either way.</p>
    <p><code>npx codepend</code></p>`;
}

/** The ember mark as a favicon: 3×3 dots, last nine days, no CSS context. */
function faviconURI(payload) {
  const tl = Array.isArray(payload.timeline) ? payload.timeline : [];
  const active = new Set(tl.filter((d) => (d.sessions || d.humanTurns || d.minutes || 0) > 0).map((d) => d.date));
  const end = (payload.profile && payload.profile.lastSeen) || Date.now();
  const lit = [];
  for (let i = 8; i >= 0; i--) {
    const d = new Date(end);
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    lit.push(active.has(key));
  }
  if (!lit.some(Boolean)) { lit.fill(false); lit[0] = lit[4] = lit[8] = true; }
  let dots = '';
  for (let i = 0; i < 9; i++) {
    const x = (i % 3) * 12 + 1, y = Math.floor(i / 3) * 12 + 1;
    // single quotes only — this string lives inside a double-quoted href
    dots += `%3Crect x='${x}' y='${y}' width='8' height='8' rx='2' fill='${lit[i] ? '%2359AAF8' : '%23F4F1EC'}' opacity='${lit[i] ? 1 : 0.22}'/%3E`;
  }
  return `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 33 33'%3E%3Crect width='33' height='33' rx='7' fill='%2306070A'/%3E${dots}%3C/svg%3E`;
}

/** Where the fallback preview card lives. Overridable with `--og-image`. */
const DEFAULT_OG_IMAGE = 'https://shatzibitten.github.io/codepend/og.png';

/**
 * Open Graph tags, for the case where somebody hosts their own page.
 *
 * Opened from `file://` these do nothing, which is the normal case. But people
 * put this on Pages or their own box, and an unfurled link with no title and no
 * image looks like a broken upload rather than a year of someone's work.
 *
 * What goes in, and what deliberately does not:
 *   - the archetype and the round numbers — the hook, and identifying of
 *     nobody;
 *   - the agents by name, because "who was in the room" is the joke;
 *   - NOT project names, NOT quotes, NOT paths. A link preview is rendered by
 *     someone else's server and cached by it, so anything here has left the
 *     machine in a way the page itself never does. Under `paranoid` even the
 *     numbers go.
 *
 * `og:image` has to be an absolute URL — scrapers reject `data:` — so it points
 * at the project's own hosted card. That is a URL in a meta tag, not a request
 * this page makes: the page still loads nothing over the network.
 *
 * @param {object} payload
 * @param {{og?:boolean, ogImage?:string, ogUrl?:string, redact?:string}} o
 * @param {string} title
 * @returns {string}
 */
export function ogTags(payload, o, title) {
  if (o.og === false) return '';
  const p = payload.profile || {};
  const a = p.archetype || {};
  const s = payload.stats || {};
  const paranoid = o.redact === 'paranoid';

  const heading = a.name || 'codepend';
  const bits = [];
  if (!paranoid) {
    if (p.activeDays) bits.push(`${groupNum(p.activeDays)} days`);
    const msgs = s.humanTurns != null ? s.humanTurns : null;
    if (msgs) bits.push(`${groupNum(msgs)} messages`);
    const agents = agentNames(payload);
    if (agents) bits.push(`with ${agents}`);
  }
  const summary = bits.length
    ? `${bits.join(', ')}. Read out of my own agent logs, on my own machine.`
    : 'An album of one working year, read out of local agent logs.';
  const description = `${a.tagline ? a.tagline + ' ' : ''}${summary} Run npx codepend on yours.`;

  const image = o.ogImage || DEFAULT_OG_IMAGE;
  const tags = [
    ['og:type', 'website'],
    ['og:site_name', 'codepend'],
    ['og:title', heading],
    ['og:description', description],
  ];
  if (o.ogUrl) tags.push(['og:url', o.ogUrl]);
  if (image) {
    tags.push(['og:image', image], ['og:image:width', '1200'], ['og:image:height', '630'],
      ['og:image:alt', 'codepend — your AI coding history, as a photo album']);
  }
  const names = [
    ['twitter:card', image ? 'summary_large_image' : 'summary'],
    ['twitter:title', heading],
    ['twitter:description', description],
  ];
  if (image) names.push(['twitter:image', image]);

  return tags.map(([k, v]) => `<meta property="${k}" content="${esc(v)}">`)
    .concat(names.map(([k, v]) => `<meta name="${k}" content="${esc(v)}">`))
    .join('\n') + `\n<!-- title: ${esc(title)} -->`;
}

/** "Cursor, Codex and Claude Code" — only the ones actually in the history. */
function agentNames(payload) {
  const LABEL = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor' };
  const totals = Object.create(null);
  for (const d of (Array.isArray(payload.timeline) ? payload.timeline : [])) {
    for (const [k, v] of Object.entries(d.agent || {})) totals[k] = (totals[k] || 0) + (v || 0);
  }
  const present = Object.keys(totals).filter((k) => totals[k] > 0 && LABEL[k])
    .sort((x, y) => totals[y] - totals[x]).map((k) => LABEL[k]);
  if (!present.length) return '';
  if (present.length === 1) return present[0];
  return `${present.slice(0, -1).join(', ')} and ${present[present.length - 1]}`;
}

const BOOT = `(function(){try{var t=localStorage.getItem('codepend.theme');
if(t!=='light'&&t!=='dark'){t=window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}
document.documentElement.dataset.theme=t;}catch(e){document.documentElement.dataset.theme='dark';}})();`;

/**
 * @param {object} payload output of buildMemories(): {profile, memories, stats, timeline}
 * @param {{title?:string, version?:string, redact?:string, generatedAt?:number,
 *          artPath?:string, appDir?:string}} [opts]
 * @returns {string} a complete, standalone HTML document
 */
export function renderHTML(payload, opts) {
  const o = opts || {};
  const appDir = o.appDir || APP;
  const tpl = readFileSync(join(appDir, 'index.html'), 'utf8');
  const css = readFileSync(join(appDir, 'app.css'), 'utf8');
  const app = readFileSync(join(appDir, 'app.js'), 'utf8');
  const video = readFileSync(join(appDir, 'video.js'), 'utf8');
  const card = readFileSync(join(appDir, 'archetype-card.js'), 'utf8');
  const share = readFileSync(join(appDir, 'share-card.js'), 'utf8');

  // Prefer the real art module; fall back to the bundled one so the renderer
  // is never blocked on it (and so `npx codepend` can't ship a blank page).
  const realArt = o.artPath || join(HERE, 'art.js');
  const artPath = existsSync(realArt) ? realArt : join(appDir, 'art-fallback.js');
  const art = readFileSync(artPath, 'utf8');

  const profile = payload.profile || {};
  const arche = profile.archetype || {};
  const title = o.title || (arche.name ? `${arche.name} — codepend` : 'codepend');
  const desc = arche.tagline
    || 'Your agent history, as a photo album. Computed locally, never uploaded.';
  const og = ogTags(payload, o, title);

  const data = Object.assign({}, payload, {
    meta: Object.assign({
      generatedAt: o.generatedAt || Date.now(),
      version: o.version || null,
      redact: o.redact || null,
    }, payload.meta || {}),
  });

  const js = [
    '/* ---- src/art.js (inlined) ---- */',
    'globalThis.CODEPEND_ART = (() => {',
    stripExports(art),
    'return {',
    "  coverArt:  typeof coverArt  !== 'undefined' ? coverArt  : null,",
    "  palette:   typeof palette   !== 'undefined' ? palette   : null,",
    "  familyFor: typeof familyFor !== 'undefined' ? familyFor : null,",
    '};',
    '})();',
    '',
    // Same IIFE trick as art.js: one module script, so two files cannot both
    // declare top-level bindings. video.js hands app.js its factory and nothing
    // else, which is also why it can be unit-tested in Node as a real module.
    '/* ---- src/app/video.js (inlined) ---- */',
    'globalThis.CODEPEND_VIDEO = (() => {',
    stripExports(video),
    'return {',
    "  createExporter:  typeof createExporter  !== 'undefined' ? createExporter  : null,",
    "  planStoryboard:  typeof planStoryboard  !== 'undefined' ? planStoryboard  : null,",
    "  videoSupported:  typeof videoSupported  !== 'undefined' ? videoSupported  : null,",
    "  pickCodec:       typeof pickCodec       !== 'undefined' ? pickCodec       : null,",
    "  videoFilename:   typeof videoFilename   !== 'undefined' ? videoFilename   : null,",
    // The chart layer, handed over directly as well as through the exporter.
    // share-card.js paints its figures with `CHART_API.paint`, and an exporter
    // that failed to construct must not be able to take the charts down with
    // it — a share card missing its clock is the exact regression this whole
    // change exists to fix.
    "  charts:          typeof CHART_API        !== 'undefined' ? CHART_API        : null,",
    '};',
    '})();',
    '',
    // The archetype card. Same bridge again, and it must be evaluated before
    // app.js: app.js reads `globalThis.CODEPEND_ARCHETYPE_CARD` once, at the top
    // level, and falls back to its own built-in drawing if the global is absent.
    // A page that shipped these in the other order would silently ship the
    // fallback — same button, different picture — so the order is load-bearing
    // and there is a test that fails if this module goes missing.
    '/* ---- src/app/archetype-card.js (inlined) ---- */',
    'globalThis.CODEPEND_ARCHETYPE_CARD = (() => {',
    stripExports(card),
    'return {',
    "  drawArchetypeCard:   typeof drawArchetypeCard   !== 'undefined' ? drawArchetypeCard   : null,",
    "  archetypeLayout:     typeof archetypeLayout     !== 'undefined' ? archetypeLayout     : null,",
    "  archetypeFilename:   typeof archetypeFilename   !== 'undefined' ? archetypeFilename   : null,",
    "  safeText:            typeof safeText            !== 'undefined' ? safeText            : null,",
    "  ARCHETYPE_PRESETS:   typeof ARCHETYPE_PRESETS   !== 'undefined' ? ARCHETYPE_PRESETS   : null,",
    // The screen is a preview of the image and has to say the same words.
    "  EYEBROW:             typeof EYEBROW             !== 'undefined' ? EYEBROW             : null,",
    "  WORDMARK_SUB:        typeof WORDMARK_SUB        !== 'undefined' ? WORDMARK_SUB        : null,",
    '};',
    '})();',
    '',
    // The share card — the OTHER thirty-three memories. Same bridge, same
    // ordering rule, and the same failure mode if it is forgotten: app.js reads
    // `globalThis.CODEPEND_SHARE_CARD` once at the top level and keeps its old
    // generic composition when the global is absent. Nothing throws; the page
    // just quietly exports the wrong picture again. There is a test that fails
    // if this block goes missing, and another that fails if it lands after
    // app.js.
    '/* ---- src/app/share-card.js (inlined) ---- */',
    'globalThis.CODEPEND_SHARE_CARD = (() => {',
    stripExports(share),
    'return {',
    "  drawShareCard:   typeof drawShareCard   !== 'undefined' ? drawShareCard   : null,",
    "  shareLayout:     typeof shareLayout     !== 'undefined' ? shareLayout     : null,",
    "  shareFilename:   typeof shareFilename   !== 'undefined' ? shareFilename   : null,",
    "  safeText:        typeof safeText        !== 'undefined' ? safeText        : null,",
    "  chartHasData:    typeof chartHasData    !== 'undefined' ? chartHasData    : null,",
    "  SHARE_PRESETS:   typeof SHARE_PRESETS   !== 'undefined' ? SHARE_PRESETS   : null,",
    "  SHARE_KINDS:     typeof SHARE_KINDS     !== 'undefined' ? SHARE_KINDS     : null,",
    '};',
    '})();',
    '',
    '/* ---- payload ---- */',
    "globalThis.CODEPEND_DATA = JSON.parse(document.getElementById('codepend-data').textContent);",
    '',
    '/* ---- src/app/app.js (inlined) ---- */',
    stripExports(app),
  ].join('\n')
    // A literal </script anywhere in the source would end the tag early.
    // In JS, `<\/script` is identical in strings, regexes and comments.
    .replace(/<\/script/gi, '<\\/script');

  return tpl
    .replace('__TITLE__', esc(title))
    .replace('__DESC__', esc(desc))
    .replace('__OG__', () => og)
    .replace('__FAVICON__', faviconURI(payload))
    .replace('__BOOT__', () => BOOT)
    .replace('__CSS__', () => css)
    .replace('__NOSCRIPT__', () => noscriptHTML(payload))
    .replace('__DATA__', () => safeJSON(data))
    .replace('__JS__', () => js);
}

export default renderHTML;
