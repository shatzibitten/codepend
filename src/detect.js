/**
 * codepend — memory construction.
 *
 * `buildMemories(sessions, opts)` turns the Session[] produced by src/scan.js
 * into the thing the front-end renders: a ranked feed of Memory cards, a
 * Profile, flat Stats, and a day-by-day timeline.
 *
 * Fully deterministic. No Math.random, no Date.now below this boundary — the
 * only clock is `opts.now`. Two runs over the same corpus produce byte-identical
 * output, and test/detect.test.mjs proves it.
 */

import { buildStats } from './stats.js';
import { hash32, fmtNum, makeMemory } from './detectors/_util.js';
import { pickArchetype } from './detectors/_archetypes.js';

import onThisDayGroup from './detectors/onthisday.js';
import quoteGroup from './detectors/quotes.js';
import catchphraseGroup from './detectors/catchphrase.js';
import scaleGroup from './detectors/scale.js';
import rhythmGroup from './detectors/rhythm.js';
import behaviorGroup from './detectors/behavior.js';
import thingsGroup from './detectors/things.js';
import seedlingGroup from './detectors/seedlings.js';
import archetypeGroup from './detectors/archetype.js';

export { hash32 };

const MIN_FEED = 12;
const MAX_FEED = 40;
const WEIGHT_FLOOR = 35;

const [onThisDay, ghostProject, theReunion, theRageQuit, rediscovered] = onThisDayGroup;
const [firstWords, theLongNight, theApology, theShortestWord, dejaVu] = quoteGroup;
const [catchphraseYours, catchphraseIts] = catchphraseGroup;
const [theAnniversary, theRatio, theMarathon, peakDay, theBill] = scaleGroup;
const [deepWorkClock, theHeatmap, theStreak, weekendWarrior] = rhythmGroup;
const [theInterruption, thePoliteness, theCompaction, twoTongues, longestThought, theSwarm] = behaviorGroup;
const [spiritTool, projectConstellation, modelLoyalty, fileMostTouched] = thingsGroup;
const [archetypeCard, shareCard] = archetypeGroup;

/**
 * Detector run order matters in exactly one way: `rediscovered` surfaces
 * sessions nothing else claimed, so it runs last.
 */
export const DETECTORS = [
  onThisDay, firstWords, theAnniversary, theRatio, theMarathon,
  catchphraseYours, spiritTool, deepWorkClock, theBill, peakDay,
  projectConstellation, theHeatmap, modelLoyalty,
  theStreak, theLongNight, theInterruption, catchphraseIts, thePoliteness,
  weekendWarrior, fileMostTouched, longestThought, theCompaction, twoTongues,
  ghostProject, theReunion, theRageQuit, theSwarm, theApology, theShortestWord,
  dejaVu, rediscovered,
  archetypeCard,
];

/** Held back until the feed would otherwise fall below MIN_FEED (§4.2). */
export const SEEDLINGS = seedlingGroup;

/**
 * @param {Array<object>} sessions Session[] from src/scan.js
 * @param {{now?:number, tz?:string, redact?:(s:string)=>string, redactLevel?:string}} [opts]
 * @returns {{profile:object, memories:object[], stats:object, timeline:object[],
 *            wrapped:string[], archive:object[]}}
 */
export function buildMemories(sessions, opts = {}) {
  const ctx = buildStats(sessions || [], {
    now: Number.isFinite(opts.now) ? opts.now : Date.now(),
    tz: opts.tz || 'UTC',
    redact: opts.redact || ((s) => s),
    redactLevel: opts.redactLevel,
    idleGapMs: opts.idleGapMs,
  });

  ctx.archetype = pickArchetype(ctx);

  const main = runAll(DETECTORS, ctx);
  const seedlings = runAll(SEEDLINGS, ctx);
  const share = runAll([shareCard], ctx)[0] || null;

  // Dedupe by id: `the-verb` can arrive from both catchphrase-yours' fallback
  // and the seedling pool, with an identical id, which is exactly what we want.
  const byId = new Map();
  for (const m of [...main, ...seedlings]) if (!byId.has(m.id)) byId.set(m.id, m);
  const mainPool = main.filter((m) => byId.get(m.id) === m);
  const seedPool = seedlings.filter((m) => byId.get(m.id) === m);

  const feed = rankFeed(mainPool, seedPool, ctx, share);
  const all = [...byId.values()].sort(
    (a, b) => (b.date || 0) - (a.date || 0) || b.weight - a.weight || hash32(a.id) - hash32(b.id),
  );
  const wrapped = buildWrapped(feed, all, share);

  const profile = {
    archetype: {
      name: ctx.archetype.name,
      tagline: ctx.archetype.tagline,
      blurb: ctx.archetype.blurb,
      seed: ctx.archetype.seed,
    },
    firstSeen: ctx.firstSeen,
    lastSeen: ctx.lastSeen,
    activeDays: ctx.activeDays,
    totalSessions: ctx.mainSessions.length,
    totalHours: Math.round(ctx.totalHours * 10) / 10,
    topProject: ctx.stats.topProject,
    topModel: ctx.stats.topModel,
    spiritTool: ctx.stats.spiritTool,
  };

  return {
    profile,
    memories: feed.map(clean),
    stats: ctx.stats,
    timeline: ctx.timeline,
    wrapped,
    archive: all.map(clean),
  };
}

/* ------------------------------------------------------------------ running */

function runAll(detectors, ctx) {
  const out = [];
  for (const d of detectors) {
    let got;
    try {
      got = d.run(ctx) || [];
    } catch (err) {
      // No detector may take the page down. A missing card is invisible; a
      // stack trace is a bug report from someone who wanted to share a link.
      got = [];
      if (process.env.CODEPEND_DEBUG) console.error(`[codepend] detector ${d.slug} failed:`, err);
    }
    for (const m of got) if (m && m.id) out.push(m);
  }
  return out;
}

/** Strip the internal ranking fields before the payload leaves this module. */
function clean(m) {
  const { _mag, _base, _ring, ...rest } = m;
  return rest;
}

/* ------------------------------------------------------------ feed ranking */

/**
 * §7 — greedy selection with rhythm penalties. The goal is that you never see
 * three stat cards in a row, and you are never more than five cards from a
 * quote. That is the whole difference between a feed and a dashboard.
 */
function rankFeed(mainPool, seedPool, ctx, share) {
  const pool = mainPool
    .filter((m) => !m.tags.includes('last'))
    .sort((a, b) => b.weight - a.weight || hash32(a.id) - hash32(b.id));

  const feed = [];
  const used = new Set();
  const take = (m) => {
    if (!m || used.has(m.id)) return false;
    used.add(m.id);
    feed.push(m);
    return true;
  };

  // Slot 1 — on-this-day, or first-words when nothing had an anniversary.
  const otd = pool.find((m) => m.type === 'on-this-day');
  take(otd || pool.find((m) => m.type === 'first-words'));

  // Slot 2 — the highest-weight quote not already used.
  take(pool.find((m) => m.kind === 'quote' && !used.has(m.id)));

  const archetypeCardMem = pool.find((m) => m.type === 'archetype');
  let promoted = false;

  while (feed.length < MAX_FEED) {
    const slot = feed.length + 1;

    // Slot 5, or 6 when slot 5's neighbours are both charts.
    if (archetypeCardMem && !used.has(archetypeCardMem.id)) {
      const prevIsChart = feed.length >= 1 && feed[feed.length - 1].kind === 'chart';
      if (slot === 5 && !prevIsChart) { take(archetypeCardMem); continue; }
      if (slot === 6) { take(archetypeCardMem); continue; }
    }

    // Three passes: all of §7.3, then the two rules that separate a feed from a
    // dashboard. There is no third pass — we would rather end the feed than
    // print three stat cards in a row.
    let candidates = pool.filter((m) => !used.has(m.id) && hardOK(m, feed));
    if (!candidates.length) candidates = pool.filter((m) => !used.has(m.id) && softOK(m, feed));

    // Never more than five cards from a quote.
    const recentQuote = feed.slice(-5).some((m) => m.kind === 'quote');
    if (!recentQuote && feed.length >= 5) {
      const quotes = candidates.filter((m) => m.kind === 'quote');
      if (quotes.length) candidates = quotes;
    }

    if (!candidates.length) {
      if (!promoted && feed.length < MIN_FEED) {
        promoted = true;
        for (const s of seedPool) if (!used.has(s.id)) pool.push(s);
        pool.sort((a, b) => b.weight - a.weight || hash32(a.id) - hash32(b.id));
        continue;
      }
      break;
    }

    let best = null;
    let bestScore = -Infinity;
    for (const m of candidates) {
      const sc = effective(m, feed, slot);
      const tie = hash32(m.id);
      if (sc > bestScore || (sc === bestScore && best && tie > hash32(best.id))) {
        best = m;
        bestScore = sc;
      }
    }

    // The tail: stop on weak cards, but never below the floor.
    if (best.weight < WEIGHT_FLOOR && feed.length >= MIN_FEED) break;
    if (best.weight < WEIGHT_FLOOR && !promoted && feed.length < MIN_FEED) {
      promoted = true;
      for (const s of seedPool) if (!used.has(s.id)) pool.push(s);
      pool.sort((a, b) => b.weight - a.weight || hash32(a.id) - hash32(b.id));
    }
    take(best);
  }

  // Promote seedlings if we still came up short. The rhythm rules still apply —
  // a short feed is fine, a dashboard is not.
  if (feed.length < MIN_FEED) {
    for (const s of [...seedPool, ...mainPool]) {
      if (feed.length >= MIN_FEED) break;
      if (used.has(s.id) || s.tags.includes('last')) continue;
      if (softOK(s, feed)) take(s);
    }
  }

  // An honest, non-apologetic close when there simply isn't more to say.
  if (feed.length < MIN_FEED) {
    feed.push(endCard(ctx));
  }
  if (share) feed.push(share);
  return feed;
}

function effective(m, feed, slot) {
  const prev = feed[feed.length - 1] || null;
  const prev2 = feed[feed.length - 2] || null;
  let e = m.weight;
  if (prev && m.type === prev.type) e -= 34;
  if (prev && m.kind === prev.kind) e -= 20;
  if (prev2 && m.kind === prev2.kind) e -= 12;
  if (m.project && prev && prev2 && m.project === prev.project && m.project === prev2.project) e -= 14;
  if (prev && prev2 && m.agent === prev.agent && m.agent === prev2.agent && m.agent !== 'both') e -= 8;
  const last4 = feed.slice(-4);
  if (!last4.some((x) => x.kind === m.kind)) e += 10;
  if (slot % 7 === 0 && (m.kind === 'chart' || m.kind === 'quote')) e += 14; // the breath
  return e;
}

/** §7.3 hard constraints, applied as a filter after scoring. */
function hardOK(m, feed, used) {
  const prev = feed[feed.length - 1];
  const prev2 = feed[feed.length - 2];
  if (prev && prev.type === m.type) return false;
  if (m.kind === 'stat' && prev && prev2 && prev.kind === 'stat' && prev2.kind === 'stat') return false;
  if (m.kind === 'chart' && feed.slice(-4).some((x) => x.kind === 'chart')) return false;
  if (m.kind === 'stat' && m._mag < 0.85 && feed.length < 7) return false;
  let sameType = 0;
  for (const x of feed) if (x.type === m.type) sameType++;
  if (sameType >= 2) return false;
  if (m.project) {
    let sameProject = 0;
    for (const x of feed.slice(-7)) if (x.project === m.project) sameProject++;
    if (sameProject >= 3) return false;
  }
  return true;
}

/**
 * Relaxed pass. Keeps the rules that separate a feed from a dashboard, plus the
 * per-type cap — three `on-this-day` cards in one scroll reads as a bug.
 */
function softOK(m, feed) {
  const prev = feed[feed.length - 1];
  const prev2 = feed[feed.length - 2];
  if (prev && prev.type === m.type) return false;
  if (m.kind === 'stat' && prev && prev2 && prev.kind === 'stat' && prev2.kind === 'stat') return false;
  let sameType = 0;
  for (const x of feed) if (x.type === m.type) sameType++;
  return sameType < 2;
}

function endCard(ctx) {
  return makeMemory(ctx, {
    type: 'end-card',
    kind: 'award',
    key: String(ctx.humanTurns.length),
    date: null,
    base: 30,
    magnitude: 1,
    eyebrow: 'THAT’S EVERYTHING — FOR NOW',
    eyebrows: ['THAT’S EVERYTHING — FOR NOW'],
    blocks: [{
      title: `${fmtNum(ctx.humanTurns.length)} messages. It’s a start.`,
      body: 'codepend reads more into your history every time you run it. Come back in a week and this page won’t look like this.',
    }],
    agent: 'both',
    tags: ['end'],
    shareable: false,
    ring: 'A',
  });
}

/* ----------------------------------------------------------------- wrapped */

/**
 * §6 — the ten-card story. Emotional order, not statistical order. Each slot
 * names its detector; if that detector didn't fire, the understudy takes it.
 * The story never has a hole in it.
 */
const WRAPPED_SLOTS = [
  ['the-anniversary', 'first-day', 'peak-day'],
  ['first-words', 'the-verb', 'catchphrase-yours'],
  ['the-ratio', 'the-bill', 'prompt-length'],
  ['deep-work-clock', 'the-heatmap', 'session-cadence'],
  ['catchphrase-yours', 'the-shortest-word', 'the-interruption', 'the-verb'],
  ['the-interruption', 'the-compaction', 'the-politeness', 'question-rate'],
  ['the-long-night', 'the-apology', 'on-this-day', 'rediscovered'],
  ['the-bill', 'the-anniversary', 'the-streak', 'tool-spread'],
  ['archetype'],
  ['share-card'],
];

function buildWrapped(feed, all, share) {
  const byType = new Map();
  for (const m of [...feed, ...all, ...(share ? [share] : [])]) {
    if (!byType.has(m.type)) byType.set(m.type, m);
  }
  const usedTypes = new Set();
  const out = [];
  for (const chain of WRAPPED_SLOTS) {
    let chosen = null;
    for (const type of chain) {
      const m = byType.get(type);
      if (m && !usedTypes.has(type)) { chosen = m; break; }
    }
    if (!chosen) {
      // Last resort: the strongest card nobody has used yet, so no slot is empty.
      chosen = [...byType.values()]
        .filter((m) => !usedTypes.has(m.type) && m.type !== 'end-card')
        .sort((a, b) => b.weight - a.weight || hash32(a.id) - hash32(b.id))[0] || null;
    }
    if (!chosen) continue;
    usedTypes.add(chosen.type);
    out.push(chosen.id);
  }
  return out;
}

export default buildMemories;
