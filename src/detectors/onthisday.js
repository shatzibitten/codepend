/**
 * Date-anchored memories: the ones that feel like Photos surfacing a Tuesday.
 *
 * on-this-day · rediscovered · ghost-project · the-reunion · the-rage-quit
 */

import {
  quoteOf, bestQuote, quoteScore, hash32, fmtDuration, fmtNum, fmtGap,
  relDay, truncate, flatten, clamp01, plural,
} from './_util.js';
import { rankedMemory, bestBlock } from './_rank.js';

const DAY = 86400000;

/**
 * The turns a thread saw on the day the card is about. Threads outlive their
 * first afternoon, so any card that names a date must quote from that date.
 * @returns {Array<object>} that day's turns, or all of them if none match
 */
function turnsOnDayOf(ctx, info, ts) {
  if (!info) return [];
  const idx = ctx.tzh.dayIndex(ts);
  const same = info.turns.filter((t) => ctx.tzh.dayIndex(t.ts) === idx);
  return same.length ? same : info.turns;
}

/** Active time a thread spent on one particular day, from its sittings. */
function durationOnDayOf(ctx, sessionId, ts) {
  const idx = ctx.tzh.dayIndex(ts);
  let ms = 0;
  for (const sit of ctx.sittingsByDay.get(idx) || []) {
    if (sit.sessionId === sessionId) ms += sit.durationMs;
  }
  return ms;
}

/* ------------------------------------------------------------ on-this-day */

const BANDS = [
  {
    key: 'year',
    test: (age) => age >= 363 && (age % 365 <= 2 || age % 365 >= 363),
    eyebrow: (age) => {
      const n = Math.max(1, Math.round(age / 365));
      return `${n} YEAR${n === 1 ? '' : 'S'} AGO TODAY`;
    },
    recency: 1.3,
  },
  { key: 'half', test: (age) => age >= 180 && age <= 187, eyebrow: () => 'SIX MONTHS AGO', recency: 1.3 },
  {
    key: 'month',
    test: (age) => age >= 30 && age % 30 <= 1,
    eyebrow: (age) => {
      const n = Math.max(1, Math.round(age / 30));
      return `${n} MONTH${n === 1 ? '' : 'S'} AGO TODAY`;
    },
    recency: 1.0,
  },
  {
    key: 'week',
    test: (age) => age >= 14 && age % 7 === 0,
    eyebrow: (age) => {
      const n = Math.round(age / 7);
      return `${n} WEEK${n === 1 ? '' : 'S'} AGO TODAY`;
    },
    recency: 1.0,
  },
  { key: 'recent', test: (age) => age >= 2 && age <= 13, eyebrow: (age) => `${age} DAYS AGO`, recency: 1.15 },
  { key: 'origin', test: () => false, eyebrow: () => 'TODAY, AND ALSO YOUR FIRST DAY', recency: 1.15 },
];

/**
 * "On this day" is about a DAY, not a thread.
 *
 * This used to anchor on a Session, which is wrong here: a Codex thread is a
 * long-lived object (36 % of them span a day or more; the longest covers 31
 * days). Anchoring on the thread produced cards headlined "1 MONTH AGO TODAY"
 * whose pull-quote was typed a month later, with an interruption count and a
 * duration summed over three weeks. Everything below is scoped to the day in
 * the eyebrow, so the card and its quote describe the same afternoon.
 */
export const onThisDay = {
  slug: 'on-this-day',
  kind: 'onthisday',
  run(ctx) {
    const today = ctx.tzh.dayIndex(ctx.now);
    const firstDay = ctx.tzh.dayIndex(ctx.firstSeen);
    const isNew = today - firstDay < 3;

    const cands = [];
    for (const idx of ctx.activeIdxs) {
      const turns = ctx.turnsByDay.get(idx) || [];
      if (!turns.length) continue;
      const age = today - idx;
      let band = BANDS.find((b) => b.test(age));
      if (!band && age < 2 && idx === firstDay) band = BANDS[BANDS.length - 1]; // origin
      if (!band) continue;

      const day = dayFacts(ctx, idx, turns);
      cands.push({ day, band, age, score: turns.length * Math.log(1 + day.durationMs) });
    }
    if (!cands.length) return [];

    const rank = (b) => BANDS.findIndex((x) => x.key === b.key);
    cands.sort(
      (a, b) => rank(a.band) - rank(b.band) || b.score - a.score || hash32(String(b.day.idx)) - hash32(String(a.day.idx)),
    );

    const maxScore = Math.max(...cands.map((c) => c.score)) || 1;
    const out = [];
    const seenProjects = new Set();
    const seenBands = new Set();
    for (const pass of [0, 1]) {
      for (const c of cands) {
        if (out.length >= 3) break;
        const p = c.day.project || 'unknown';
        if (seenProjects.has(p)) continue;
        if (pass === 0 && seenBands.has(c.band.key)) continue;
        seenProjects.add(p);
        seenBands.add(c.band.key);
        // The threads that fed this day are spoken for; nothing else should
        // reach for them as "an archive find nobody has claimed".
        for (const id of c.day.sessionIds) ctx.markUsed(id);
        out.push(build(ctx, c, maxScore, isNew));
      }
      if (out.length >= 3) break;
    }
    return out;
  },
};

/**
 * Everything true about one local day, and nothing that isn't.
 * @param {object} ctx
 * @param {number} idx local day index
 * @param {Array<object>} turns that day's human turns, already time-ordered
 */
function dayFacts(ctx, idx, turns) {
  const sits = ctx.sittingsByDay.get(idx) || [];
  // Active minutes of the sittings that began this day. Deliberately not the
  // day bucket's `minutes`, which charges a multi-week thread to its start day.
  const durationMs = sits.reduce((a, s) => a + s.durationMs, 0);

  const tally = new Map();
  for (const t of turns) if (t.project) tally.set(t.project, (tally.get(t.project) || 0) + 1);
  const project = [...tally.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'en'))[0]?.[0] || null;

  // A pasted URL or a stack trace is a real last message but a terrible pull
  // quote, so the day also carries its last/first *quotable* turn. The copy in
  // build() only claims "your last words" when that turn really was the last.
  const quotable = turns.filter((t) => quoteScore(t) >= 0.5);
  const lastGood = quotable.length ? quotable[quotable.length - 1] : null;

  const agents = new Set(turns.map((t) => t.agent));
  return {
    idx,
    turns,
    humanCount: turns.length,
    first: quotable[0] || turns[0],
    firstIsReallyFirst: !quotable.length || quotable[0] === turns[0],
    last: lastGood || turns[turns.length - 1],
    lastIsReallyLast: !lastGood || lastGood === turns[turns.length - 1],
    durationMs,
    project,
    projects: tally.size,
    interrupts: ctx.interruptsByDay.get(idx) || 0,
    sittings: sits.length,
    sessionIds: [...new Set(sits.map((s) => s.sessionId))],
    agent: agents.size === 1 ? [...agents][0] : 'both',
  };
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function build(ctx, c, maxScore, isNew) {
  const { day, band, age } = c;
  const tzh = ctx.tzh;
  const project = day.project || 'that project';
  const dur = fmtDuration(day.durationMs);
  const msgs = `${fmtNum(day.humanCount)} ${plural(day.humanCount, 'message', 'messages')}`;

  // Best first (see _rank.js). The two gated variants say what KIND of day it
  // was — a fight, or one you kept coming back to — and only fire when the day
  // really was that. The last variant has no number in it at all.
  const blocks = [
    day.interrupts >= 2
      ? {
        title: `${project}, and it was not going well.`,
        body: `You stopped it ${day.interrupts} times that day. Then you typed this and walked away.`,
        quoteTurn: day.last,
      }
      : null,
    day.sittings >= 3
      ? {
        title: `You came back to ${project} ${day.sittings} times that day.`,
        body: `${msgs} across ${day.sittings} sittings. You couldn’t leave it alone.`,
        quoteTurn: day.last,
      }
      : null,
    {
      title: `You were deep in ${project}.`,
      body: day.lastIsReallyLast
        ? `${msgs}, ${dur}. Your last words that day were at ${tzh.time(day.last.ts)}:`
        : `${msgs}, ${dur}. Somewhere in there, at ${tzh.time(day.last.ts)}, you typed:`,
      quoteTurn: day.last,
    },
    {
      title: `A ${tzh.weekdayFromIndex(day.idx)}, ${dur}, one problem.`,
      body: day.firstIsReallyFirst
        ? `You started at ${tzh.time(day.first.ts)}. This is how:`
        : `Early on, at ${tzh.time(day.first.ts)}, you asked for this:`,
      quoteTurn: day.first,
    },
    isNew
      ? null
      : {
        title: `${dur} on ${project}.`,
        body: 'You don’t remember this day. It’s all still here.',
        quoteTurn: day.last,
      },
  ];

  const id = `on-this-day:${tzh.keyFromIndex(day.idx)}`;
  const block = bestBlock(id, blocks);
  const quoteTurn = block.quoteTurn;

  let body = block.body;
  let quote = quoteOf(ctx, quoteTurn, 'you');
  if (ctx.paranoid && quoteTurn) {
    quote = null;
    body = `${body.replace(/[:]$/, '.')} ${quoteTurn.wordCount} words. You know which ones.`;
  }

  return rankedMemory(ctx, {
    type: 'on-this-day',
    kind: 'onthisday',
    key: tzh.keyFromIndex(day.idx),
    date: day.first.ts,
    base: 95,
    recencyMul: band.recency,
    magnitude: clamp01(c.score / maxScore),
    eyebrow: band.eyebrow(age),
    block: { title: block.title, body },
    quote,
    agent: day.agent,
    project: day.project,
    tags: ['anniversary', band.key],
    ring: 'A',
  });
}

/* ------------------------------------------------------------ rediscovered */

export const rediscovered = {
  slug: 'rediscovered',
  kind: 'onthisday',
  run(ctx) {
    if (ctx.mainSessions.length < 3) return [];
    const today = ctx.tzh.dayIndex(ctx.now);
    const dayKey = ctx.tzh.keyFromIndex(today);

    const pick = (minAge) =>
      ctx.mainSessions
        .filter((s) => {
          if (ctx.used.has(s.id)) return false;
          const info = ctx.sessionInfo.get(s.id);
          if (!info || info.humanCount < 3) return false;
          return today - ctx.tzh.dayIndex(s.startedAt) >= minAge;
        })
        .sort((a, b) => hash32(a.id + '|' + dayKey) - hash32(b.id + '|' + dayKey));

    let pool = pick(30);
    let fresh = false;
    if (!pool.length) {
      pool = pick(3);
      fresh = true;
    }
    if (!pool.length) return [];

    return pool.slice(0, 2).map((s) => {
      const info = ctx.sessionInfo.get(s.id);
      ctx.markUsed(s.id);
      const tzh = ctx.tzh;
      const days = today - tzh.dayIndex(s.startedAt);
      const project = s.project || 'something';
      const title = sessionTitle(ctx, s, info);
      // Scoped to the day in the copy, not to the whole thread.
      const dayTurns = turnsOnDayOf(ctx, info, s.startedAt);
      const dayDur = fmtDuration(durationOnDayOf(ctx, s.id, s.startedAt) || s.durationMs);
      // Best first: date, project, duration and how long ago you last thought
      // about it. The middle variant is the one with the fewest facts in it.
      const blocks = [
        {
          title,
          body: `${tzh.date(s.startedAt)}, ${project}, ${dayDur}. You haven’t thought about this in ${days} days. Here it is anyway.`,
        },
        {
          title: `A ${tzh.weekdayName(s.startedAt)} in ${tzh.monthName(s.startedAt)}.`,
          body: `${dayTurns.length} messages about ${project}. You closed the window and never opened this one again.`,
        },
        {
          title,
          body: `${dayDur} of your life on a ${tzh.weekdayName(s.startedAt)} in ${tzh.monthName(s.startedAt)}. It kept the notes.`,
        },
      ];
      const quoteTurn = bestQuote(dayTurns);
      return rankedMemory(ctx, {
        type: 'rediscovered',
        kind: 'onthisday',
        key: s.id,
        date: s.startedAt,
        base: 73,
        magnitude: clamp01(days / 180),
        eyebrows: fresh
          ? ['EARLIER THIS WEEK', 'FROM THE ARCHIVE', relDay(tzh, s.startedAt, ctx.now).toUpperCase()]
          : ['REDISCOVERED', 'FROM THE ARCHIVE', relDay(tzh, s.startedAt, ctx.now).toUpperCase()],
        blocks,
        quote: ctx.paranoid ? null : quoteOf(ctx, quoteTurn, 'you'),
        agent: s.agent,
        project: s.project,
        tags: ['archive'],
        ring: 'B',
      });
    });
  },
};

/** custom-title → ai-title → first 60 chars of the first prompt → project, date. */
function sessionTitle(ctx, s, info) {
  const fallback = `${s.project || 'unknown'}, ${ctx.tzh.shortDate(s.startedAt)}`;
  if (s.title && isProse(s.title)) return ctx.redact(truncate(flatten(s.title), 70));
  if (info.firstHuman && !ctx.paranoid && isProse(info.firstHuman.text)) {
    return ctx.redact(truncate(flatten(info.firstHuman.text), 60));
  }
  return fallback;
}

/** A URL or a path is not a headline, however long it is. */
function isProse(text) {
  const t = flatten(text);
  if (!t) return false;
  if (/^https?:\/\/|^~?\//.test(t)) return false;
  if (/^\S+$/.test(t) && /[/\\.]/.test(t)) return false;
  return true;
}

/* ----------------------------------------------------------- ghost-project */

export const ghostProject = {
  slug: 'ghost-project',
  kind: 'onthisday',
  run(ctx) {
    if (ctx.daysSinceFirst < 45 && ctx.spanDays < 45) return [];
    const today = ctx.tzh.dayIndex(ctx.now);
    const current = ctx.mainSessions.length
      ? ctx.mainSessions[ctx.mainSessions.length - 1].project
      : null;

    const cands = [];
    for (const p of ctx.projectList) {
      if (p.sessions !== 1) continue;
      if (p.name === current) continue;
      const daysSince = today - ctx.tzh.dayIndex(p.lastTs);
      if (daysSince < 45) continue;
      const s = ctx.mainSessions.find((x) => x.project === p.name);
      if (!s) continue;
      const info = ctx.sessionInfo.get(s.id);
      if (!info || info.humanCount < 2) continue;
      cands.push({ p, s, info, daysSince, score: daysSince * Math.log(1 + s.durationMs) });
    }
    if (!cands.length) return [];
    const maxScore = Math.max(...cands.map((c) => c.score)) || 1;
    cands.sort((a, b) => b.score - a.score || a.p.name.localeCompare(b.p.name, 'en'));

    return cands.slice(0, 2).map(({ p, s, info, daysSince, score }) => {
      ctx.markUsed(s.id);
      const tzh = ctx.tzh;
      const q = bestQuote(turnsOnDayOf(ctx, info, s.startedAt));
      const quoteText = q ? truncate(flatten(ctx.redact(q.text)), 90) : null;
      // Best first: the last thing you ever said to it, verbatim.
      const blocks = [
        quoteText && !ctx.paranoid
          ? {
            title: p.name,
            body: `One session. ${fmtDuration(s.durationMs)}. ${tzh.date(s.startedAt)}. You never opened it again. The last thing you said was «${quoteText}».`,
          }
          : null,
        {
          title: `Whatever happened to ${p.name}?`,
          body: `${info.humanCount} messages on ${tzh.date(s.startedAt)}. That’s the whole story. You had a plan that morning.`,
        },
        {
          title: `${p.name}, ${fmtDuration(s.durationMs)}, and then nothing.`,
          body: `${daysSince} days of silence and counting. It’s still sitting there with your last message unanswered — well, answered. Just unread.`,
        },
      ];

      return rankedMemory(ctx, {
        type: 'ghost-project',
        kind: 'onthisday',
        key: p.name,
        date: s.startedAt,
        base: 89,
        recencyMul: 0.9,
        magnitude: clamp01(score / maxScore),
        eyebrows: ['THE ONE YOU LEFT', `${daysSince} DAYS AGO`, 'NEVER CAME BACK'],
        blocks,
        quote: ctx.paranoid ? null : quoteOf(ctx, q, 'you'),
        agent: s.agent,
        project: p.name,
        tags: ['ghost'],
        ring: 'C',
      });
    });
  },
};

/* ------------------------------------------------------------- the-reunion */

export const theReunion = {
  slug: 'the-reunion',
  kind: 'onthisday',
  run(ctx) {
    if (ctx.spanDays < 30) return [];
    let best = null;
    for (const p of ctx.projectList) {
      const ts = p.sessionTs;
      for (let i = 1; i < ts.length; i++) {
        const gapDays = Math.round((ts[i] - ts[i - 1]) / DAY);
        if (gapDays < 30) continue;
        const after = ts.length - i;
        if (after < 2) continue;
        if (!best || gapDays > best.gapDays) {
          best = { p, gapDays, oldTs: ts[i - 1], newTs: ts[i], sessionsSince: after };
        }
      }
    }
    if (!best) return [];

    const tzh = ctx.tzh;
    const newSession = ctx.mainSessions.find(
      (s) => s.project === best.p.name && s.startedAt === best.newTs,
    );
    const info = newSession ? ctx.sessionInfo.get(newSession.id) : null;
    // "Out of nowhere: «…»" has to quote the day you came back, not whatever
    // you said later in a thread that then stayed open for another three weeks.
    const returnDay = ctx.tzh.dayIndex(best.newTs);
    const sameDay = info ? info.turns.filter((t) => ctx.tzh.dayIndex(t.ts) === returnDay) : [];
    const q = bestQuote(sameDay.length ? sameDay : (info ? info.turns : []));
    const quoteText = q ? truncate(flatten(ctx.redact(q.text)), 90) : null;

    // Best first: the sentence you came back with, quoted and dated.
    const blocks = [
      quoteText && !ctx.paranoid
        ? {
          title: `You came back to ${best.p.name}.`,
          body: `Last seen ${tzh.date(best.oldTs)}. Then, ${best.gapDays} days later, out of nowhere: «${quoteText}».`,
        }
        : null,
      {
        title: `${best.p.name} came back from the dead.`,
        body: `Dormant from ${tzh.date(best.oldTs)} to ${tzh.date(best.newTs)}. ${best.sessionsSince} sessions since. Something reminded you.`,
      },
      {
        title: `${best.gapDays} days of silence, then ${tzh.date(best.newTs)}.`,
        body: `${best.p.name}. No preamble, no catching up. You picked up exactly where you left off and so did it.`,
      },
    ];

    if (newSession) ctx.markUsed(newSession.id);
    return [
      rankedMemory(ctx, {
        type: 'the-reunion',
        kind: 'onthisday',
        key: best.p.name + ':' + best.newTs,
        date: best.newTs,
        base: 82,
        magnitude: clamp01(best.gapDays / 120),
        eyebrows: [`${best.gapDays} DAYS APART`, 'THE RETURN', 'YOU CAME BACK'],
        blocks,
        quote: ctx.paranoid ? null : quoteOf(ctx, q, 'you'),
        project: best.p.name,
        agent: newSession ? newSession.agent : null,
        tags: ['gap'],
        ring: 'C',
      }),
    ];
  },
};

/* ------------------------------------------------------------ the-rage-quit */

export const theRageQuit = {
  slug: 'the-rage-quit',
  kind: 'onthisday',
  run(ctx) {
    if (!ctx.interrupts.length) return [];
    if (ctx.spanDays < 7) return [];
    const turns = ctx.humanTurns;
    if (!turns.length) return [];

    let best = null;
    for (const s of ctx.mainSessions) {
      const info = ctx.sessionInfo.get(s.id);
      if (!info || !info.lastHuman) continue;
      const ints = s.interrupts.filter((i) => Number.isFinite(i.ts));
      if (!ints.length) continue;
      const lastInt = ints[ints.length - 1];
      const lastHumanTs = info.lastHuman.ts;
      if (lastHumanTs - lastInt.ts > 3 * 60000) continue;
      if (s.endedAt - lastInt.ts > 5 * 60000) continue;

      // Nothing anywhere for six hours afterwards.
      const next = turns.find((t) => t.ts > s.endedAt);
      const gapMs = next ? next.ts - s.endedAt : ctx.now - s.endedAt;
      if (gapMs < 6 * 3600000) continue;

      const finalInterrupts = ints.filter((i) => i.ts >= s.endedAt - 10 * 60000).length;
      const score = finalInterrupts;
      if (!best || score > best.score || (score === best.score && s.startedAt > best.s.startedAt)) {
        best = { s, info, ints, finalInterrupts, gapMs, next, score };
      }
    }
    if (!best) return [];

    const { s, info, finalInterrupts, gapMs, next } = best;
    const tzh = ctx.tzh;
    const q = bestQuote(info.turns.slice(-3));
    const quoteText = q ? truncate(flatten(ctx.redact(q.text)), 90) : null;
    // Best first: the count of interruptions in the last ten minutes is the
    // evidence for everything the other two variants only assert.
    const blocks = [
      {
        title: `${tzh.time(s.endedAt)}. That was enough for one day.`,
        body: `${finalInterrupts} ${plural(finalInterrupts, 'interruption', 'interruptions')} in the last 10 minutes, then silence until ${next ? tzh.time(next.ts) : 'the next morning'}. It was still there.`,
      },
      {
        title: 'You closed the laptop.',
        body: `${tzh.time(s.endedAt)}, ${s.project || 'that project'}. You stopped it mid-answer and didn’t type another word for ${fmtGap(gapMs)}. Fair.`,
      },
      quoteText && !ctx.paranoid
        ? {
          // The pull-quote slot already prints the words — repeating them in the
          // title rendered the same sentence twice on one card.
          title: 'That was the last thing you said that day.',
          body: `Then you cut it off and left. ${cap(fmtGap(gapMs))} of nothing. You came back. You always come back.`,
        }
        : null,
    ].filter(Boolean);

    ctx.markUsed(s.id);
    return [
      rankedMemory(ctx, {
        type: 'the-rage-quit',
        kind: 'onthisday',
        key: s.id,
        date: s.endedAt,
        base: 86,
        magnitude: clamp01(finalInterrupts / 3),
        eyebrows: [tzh.date(s.endedAt).toUpperCase(), 'THE END OF THAT DAY', 'YOU CLOSED THE LAPTOP'],
        blocks,
        quote: ctx.paranoid ? null : quoteOf(ctx, q, 'you'),
        agent: s.agent,
        project: s.project,
        tags: ['interrupt'],
        ring: 'C',
      }),
    ];
  },
};

export default [onThisDay, ghostProject, theReunion, theRageQuit, rediscovered];
