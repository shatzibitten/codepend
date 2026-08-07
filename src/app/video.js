/* ============================================================================
   codepend — video.js
   Wrapped, exported as a 1080×1920 clip you can post as a story.

   How it works, and why it works this way:

   • An offscreen <canvas> at 1080×1920 is driven by requestAnimationFrame with
     an explicit elapsed-time clock. captureStream(30) turns that canvas into a
     MediaStream and MediaRecorder turns the stream into a Blob. All of it is
     client-side; nothing leaves the page, which is the whole promise of this
     tool and must stay true of the share assets too.

   • We DRAW, we do not screenshot. Every card is composed with the 2D API using
     the same lockup grammar as the share card, so type stays crisp at 1080 wide
     instead of being an upscaled DOM rasterisation.

   • The five charts live here but are not the clip's property. `paintChart()`
     is the one public way to put a codepend figure on any canvas at any size —
     the clip animates it, a share card asks for it finished. See the charts:
     painting section. Anything that draws its own is a chart that will drift.

   • The generative art is SVG. Rasterising an SVG costs a decode, so each scene's
     art is turned into an <img> ONCE during preparation and then only ever
     drawn — never re-encoded per frame. Same for the grain, which is baked into
     a single full-size tile up front.

   • prefers-reduced-motion is a statement about the *user interface*. The video
     is an artefact — a file the user asked for, which will be played by
     Instagram or TikTok on someone else's device — so it always animates. The
     page around it still respects the preference; app.js handles that.

   Everything here is pure or takes its browser dependencies through `deps`, so
   the timing, codec and filename logic can be unit-tested in Node.
   ========================================================================== */

/* ── constants ────────────────────────────────────────────────────────── */

export const VIDEO_W = 1080;
export const VIDEO_H = 1920;
export const VIDEO_FPS = 30;

/** Ceiling on the clip. Cards are dropped to fit it, never sped up. */
export const VIDEO_TARGET_MS = 46000;

/** Cross-dissolve between consecutive scenes. */
export const XFADE_MS = 340;

/**
 * Scene budget. `intro` and `finale` are fixed because they carry the setup and
 * the payoff; the middle cards absorb whatever is left of the target so the
 * clip lands on VIDEO_TARGET_MS exactly whenever the arithmetic allows it.
 */
export const SCENE_TIMING = {
  cast: 3000,
  intro: 3000,
  finale: 4200,
  midMin: 3000,
  midMax: 6200,
  midCountMax: 6,
  /** Taking in the art and the eyebrow, before a word of the copy is read. */
  readBase: 1900,
  /**
   * Per word of eyebrow + headline + body.
   *
   * ~7.7 words/second, which is faster than prose reading and slower than
   * glancing — right for display type you skim rather than read. A typical card
   * carries about 30 words and lands near 5.8 s.
   */
  readPerWord: 130,
};

/**
 * Codec preference, best first.
 *   mp4/avc1 — Safari 17+ and recent Chrome. The only thing every social
 *              platform ingests without a re-encode, so it wins when offered.
 *   vp9/vp8  — WebM, universally accepted by Chrome/Firefox; X and TikTok
 *              transcode it, Instagram sometimes refuses it. Still better than
 *              no video at all.
 */
export const CODEC_CANDIDATES = [
  'video/mp4;codecs=avc1',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

/* ── pure helpers (unit-tested) ───────────────────────────────────────── */

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/**
 * First candidate the platform admits it can record.
 * @param {(mime:string)=>boolean} isSupported usually MediaRecorder.isTypeSupported
 * @param {string[]} [candidates]
 * @returns {string|null}
 */
export function pickCodec(isSupported, candidates) {
  const list = Array.isArray(candidates) ? candidates : CODEC_CANDIDATES;
  if (typeof isSupported !== 'function') return null;
  for (const mime of list) {
    try { if (isSupported(mime)) return mime; } catch (e) { /* probe threw; try the next */ }
  }
  return null;
}

/**
 * A file named .webm that is actually MP4 (or the reverse) is rejected on
 * upload, so the extension follows what the recorder really produced.
 * @param {string} mime
 * @returns {string}
 */
export function extensionFor(mime) {
  const s = String(mime || '').toLowerCase();
  if (s.indexOf('mp4') >= 0) return 'mp4';
  if (s.indexOf('quicktime') >= 0) return 'mov';
  // Some Chrome builds answer an H.264 request with an MKV container. Calling
  // that file .mp4 would make it fail to open rather than fail to upload.
  if (s.indexOf('matroska') >= 0) return 'mkv';
  if (s.indexOf('webm') >= 0) return 'webm';
  if (s.indexOf('ogg') >= 0) return 'ogv';
  return 'webm';
}

/** `codepend-the-midnight-interrogator-wrapped.mp4` */
export function videoFilename(name, mime) {
  const slug = String(name || '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
    .replace(/-+$/, '');
  const ext = extensionFor(mime);
  return slug ? `codepend-${slug}-wrapped.${ext}` : `codepend-wrapped.${ext}`;
}

/**
 * Fit the middle cards into the budget, in order.
 *
 * The naive `slice(0, max)` dropped whatever came last, and on a real corpus
 * that was reliably the donut — so the clip carried one figure where the story
 * had two. A card with a chart is the most distinctive frame in the export, so
 * text-only cards are surrendered first, latest first, and the surviving order
 * is never rearranged.
 *
 * @param {object[]} mids
 * @param {number} max
 * @returns {object[]}
 */
export function trimMids(mids, max) {
  const keep = mids.slice();
  while (keep.length > max) {
    let idx = -1;
    for (let i = keep.length - 1; i >= 0; i--) if (!keep[i].chart) { idx = i; break; }
    keep.splice(idx >= 0 ? idx : keep.length - 1, 1);
  }
  return keep;
}

/**
 * Lay the storyboard out on a timeline.
 *
 * @param {Array<{role?:string}>} items scenes in order; roles 'cast' / 'intro' /
 *   'finale' are pulled out, everything else is a middle card.
 * @param {{target?:number, timing?:object, fps?:number}} [opts]
 * @returns {{scenes:object[], duration:number, fps:number, width:number, height:number}}
 */
/**
 * How long this card needs to be readable.
 *
 * Counts the words actually set on it — eyebrow, headline, body — because a
 * stat card that says "349 days" and a story card with three lines of copy do
 * not deserve the same hold. A chart earns a little extra: there is something
 * to look at as well as read.
 *
 * @param {{eyebrow?:string, headline?:string, body?:string, chart?:object}} s
 * @param {{readBase:number, readPerWord:number}} t
 * @returns {number} milliseconds
 */
export function readMs(s, t) {
  const text = [s && s.eyebrow, s && s.headline, s && s.body].filter(Boolean).join(' ');
  const words = text ? (text.match(/\S+/g) || []).length : 0;
  return Math.round(t.readBase + words * t.readPerWord + (s && s.chart ? 700 : 0));
}

export function planStoryboard(items, opts) {
  const o = opts || {};
  const t = Object.assign({}, SCENE_TIMING, o.timing || {});
  const target = o.target || VIDEO_TARGET_MS;
  const list = (Array.isArray(items) ? items : []).filter(Boolean);

  // The cast card is a title card: fixed length, always first, and never
  // competes with the memories for the middle budget.
  const cast = list.filter((s) => s.role === 'cast').slice(0, 1);
  const intro = list.filter((s) => s.role === 'intro').slice(0, 1);
  const finale = list.filter((s) => s.role === 'finale').slice(-1);
  let mids = list.filter((s) => s.role !== 'cast' && s.role !== 'intro' && s.role !== 'finale');
  if (mids.length > t.midCountMax) mids = trimMids(mids, t.midCountMax);

  // Each card is held for as long as it takes to read, not for an equal slice
  // of a fixed runtime.
  //
  // Dividing a 15 s budget between however many cards there were gave every one
  // ~1.5 s — the same for a four-word stat and a thirty-word story — and the
  // whole thing went past faster than anyone could read it. A story people
  // cannot read is not shorter, it is wasted.
  //
  // So the runtime is an outcome now, and `target` is a ceiling rather than a
  // quota: when the reading time overruns it we drop cards, never speed them up.
  const durs = mids.map((s) => clamp(readMs(s, t), t.midMin, t.midMax));
  const fixed = cast.length * t.cast + intro.length * t.intro + finale.length * t.finale;
  while (durs.length > 1 && fixed + durs.reduce((a, b) => a + b, 0) > target) {
    // Shed the shortest card: it is the one carrying the least to read.
    let worst = 0;
    for (let i = 1; i < durs.length; i++) if (durs[i] < durs[worst]) worst = i;
    durs.splice(worst, 1);
    mids.splice(worst, 1);
  }

  // The finale is the payoff and has to be held longest — a story that lingers
  // on a stat card and then flicks past the archetype has buried its own ending.
  // Reading time alone does not guarantee that once cards are timed by word
  // count, so the floor is explicit.
  const longestMid = durs.length ? Math.max(...durs) : 0;
  const finaleMs = Math.max(t.finale, longestMid + 600);

  const ordered = cast
    .map((s) => [s, t.cast])
    .concat(intro.map((s) => [s, t.intro]))
    .concat(mids.map((s, i) => [s, durs[i]]))
    .concat(finale.map((s) => [s, finaleMs]));

  let at = 0;
  const scenes = ordered.map(([s, duration], i) => {
    const scene = Object.assign({}, s, {
      index: i, duration, start: at, end: at + duration,
      role: s.role || 'mid',
    });
    at += duration;
    return scene;
  });

  return { scenes, duration: at, fps: o.fps || VIDEO_FPS, width: VIDEO_W, height: VIDEO_H };
}

/** Total of a plan — kept separate so tests can assert the invariant directly. */
export function storyboardDuration(plan) {
  const scenes = (plan && plan.scenes) || [];
  return scenes.reduce((s, x) => s + (x.duration || 0), 0);
}

/**
 * Is a canvas → video export possible at all here?
 * Safari < 14.1, Firefox on some platforms and every older WebView say no.
 * @param {object} [win]
 * @returns {boolean}
 */
export function videoSupported(win) {
  const w = win || (typeof globalThis !== 'undefined' ? globalThis : null);
  if (!w) return false;
  try {
    if (typeof w.MediaRecorder !== 'function') return false;
    const C = w.HTMLCanvasElement;
    if (!C || typeof C.prototype.captureStream !== 'function') return false;
    const probe = w.MediaRecorder.isTypeSupported;
    // No probe means we cannot promise anything sane; treat the default as fine.
    if (typeof probe !== 'function') return true;
    return pickCodec((m) => probe.call(w.MediaRecorder, m)) != null;
  } catch (e) { return false; }
}

/* ── charts: data ─────────────────────────────────────────────────────── */

/**
 * The detectors emit chart payloads in whatever shape was convenient at the
 * time: a flat array of numbers for the clock, `[{date, v}]` for the heat map
 * and the sparkline, `[{label, v}]` for bars and donuts. Everything downstream —
 * the SVG figures in the page and the canvas renderers below — reads ONE shape,
 * produced here, so the two surfaces cannot drift apart or disagree about what
 * "the top row" is.
 *
 * Sorting and capping also happen here rather than in each renderer, which is
 * why the page and the clip pick the same four donut segments.
 */

const TAU = Math.PI * 2;
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);

/** Thin-space grouping above 10 000, exactly as the page does it. */
function groupNum(n) {
  const s = String(n);
  return s.length > 4 ? s.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') : s;
}

/**
 * `#59AAF8` → `rgba(89,170,248,.38)`. Gradient stops need the alpha baked in,
 * and globalAlpha would fade the whole fill rather than one end of it.
 * Anything that is not a hex triple is handed back untouched at full alpha and
 * transparent at zero, which still produces a usable ramp.
 */
function withAlpha(color, a) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color || ''));
  if (!m) return a <= 0 ? 'rgba(0,0,0,0)' : color;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const v = parseInt(h, 16);
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`;
}

/** `[{label, value}]` out of every row shape the detectors emit. */
function rowsOf(data) {
  const raw = Array.isArray(data) ? data
    : (data && (data.rows || data.bars || data.items || data.segments || data.slices)) || [];
  const out = [];
  for (const r of raw) {
    if (Array.isArray(r)) { out.push({ label: String(r[0]), value: num(Number(r[1])) }); continue; }
    if (!r || typeof r !== 'object') continue;
    const label = r.label != null ? r.label : (r.name != null ? r.name : r.key);
    if (label == null) continue;
    const value = r.value != null ? r.value : (r.v != null ? r.v : r.n);
    out.push({ label: String(label), value: num(Number(value)) });
  }
  return out.filter((r) => r.label && r.label !== 'undefined');
}

/** A flat number series out of `[1,2,3]`, `[{v}]`, `[{value}]` or `{values:[…]}`. */
function seriesOf(data) {
  const raw = Array.isArray(data) ? data
    : (data && (data.bins || data.hours || data.values || data.points
      || data.series || data.days || data.cells)) || [];
  const out = [];
  for (const p of raw) {
    if (typeof p === 'number') { out.push(num(p)); continue; }
    if (!p || typeof p !== 'object') { out.push(0); continue; }
    out.push(num(Number(p.value != null ? p.value : (p.v != null ? p.v : p.n))));
  }
  return out;
}

/**
 * @param {{type?:string, data?:any, note?:string, peak?:number}} chart
 * @returns {object|null} `null` when there is nothing worth drawing — the
 *   caller then falls back to a text-only card rather than an empty frame.
 */
export function normalizeChart(chart) {
  if (!chart || !chart.type) return null;
  const type = String(chart.type);
  const note = chart.note || '';
  const d = chart.data;

  if (type === 'clock') {
    const bins = seriesOf(d).slice(0, 24);
    while (bins.length < 24) bins.push(0);
    if (!bins.some((v) => v > 0)) return null;
    let peak = 0;
    for (let i = 1; i < 24; i++) if (bins[i] > bins[peak]) peak = i;
    return { type, bins, peak, note };
  }

  if (type === 'heat') {
    const values = seriesOf(d);
    if (values.length < 7 || !values.some((v) => v > 0)) return null;
    return { type, values, note };
  }

  if (type === 'spark') {
    const points = seriesOf(d);
    if (points.length < 2) return null;
    return { type, points, note };
  }

  if (type === 'bars' || type === 'donut') {
    let rows = rowsOf(d).filter((r) => r.value > 0)
      .sort((a, b) => b.value - a.value || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
    if (!rows.length) return null;
    if (type === 'bars') rows = rows.slice(0, 8);
    else if (rows.length > 4) {
      const rest = rows.slice(4).reduce((s, r) => s + r.value, 0);
      rows = rows.slice(0, 4).concat(rest > 0 ? [{ label: 'other', value: rest }] : []);
    }
    return { type, rows, note };
  }

  return null;
}

/* ── the cast ─────────────────────────────────────────────────────────── */

/** Product names, set in type. No vendor marks, no invented logos. */
export const AGENT_NAMES = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor' };

function agentName(key) {
  if (AGENT_NAMES[key]) return AGENT_NAMES[key];
  const s = String(key || '').replace(/[-_]+/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Unknown';
}

/** "Cursor, Codex and Claude Code present" / "Codex presents". */
export function castHeadline(agents) {
  const names = (agents || []).map((a) => a.name).filter(Boolean);
  if (!names.length) return '';
  if (names.length === 1) return `${names[0]} presents`;
  const shown = names.length > 4 ? names.slice(0, 3).concat([`${names.length - 3} more`]) : names;
  const last = shown[shown.length - 1];
  return `${shown.slice(0, -1).join(', ')} and ${last} present`;
}

/**
 * Who this history is actually with, and in what proportion.
 *
 * The split is counted in MESSAGES YOU TYPED, from `timeline[].agent` — the
 * per-day, per-agent human-turn counts the payload already carries. Sessions
 * would flatter whichever agent you open and close most; messages are the
 * closest honest proxy for who you actually talked to.
 *
 * Only agents that appear are credited: a corpus with nothing but Claude Code
 * never mentions Cursor.
 *
 * @param {Array<{agent?:Object<string,number>}>} timeline
 * @returns {{agents:{key:string,name:string,messages:number,share:number}[],
 *            total:number, days:number, headline:string}}
 */
export function castFromTimeline(timeline) {
  const totals = new Map();
  let days = 0;
  const list = Array.isArray(timeline) ? timeline : [];
  for (const d of list) {
    const a = d && d.agent;
    if (!a || typeof a !== 'object') continue;
    let dayTotal = 0;
    for (const key in a) {
      const v = num(Number(a[key]));
      if (v <= 0) continue;
      totals.set(key, (totals.get(key) || 0) + v);
      dayTotal += v;
    }
    if (dayTotal > 0) days++;
  }
  const agents = Array.from(totals, ([key, messages]) => ({ key, name: agentName(key), messages }))
    .sort((a, b) => b.messages - a.messages || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const total = agents.reduce((s, x) => s + x.messages, 0);
  for (const x of agents) x.share = total ? x.messages / total : 0;
  return { agents, total, days, headline: castHeadline(agents) };
}

/* ── charts: geometry ─────────────────────────────────────────────────── */

/*
 * Pure. No canvas, no measurement, no time. Every renderer below is handed one
 * of these objects and does nothing but stroke and fill it, which is what keeps
 * a 2 Mpx frame inside the 33 ms budget at 30 fps.
 *
 * Each geometry fits the page's own viewBox into `box` and keeps the page's
 * proportions, so a chart in the clip is the same drawing as the chart on the
 * card, only bigger.
 */

/** Five opacity steps, exactly as the page's heat map uses them. */
export const HEAT_OPS = [0.06, 0.12, 0.3, 0.52, 0.76, 1];

function heatStep(v, max) {
  if (v <= 0) return 0;
  const f = v / max;
  return f < 0.2 ? 1 : f < 0.45 ? 2 : f < 0.7 ? 3 : f < 0.9 ? 4 : 5;
}

/** 24-spoke radial histogram, midnight at the top. Page viewBox: 320×320. */
export function clockGeometry(bins, box) {
  const b = (bins || []).slice(0, 24);
  while (b.length < 24) b.push(0);
  const S = Math.min(box.w, box.h);
  const k = S / 320;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const r0 = 52 * k, r1 = 142 * k;
  let max = 1, peak = 0;
  for (let i = 0; i < 24; i++) { if (b[i] > max) max = b[i]; if (b[i] > b[peak]) peak = i; }
  const rays = [];
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * TAU - Math.PI / 2;
    const cos = Math.cos(a), sin = Math.sin(a);
    const len = r0 + (r1 - r0) * (b[i] / max);
    rays.push({
      i, a, value: b[i], night: i < 6, peak: i === peak, zero: b[i] === 0,
      x1: cx + cos * r0, y1: cy + sin * r0,
      x2: cx + cos * len, y2: cy + sin * len,
    });
  }
  const marks = [0, 6, 12, 18].map((i) => {
    const a = (i / 24) * TAU - Math.PI / 2;
    return {
      label: String(i).padStart(2, '0'),
      x: cx + Math.cos(a) * (r1 + 18 * k),
      y: cy + Math.sin(a) * (r1 + 18 * k),
    };
  });
  const pad = 34 * k;
  return {
    type: 'clock', k, cx, cy, r0, r1, rays, marks, peak, max,
    lineWidth: 7 * k,
    big: String(peak).padStart(2, '0'), sub: 'PEAK HOUR',
    // The page sets these at 9–10px in a 320px viewBox. Held to that ratio they
    // land near 20px in a 1080-wide frame, which survives a phone screen but not
    // a thumbnail, so the in-chart type is a shade larger here than on the card.
    bigSize: 34 * k, subSize: Math.max(16, 11 * k), labSize: Math.max(18, 12 * k),
    bounds: { x: cx - r1 - pad, y: cy - r1 - pad, w: (r1 + pad) * 2, h: (r1 + pad) * 2 },
  };
}

/** ≤4 segments + "other", 3° gaps, headline share in the hole. Page: 460×330. */
export function donutGeometry(rows, box) {
  const list = rows || [];
  const k = Math.min(box.w / 460, box.h / 330);
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const r = 104 * k, sw = 28 * k;
  let total = 0;
  for (const row of list) total += row.value;
  if (total <= 0) total = 1;
  const gap = (1.5 * Math.PI) / 180;
  const labelR = r + sw / 2 + 16 * k;
  let ang = -Math.PI / 2;
  const arcs = list.map((row, i) => {
    const sweep = (row.value / total) * TAU;
    const mid = ang + sweep / 2;
    const arc = {
      i, label: String(row.label).toUpperCase().slice(0, 14), value: row.value,
      frac: row.value / total, start: ang, sweep,
      a0: ang + gap, a1: ang + sweep - gap, mid,
      labelX: cx + Math.cos(mid) * labelR,
      labelY: cy + Math.sin(mid) * labelR,
      anchor: Math.cos(mid) > 0.25 ? 'left' : Math.cos(mid) < -0.25 ? 'right' : 'center',
      roomy: sweep >= (34 * Math.PI) / 180,
    };
    ang += sweep;
    return arc;
  });
  const top = list[0] || { label: '', value: 0 };
  return {
    type: 'donut', k, cx, cy, r, sw, arcs, total,
    big: `${Math.round((top.value / total) * 100)}%`,
    sub: String(top.label).toUpperCase().slice(0, 16),
    bigSize: 34 * k, subSize: Math.max(16, 11 * k), labSize: Math.max(18, 12 * k),
    bounds: { x: cx - 230 * k, y: cy - 165 * k, w: 460 * k, h: 330 * k },
  };
}

/** Horizontal bars, label left, value right. Page: 520 wide, 30px rows. */
export function barsGeometry(rows, box) {
  const list = rows || [];
  const n = Math.max(1, list.length);
  const VW = 520, BH = 30, GAP = 10;
  const VH = n * (BH + GAP) - GAP;
  const k = Math.min(box.w / VW, box.h / VH);
  const w = VW * k, h = VH * k;
  const x = box.x + (box.w - w) / 2;
  const y0 = box.y + (box.h - h) / 2;
  let max = 1;
  for (const r of list) if (r.value > max) max = r.value;
  const bars = list.map((r, i) => ({
    i, label: String(r.label).toUpperCase(), value: r.value, text: groupNum(r.value),
    frac: r.value / max,
    x, y: y0 + i * (BH + GAP) * k, h: BH * k,
    w: Math.max(3 * k, (r.value / max) * w),
    alpha: Math.max(0.3, 1 - i * 0.09),
    // Set by annotateChart() once a context exists to measure with.
    labelInside: false, valueInside: false,
  }));
  return {
    type: 'bars', k, x, y: y0, w, h, bars, max, trackW: w, radius: 4 * k,
    labSize: Math.max(13, 11 * k), valSize: Math.max(14, 12 * k),
    bounds: { x, y: y0, w, h },
  };
}

/** Area + line, no axes. Page: 520×140. */
export function sparkGeometry(points, box) {
  const list = points || [];
  const VW = 520, VH = 140;
  const k = Math.min(box.w / VW, box.h / VH);
  const w = VW * k, h = VH * k;
  const x0 = box.x + (box.w - w) / 2;
  const y0 = box.y + (box.h - h) / 2;
  let max = 1, min = Infinity;
  for (const v of list) { if (v > max) max = v; if (v < min) min = v; }
  if (!isFinite(min)) min = 0;
  const span = Math.max(1e-6, max - min);
  const last = Math.max(1, list.length - 1);
  const pts = list.map((v, i) => ({
    v,
    x: x0 + (i / last) * w,
    y: y0 + h - 6 * k - ((v - min) / span) * (h - 22 * k),
  }));
  return {
    type: 'spark', k, x: x0, y: y0, w, h, pts, min, max, dotR: 5 * k,
    lineWidth: Math.max(2, 2.4 * k),
    // One gradient per canvas, built on first use: the cross-dissolve paints the
    // same scene into two different contexts and a gradient belongs to one.
    grads: new Map(),
    bounds: { x: x0, y: y0, w, h },
  };
}

/** GitHub-shaped day grid, seven rows, column per week. Page: 10px cells, 3px gutter. */
export function heatGeometry(values, box) {
  const list = values || [];
  const ROWS = 7, CS = 10, G = 3;
  const cols = Math.max(1, Math.ceil(list.length / ROWS));
  const VW = cols * (CS + G) - G, VH = ROWS * (CS + G) - G;
  const k = Math.min(box.w / VW, box.h / VH);
  const w = VW * k, h = VH * k;
  const x0 = box.x + (box.w - w) / 2;
  const y0 = box.y + (box.h - h) / 2;
  let max = 1, lit = 0;
  for (const v of list) { if (v > max) max = v; if (v > 0) lit++; }
  const cells = list.map((v, i) => {
    const col = Math.floor(i / ROWS), row = i % ROWS;
    return {
      i, col, row, value: v, step: heatStep(v, max),
      x: x0 + col * (CS + G) * k, y: y0 + row * (CS + G) * k, s: CS * k,
    };
  });
  return {
    type: 'heat', k, x: x0, y: y0, w, h, cols, rows: ROWS, cells, max, lit,
    radius: 2.5 * k,
    bounds: { x: x0, y: y0, w, h },
  };
}

/**
 * The one part of a chart that cannot be decided without a context: whether a
 * bar's label fits inside it. Run once at prepare time, never per frame.
 * @param {CanvasRenderingContext2D} ctx a scratch context, only measured with
 */
export function annotateChart(ctx, g, F) {
  if (!g || g.type !== 'bars' || !ctx) return g;
  for (let i = 0; i < g.bars.length; i++) {
    const b = g.bars[i];
    setFont(ctx, 600, g.labSize, F.display);
    b.labelInside = b.w > ctx.measureText(b.label).width + 34 * g.k;
    setFont(ctx, 700, g.valSize, F.display);
    b.valueInside = b.w > g.trackW - ctx.measureText(b.text).width - 26 * g.k;
  }
  return g;
}

/**
 * Dispatch. `box` is the middle band reserved by layoutScene.
 * @param {object} chart output of normalizeChart()
 * @param {{x:number,y:number,w:number,h:number}} box
 */
export function chartGeometry(chart, box) {
  if (!chart || !box || box.w <= 0 || box.h <= 0) return null;
  if (chart.type === 'clock') return clockGeometry(chart.bins, box);
  if (chart.type === 'donut') return donutGeometry(chart.rows, box);
  if (chart.type === 'bars') return barsGeometry(chart.rows, box);
  if (chart.type === 'spark') return sparkGeometry(chart.points, box);
  if (chart.type === 'heat') return heatGeometry(chart.values, box);
  return null;
}

/**
 * The cast block: a name per agent with its share, over one slim stacked bar.
 * Sized to read at thumbnail scale — the bar is the thing you see first.
 *
 * The opening card no longer asks for this. It was the first frame of the clip
 * and the first screen of the story, and a legend is a poor way to open either;
 * the proportions are a sentence now, so app.js stops passing `cast` on the
 * scene and this draws nothing. It stays because it is a correct, covered piece
 * of the public surface and the split is the sort of figure a later card may
 * well want — but if you are looking for what opens the clip, it is `body`.
 */
export function castGeometry(cast, box) {
  const agents = (cast && cast.agents) || [];
  if (!agents.length || !box) return null;
  const n = agents.length;
  const rowH = Math.min(126, Math.max(56, (box.h * 0.62) / n));
  const barH = Math.max(16, Math.min(30, box.h * 0.036));
  const gap = Math.max(24, box.h * 0.05);
  const blockH = n * rowH + gap + barH;
  const top = box.y + Math.max(0, (box.h - blockH) / 2);
  const rows = agents.map((a, i) => ({
    i, name: a.name, share: a.share, messages: a.messages,
    pct: `${Math.max(1, Math.round(a.share * 100))}%`,
    y: top + i * rowH + rowH * 0.68,
    dotX: box.x + rowH * 0.16,
    dotY: top + i * rowH + rowH * 0.44,
    dotR: Math.max(6, rowH * 0.11),
    textX: box.x + rowH * 0.42,
    rightX: box.x + box.w,
    nameSize: Math.max(30, rowH * 0.52),
    pctSize: Math.max(22, rowH * 0.34),
  }));
  const barY = top + n * rowH + gap;
  const segGap = Math.max(3, box.w * 0.004);
  let at = box.x;
  const segments = agents.map((a, i) => {
    const raw = box.w * a.share;
    const seg = { i, x: at, w: Math.max(barH * 0.6, raw - (i < n - 1 ? segGap : 0)), share: a.share };
    at += raw;
    return seg;
  });
  return {
    type: 'cast', rows, segments, barY, barH, barX: box.x, barW: box.w,
    radius: barH / 2,
    bounds: { x: box.x, y: top, w: box.w, h: blockH },
  };
}

/* ── easing + motion ──────────────────────────────────────────────────── */

const easeOutExpo = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

/** Type entrance: 460ms, staggered 90ms per group. */
const ENTER_MS = 460;
const STAGGER_MS = 90;
function entrance(localMs, group) {
  return easeOutExpo(clamp((localMs - group * STAGGER_MS) / ENTER_MS, 0, 1));
}

/* ── layout ───────────────────────────────────────────────────────────── */

const PAD = 96;
const COL = VIDEO_W - PAD * 2;
/** Story UI (avatars, captions, the send bar) eats roughly 250px top and bottom. */
const SAFE_TOP = 250;
const SAFE_BOTTOM = 300;

function setFont(ctx, weight, size, family, italic) {
  ctx.font = `${italic ? 'italic ' : ''}${weight} ${Math.round(size)}px ${family}`;
}

/** Greedy wrap; returns the lines it managed to fit, ellipsised if it overran. */
function wrapLines(ctx, text, maxW, maxLines) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const t = line ? line + ' ' + w : w;
    if (ctx.measureText(t).width > maxW && line) {
      lines.push(line);
      line = w;
      if (lines.length === maxLines) { line = ''; break; }
    } else line = t;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) lines.length = maxLines;
  const kept = lines.join(' ');
  if (kept.length && words.join(' ').length > kept.length) {
    lines[lines.length - 1] = lines[lines.length - 1].replace(/[.,;:]?$/, '…');
  }
  return lines;
}

/**
 * Shrink until the copy fits in `maxLines`. Headlines on a story card are the
 * one thing that must never clip, and the copy length is user data.
 */
function fitLines(ctx, text, weight, family, startSize, minSize, maxW, maxLines, italic) {
  let size = startSize;
  let lines = [];
  for (;;) {
    setFont(ctx, weight, size, family, italic);
    lines = wrapLines(ctx, text, maxW, maxLines + 2);
    const tooMany = lines.length > maxLines;
    const tooWide = lines.some((l) => ctx.measureText(l).width > maxW);
    if ((!tooMany && !tooWide) || size <= minSize) break;
    size = Math.max(minSize, size * 0.92);
  }
  if (lines.length > maxLines) lines.length = maxLines;
  return { size, lines };
}

/**
 * Turn a scene's copy into a flat list of draw ops with fixed geometry.
 * Done once per scene at prepare time, never per frame.
 */
function layoutScene(ctx, sc, F) {
  const ops = [];
  const push = (op) => { ops.push(op); return op; };
  const ink0 = F.ink0, ink2 = F.ink2, accent = (sc.pal && sc.pal.accents && sc.pal.accents[0]) || '#59AAF8';

  /* wordmark, top-left, on every scene */
  ops.push({ g: 0, type: 'mark', x: PAD, y: SAFE_TOP - 46, size: 46 });
  push({ g: 0, type: 'text', text: 'codepend', font: [700, 40, F.display], fill: ink0, x: PAD + 64, y: SAFE_TOP - 12 });

  if (sc.role === 'finale') {
    /* ---- the payoff: the archetype, centred, as big as it will go -------- */
    const name = sc.name || 'codepend';
    const tagFit = sc.tagline
      ? fitLines(ctx, sc.tagline, 400, F.serif, 50, 32, COL, 3, true) : null;
    const cells = (sc.cells || []).slice(0, 2);
    // The name gets the whole middle of the frame. Start from a size nothing
    // fits at and come down, so a short archetype fills the story instead of
    // sitting politely at 168px in the middle of an empty 1920px canvas.
    const tagBlock = tagFit ? tagFit.lines.length * (tagFit.size * 1.3) + 34 : 0;
    const cellBlock = cells.length ? 130 : 0;
    const nameRoom = (VIDEO_H - SAFE_TOP - SAFE_BOTTOM) - 74 - tagBlock - cellBlock - 70;
    let fitted = { size: 260, lines: [] };
    for (;;) {
      fitted = fitLines(ctx, name, 800, F.display, fitted.size, 62, COL, 4);
      if (fitted.lines.length * fitted.size * 1.02 <= nameRoom || fitted.size <= 62) break;
      fitted = { size: fitted.size * 0.93, lines: [] };
    }
    const lh = fitted.size * 1.02;

    const nameH = fitted.lines.length * lh;
    const tagH = tagBlock;
    const cellH = cellBlock;
    const total = 74 + nameH + tagH + cellH;
    let y = (VIDEO_H - SAFE_TOP - SAFE_BOTTOM) / 2 + SAFE_TOP - total / 2 + fitted.size * 0.78;

    push({
      g: 1, type: 'text', text: String(sc.eyebrow || 'What you are').toUpperCase(), font: [600, 28, F.display],
      fill: ink0, alpha: 0.62, x: PAD, y: y - fitted.size * 0.78 - 30, track: 5,
    });
    fitted.lines.forEach((l, i) => {
      push({ g: 2 + i * 0.25, type: 'text', text: l, font: [800, fitted.size, F.display], fill: ink0, x: PAD, y: y + i * lh });
    });
    y += nameH + 6;

    if (tagFit) {
      const tlh = tagFit.size * 1.3;
      y += 34;
      tagFit.lines.forEach((l, i) => {
        push({ g: 3.4, type: 'text', text: l, font: [400, tagFit.size, F.serif], italic: true, fill: ink0, alpha: 0.86, x: PAD, y: y + i * tlh });
      });
      y += tagFit.lines.length * tlh;
    }

    if (cells.length) {
      y += 96;
      push({ g: 4, type: 'rule', x: PAD, y: y - 74, w: COL, color: F.rule });
      let cx = PAD;
      cells.forEach(([v, l]) => {
        push({ g: 4.2, type: 'text', text: String(v), font: [800, 60, F.display], fill: ink0, x: cx, y });
        push({ g: 4.4, type: 'text', text: String(l).toUpperCase(), font: [600, 24, F.display], fill: ink2, x: cx, y: y + 40, track: 3 });
        cx += COL / 2;
      });
    }

    /* the pitch, pinned to the bottom — this frame is the thumbnail */
    push({ g: 5, type: 'rule', x: PAD, y: VIDEO_H - SAFE_BOTTOM + 96, w: COL, color: F.rule });
    push({ g: 5, type: 'text', text: 'npx codepend', font: [600, 34, F.display], fill: ink0, alpha: 0.9, x: PAD, y: VIDEO_H - SAFE_BOTTOM + 152 });
    push({ g: 5, type: 'text', text: '100% local', font: [600, 34, F.display], fill: ink2, x: PAD, y: VIDEO_H - SAFE_BOTTOM + 152, align: 'right', rightAt: PAD + COL });
    return { ops, accent };
  }

  /* ---- intro + middle cards: bottom-anchored lockup -------------------- */
  const bottom = VIDEO_H - SAFE_BOTTOM;
  const stack = [];   // built bottom-up, then flipped into ops

  if (sc.body) {
    setFont(ctx, 400, 36, F.display);
    const lines = wrapLines(ctx, sc.body, COL, 3);
    for (let i = lines.length - 1; i >= 0; i--) {
      stack.push({ g: 3, type: 'text', text: lines[i], font: [400, 36, F.display], fill: ink0, alpha: 0.78, adv: 50 });
    }
    stack.push({ type: 'gap', adv: 20 });
  }

  if (sc.headline) {
    const fitted = fitLines(ctx, sc.headline, 700, F.display, 92, 46, COL, 4);
    for (let i = fitted.lines.length - 1; i >= 0; i--) {
      stack.push({ g: 2, type: 'text', text: fitted.lines[i], font: [700, fitted.size, F.display], fill: ink0, adv: fitted.size * 1.1 });
    }
    stack.push({ type: 'gap', adv: 26 });
  }

  if (sc.stat) {
    const vs = String(sc.stat.value);
    let size = vs.length > 8 ? 150 : vs.length > 5 ? 200 : 250;
    setFont(ctx, 800, size, F.display);
    while (ctx.measureText(vs).width > COL * 0.96 && size > 64) {
      size *= 0.92; setFont(ctx, 800, size, F.display);
    }
    // The stack is filled bottom-up: whatever is pushed first sits lowest. The
    // label belongs UNDER the number, exactly as it does on the card, so it has
    // to be pushed before it.
    if (sc.stat.label) {
      stack.push({ g: 1.4, type: 'text', text: String(sc.stat.label).toUpperCase(), font: [600, 30, F.display], fill: ink2, track: 3, adv: 62 });
    }
    stack.push({
      g: 1, type: 'count', text: vs, font: [800, size, F.display], fill: ink0, adv: size * 0.92,
      unit: sc.stat.unit || '', unitFont: [600, 60, F.display], unitFill: accent,
    });
    stack.push({ type: 'gap', adv: 16 });
  } else if (sc.quote) {
    const fitted = fitLines(ctx, '«' + sc.quote.text + '»', 400, F.serif, 68, 38, COL, 6, true);
    // Attribution goes under the quote — push it first (see the note above).
    if (sc.quote.who) {
      stack.push({ g: 1.4, type: 'text', text: String(sc.quote.who).toUpperCase(), font: [600, 26, F.display], fill: ink2, track: 3, adv: 64 });
    }
    for (let i = fitted.lines.length - 1; i >= 0; i--) {
      stack.push({ g: 1, type: 'text', text: fitted.lines[i], font: [400, fitted.size, F.serif], italic: true, fill: ink0, adv: fitted.size * 1.28 });
    }
    stack.push({ type: 'gap', adv: 16 });
  }

  if (sc.eyebrow) {
    stack.push({ g: 0.6, type: 'text', text: String(sc.eyebrow).toUpperCase(), font: [600, 26, F.display], fill: ink0, alpha: 0.62, track: 5, adv: 50 });
  }

  let y = bottom;
  for (const item of stack) {
    if (item.type !== 'gap') push(Object.assign({}, item, { x: PAD, y }));
    y -= item.adv || 0;
  }

  /* The middle band: whatever is left between the wordmark and the top of the
     type stack. A chart is only drawn when there is honestly room for one —
     a squeezed 180px clock reads as a smudge, and a text-only card is better
     than a bad chart. */
  let chartBox = null;
  if (sc.chart || sc.cast) {
    const top = SAFE_TOP + 96;
    const bot = y - 76;
    if (bot - top >= 260) chartBox = { x: PAD, y: top, w: COL, h: bot - top };
  }
  return { ops, accent, chartBox };
}

/* ── frame painting ───────────────────────────────────────────────────── */

/** Cover-fit with a slow Ken Burns push. `p` runs 0→1 across the scene. */
function drawArt(ctx, sc, p) {
  const img = sc.img;
  if (!img) return;
  const zoom = 1.05 + 0.11 * easeInOut(clamp(p, 0, 1));
  const drift = sc.drift || 0;
  const ar = (img.width || VIDEO_W) / (img.height || VIDEO_H);
  const tar = VIDEO_W / VIDEO_H;
  let dw, dh;
  if (ar > tar) { dh = VIDEO_H * zoom; dw = dh * ar; } else { dw = VIDEO_W * zoom; dh = dw / ar; }
  const dx = (VIDEO_W - dw) / 2 + drift * 34 * (p - 0.5);
  const dy = (VIDEO_H - dh) / 2 - 26 * (p - 0.5);
  ctx.drawImage(img, dx, dy, dw, dh);
}

function drawScrim(ctx, sc, F) {
  const s = F.scrim;
  const g = ctx.createLinearGradient(0, 0, 0, VIDEO_H);
  if (sc.role === 'finale') {
    g.addColorStop(0, `rgba(${s},0.72)`);
    g.addColorStop(0.42, `rgba(${s},0.58)`);
    g.addColorStop(1, `rgba(${s},0.80)`);
  } else {
    g.addColorStop(0, `rgba(${s},0.66)`);
    g.addColorStop(0.30, `rgba(${s},0.20)`);
    g.addColorStop(0.56, `rgba(${s},0.62)`);
    g.addColorStop(0.78, `rgba(${s},0.92)`);
    g.addColorStop(1, `rgba(${s},0.96)`);
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VIDEO_W, VIDEO_H);
}

/* ── charts: painting ─────────────────────────────────────────────────── */

/*
 * These are the only things in the file that draw user data as shapes, and they
 * run 30 times a second into a 1080×1920 canvas while MediaRecorder encodes. So:
 * every coordinate is precomputed (see the geometry section), nothing allocates
 * here, and the one unavoidable object — the sparkline's gradient — is cached
 * per context because the cross-dissolve alternates between two canvases.
 *
 * They are also no longer the clip's private business. `paintChart()` at the
 * bottom of this section is the ONE way in, for the clip and for the share card
 * alike: the same five drawings, the same normaliser, the same geometry. The
 * individual painters stay module-private on purpose — a second public door is
 * a second thing to keep in step, and the export dropping the chart entirely is
 * exactly the bug this file is now the single source of truth against.
 */

/** The chart's own animation window, inside the scene. */
const CHART_DELAY = 150;
const CHART_MS = 1050;

/**
 * Local progress for element `i` of `n`, where the first and last elements are
 * `spread` of the window apart. This is what makes rays grow outward in order
 * and heat columns light up left to right instead of all at once.
 */
function stagger(p, i, n, spread) {
  const s = spread == null ? 0.6 : spread;
  const step = n > 1 ? s / (n - 1) : 0;
  return clamp((p - i * step) / (1 - s), 0, 1);
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Centre/left/right text without allocating a new alignment string. */
function alignedX(ctx, text, x, anchor) {
  if (anchor === 'left') return x;
  const w = ctx.measureText(text).width;
  return anchor === 'right' ? x - w : x - w / 2;
}

/* ── what a painter needs besides geometry ────────────────────────────── */

/**
 * Type colours and the family to set them in. A caller that already has the
 * clip's field object passes it straight through and nothing is allocated;
 * anything short of a full set is filled in from these.
 */
export const CHART_INK = {
  ink0: '#F4F1EC',
  ink1: '#B9B4AC',
  ink2: '#827D75',
  inkInv: '#06070A',
  rule: 'rgba(255,255,255,.18)',
  scrim: '5,6,10',
  display: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
};

function inkFields(ink) {
  if (!ink) return CHART_INK;
  if (ink.ink0 && ink.ink1 && ink.ink2 && ink.inkInv && ink.rule && ink.scrim && ink.display) return ink;
  return Object.assign({}, CHART_INK, ink);
}

/** Three accents, night → day → highlight. */
export const CHART_ACCENTS = ['#59AAF8', '#8771DE', '#A9C7F2'];

function accentsOf(palette) {
  const a = Array.isArray(palette) ? palette : (palette && palette.accents);
  if (!Array.isArray(a) || !a.length) return CHART_ACCENTS;
  if (a.length >= 3) return a;
  return [a[0], a[1] || a[0], a[2] || a[1] || a[0]];
}

/**
 * Which words a chart is allowed to say.
 *
 * The same drawing appears at three sizes — a 320px figure in the feed, a
 * 1080-wide frame in the clip, a share card somewhere between — and the answer
 * to "does a project name fit next to this arc" is different at each. So it is
 * the caller's call, not a constant in here.
 *
 * The four switches are separated by what the text IS, not by where it sits:
 *
 *   axis    structural ticks the chart cannot be read without — the clock's
 *           00/06/12/18. No user data, ever.
 *   center  the in-chart lockup: the clock's peak hour, the donut's leading
 *           share. A figure, plus its caption.
 *   series  text lifted straight out of the corpus — donut arc labels, the
 *           donut's hole caption, bar row labels. THIS IS THE ONE THE
 *           "Hide project names" toggle turns off. Nothing else on the chart
 *           can leak a name.
 *   values  the numbers set beside a mark, e.g. a bar's count.
 *   scale   multiplier on every in-chart type size. Geometry decides the sizes;
 *           this only lets a smaller surface pull them down without touching
 *           the pure layer.
 */
export const CHART_LABELS = { axis: true, center: true, series: true, values: true, scale: 1 };
const LABELS_NONE = { axis: false, center: false, series: false, values: false, scale: 1 };
const LABELS_MINIMAL = { axis: false, center: true, series: false, values: false, scale: 1 };
const LABELS_ANON = { axis: true, center: true, series: false, values: true, scale: 1 };

function labelFields(labels) {
  if (labels == null || labels === true || labels === 'all') return CHART_LABELS;
  if (labels === false || labels === 'none') return LABELS_NONE;
  if (labels === 'minimal') return LABELS_MINIMAL;
  if (labels === 'anonymous') return LABELS_ANON;
  if (typeof labels !== 'object') return CHART_LABELS;
  const s = Number(labels.scale);
  return {
    axis: labels.axis !== false,
    center: labels.center !== false,
    series: labels.series !== false,
    values: labels.values !== false,
    scale: isFinite(s) && s > 0 ? s : 1,
  };
}

function paintClock(ctx, g, p, acc, F, L) {
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(1, 1.6 * g.k);
  ctx.strokeStyle = F.rule;
  ctx.globalAlpha = easeOutExpo(clamp(p * 2, 0, 1));
  ctx.beginPath(); ctx.arc(g.cx, g.cy, g.r0 - 8 * g.k, 0, TAU); ctx.stroke();
  ctx.beginPath(); ctx.arc(g.cx, g.cy, g.r1, 0, TAU); ctx.stroke();

  for (let i = 0; i < g.rays.length; i++) {
    const r = g.rays[i];
    const e = easeOutExpo(stagger(p, i, 24, 0.55));
    if (e <= 0.001) continue;
    // Night keeps the first accent, day the second — the page's own rule. The
    // peak hour is the one thing a viewer should find in half a second, so it
    // gets full alpha and a heavier stroke on top of that.
    ctx.strokeStyle = r.peak || r.night ? acc[0] : acc[1];
    ctx.globalAlpha = r.zero ? 0.16 : r.peak ? 1 : r.night ? 0.9 : 0.6;
    ctx.lineWidth = r.peak ? g.lineWidth * 1.35 : g.lineWidth;
    ctx.beginPath();
    ctx.moveTo(r.x1, r.y1);
    ctx.lineTo(r.x1 + (r.x2 - r.x1) * e, r.y1 + (r.y2 - r.y1) * e);
    ctx.stroke();
  }

  const late = easeOutExpo(clamp((p - 0.45) / 0.55, 0, 1));
  if (late <= 0.001) return;
  const labSize = g.labSize * L.scale;
  const bigSize = g.bigSize * L.scale;
  const subSize = g.subSize * L.scale;
  if (L.axis) {
    ctx.globalAlpha = late * 0.7;
    setFont(ctx, 600, labSize, F.display);
    ctx.fillStyle = F.ink2;
    for (let i = 0; i < g.marks.length; i++) {
      const m = g.marks[i];
      ctx.fillText(m.label, alignedX(ctx, m.label, m.x, 'center'), m.y + labSize * 0.34);
    }
  }
  if (!L.center) return;
  ctx.globalAlpha = late;
  setFont(ctx, 800, bigSize, F.display);
  ctx.fillStyle = F.ink0;
  ctx.fillText(g.big, alignedX(ctx, g.big, g.cx, 'center'), g.cy + bigSize * 0.06);
  setFont(ctx, 600, subSize, F.display);
  ctx.fillStyle = F.ink2;
  ctx.fillText(g.sub, alignedX(ctx, g.sub, g.cx, 'center'), g.cy + bigSize * 0.06 + subSize * 2.2);
}

function paintDonut(ctx, g, p, acc, F, L) {
  const swept = easeInOut(p);
  const end = -Math.PI / 2 + TAU * swept;
  ctx.lineCap = 'butt';
  ctx.lineWidth = g.sw;
  for (let i = 0; i < g.arcs.length; i++) {
    const a = g.arcs[i];
    const a1 = Math.min(a.a1, end);
    if (a1 <= a.a0) continue;
    ctx.strokeStyle = acc[i % 3];
    ctx.globalAlpha = i === 0 ? 1 : i === 1 ? 0.92 : i === 2 ? 0.85 : i === 3 ? 0.5 : 0.32;
    ctx.beginPath();
    ctx.arc(g.cx, g.cy, g.r, a.a0, a1);
    ctx.stroke();
  }
  const labSize = g.labSize * L.scale;
  const bigSize = g.bigSize * L.scale;
  const subSize = g.subSize * L.scale;
  // Labels sit on the mark, not in a legend — but only once their arc exists.
  if (L.series) {
    setFont(ctx, 600, labSize, F.display);
    ctx.fillStyle = F.ink2;
    for (let i = 0; i < g.arcs.length; i++) {
      const a = g.arcs[i];
      if (!a.roomy) continue;
      // The last arc ends a gap short of `end`, so the fade-in it is scored
      // against never quite reaches 1 while it is being drawn. On a still card
      // that left the final label at 7% alpha — invisible — and the clip held
      // the same near-blank label for the whole tail of the scene. A finished
      // chart is finished: past p=1 every label it earned is fully set.
      const e = p >= 1 ? 1 : clamp((end - a.a1) / 0.35, 0, 1);
      if (e <= 0.001) continue;
      ctx.globalAlpha = e;
      ctx.fillText(a.label, alignedX(ctx, a.label, a.labelX, a.anchor), a.labelY + labSize * 0.34);
    }
  }
  const late = easeOutExpo(clamp((p - 0.4) / 0.6, 0, 1));
  if (late <= 0.001 || !L.center) return;
  ctx.globalAlpha = late;
  setFont(ctx, 800, bigSize, F.display);
  ctx.fillStyle = F.ink0;
  ctx.fillText(g.big, alignedX(ctx, g.big, g.cx, 'center'), g.cy + bigSize * 0.06);
  // The hole's caption is the leading project's own name, so it answers to
  // `series` and not to `center`: hiding project names must hide this too.
  if (!L.series) return;
  setFont(ctx, 600, subSize, F.display);
  ctx.fillStyle = F.ink2;
  ctx.fillText(g.sub, alignedX(ctx, g.sub, g.cx, 'center'), g.cy + bigSize * 0.06 + subSize * 2.2);
}

function paintBars(ctx, g, p, acc, F, L) {
  for (let i = 0; i < g.bars.length; i++) {
    const b = g.bars[i];
    const e = easeOutExpo(stagger(p, i, g.bars.length, 0.5));
    ctx.globalAlpha = 0.07;
    ctx.fillStyle = acc[0];
    roundRect(ctx, b.x, b.y, g.trackW, b.h, g.radius);
    ctx.fill();
    if (e <= 0.001) continue;
    ctx.globalAlpha = b.alpha;
    roundRect(ctx, b.x, b.y, Math.max(g.radius * 2, b.w * e), b.h, g.radius);
    ctx.fill();
  }
  if (!L.series && !L.values) return;
  const labSize = g.labSize * L.scale;
  const valSize = g.valSize * L.scale;
  for (let i = 0; i < g.bars.length; i++) {
    const b = g.bars[i];
    const e = easeOutExpo(stagger(p, i, g.bars.length, 0.5));
    if (e <= 0.05) continue;
    ctx.globalAlpha = e;
    if (L.series) {
      setFont(ctx, 600, labSize, F.display);
      ctx.fillStyle = b.labelInside ? F.inkInv : F.ink2;
      ctx.fillText(b.label, b.labelInside ? b.x + 14 * g.k : b.x + b.w * e + 14 * g.k, b.y + b.h / 2 + labSize * 0.34);
    }
    if (L.values) {
      setFont(ctx, 700, valSize, F.display);
      ctx.fillStyle = b.valueInside ? F.inkInv : F.ink1;
      const vx = b.x + g.trackW - 12 * g.k;
      ctx.fillText(b.text, alignedX(ctx, b.text, vx, 'right'), b.y + b.h / 2 + valSize * 0.32);
    }
  }
}

function sparkGradient(ctx, g, acc) {
  let grad = g.grads.get(ctx);
  if (!grad) {
    grad = ctx.createLinearGradient(0, g.y, 0, g.y + g.h);
    grad.addColorStop(0, withAlpha(acc[0], 0.38));
    grad.addColorStop(1, withAlpha(acc[0], 0));
    g.grads.set(ctx, grad);
  }
  return grad;
}

function paintSpark(ctx, g, p, acc) {
  const e = easeInOut(p);
  if (e <= 0.001) return;
  ctx.save();
  // Draw the whole path and reveal it left to right — cheaper and smoother than
  // re-tracing a partial polyline every frame.
  ctx.beginPath();
  ctx.rect(g.x - 2, g.y - g.dotR * 2, g.w * e + 2, g.h + g.dotR * 4);
  ctx.clip();
  ctx.beginPath();
  ctx.moveTo(g.pts[0].x, g.pts[0].y);
  for (let i = 1; i < g.pts.length; i++) ctx.lineTo(g.pts[i].x, g.pts[i].y);
  ctx.lineTo(g.x + g.w, g.y + g.h);
  ctx.lineTo(g.x, g.y + g.h);
  ctx.closePath();
  ctx.globalAlpha = 1;
  ctx.fillStyle = sparkGradient(ctx, g, acc);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(g.pts[0].x, g.pts[0].y);
  for (let i = 1; i < g.pts.length; i++) ctx.lineTo(g.pts[i].x, g.pts[i].y);
  ctx.strokeStyle = acc[0];
  ctx.lineWidth = g.lineWidth;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.restore();

  // The dot rides the leading edge and lands on the last reading.
  const fi = clamp(e, 0, 1) * (g.pts.length - 1);
  const i0 = Math.floor(fi), i1 = Math.min(g.pts.length - 1, i0 + 1), f = fi - i0;
  const dx = g.pts[i0].x + (g.pts[i1].x - g.pts[i0].x) * f;
  const dy = g.pts[i0].y + (g.pts[i1].y - g.pts[i0].y) * f;
  ctx.globalAlpha = 1;
  ctx.fillStyle = acc[2];
  ctx.beginPath();
  ctx.arc(dx, dy, g.dotR, 0, TAU);
  ctx.fill();
}

function paintHeat(ctx, g, p, acc) {
  ctx.fillStyle = acc[0];
  for (let i = 0; i < g.cells.length; i++) {
    const c = g.cells[i];
    const e = easeOutExpo(stagger(p, c.col, g.cols, 0.72));
    if (e <= 0.001) continue;
    ctx.globalAlpha = HEAT_OPS[c.step] * e;
    roundRect(ctx, c.x, c.y, c.s, c.s, g.radius);
    ctx.fill();
  }
}

function paintCast(ctx, g, p, acc, F, L) {
  for (let i = 0; i < g.rows.length; i++) {
    const r = g.rows[i];
    const e = easeOutExpo(stagger(p, i, g.rows.length, 0.5));
    if (e <= 0.001) continue;
    const dy = (1 - e) * 26;
    ctx.globalAlpha = e;
    ctx.fillStyle = acc[i % 3];
    ctx.beginPath();
    ctx.arc(r.dotX, r.dotY + dy, r.dotR, 0, TAU);
    ctx.fill();
    // These are product names, not the user's projects, so they answer to
    // `series` only because that is where every from-the-corpus string lives.
    if (L.series) {
      setFont(ctx, 700, r.nameSize * L.scale, F.display);
      ctx.fillStyle = F.ink0;
      ctx.fillText(r.name, r.textX, r.y + dy);
    }
    if (L.values) {
      setFont(ctx, 600, r.pctSize * L.scale, F.display);
      ctx.fillStyle = F.ink2;
      ctx.fillText(r.pct, alignedX(ctx, r.pct, r.rightX, 'right'), r.y + dy);
    }
  }
  const bar = easeOutExpo(clamp((p - 0.25) / 0.75, 0, 1));
  if (bar <= 0.001) return;
  ctx.globalAlpha = 0.10;
  ctx.fillStyle = F.ink0;
  roundRect(ctx, g.barX, g.barY, g.barW, g.barH, g.radius);
  ctx.fill();
  for (let i = 0; i < g.segments.length; i++) {
    const s = g.segments[i];
    const w = s.w * bar;
    if (w <= 0.5) continue;
    ctx.globalAlpha = 1;
    ctx.fillStyle = acc[i % 3];
    roundRect(ctx, s.x, g.barY, w, g.barH, g.radius);
    ctx.fill();
  }
}

/**
 * Is this already the output of normalizeChart()?
 *
 * Matters because the entry point takes a chart in whatever state the caller
 * has it: the clip normalises once at prepare time, the page keeps normalised
 * charts on its scenes, and a share card may well hand over the raw payload
 * straight off the Memory. Running the normaliser twice is not harmless — the
 * donut folds its tail into "other" and would fold the fold — so it is asked
 * first rather than run blind.
 */
function asNormalized(chart) {
  if (!chart || !chart.type) return null;
  const t = chart.type;
  if (t === 'clock') return Array.isArray(chart.bins) ? chart : normalizeChart(chart);
  if (t === 'heat') return Array.isArray(chart.values) ? chart : normalizeChart(chart);
  if (t === 'spark') return Array.isArray(chart.points) ? chart : normalizeChart(chart);
  if (t === 'bars' || t === 'donut') return Array.isArray(chart.rows) ? chart : normalizeChart(chart);
  return normalizeChart(chart);
}

/**
 * Draw one chart. The only public way to put a codepend figure on a canvas.
 *
 * `progress` is what separates the two surfaces and it is the ONLY thing that
 * does: the clip runs it 0 → 1 across the scene, a still card passes 1 (the
 * default) and gets the finished drawing. Same normaliser, same pure geometry,
 * same strokes — so the card in the feed, the frame in the clip and the PNG a
 * user posts are one drawing at three sizes rather than three drawings.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{type:string, data:*, note?:string}|null} chart raw, as a Memory
 *   carries it — or already normalised, or null when `opts.geometry` is given.
 * @param {{x:number,y:number,w:number,h:number}|null} box where it goes; ignored
 *   when `opts.geometry` is given.
 * @param {{palette?:object|string[], ink?:object, progress?:number,
 *          labels?:boolean|string|object, geometry?:object,
 *          panel?:number|boolean|{alpha:number,inset?:number,radius?:number}}} [opts]
 *   `geometry` short-circuits the pure layer for callers that resolved it ahead
 *   of time (the clip does, at prepare time, so no frame does arithmetic); such
 *   geometry is assumed to have been through annotateChart() already.
 *   `panel` lays the scrim rectangle down first, for a chart drawn over art.
 * @returns {object|null} the geometry that was drawn, or null if nothing was —
 *   an unknown type, an empty series or a box with no room is a no-op.
 */
export function paintChart(ctx, chart, box, opts) {
  if (!ctx) return null;
  const o = opts || {};
  const F = inkFields(o.ink);
  const g = o.geometry || chartGeometry(asNormalized(chart), box);
  if (!g || !g.type) return null;

  const raw = Number(o.progress);
  const p = o.progress == null ? 1 : clamp(isFinite(raw) ? raw : 1, 0, 1);
  const acc = accentsOf(o.palette);
  const L = labelFields(o.labels);

  ctx.save();
  ctx.textBaseline = 'alphabetic';
  ctx.globalAlpha = 1;

  if (o.panel) {
    // A scrim so the drawing survives whatever the generative art is doing
    // behind it. The inset shrinks with the figure: 30px around a 1080-wide
    // frame is a margin, around a 300px thumbnail it is the whole picture.
    const cfg = typeof o.panel === 'object' ? o.panel : null;
    const a = cfg ? cfg.alpha : (o.panel === true ? 0.55 : Number(o.panel));
    if (isFinite(a) && a > 0.001) {
      const s = Math.min(1, g.k || 1);
      const inset = cfg && cfg.inset != null ? cfg.inset : 30 * s;
      const radius = cfg && cfg.radius != null ? cfg.radius : 26 * s;
      ctx.globalAlpha = Math.min(1, a);
      ctx.fillStyle = `rgb(${F.scrim})`;
      roundRect(ctx, g.bounds.x - inset, g.bounds.y - inset,
        g.bounds.w + inset * 2, g.bounds.h + inset * 2, radius);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  // Bars are the one geometry that cannot be finished without a context to
  // measure with. The clip pays for that once, at prepare time; a caller who
  // let us build the geometry pays for it here, which is still once per draw.
  if (!o.geometry && g.type === 'bars') annotateChart(ctx, g, F);

  if (g.type === 'clock') paintClock(ctx, g, p, acc, F, L);
  else if (g.type === 'donut') paintDonut(ctx, g, p, acc, F, L);
  else if (g.type === 'bars') paintBars(ctx, g, p, acc, F, L);
  else if (g.type === 'spark') paintSpark(ctx, g, p, acc);
  else if (g.type === 'heat') paintHeat(ctx, g, p, acc);
  else if (g.type === 'cast') paintCast(ctx, g, p, acc, F, L);
  else { ctx.restore(); ctx.globalAlpha = 1; return null; }

  ctx.restore();
  ctx.globalAlpha = 1;
  return g;
}

/**
 * Reused so the 30 fps path allocates nothing per frame. Painting is
 * synchronous and non-reentrant — the cross-dissolve paints two scenes, but one
 * after the other — so one scratch object is safe and one is all there is.
 */
const FRAME_CHART_OPTS = { geometry: null, progress: 1, palette: null, ink: null, panel: 0 };

/** The middle band of one scene: the translucent panel, then the figure. */
function paintChartLayer(ctx, sc, localMs, F) {
  const g = sc.chartGeo;
  if (!g) return;
  const panel = easeOutExpo(clamp(localMs / 420, 0, 1));
  FRAME_CHART_OPTS.geometry = g;
  FRAME_CHART_OPTS.progress = clamp((localMs - CHART_DELAY) / CHART_MS, 0, 1);
  FRAME_CHART_OPTS.palette = sc.pal;
  FRAME_CHART_OPTS.ink = F;
  // The cast block is type on a bar, not a figure in a frame — it was never
  // panelled and still is not.
  FRAME_CHART_OPTS.panel = g.type === 'cast' ? 0 : panel * 0.55;
  // No `labels`: at 1080 wide the clip has room for every word the chart knows.
  // Redaction has already happened upstream, in the payload.
  paintChart(ctx, null, null, FRAME_CHART_OPTS);
}

/** Numbers land on the truth: the count-up finishes well before the scene does. */
function countText(op, localMs, deps) {
  const parsed = deps.splitNumeric ? deps.splitNumeric(op.text) : null;
  if (!parsed) return op.text;
  const dur = 900;
  const p = clamp((localMs - STAGGER_MS) / dur, 0, 1);
  if (p >= 1) return op.text;
  const dec = (parsed.text.split('.')[1] || '').replace(/\D/g, '').length;
  const thin = /[  ]/.test(parsed.text);   // U+2009 is what groupNum() uses
  const comma = parsed.text.indexOf(',') >= 0;
  let s = (parsed.num * easeOutExpo(p));
  s = dec ? s.toFixed(dec) : String(Math.round(s));
  if (thin) s = s.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  else if (comma) s = s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return parsed.pre + s + parsed.post;
}

function drawOps(ctx, sc, localMs, F, deps) {
  const ops = sc.ops || [];
  const track = 'letterSpacing' in ctx;
  for (const op of ops) {
    const e = entrance(localMs, op.g || 0);
    if (e <= 0.001) continue;
    const dy = (1 - e) * 44;
    ctx.globalAlpha = e * (op.alpha == null ? 1 : op.alpha);

    if (op.type === 'mark') {
      if (sc.markImg) ctx.drawImage(sc.markImg, op.x, op.y + dy, op.size, op.size);
      continue;
    }
    if (op.type === 'rule') {
      ctx.strokeStyle = op.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(op.x, op.y + dy); ctx.lineTo(op.x + op.w, op.y + dy); ctx.stroke();
      continue;
    }

    const [weight, size, family] = op.font;
    setFont(ctx, weight, size, family, op.italic);
    if (track) ctx.letterSpacing = op.track ? `${op.track}px` : '0px';
    ctx.fillStyle = op.fill;
    const text = op.type === 'count' ? countText(op, localMs, deps) : op.text;
    const x = op.align === 'right' ? op.rightAt - ctx.measureText(text).width : op.x;
    ctx.fillText(text, x, op.y + dy);

    if (op.type === 'count' && op.unit) {
      const w = ctx.measureText(text).width;
      const [uw, us, uf] = op.unitFont;
      setFont(ctx, uw, us, uf);
      ctx.fillStyle = op.unitFill;
      ctx.fillText(op.unit, x + w + 18, op.y + dy);
    }
  }
  if (track) ctx.letterSpacing = '0px';
  ctx.globalAlpha = 1;
}

/** One complete scene at local time `localMs`, opaque, filling the canvas. */
function paintScene(ctx, sc, localMs, F, deps) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = (sc.pal && sc.pal.bg) || F.paper;
  ctx.fillRect(0, 0, VIDEO_W, VIDEO_H);
  ctx.textBaseline = 'alphabetic';
  drawArt(ctx, sc, clamp(localMs / sc.duration, 0, 1.25));
  drawScrim(ctx, sc, F);
  paintChartLayer(ctx, sc, localMs, F);
  drawOps(ctx, sc, localMs, F, deps);
}

/**
 * The whole frame at global time `t`, including the cross-dissolve.
 * `buf` is a scratch canvas the same size, used so the incoming scene can be
 * composited at a real alpha instead of having every op multiplied by hand.
 */
export function paintFrame(ctx, plan, t, F, deps, buf) {
  const scenes = plan.scenes;
  let i = 0;
  while (i < scenes.length - 1 && t >= scenes[i].end) i++;
  const cur = scenes[i];
  const local = t - cur.start;

  const prev = i > 0 ? scenes[i - 1] : null;
  const fading = prev && local < XFADE_MS;

  if (fading && buf) {
    paintScene(ctx, prev, t - prev.start, F, deps);
    const bctx = buf.getContext('2d');
    paintScene(bctx, cur, local, F, deps);
    ctx.save();
    ctx.globalAlpha = easeInOut(clamp(local / XFADE_MS, 0, 1));
    ctx.drawImage(buf, 0, 0);
    ctx.restore();
  } else {
    paintScene(ctx, cur, local, F, deps);
  }

  if (F.grainImg) {
    ctx.save();
    ctx.globalAlpha = 0.05;
    ctx.globalCompositeOperation = 'overlay';
    ctx.drawImage(F.grainImg, 0, 0);
    ctx.restore();
  }
  return i;
}

/* ── the exporter ─────────────────────────────────────────────────────── */

/**
 * @param {object} deps browser + app bridges:
 *   { doc, win, artImage(seed,kind,w,h)->Promise<Image|null>,
 *     markImage(px)->Promise<Image|null>, paletteOf(seed), grainPattern(ctx,seed),
 *     splitNumeric(v), fonts:{display,serif}, colors:{ink0,ink1,ink2,paper,scrim,rule} }
 */
export function createExporter(deps) {
  const D = deps || {};
  const win = D.win || globalThis;
  const doc = D.doc || (win && win.document);

  const supported = () => videoSupported(win);

  function makeCanvas(w, h) {
    const c = doc.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  /** Bake the grain once. Filling a pattern over 2 Mpx every frame is not free. */
  function bakeGrain(seed) {
    try {
      const c = makeCanvas(VIDEO_W, VIDEO_H);
      const g = c.getContext('2d');
      const pat = D.grainPattern(g, seed >>> 0);
      if (!pat) return null;
      g.fillStyle = pat;
      g.fillRect(0, 0, VIDEO_W, VIDEO_H);
      return c;
    } catch (e) { return null; }
  }

  /**
   * Rasterise art + mark for every scene, up front. Returns the plan with the
   * images attached. This is the slow part (a decode per scene) and it happens
   * BEFORE the recorder starts, so no frame is ever stalled on a decode.
   */
  async function prepare(scenes, opts) {
    const o = opts || {};
    const plan = planStoryboard(scenes, o);
    const F = fields(o);
    const measure = makeCanvas(8, 8).getContext('2d');
    const markImg = await safe(D.markImage(64));

    for (let i = 0; i < plan.scenes.length; i++) {
      const sc = plan.scenes[i];
      sc.pal = D.paletteOf(sc.seed >>> 0);
      sc.img = await safe(D.artImage(sc.seed >>> 0, sc.artKind || 'onthisday', VIDEO_W, VIDEO_H));
      sc.markImg = markImg;
      sc.drift = i % 2 === 0 ? 1 : -1;
      const laid = layoutScene(measure, sc, F);
      sc.ops = laid.ops;
      // Chart geometry is resolved here, with the art, for the same reason: a
      // frame must never do arithmetic it could have done before the recorder
      // opened. `chartBox` is null when the copy left no room, and the scene
      // then plays as the text-only card it was before.
      sc.chartGeo = laid.chartBox
        ? annotateChart(measure, sc.cast
          ? castGeometry(sc.cast, laid.chartBox)
          : chartGeometry(sc.chart, laid.chartBox), F)
        : null;
      if (o.onPrepare) o.onPrepare((i + 1) / plan.scenes.length);
    }
    F.grainImg = bakeGrain((plan.scenes[0] && plan.scenes[0].seed) || 1);
    plan.F = F;
    return plan;
  }

  function fields(o) {
    const c = (o && o.colors) || {};
    const f = (o && o.fonts) || {};
    return {
      display: f.display || 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      serif: f.serif || 'Georgia, "Times New Roman", serif',
      ink0: c.ink0 || '#F4F1EC',
      ink1: c.ink1 || '#B9B4AC',
      ink2: c.ink2 || '#827D75',
      // Type set on top of a filled bar, where the page uses --ink-inv.
      inkInv: c.inkInv || '#06070A',
      paper: c.paper || '#06070A',
      scrim: c.scrim || '5,6,10',
      rule: c.rule || 'rgba(255,255,255,.18)',
      grainImg: null,
    };
  }

  const safe = (p) => Promise.resolve(p).then((v) => v, () => null);

  /**
   * Record the plan. Resolves with `{blob, mimeType, filename, duration}` or
   * `{cancelled:true}`. Never rejects for anything the caller can't fix — a
   * failure comes back as `{error}` so the UI can say so and move on.
   *
   * @param {object} plan from prepare()
   * @param {{name?:string, onProgress?:(p:number)=>void, cancelled?:()=>boolean}} [opts]
   */
  function record(plan, opts) {
    const o = opts || {};
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
      if (!supported()) return finish({ error: 'unsupported' });

      let canvas, buf, ctx, stream, rec;
      /** Hands a painted frame to the stream. No-op on the timed fallback. */
      let pushFrame = () => {};
      try {
        canvas = makeCanvas(VIDEO_W, VIDEO_H);
        buf = makeCanvas(VIDEO_W, VIDEO_H);
        ctx = canvas.getContext('2d', { alpha: false });
        const probe = win.MediaRecorder.isTypeSupported;
        const mime = typeof probe === 'function'
          ? pickCodec((m) => probe.call(win.MediaRecorder, m)) : null;
        // Manual frame mode where the browser offers it.
        //
        // `captureStream(fps)` samples whatever the compositor is painting, and
        // this canvas is deliberately never in the document. Chrome captures it
        // anyway; Safari does not — it emitted exactly one frame, so the export
        // produced a valid 0.033-second mp4 that looked like a broken button.
        //
        // `captureStream(0)` + `requestFrame()` after each paint takes the
        // compositor out of it entirely: we hand over frames ourselves, which is
        // also more honest about the fixed timeline we already keep. The timed
        // stream stays as the fallback for anything without `requestFrame`.
        stream = canvas.captureStream(0);
        const tracks = stream && typeof stream.getVideoTracks === 'function'
          ? stream.getVideoTracks() : null;
        const track0 = tracks && tracks[0];
        if (track0 && typeof track0.requestFrame === 'function') {
          pushFrame = () => { try { track0.requestFrame(); } catch (e) { /* track ended */ } };
        } else {
          try { stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* noop */ }
          stream = canvas.captureStream(plan.fps || VIDEO_FPS);
        }
        const cfg = { videoBitsPerSecond: 9_000_000 };
        if (mime) cfg.mimeType = mime;
        rec = new win.MediaRecorder(stream, cfg);
      } catch (e) {
        return finish({ error: (e && e.message) || 'recorder failed' });
      }

      const chunks = [];
      let stopped = false;
      const F = plan.F || fields(o);

      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onerror = () => { stopped = true; try { rec.stop(); } catch (e) { /* already dead */ } };
      rec.onstop = () => {
        try { stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* noop */ }
        if (o.cancelled && o.cancelled()) return finish({ cancelled: true });
        const type = (rec.mimeType || (chunks[0] && chunks[0].type) || 'video/webm').split(';')[0];
        const blob = new win.Blob(chunks, { type: rec.mimeType || type });
        if (!blob.size) return finish({ error: 'empty recording' });
        finish({
          blob,
          mimeType: rec.mimeType || type,
          filename: videoFilename(o.name, rec.mimeType || type),
          duration: plan.duration,
        });
      };

      // Paint frame zero before the recorder opens, so the very first sampled
      // frame is already the intro and not a blank canvas.
      paintFrame(ctx, plan, 0, F, D, buf);
      pushFrame();
      try { rec.start(200); } catch (e) { return finish({ error: (e && e.message) || 'start failed' }); }

      // An explicit elapsed clock. rAF cadence is never assumed — a 120 Hz
      // display and a throttled background tab must produce the same 15 seconds.
      const t0 = (win.performance || Date).now();
      const total = plan.duration;
      const TAIL = 140;               // hold the last frame so it is definitely sampled
      const FRAME_MS = Math.max(1, Math.round(1000 / (plan.fps || VIDEO_FPS)));
      let nextFrameAt = 0;            // when the next frame is due, on the same clock
      let painted = 0;                // frames actually handed over, for the caller
      let tailPainted = false;        // the held final frame, drawn once

      // Two drivers, whichever fires first.
      //
      // requestAnimationFrame alone was the whole loop, and a hidden tab does not merely
      // throttle it — Chrome stops delivering it entirely. Switching tabs during the fifteen
      // seconds therefore left the export with no frames, no `rec.stop()`, no rejection and no
      // timeout: the promise stayed pending and the progress bar sat at "Recording" forever.
      // The timer keeps the clock moving (coarsely, ~1 s, when backgrounded) so the recording
      // always reaches its end and always resolves.
      let rafId = 0;
      let timerId = 0;
      const clearPending = () => {
        if (rafId && typeof win.cancelAnimationFrame === 'function') win.cancelAnimationFrame(rafId);
        if (timerId) win.clearTimeout(timerId);
        rafId = 0;
        timerId = 0;
      };
      const schedule = () => {
        if (typeof win.requestAnimationFrame === 'function') rafId = win.requestAnimationFrame(tick);
        timerId = win.setTimeout(tick, FRAME_MS);
      };

      function tick() {
        clearPending();
        if (stopped) return;
        if (o.cancelled && o.cancelled()) {
          stopped = true;
          try { rec.stop(); } catch (e) { finish({ cancelled: true }); }
          return;
        }
        const t = (win.performance || Date).now() - t0;

        // Paint on the frame grid, not on every wake-up.
        //
        // The loop arms rAF and a FRAME_MS timer together and takes whichever
        // lands first, which is always rAF: every 16.7 ms on a 60 Hz screen and
        // every 8 ms on an iPhone's 120 Hz one. So a clip declared at 30 fps was
        // handing the encoder two to four times that many frames. It kept up
        // until it didn't, and the frames it dropped it dropped unevenly — which
        // is what "very harsh frame-by-frame animation" in the finished video
        // actually was. `plan.fps` was decorative.
        //
        // Waking often is still right: it is how a throttled tab is caught up
        // and how the clock stays honest. Only the painting is rationed.
        // The tail exists so the recorder definitely samples the final frame —
        // one held frame, not a burst. Painting every wake-up through it added
        // seventeen frames to a three-second clip on a 120 Hz screen.
        const due = nextFrameAt <= t || (t >= total && !tailPainted);
        if (t >= total) tailPainted = true;
        if (due) {
          // Advance one frame at a time so the rate stays at the target, and
          // resync only when a stall has put us more than a frame behind —
          // otherwise every hiccup would grant an extra frame and the clip
          // would drift above its declared fps.
          nextFrameAt += FRAME_MS;
          if (nextFrameAt < t - FRAME_MS) nextFrameAt = t + FRAME_MS;
          paintFrame(ctx, plan, Math.min(t, total - 1), F, D, buf);
          pushFrame();
          painted++;
        }
        if (o.onProgress) { try { o.onProgress(clamp(t / total, 0, 1)); } catch (e) { /* noop */ } }
        if (t >= total + TAIL) {
          stopped = true;
          try { rec.stop(); } catch (e) { finish({ error: 'stop failed' }); }
          return;
        }
        schedule();
      }

      schedule();
    });
  }

  // `charts` is how app.js reaches the pure layer. render.js inlines this file
  // as an IIFE that only hands back a fixed list of names, so the exporter's
  // return value is the one channel that does not require touching render.js —
  // and it keeps the page's SVG figures reading the same normalised data as the
  // clip's canvas ones.
  return { supported, prepare, record, plan: planStoryboard, charts: CHART_API };
}

/**
 * The chart layer as one object, for surfaces that reach this file through the
 * exporter rather than through an import. `paint` is the whole point of it: any
 * canvas in the page — the share card included — draws a codepend figure by
 * calling this and nothing else.
 */
export const CHART_API = {
  normalize: normalizeChart,
  geometry: chartGeometry,
  annotate: annotateChart,
  paint: paintChart,
  labels: CHART_LABELS,
  ink: CHART_INK,
  accents: CHART_ACCENTS,
  cast: castFromTimeline,
  castHeadline,
  agentNames: AGENT_NAMES,
  heatOps: HEAT_OPS,
};

export default createExporter;
