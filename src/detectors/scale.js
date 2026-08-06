/**
 * The numbers that do the punching.
 *
 * the-anniversary · the-ratio · the-marathon · peak-day · the-bill
 */

import {
  hash32, fmtNum, fmtBig, fmtMoney, fmtPct, fmtDuration, fmtSpan,
  fmtQuote, relDay, clamp01, plural, median, pickSalted,
} from './_util.js';
import { rankedMemory } from './_rank.js';

/* ---------------------------------------------------------- the-anniversary */

export const theAnniversary = {
  slug: 'the-anniversary',
  kind: 'stat',
  run(ctx) {
    const tzh = ctx.tzh;
    const days = Math.max(1, ctx.daysSinceFirst || ctx.spanDays);
    const hours = Math.round(ctx.totalHours);
    const sessions = ctx.mainSessions.length;
    const long = days >= 60;

    const blocks = long
      ? [
        // The first two are genuinely the same card — same three numbers, same
        // punch — so they share a rank and the hash breaks the tie. That is the
        // one job the hash still has. The hours-only variant is weaker: it says
        // nothing about how often you showed up.
        {
          rank: 3,
          title: `${fmtNum(days)} days together.`,
          body: `${fmtNum(sessions)} sessions. You showed up on ${fmtNum(ctx.activeDays)} of those days. ${fmtNum(hours)} hours of your life, in total, talking to a program.`,
        },
        {
          rank: 3,
          title: `${fmtNum(days)} days. ${fmtNum(ctx.activeDays)} of them with it.`,
          body: `That’s ${fmtPct(ctx.activeDays / days)} of your days since ${tzh.shortDate(ctx.firstSeen)}. Some relationships get less.`,
        },
        {
          title: `${fmtNum(hours)} hours.`,
          body: `Spread over ${fmtNum(days)} days and ${ctx.projectList.length} projects. Long enough to have a house style, a favorite tool, and a bad habit.`,
        },
      ]
      : [
        {
          title: `${fmtNum(days)} days in.`,
          body: `${fmtNum(sessions)} sessions, ${fmtNum(hours)} hours, ${fmtNum(ctx.humanTurns.length)} things you asked for. This page gets better the longer you stay.`,
        },
        {
          title: `You started ${relDay(tzh, ctx.firstSeen, ctx.now)}.`,
          body: `${fmtNum(ctx.humanTurns.length)} messages already. Come back in a month and this whole page will be different.`,
        },
      ];

    return [
      rankedMemory(ctx, {
        type: 'the-anniversary',
        kind: 'stat',
        key: String(tzh.dayIndex(ctx.firstSeen)),
        date: null,
        base: 88,
        magnitude: clamp01(days / 365),
        confidence: long ? 1 : 0.65,
        eyebrows: long
          ? ['SINCE DAY ONE', `${days} DAYS`, 'THE RELATIONSHIP']
          : [`DAY ${days}`, 'SO FAR'],
        blocks,
        stat: { value: fmtNum(days), unit: plural(days, 'day', 'days'), label: 'since the first prompt' },
        agent: 'both',
        tags: ['hero'],
        ring: 'A',
      }),
    ];
  },
};

/* ---------------------------------------------------------------- the-ratio */

export const theRatio = {
  slug: 'the-ratio',
  kind: 'stat',
  run(ctx) {
    if (ctx.humanTurns.length < 5 || ctx.agentTurns.length < 5) return [];
    if (!ctx.yourWords || !ctx.itsWords) return [];
    const ratio = Math.max(1, Math.round(ctx.itsWords / ctx.yourWords));
    const books = Math.round(ctx.itsWords / 90000);

    const blocks = ratio < 12
      ? [
        {
          title: `You wrote ${fmtNum(ctx.yourWords)} words. It wrote ${fmtNum(ctx.itsWords)}.`,
          body: `Only ${ratio} to one. You’re one of the few people who actually types back.`,
        },
      ]
      : [
        // Best first: "N books' worth" turns an abstract word count into a
        // thing you can picture, and it needs the data to be big enough.
        books >= 2
          ? {
            title: `It has written you ${fmtNum(ctx.itsWords)} words.`,
            body: `That’s ${fmtNum(books)} books’ worth. Nobody has ever written you this much. Nobody ever will.`,
          }
          : null,
        {
          title: `You wrote ${fmtNum(ctx.yourWords)} words. It wrote ${fmtNum(ctx.itsWords)}.`,
          body: `${ratio} to one. You are the smallest and most important part of this conversation.`,
        },
        {
          title: `${ratio} words back for every word you typed.`,
          body: 'A text message in, a novel out. Every time. You’ve never once complained about the length.',
        },
      ];

    return [
      rankedMemory(ctx, {
        type: 'the-ratio',
        kind: 'stat',
        key: `${ctx.yourWords}:${ctx.itsWords}`,
        date: null,
        base: 86,
        magnitude: clamp01(ratio / 80),
        eyebrows: ['THE CONVERSATION', 'WORD COUNT', 'WHO TALKED'],
        blocks,
        stat: { value: `${ratio}:1`, unit: null, label: 'its words to yours' },
        agent: 'both',
        tags: ['hero'],
        ring: 'A',
      }),
    ];
  },
};

/* ------------------------------------------------------------- the-marathon */

/**
 * The longest *sitting*, not the longest thread.
 *
 * A Codex thread can stay open for a month, so `max(session.durationMs)` used
 * to headline "14h 4m without closing the window" for a thread whose 14 hours
 * were spread across 12 separate days. A sitting is a contiguous burst (see
 * stats.js), which is the thing the copy on this card actually claims.
 */
export const theMarathon = {
  slug: 'the-marathon',
  kind: 'stat',
  run(ctx) {
    if (!ctx.sittings.length) return [];
    let best = null;
    for (const s of ctx.sittings) {
      if (s.humanCount < 1) continue;
      if (!best || s.durationMs > best.durationMs) best = s;
    }
    if (!best || best.durationMs <= 0) return [];
    const tzh = ctx.tzh;
    const dur = fmtDuration(best.durationMs);
    const hours = best.durationMs / 3600000;
    const long = best.durationMs >= 20 * 60000;
    const project = best.project || 'one directory';
    const msgs = fmtNum(best.humanCount);

    const blocks = long
      ? [
        // Best first: date, project, message count and the time it ended.
        {
          title: `${dur}, one sitting.`,
          body: `${tzh.date(best.startedAt)}, ${project}. ${msgs} messages from you. It ended at ${tzh.time(best.endedAt)} and neither of you said goodbye.`,
        },
        {
          title: `${tzh.time(best.startedAt)} to ${tzh.time(best.endedAt)}.`,
          body: `${project}, ${tzh.date(best.startedAt)}. Somewhere in the middle of that you stopped noticing the time.`,
        },
        {
          title: `${dur} without closing the window.`,
          body: `${tzh.date(best.startedAt)}. ${msgs} messages, no break longer than ten minutes. The longest you have ever kept it awake.`,
        },
      ]
      : [
        {
          title: `${dur}, your longest so far.`,
          body: `${tzh.date(best.startedAt)}, ${project}. ${msgs} messages. Ask it something hard and this number moves.`,
        },
      ];

    return [
      rankedMemory(ctx, {
        type: 'the-marathon',
        kind: 'stat',
        key: `${best.sessionId}:${best.startedAt}`,
        date: best.startedAt,
        base: 84,
        magnitude: clamp01(hours / 6),
        confidence: long ? 1 : 0.65,
        eyebrows: ['THE LONGEST ONE', tzh.shortDate(best.startedAt).toUpperCase(), 'ONE SITTING'],
        blocks,
        stat: { value: dur, unit: null, label: 'longest single sitting' },
        agent: best.agent,
        project: best.project,
        tags: ['session'],
        ring: 'A',
      }),
    ];
  },
};

/* ---------------------------------------------------------------- peak-day */

export const peakDay = {
  slug: 'peak-day',
  kind: 'stat',
  run(ctx) {
    if (!ctx.activeIdxs.length) return [];
    let best = null;
    for (const idx of ctx.activeIdxs) {
      const b = ctx.days.get(idx);
      if (!best || b.humanTurns > best.humanTurns || (b.humanTurns === best.humanTurns && b.minutes > best.minutes)) {
        best = b;
      }
    }
    if (!best || best.humanTurns === 0) return [];

    const tzh = ctx.tzh;
    const turnsPerActiveDay = ctx.activeIdxs
      .map((i) => ctx.days.get(i).humanTurns)
      .filter((n) => n > 0);
    const med = Math.max(1, Math.round(median(turnsPerActiveDay)));
    const hours = fmtDuration(best.minutes * 60000);
    const fewDays = ctx.activeDays < 4;
    const topProject = [...best.projects].sort()[0] || 'one project';

    const blocks = fewDays
      ? [
        {
          title: `${tzh.dateFromIndex(best.idx)}: ${fmtNum(best.humanTurns)} messages.`,
          body: `${hours}, ${best.sessions} ${plural(best.sessions, 'session', 'sessions')}, ${best.projects.size} ${plural(best.projects.size, 'project', 'projects')}. Whatever was going on that day, it was going on all day.`,
        },
      ]
      : [
        // Best first: the comparison to your median day is what makes the
        // number mean anything. Without it this is just a big number.
        {
          title: `${fmtNum(best.humanTurns)} messages in one day.`,
          body: `${tzh.weekdayFromIndex(best.idx)}, ${tzh.shortDateFromIndex(best.idx)}. From ${tzh.time(best.firstTs)} to ${tzh.time(best.lastTs)}. Your median day is ${med}. This was not a median day.`,
        },
        {
          title: `A ${tzh.weekdayFromIndex(best.idx)} you probably don’t remember.`,
          body: `${fmtNum(best.humanTurns)} messages, ${hours}, ${topProject}. More than any day before or since.`,
        },
        {
          title: `${tzh.dateFromIndex(best.idx)}: ${fmtNum(best.humanTurns)} messages.`,
          body: `${hours}, ${best.sessions} ${plural(best.sessions, 'session', 'sessions')}, ${best.projects.size} ${plural(best.projects.size, 'project', 'projects')}. Whatever was going on that day, it was going on all day.`,
        },
      ];

    return [
      rankedMemory(ctx, {
        type: 'peak-day',
        kind: 'stat',
        key: tzh.keyFromIndex(best.idx),
        date: best.firstTs === Infinity ? null : best.firstTs,
        base: 76,
        magnitude: clamp01(best.humanTurns / (3 * med)),
        confidence: fewDays ? 0.65 : 1,
        eyebrows: ['YOUR BIGGEST DAY', tzh.dateFromIndex(best.idx).toUpperCase(), 'THE DAY IT ALL HAPPENED'],
        blocks,
        stat: { value: fmtNum(best.humanTurns), unit: 'messages', label: tzh.dateFromIndex(best.idx) },
        chart: {
          type: 'spark',
          data: ctx.timeline.slice(-60).map((d) => ({ date: d.date, v: d.humanTurns })),
        },
        agent: 'both',
        project: null,
        tags: ['day'],
        ring: 'A',
      }),
    ];
  },
};

/* ----------------------------------------------------------------- the-bill */

export const theBill = {
  slug: 'the-bill',
  kind: 'stat',
  run(ctx) {
    if (!ctx.totalTokens) return []; // never guess a bill
    const cost = ctx.cost;
    const tokens = ctx.totalTokens;
    const id = 'the-bill:' + tokens;
    const spanDays = Math.max(1, ctx.spanDays);
    const cacheShare = tokens ? ctx.tokens.cacheRead / tokens : 0;

    const comparisons = [
      `War and Peace, ${fmtNum(Math.max(1, Math.round(tokens / 780000)))} times over.`,
      `${fmtNum(Math.max(1, Math.round(cost / 5)))} coffees, if you’re the kind of person who counts coffees.`,
      `A paperback a day, for ${(Math.round((tokens / 130000 / 365) * 10) / 10)} years.`,
      `${fmtNum(Math.max(1, Math.round(tokens / 120000)))} full novels written and thrown away.`,
    ];
    // Four jokes of equal strength, all computed from the same token count —
    // this is a legitimate use of the hash (see _rank.js): nothing is lost by
    // giving different people different ones.
    const comparison = comparisons[hash32(id + '|c') % comparisons.length];

    const blocks = cost < 1
      ? [
        {
          title: `${fmtBig(tokens)} tokens. Call it ${fmtMoney(cost)}.`,
          body: 'Barely anything yet. This number has a way of growing.',
        },
      ]
      : [
        // Best first: the cache line is the only one that says something about
        // the relationship rather than the invoice.
        cacheShare > 0.2
          ? {
            title: fmtMoney(cost),
            body: `${fmtPct(cacheShare)} of it was the same context, read back to it again and again, because it cannot remember you.`,
          }
          : null,
        {
          title: `${fmtBig(tokens)} tokens.`,
          body: `Roughly ${fmtMoney(cost)} at list price. ${comparison} You spent it on ${ctx.stats.topProject || 'one project'}, mostly.`,
        },
        {
          title: `About ${fmtMoney(cost)} of tokens.`,
          body: `${fmtBig(tokens)} of them, over ${fmtSpan(spanDays)}. That’s ${comparison}`,
        },
      ];

    return [
      rankedMemory(ctx, {
        type: 'the-bill',
        kind: 'stat',
        key: String(Math.round(cost * 100)),
        date: null,
        base: 81,
        magnitude: clamp01(Math.log10(Math.max(1, cost)) / 4),
        confidence: cost < 1 ? 0.65 : 1,
        eyebrows: ['THE BILL', 'WHAT IT COST', 'TOKENS'],
        blocks,
        stat: { value: fmtMoney(cost), unit: null, label: 'estimated, at list price' },
        chart: {
          type: 'donut',
          data: [
            { label: 'cache read', v: ctx.tokens.cacheRead },
            { label: 'input', v: ctx.tokens.in },
            { label: 'output', v: ctx.tokens.out },
            { label: 'cache write', v: ctx.tokens.cacheWrite },
          ].filter((d) => d.v > 0),
        },
        agent: 'both',
        tags: ['money', 'estimate'],
        ring: 'A',
      }),
    ];
  },
};

export default [theAnniversary, theRatio, theMarathon, peakDay, theBill];
