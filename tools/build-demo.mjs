/**
 * codepend — build the public demo page.
 *
 *   node tools/build-demo.mjs [--out site/index.html] [--base-url https://…]
 *
 * Renders test/fixture-payload.mjs through src/render.js — the real renderer, the real
 * front-end, the real art — and then post-processes the resulting HTML string to:
 *
 *   1. state, unmissably and permanently, that the data is synthetic;
 *   2. carry the `npx codepend` call to action;
 *   3. add OG / Twitter card metadata so the link previews well;
 *   4. flip `robots: noindex` (correct for a private, personal export) to indexable
 *      (correct for the one page that is meant to be found).
 *
 * Everything is injected as inline <style>/<meta>/markup. The offline promise the footer
 * makes stays literally true: no <script src>, no <link href>, no fetch, no web fonts.
 *
 * This file only ever edits the *rendered string*. src/render.js and src/app/* are owned
 * elsewhere and are not touched.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderHTML } from '../src/render.js';
import { payload } from '../test/fixture-payload.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ─────────────────────────────── options ─────────────────────────────── */

const DEFAULT_BASE_URL = 'https://shatzibitten.github.io/codepend';

function parseArgs(argv) {
  const o = {
    out: resolve(ROOT, 'site/index.html'),
    baseUrl: process.env.CODEPEND_SITE_URL || DEFAULT_BASE_URL,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out' || a === '-o') o.out = resolve(process.cwd(), argv[++i]);
    else if (a.startsWith('--out=')) o.out = resolve(process.cwd(), a.slice(6));
    else if (a === '--base-url') o.baseUrl = argv[++i];
    else if (a.startsWith('--base-url=')) o.baseUrl = a.slice(11);
    else if (a === '--quiet' || a === '-q') o.quiet = true;
    else if (a === '--help' || a === '-h') {
      console.log(
        'usage: node tools/build-demo.mjs [--out site/index.html] [--base-url URL] [--quiet]\n' +
        `       base url also reads $CODEPEND_SITE_URL (default ${DEFAULT_BASE_URL})`,
      );
      process.exit(0);
    } else {
      console.error(`build-demo: unknown option ${a}`);
      process.exit(2);
    }
  }
  o.baseUrl = String(o.baseUrl).replace(/\/+$/, '');
  return o;
}

/* ─────────────────────────────── copy ─────────────────────────────── */

/*
 * The name does not describe the product, so every piece of metadata here has to.
 * "AI agent history" + "photo album" is the whole pitch in six words; the keywords a
 * person would actually search ("claude code", "codex", "cursor", "stats") go in the description.
 */
const TITLE = 'codepend — your AI coding history, as a photo album';
const DESC =
  'A live demo. codepend reads your local Claude Code, Codex and Cursor session logs and '
  + 'builds a Google-Photos-style memory feed: on this day, your stats, your archetype. '
  + 'Runs on your machine, uploads nothing, zero dependencies. npx codepend';

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* ─────────────────────────────── injected markup ─────────────────────────────── */

function metaTags(baseUrl) {
  const img = `${baseUrl}/og.png`;
  const tags = [
    ['og:type', 'website'],
    ['og:site_name', 'codepend'],
    ['og:title', TITLE],
    ['og:description', DESC],
    ['og:url', `${baseUrl}/`],
    ['og:image', img],
    ['og:image:width', '1200'],
    ['og:image:height', '630'],
    ['og:image:alt', 'codepend — your AI agent history, as a photo album'],
  ].map(([p, c]) => `<meta property="${p}" content="${esc(c)}">`);

  const names = [
    ['twitter:card', 'summary_large_image'],
    ['twitter:title', TITLE],
    ['twitter:description', DESC],
    ['twitter:image', img],
    ['twitter:image:alt', 'codepend — your AI agent history, as a photo album'],
  ].map(([n, c]) => `<meta name="${n}" content="${esc(c)}">`);

  return ['<!-- link preview -->', ...tags, ...names, `<link rel="canonical" href="${esc(baseUrl)}/">`]
    .join('\n');
}

/*
 * The banner is not an apology. It is the only card on the page that is allowed to sell,
 * and being synthetic is what licenses it to: nobody's real 3 AM is on screen, so the
 * page can say out loud what the tool would show you instead.
 *
 * Two pieces, on purpose:
 *   · a hero strip at the top, which explains and carries the CTA;
 *   · a "demo data" tag welded into the sticky wordmark, which never scrolls away.
 * The second one is the honest one — a banner you scroll past is a banner you forget.
 */
const HERO = `
<aside class="demo" aria-label="About this page">
  <div class="demo__in">
    <p class="demo__kicker"><span class="demo__dot" aria-hidden="true"></span> Demo &mdash; invented data</p>
    <h1 class="demo__h">This is a real page built from a fake person.</h1>
    <p class="demo__p">Every session, quote, streak and 3 AM confession below was generated
      from a fixture so the whole thing could be shown without showing anyone's actual
      history. Run the command on your own machine and this same page comes back with
      <em>your</em> six months in it &mdash; computed locally, uploaded nowhere.</p>
    <p class="demo__cmd"><code>npx codepend</code></p>
    <p class="demo__fine">Node 18+. Reads <code>~/.claude</code>, <code>~/.codex</code> and Cursor,
      writes one HTML file, makes no network requests. Scroll on for the demo.</p>
  </div>
</aside>`;

const TAG = '<span class="demo-tag" aria-label="demo data">demo</span>';

/*
 * Scoped to .demo* only, and written against the tokens app.css already defines, so the
 * strip follows the page into light mode instead of fighting it.
 */
const CSS = `
/* ---- demo banner (tools/build-demo.mjs) ---- */
.demo {
  position: relative; z-index: 1;
  padding: clamp(30px, 8vw, 68px) max(16px, env(safe-area-inset-left)) clamp(22px, 5vw, 38px);
  background:
    radial-gradient(120% 140% at 8% 0%, rgb(89 170 248 / .16) 0%, transparent 62%),
    linear-gradient(180deg, var(--surface-1) 0%, var(--paper) 100%);
  border-bottom: 1px solid var(--hairline);
}
.demo__in { max-width: 640px; margin-inline: auto; }
.demo__kicker {
  display: inline-flex; align-items: center; gap: 7px;
  margin: 0 0 14px;
  font: 600 var(--t-eyebrow)/1 var(--f-text);
  letter-spacing: .14em; text-transform: uppercase;
  color: var(--a-1);
  padding: 7px 12px; border-radius: var(--r-chip);
  border: 1px solid rgb(89 170 248 / .34);
  background: rgb(89 170 248 / .09);
}
.demo__dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: currentColor; box-shadow: 0 0 0 3px rgb(89 170 248 / .2);
}
.demo__h {
  margin: 0 0 12px;
  font: 700 var(--t-d2)/1.12 var(--f-display);
  letter-spacing: -.02em; color: var(--ink-0); text-wrap: balance;
}
.demo__p {
  margin: 0 0 20px; max-width: 54ch;
  font: 400 var(--t-body)/1.55 var(--f-text); color: var(--ink-1);
}
.demo__p em { color: var(--ink-0); font-style: italic; }
.demo__cmd { margin: 0 0 12px; }
.demo__cmd code {
  display: inline-block;
  font: 600 clamp(15px, 4vw, 19px)/1 var(--f-mono);
  color: var(--ink-inv); background: var(--ink-0);
  padding: 13px 20px; border-radius: 12px;
  user-select: all; -webkit-user-select: all;
}
.demo__fine {
  margin: 0; max-width: 52ch;
  font: 400 var(--t-meta)/1.5 var(--f-text); color: var(--ink-2);
}
.demo__fine code { font-family: var(--f-mono); font-size: .94em; color: var(--ink-1); }

/* the part that never scrolls away */
.demo-tag {
  margin-left: 8px; padding: 3px 7px;
  border-radius: 5px; border: 1px solid var(--hairline);
  background: rgb(89 170 248 / .13); color: var(--a-1);
  font: 600 var(--t-micro)/1 var(--f-text);
  letter-spacing: .1em; text-transform: uppercase;
  vertical-align: 2px;
}
/* Only give it up on the very narrowest phones — this tag is the honest one, and a
   phone is exactly where the hero has already been scrolled past. */
@media (max-width: 330px) { .demo-tag { display: none; } }
@media print { .demo { break-after: avoid; } }
`;

/* ─────────────────────────────── the build ─────────────────────────────── */

/** Replace once, and shout if the anchor moved. Silent no-op injection is the bug here. */
function must(html, needle, replacement, what) {
  const i = html.indexOf(needle);
  if (i === -1) throw new Error(`build-demo: could not find ${what} (${JSON.stringify(needle)}) in the rendered page — src/render.js or src/app/index.html changed shape`);
  return html.slice(0, i) + replacement + html.slice(i + needle.length);
}

/**
 * @param {{baseUrl?:string}} [opts]
 * @returns {string} the demo page
 */
export function buildDemoHTML(opts = {}) {
  const baseUrl = String(opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');

  let html = renderHTML(payload, {
    title: TITLE,
    version: '0.1.0',
    redact: 'safe',
    // Pinned so two builds of the same commit are byte-identical; Pages redeploys
    // otherwise churn the artifact for no reason.
    generatedAt: Date.UTC(2026, 7, 5, 18, 0, 0),
  });

  // A personal export is deliberately noindex. The demo is the exact opposite.
  html = must(html, '<meta name="robots" content="noindex">',
    '<meta name="robots" content="index, follow">', 'the robots meta');

  // The renderer writes the archetype tagline here; the demo needs to say what the thing is.
  html = html.replace(/<meta name="description" content="[^"]*">/,
    () => `<meta name="description" content="${esc(DESC)}">`);

  html = must(html, '</head>', `${metaTags(baseUrl)}\n<style>${CSS}</style>\n</head>`, 'the head close');
  html = must(html, '<span class="wordmark__t">codepend</span>',
    `<span class="wordmark__t">codepend</span>${TAG}`, 'the wordmark');
  html = must(html, '<a class="skip" href="#feed">Skip to the feed</a>',
    `<a class="skip" href="#feed">Skip to the feed</a>\n${HERO}`, 'the skip link');

  // The no-JS view is the page for crawlers and for anyone with scripting off. It must
  // not read as one person's real history either.
  html = must(html, '<div class="ns">',
    '<div class="ns"><p><strong>Demo &mdash; every number below is invented.</strong> '
    + 'Run <code>npx codepend</code> to build this page from your own local '
    + 'Claude Code, Codex and Cursor logs.</p>', 'the noscript block');

  return html;
}

/** Cheap guards that the demo did not quietly stop being a demo, or stop being offline. */
function audit(html) {
  const fail = [];
  if (!/class="demo"/.test(html)) fail.push('the demo banner is missing');
  if (!/class="demo-tag"/.test(html)) fail.push('the sticky demo tag is missing');
  if (!/property="og:image"/.test(html)) fail.push('og:image is missing');
  if (!/name="twitter:card" content="summary_large_image"/.test(html)) fail.push('twitter:card is missing');
  // The offline promise, re-checked on the artifact itself rather than on the sources.
  // `rel="canonical"` is metadata and is never fetched, so only the rels that actually
  // pull bytes are disqualifying — the rest of the page must load nothing at all.
  const NET = [
    [/<script[^>]+\bsrc=/i, '<script src>'],
    [/<link[^>]+\brel="(?:stylesheet|preload|prefetch|preconnect|dns-prefetch|modulepreload|manifest)"[^>]*\bhref="https?:/i,
      'a <link> that fetches over the network'],
    [/<link[^>]+\bhref="https?:[^"]*"[^>]*\brel="(?:stylesheet|preload|prefetch|preconnect|dns-prefetch|modulepreload|manifest)"/i,
      'a <link> that fetches over the network'],
    [/@import\s+url\(\s*['"]?https?:/i, '@import url(http…)'],
    [/<img[^>]+\bsrc="https?:/i, '<img src="http…">'],
    [/\bfetch\s*\(/, 'fetch()'],
    [/XMLHttpRequest|new\s+WebSocket|sendBeacon/, 'a network API'],
  ];
  for (const [re, what] of NET) if (re.test(html)) fail.push(`the page contains ${what} — it is no longer offline-safe`);
  if (fail.length) throw new Error(`build-demo: ${fail.join('; ')}`);
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const html = buildDemoHTML({ baseUrl: o.baseUrl });
  audit(html);
  mkdirSync(dirname(o.out), { recursive: true });
  writeFileSync(o.out, html);
  if (!o.quiet) {
    const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
    console.log(`build-demo: wrote ${o.out} (${kb} KB), og:image → ${o.baseUrl}/og.png`);
  }
}

// Run when invoked directly; stay inert when imported (the audit above is worth reusing).
if (process.argv[1] && process.argv[1].endsWith('build-demo.mjs')) main();

export default buildDemoHTML;
