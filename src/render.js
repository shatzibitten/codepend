/* ============================================================================
   codepend — render.js
   Turns the buildMemories() payload into ONE self-contained HTML file.

   Everything is inlined: the payload JSON, app.css, app.js, and src/art.js.
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
    .replace('__FAVICON__', faviconURI(payload))
    .replace('__BOOT__', () => BOOT)
    .replace('__CSS__', () => css)
    .replace('__NOSCRIPT__', () => noscriptHTML(payload))
    .replace('__DATA__', () => safeJSON(data))
    .replace('__JS__', () => js);
}

export default renderHTML;
