/**
 * The twelve archetypes (catalog §5).
 *
 * One per person. Selection is a weighted dot product over the sixteen features
 * computed in src/stats.js, minus penalties. Penalties are what keep these from
 * collapsing into mush: The Patient Architect *must* be penalized for
 * interrupting; The Ctrl-C Cowboy *must* be penalized for deliberation.
 */

import { hash32, fmtPct, fmtNum, fmtDuration, median, spell } from './_util.js';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * @typedef {{name:string, weights:Object<string,number>, penalties:Object<string,number>,
 *            tagline:(d:any)=>string, blurb:(d:any)=>string}} Archetype
 */

/** @type {Archetype[]} Order is the tiebreak order. */
export const ARCHETYPES = [
  {
    name: 'The Midnight Interrogator',
    weights: { night: 1.0, marathon: 0.3, terse: 0.2 },
    penalties: { dawn: 0.8 },
    tagline: () => 'The best questions arrive after midnight. So do you.',
    blurb: (d) =>
      `${d.nightPct} of your conversations start after the day is officially over. The latest was ` +
      `${d.latestTime}. You’re not avoiding sleep. You’re just not finished.`,
  },
  {
    name: 'The Ctrl-C Cowboy',
    weights: { interrupt: 1.0, terse: 0.4 },
    penalties: { deliberate: 0.7, verbose: 0.5 },
    tagline: () => 'Fastest ESC in the west.',
    blurb: (d) =>
      `You cut it off every ${d.perN} messages${d.medianSec ? `, usually within ${d.medianSec} seconds` : ''}. ` +
      `You’d rather steer than read. It has never finished a thought in your presence and it has ` +
      `never held it against you.`,
  },
  {
    name: 'The Patient Architect',
    weights: { verbose: 1.0, deliberate: 0.6, focus: 0.3 },
    penalties: { interrupt: 1.0, terse: 0.8 },
    tagline: () => 'You brief it like a contractor, and you’ve been burned before.',
    blurb: (d) =>
      `Your median prompt is ${d.medianWords} words. You interrupt it ${d.interruptPct} of the time — ` +
      `almost never. You write the spec, then you let it work.`,
  },
  {
    name: 'The Two-Word Tyrant',
    weights: { terse: 1.0, tooling: 0.5 },
    penalties: { verbose: 1.0, polite: 0.4 },
    tagline: (d) => d.terseExamples || 'Three words, and it moves mountains.',
    blurb: (d) =>
      `${d.tersePct} of your prompts are under five words, and they move mountains: ${d.tools} tool ` +
      `calls off a median of ${d.medianWords} words. You’ve optimized language down to the bone.`,
  },
  {
    name: 'The Marathoner',
    weights: { marathon: 1.0, streak: 0.3 },
    penalties: { breadth: 0.4 },
    tagline: () => 'Your median session outlasts a feature film.',
    blurb: (d) =>
      `Longest: ${d.longestDuration} in one sitting, ending at ${d.endTime}. You don’t work in ` +
      `sprints. You work until it’s done or until the sun comes up.`,
  },
  {
    name: 'The Serial Monogamist',
    weights: { focus: 1.0, streak: 0.5 },
    penalties: { breadth: 1.0, ghosting: 0.6 },
    tagline: () => 'One repo. All of it.',
    blurb: (d) =>
      `${d.focusPct} of everything you have ever said went to ${d.topProject}. ${d.days} days on one ` +
      `thing. Some people call that a rut. It’s also how anything gets finished.`,
  },
  {
    name: 'The Sampler',
    weights: { breadth: 1.0, ghosting: 0.8 },
    penalties: { focus: 1.0, streak: 0.4 },
    tagline: (d) => `${d.projects} projects. ${d.ghosts} of them you visited once and never again.`,
    blurb: (d) =>
      `You start things. That’s the skill. ${d.ghostList} are all still sitting there with the ` +
      `lights on.`,
  },
  {
    name: 'The Weekend Resident',
    weights: { weekend: 1.0, consistency: 0.3 },
    penalties: { dawn: 0.3 },
    tagline: () => 'Saturday is a workday with better lighting.',
    blurb: (d) =>
      `${d.weekendPct} of your messages went out on a Saturday or Sunday. Your best day of the week ` +
      `is ${d.bestWeekday}. Whatever this is, it isn’t only a job.`,
  },
  {
    name: 'The Dawn Patrol',
    weights: { dawn: 1.0, consistency: 0.5 },
    penalties: { night: 1.0 },
    tagline: () => 'You get to it before the world does.',
    blurb: (d) =>
      `${d.dawnPct} of your messages are sent before 9 AM, median first message at ${d.medianFirst}. ` +
      `It’s awake whenever you are. That has never been the constraint.`,
  },
  {
    name: 'The Swarm Lord',
    weights: { swarm: 1.0, tooling: 0.4, breadth: 0.2 },
    penalties: { verbose: 0.3 },
    tagline: () => 'You don’t use an agent. You run a department.',
    // The catalog's copy says "running at once", which is only true when we
    // have per-subagent timestamps. Codex gives per-session counts only, so the
    // phrasing follows the evidence — a number we can't stand behind would
    // undermine every other number on the page.
    blurb: (d) =>
      `${d.subagents} sub-agents spawned, ${d.peak} of them ${d.peakExact ? 'running at once' : 'in a single sitting'} on ${d.peakDate}. You ` +
      `stopped doing the work and started assigning it, and nobody noticed the transition.`,
  },
  {
    name: 'The Considerate',
    weights: { polite: 1.0, verbose: 0.3 },
    penalties: { interrupt: 0.8 },
    tagline: () => 'You say please to a program.',
    blurb: (d) =>
      `${d.politeCount} times. ${d.politePct} of your messages. You know it can’t tell. Don’t let ` +
      `anyone talk you out of it.`,
  },
  {
    name: 'The Everyday Companion',
    weights: { consistency: 1.0, streak: 0.6 },
    penalties: { night: 0.3, interrupt: 0.3 },
    tagline: () => 'You just show up.',
    blurb: (d) =>
      `${d.activeDays} days out of ${d.spanDays}. No all-nighters, no drama, no ${d.gapDays}-day ` +
      `disappearances. ${d.sessions} sessions of steady, unglamorous, actual work. This is the one ` +
      `that compounds.`,
  },
];

const ELIGIBLE = 0.45;

/**
 * Score every archetype and pick one.
 * @param {object} ctx
 * @returns {{name:string, tagline:string, blurb:string, seed:number, scores:Array}}
 */
export function pickArchetype(ctx) {
  const f = ctx.features;
  const scored = ARCHETYPES.map((a, i) => {
    let s = 0;
    for (const [k, w] of Object.entries(a.weights)) s += w * (f[k] || 0);
    for (const [k, p] of Object.entries(a.penalties)) s -= p * (f[k] || 0);
    return { i, a, score: s };
  });
  // argmax; ties go to the lower index
  let best = null;
  for (const s of scored) {
    if (!best || s.score > best.score + 1e-9) best = s;
  }
  const fallback = scored[scored.length - 1];
  const chosen = best && best.score >= ELIGIBLE ? best : fallback;

  const d = archetypeData(ctx);
  const name = chosen.a.name;
  return {
    name,
    tagline: chosen.a.tagline(d),
    blurb: chosen.a.blurb(d),
    seed: hash32(name + '|' + ctx.firstSeen),
    scores: scored
      .map((s) => ({ name: s.a.name, score: Math.round(s.score * 1000) / 1000 }))
      .sort((x, y) => y.score - x.score || x.name.localeCompare(y.name, 'en')),
  };
}

/** Everything the twelve blurbs can ask for. */
export function archetypeData(ctx) {
  const tzh = ctx.tzh;
  const n = ctx.humanTurns.length || 1;
  const durs = ctx.interruptsWithDuration.map((i) => i.durationMs / 1000);
  const longest = ctx.mainSessions.reduce(
    (a, s) => (!a || s.durationMs > a.durationMs ? s : a), null,
  );
  const ghostNames = ctx.projectList.filter((p) => p.sessions === 1).map((p) => p.name);
  const swarm = peakSwarm(ctx);
  const latestNight = latestNightTurn(ctx);
  const bestWd = ctx.weekdayHist.indexOf(Math.max(...ctx.weekdayHist));

  return {
    nightPct: fmtPct(ctx.nightTurns.length / n),
    latestTime: latestNight ? tzh.time(latestNight.ts) : '—',
    perN: Math.max(1, Math.round(n / Math.max(1, ctx.interrupts.length))),
    medianSec: durs.length ? Math.round(median(durs)) : 0,
    medianWords: Math.round(median(ctx.turnWordCounts)) || 1,
    interruptPct: fmtPct(ctx.interrupts.length / n),
    tersePct: fmtPct(ctx.terseTurns / n),
    terseExamples: terseExamples(ctx),
    tools: fmtNum(ctx.toolCalls),
    longestDuration: longest ? fmtDuration(longest.durationMs) : '—',
    endTime: longest ? tzh.time(longest.endedAt) : '—',
    focusPct: fmtPct(ctx.stats.topProjectShare),
    topProject: ctx.stats.topProject || 'one project',
    days: ctx.daysSinceFirst || ctx.spanDays,
    projects: ctx.projectList.length,
    ghosts: ghostNames.length,
    ghostList: listOf(ghostNames.slice(0, 3)),
    weekendPct: fmtPct(ctx.weekendTurns / n),
    bestWeekday: WEEKDAYS[bestWd < 0 ? 1 : bestWd],
    dawnPct: fmtPct(ctx.dawnTurns / n),
    medianFirst: medianFirstTime(ctx),
    subagents: fmtNum(ctx.subagents),
    peak: swarm.peak,
    peakExact: swarm.exact,
    peakDate: swarm.peakTs ? tzh.date(swarm.peakTs) : '—',
    politeCount: spell(ctx.politeTurns),
    politePct: fmtPct(ctx.politeTurns / n),
    activeDays: ctx.activeDays,
    spanDays: ctx.spanDays,
    gapDays: ctx.streak.longestGap || 1,
    sessions: ctx.mainSessions.length,
  };
}

/**
 * Three of the shortest things they actually typed, quoted back at them.
 *
 * Beats a hardcoded example because it lands in whatever language they think in,
 * and a Two-Word Tyrant's own two words are funnier than any we could invent.
 * Returns null under `paranoid` (no quotes leave the machine) or when there
 * aren't enough distinct terse prompts to make a rhythm.
 *
 * @param {any} ctx
 * @returns {string|null}
 */
function terseExamples(ctx) {
  if (ctx.redactLevel === 'paranoid') return null;
  const seen = new Set();
  const picks = [];
  // Shortest first, oldest first as the tiebreak — deterministic, no sort instability.
  const cands = ctx.humanTurns
    .filter((t) => t.wordCount > 0 && t.wordCount <= 4 && !t.redacted)
    .sort((a, b) => a.wordCount - b.wordCount || a.ts - b.ts);
  for (const t of cands) {
    const s = t.redactedText.trim().replace(/\s+/g, ' ');
    if (s.length > 28 || /[<>{}[\]|`/\\]/.test(s)) continue; // no paths, code or markup
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    picks.push(s);
    if (picks.length === 3) break;
  }
  return picks.length === 3 ? picks.map((s) => `«${s}»`).join('. ') + '.' : null;
}

function listOf(names) {
  if (!names.length) return 'They';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function medianFirstTime(ctx) {
  const mins = ctx.firstLastByDay.map((d) => d.first);
  if (!mins.length) return '—';
  const m = Math.round(median(mins));
  const h = Math.floor(m / 60) % 24;
  const mm = m % 60;
  const ap = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(mm).padStart(2, '0')} ${ap}`;
}

function latestNightTurn(ctx) {
  // "Latest" means latest wall-clock time inside [0,5) — 3:47 beats 1:10.
  let best = null;
  for (const t of ctx.nightTurns) {
    const p = ctx.tzh.parts(t.ts);
    const mins = p.h * 60 + p.mi;
    if (!best || mins > best.mins || (mins === best.mins && hash32(t.sessionId + ':' + t.ts) > best.tie)) {
      best = { ...t, mins, tie: hash32(t.sessionId + ':' + t.ts) };
    }
  }
  return best;
}

/**
 * Peak sub-agent count.
 *
 * Claude sidechain sessions carry real timestamps, so concurrency inside a
 * 10-minute window is measurable and `exact` is true. Codex reports only a
 * per-session total, so the honest fallback is "the most in one sitting" —
 * flagged with `exact: false` so the copy can say what it actually means.
 */
export function peakSwarm(ctx) {
  const side = ctx.sessions
    .filter((s) => s.isSidechain)
    .map((s) => s.startedAt)
    .sort((a, b) => a - b);
  let peak = 0;
  let peakTs = null;
  for (let i = 0; i < side.length; i++) {
    let c = 0;
    for (let j = i; j < side.length && side[j] - side[i] <= 600000; j++) c++;
    if (c > peak) { peak = c; peakTs = side[i]; }
  }
  if (peak >= 2) return { peak, peakTs, exact: true };

  for (const s of ctx.sessions) {
    if (s.subagents > peak) { peak = s.subagents; peakTs = s.startedAt; }
  }
  return {
    peak: peak || 1,
    peakTs: peakTs || (ctx.mainSessions[0] && ctx.mainSessions[0].startedAt) || null,
    exact: false,
  };
}
