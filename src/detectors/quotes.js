/**
 * The cards that quote you back to yourself.
 *
 * first-words · the-long-night · the-apology · the-shortest-word · deja-vu
 *
 * This is where the poignancy budget gets spent (§0 of the catalog). Nowhere
 * else in the feed is allowed to be quiet and a little sad.
 */

import {
  quoteOf, bestQuote, quoteScore, hash32, fmtNum, fmtGap, fmtDuration,
  fmtQuote, truncate, flatten, clamp01, plural, relDay,
} from './_util.js';
import { rankedMemory } from './_rank.js';
import { jaccard } from './_ngram.js';

const DAY = 86400000;

/* ------------------------------------------------------------- first-words */

export const firstWords = {
  slug: 'first-words',
  kind: 'quote',
  run(ctx) {
    const turns = ctx.humanTurns;
    if (!turns.length) return [];
    const t1 = turns[0];
    const t2 = turns[1] || null;
    const tzh = ctx.tzh;
    const gapMs = t2 ? t2.ts - t1.ts : null;
    const daysSince = tzh.dayIndex(ctx.now) - tzh.dayIndex(t1.ts);
    const quoted = fmtQuote(ctx.redact(t1.text), 120);

    let blocks;
    if (ctx.paranoid) {
      blocks = [
        {
          title: `${t1.wordCount} words, ${flatten(t1.text).length} characters`,
          body: `${daysSince} days ago. You’ve typed ${fmtNum(turns.length - 1)} more messages since. You still don’t say hello.`,
        },
      ];
    } else {
      // Best first: the second thing you ever typed, quoted, is the only
      // variant that could not be written about anybody else.
      blocks = [
        t2 && gapMs <= 7 * DAY
          ? {
            title: quoted,
            body: `That’s it. That’s how it started. No hello, no context. ${cap(fmtGap(gapMs))} later you asked it ${fmtQuote(ctx.redact(t2.text), 90)}.`,
          }
          : null,
        {
          title: quoted,
          body: `${daysSince} days ago. You’ve typed ${fmtNum(Math.max(0, turns.length - 1))} more messages since. You still don’t say hello.`,
        },
        {
          title: quoted,
          body: `${tzh.date(t1.ts)}, ${tzh.time(t1.ts)}. You had no idea how much of your year this was going to take.`,
        },
      ];
    }

    return [
      rankedMemory(ctx, {
        type: 'first-words',
        kind: 'quote',
        key: String(t1.ts),
        date: t1.ts,
        base: 92,
        magnitude: 1,
        eyebrows: [
          'THE FIRST THING YOU EVER TYPED',
          `${tzh.date(t1.ts).toUpperCase()} — ${tzh.time(t1.ts)}`,
          'WHERE IT STARTED',
        ],
        blocks,
        quote: ctx.paranoid ? null : quoteOf(ctx, t1, 'you'),
        agent: t1.agent,
        project: t1.project,
        tags: ['origin'],
        ring: 'A',
      }),
    ];
  },
};

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/* ----------------------------------------------------------- the-long-night */

export const theLongNight = {
  slug: 'the-long-night',
  kind: 'quote',
  run(ctx) {
    const night = ctx.nightTurns;
    if (night.length < 3) return [];
    const tzh = ctx.tzh;

    // "Latest" is wall-clock, not chronological: 3:47 AM beats 1:10 AM.
    let latest = null;
    for (const t of night) {
      const p = tzh.parts(t.ts);
      const mins = p.h * 60 + p.mi;
      const tie = hash32(t.sessionId + ':' + t.ts);
      const sc = quoteScore(t);
      if (
        !latest ||
        mins > latest.mins ||
        (mins === latest.mins && (sc > latest.sc || (sc === latest.sc && tie > latest.tie)))
      ) {
        latest = { t, mins, sc, tie };
      }
    }
    const t = latest.t;
    const nightsCount = new Set(night.map((x) => x.day)).size;
    const turnsThatNight = night.filter((x) => x.day === t.day).length;
    const wdMorning = tzh.weekdayName(t.ts);
    const wdNight = tzh.weekdayFromIndex(t.day - 1);

    // Best first: "Tuesday night, technically Wednesday morning" names the hour,
    // both weekdays and how deep in you were. The bare count is the fallback,
    // and the only one that survives paranoid mode.
    const blocks = [
      ctx.paranoid
        ? null
        : {
          title: `${tzh.time(t.ts)}, ${wdNight} night. Technically ${wdMorning} morning.`,
          body: `${t.project || 'One project'}. You were ${turnsThatNight} messages deep and showed no sign of stopping.`,
        },
      ctx.paranoid
        ? null
        : {
          title: `The latest you ever asked for help: ${tzh.time(t.ts)}.`,
          body: `${tzh.date(t.ts)}. ${t.project || 'No project name, just a directory'}. You typed this, and it answered like it was the middle of the afternoon.`,
        },
      {
        title: `${nightsCount} conversations that started after midnight.`,
        body: `The latest at ${tzh.time(t.ts)} on ${tzh.shortDate(t.ts)}. Nobody else was awake. It was.`,
      },
    ];

    return [
      rankedMemory(ctx, {
        type: 'the-long-night',
        kind: 'quote',
        key: String(t.ts),
        date: t.ts,
        base: 85,
        magnitude: clamp01(night.length / Math.max(1, 0.1 * ctx.humanTurns.length)),
        eyebrows: [
          `${nightsCount} NIGHTS AFTER MIDNIGHT`,
          tzh.time(t.ts).toUpperCase(),
          'THE LATE SHIFT',
        ],
        blocks,
        quote: ctx.paranoid ? null : quoteOf(ctx, t, 'you'),
        agent: t.agent,
        project: t.project,
        tags: ['night'],
        ring: 'B',
      }),
    ];
  },
};

/* -------------------------------------------------------------- the-apology */

export const theApology = {
  slug: 'the-apology',
  kind: 'quote',
  run(ctx) {
    const pool = ctx.apologyTurns;
    if (!pool.length) return [];
    const t = bestQuote(pool) || pool[0];
    const tzh = ctx.tzh;
    const m = ctx.agentApologies;
    const quoted = fmtQuote(ctx.redact(t.text), 120);

    // Best first: your apology next to its apology count is the one with the
    // ledger in it. The bare count is the paranoid-mode floor.
    const blocks = [
      !ctx.paranoid && m > 0
        ? {
          title: quoted,
          body: `${tzh.date(t.ts)}. You apologized to a program. It has apologized to you ${fmtNum(m)} times in the same period, so the ledger is not close.`,
        }
        : null,
      ctx.paranoid
        ? null
        : {
          title: quoted,
          body: `${cap(relDay(tzh, t.ts, ctx.now))}. Nobody was watching. You did it anyway.`,
        },
      {
        title: `You said sorry ${fmtNum(pool.length)} times.`,
        body: 'To software. That built nothing into its model of you and everything into yours.',
      },
    ];

    return [
      rankedMemory(ctx, {
        type: 'the-apology',
        kind: 'quote',
        key: String(t.ts),
        date: t.ts,
        base: 84,
        magnitude: 1,
        eyebrows: ['YOU APOLOGIZED', tzh.shortDate(t.ts).toUpperCase(), 'SORRY'],
        blocks,
        quote: ctx.paranoid ? null : quoteOf(ctx, t, 'you'),
        agent: t.agent,
        project: t.project,
        tags: ['manners'],
        ring: 'C',
      }),
    ];
  },
};

/* -------------------------------------------------------- the-shortest-word */

/**
 * Attribution note: neither agent logs a timestamp per tool call, so a turn's
 * "work done after it" is apportioned from its session's totals by the share of
 * session time the turn's window covers. Windows are capped at 30 minutes so a
 * closed laptop doesn't win the card.
 */
export const theShortestWord = {
  slug: 'the-shortest-word',
  kind: 'quote',
  run(ctx) {
    if (!ctx.toolCalls) return [];
    const cands = [];
    for (const s of ctx.mainSessions) {
      const info = ctx.sessionInfo.get(s.id);
      if (!info || !info.turns.length || !info.toolCalls) continue;
      const files = s.filesTouched.length;
      const windows = info.turns.map((t, i) => {
        const end = i + 1 < info.turns.length ? info.turns[i + 1].ts : s.endedAt;
        return Math.max(0, Math.min(end - t.ts, 30 * 60000));
      });
      const total = windows.reduce((a, b) => a + b, 0) || 1;
      info.turns.forEach((t, i) => {
        if (t.wordCount === 0 || t.wordCount > 4) return;
        const share = windows[i] / total;
        const toolsAfter = info.toolCalls * share;
        const filesAfter = files * share;
        const minutesAfter = windows[i] / 60000;
        const impact = toolsAfter + filesAfter * 3 + minutesAfter * 0.5;
        if (impact < 20) return;
        cands.push({ t, s, impact, toolsAfter, filesAfter, minutesAfter });
      });
    }
    if (!cands.length) return [];
    cands.sort(
      (a, b) => b.impact - a.impact || hash32(b.t.sessionId + b.t.ts) - hash32(a.t.sessionId + a.t.ts),
    );
    const c = cands[0];
    const tzh = ctx.tzh;
    const files = Math.max(1, Math.round(c.filesAfter));
    const tools = Math.max(1, Math.round(c.toolsAfter));
    const dur = fmtDuration(c.minutesAfter * 60000);
    const quoted = fmtQuote(ctx.redact(c.t.text), 60);

    const blocks = ctx.paranoid
      ? [{
        title: `Your shortest useful prompt was ${c.t.wordCount} words.`,
        body: `It produced ${files} changed ${plural(files, 'file', 'files')}.`,
      }]
      : [
        // Best first: three numbers on the other side of the trade beats one.
        {
          title: quoted,
          body: `${c.t.wordCount} ${plural(c.t.wordCount, 'word', 'words')} from you. ${dur} of work, ${files} ${plural(files, 'file', 'files')} changed, ${fmtNum(tools)} tool calls back. Best trade you ever made.`,
        },
        {
          title: `${c.t.wordCount} ${plural(c.t.wordCount, 'word', 'words')} in. ${files} ${plural(files, 'file', 'files')} out.`,
          body: `${quoted}, ${tzh.date(c.t.ts)}. You’ve written longer text messages about lunch.`,
        },
        {
          title: quoted,
          body: `That’s the whole prompt. It went away for ${dur} and came back with ${files} changed ${plural(files, 'file', 'files')}.`,
        },
      ];

    return [
      rankedMemory(ctx, {
        type: 'the-shortest-word',
        kind: ctx.paranoid ? 'stat' : 'quote',
        key: c.t.sessionId + ':' + c.t.ts,
        date: c.t.ts,
        base: 80,
        magnitude: clamp01(c.impact / 120),
        eyebrows: [
          `${c.t.wordCount} ${plural(c.t.wordCount, 'WORD', 'WORDS')}`,
          'THE BEST TRADE YOU EVER MADE',
          tzh.shortDate(c.t.ts).toUpperCase(),
        ],
        blocks,
        quote: ctx.paranoid ? null : quoteOf(ctx, c.t, 'you'),
        agent: c.s.agent,
        project: c.s.project,
        tags: ['leverage'],
        ring: 'C',
      }),
    ];
  },
};

/* ----------------------------------------------------------------- deja-vu */

export const dejaVu = {
  slug: 'deja-vu',
  kind: 'quote',
  run(ctx) {
    if (ctx.paranoid) return [];
    if (ctx.spanDays < 21 || ctx.humanTurns.length < 30) return [];

    const byProject = new Map();
    for (const t of ctx.humanTurns) {
      if (t.tokens.length < 4) continue;
      const key = t.project || 'unknown';
      let arr = byProject.get(key);
      if (!arr) byProject.set(key, (arr = []));
      arr.push({ t, set: new Set(t.tokens) });
    }

    let best = null;
    for (const arr of byProject.values()) {
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          const a = arr[i];
          const b = arr[j];
          const gapDays = ctx.tzh.dayIndex(b.t.ts) - ctx.tzh.dayIndex(a.t.ts);
          if (gapDays < 21) continue;
          // Jaccard ≥ 0.75 is impossible when the sets differ this much in size.
          const r = a.set.size / b.set.size;
          if (r < 0.6 || r > 1.67) continue;
          const sim = jaccard(a.set, b.set);
          if (sim < 0.75) continue;
          if (!best || gapDays > best.gapDays) best = { a: a.t, b: b.t, gapDays, sim };
        }
      }
    }
    if (!best) return [];

    const tzh = ctx.tzh;
    const q1 = fmtQuote(ctx.redact(best.a.text), 55);
    const q2 = fmtQuote(ctx.redact(best.b.text), 90);
    // Best first: both halves of the repeat, quoted and dated. The last variant
    // has no number in the body at all.
    const blocks = [
      {
        title: 'You asked the same thing twice.',
        body: `${q1} on ${tzh.shortDate(best.a.ts)}. ${fmtQuote(ctx.redact(best.b.text), 55)} on ${tzh.shortDate(best.b.ts)}. It answered both times without mentioning the first.`,
      },
      {
        title: q2,
        body: `You also said this on ${tzh.date(best.a.ts)}. Word for word, near enough. Some problems are just yours.`,
      },
      {
        title: `${best.gapDays} days later, the exact same question.`,
        body: 'Either it didn’t stick, or the bug came back. It has no way of telling you which.',
      },
    ];

    return [
      rankedMemory(ctx, {
        type: 'deja-vu',
        kind: 'quote',
        key: best.a.ts + ':' + best.b.ts,
        date: best.b.ts,
        base: 76,
        magnitude: clamp01(best.gapDays / 180),
        eyebrows: [`${best.gapDays} DAYS APART`, 'AGAIN', 'YOU’VE BEEN HERE BEFORE'],
        blocks,
        quote: quoteOf(ctx, best.b, 'you'),
        agent: best.b.agent,
        project: best.b.project,
        tags: ['repeat'],
        ring: 'C',
      }),
    ];
  },
};

export default [firstWords, theLongNight, theApology, theShortestWord, dejaVu];
