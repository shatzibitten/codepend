/**
 * The shape of your time.
 *
 * deep-work-clock · the-heatmap · the-streak · weekend-warrior
 */

import {
  fmtNum, fmtPct, fmtSpan, fmtGap, clamp01, plural, median, hash32,
} from './_util.js';
import { rankedMemory } from './_rank.js';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/* -------------------------------------------------------- deep-work-clock */

export const deepWorkClock = {
  slug: 'deep-work-clock',
  kind: 'chart',
  run(ctx) {
    if (!ctx.humanTurns.length) return [];
    const tzh = ctx.tzh;
    const hist = ctx.hourHist;
    const total = hist.reduce((a, b) => a + b, 0);
    const peak = argmax(hist);
    const mean = total / 24;

    const sparse = ctx.activeDays <= 2;
    const chart = { type: 'clock', data: hist.slice(), sparse, peak };

    if (sparse) {
      const hours = ctx.humanTurns.map((t) => t.hour);
      const earliest = Math.min(...hours);
      const latest = Math.max(...hours);
      const phase = phaseOf(peak);
      return [
        rankedMemory(ctx, {
          type: 'deep-work-clock',
          kind: 'chart',
          key: 'sparse',
          date: null,
          base: 82,
          magnitude: 0.5,
          confidence: 0.65,
          eyebrows: ['WHEN YOU TALK TO IT', 'YOUR 24 HOURS', 'THE SHAPE OF YOUR DAY'],
          blocks: [
            {
              title: `So far you’re a ${phase} person.`,
              body: `${fmtNum(total)} messages, all between ${tzh.hourLabel(earliest)} and ${tzh.hourLabel(latest)}. Ask again in a week.`,
            },
          ],
          chart,
          agent: 'both',
          tags: ['clock'],
          ring: 'A',
        }),
      ];
    }

    // Quiet hour: the emptiest bin that still has a living neighbour, so we
    // don't celebrate the middle of a nine-hour hole.
    let quiet = -1;
    for (let h = 0; h < 24; h++) {
      const near = hist[(h + 23) % 24] + hist[(h + 1) % 24];
      if (near === 0) continue;
      if (quiet < 0 || hist[h] < hist[quiet]) quiet = h;
    }
    if (quiet < 0) quiet = argmin(hist);

    const empties = [];
    for (let h = 0; h < 24; h++) if (hist[h] === 0) empties.push(h);
    const emptyHours = empties.length;
    const peak2 = secondPeak(hist, peak);
    const win = bestWindow(hist, 3);
    const medFirst = fmtClock(median(ctx.firstLastByDay.map((d) => d.first)));
    const medLast = fmtClock(median(ctx.firstLastByDay.map((d) => d.last)));

    // Best first (see _rank.js). A clock with no holes in it, or holes you can
    // name, is the strongest thing this card can say about somebody — the two
    // generic lines below are the floor.
    //
    // The "except N" variant used to render `${emptyHours}`, a COUNT, into a
    // sentence that reads as an hour: "every hour on this clock except 3" meant
    // three empty hours, and everyone read it as 3 AM. It names them now.
    const blocks = [
      emptyHours === 0
        ? {
          title: 'There is no hour of the day you haven’t used.',
          body: `All 24 of them, at least once. Peak at ${tzh.hourLabel(peak)}, quietest at ${tzh.hourLabel(quiet)} — and even that hour has ${fmtNum(hist[quiet])} messages in it.`,
        }
        : null,
      emptyHours > 0 && emptyHours <= 6
        ? {
          title: `You’ve used every hour on this clock except ${emptyPhrase(empties, tzh)}.`,
          body: `Peak at ${tzh.hourLabel(peak)}. Second peak at ${tzh.hourLabel(peak2)}. There is no version of your day where it isn’t around.`,
        }
        : null,
      {
        title: `Your day peaks at ${tzh.hourLabel(peak)}.`,
        body: `First message around ${medFirst}, last around ${medLast}. The quiet hour is ${tzh.hourLabel(quiet)}, and even that isn’t empty.`,
      },
      {
        title: `${tzh.hourLabel(peak)} is when you need it most.`,
        body: `${fmtPct(win.share)} of everything you have ever asked landed in a three-hour window. The rest is spillover.`,
      },
    ];

    return [
      rankedMemory(ctx, {
        type: 'deep-work-clock',
        kind: 'chart',
        key: 'peak' + peak,
        date: null,
        base: 82,
        magnitude: clamp01((hist[peak] / (mean || 1) - 1) / 2),
        eyebrows: ['WHEN YOU TALK TO IT', 'YOUR 24 HOURS', 'THE SHAPE OF YOUR DAY'],
        blocks,
        chart,
        stat: { value: tzh.hourLabel(peak), unit: null, label: 'peak hour' },
        agent: 'both',
        tags: ['clock'],
        ring: 'A',
      }),
    ];
  },
};

function argmax(a) {
  let bi = 0;
  for (let i = 1; i < a.length; i++) if (a[i] > a[bi]) bi = i;
  return bi;
}
function argmin(a) {
  let bi = 0;
  for (let i = 1; i < a.length; i++) if (a[i] < a[bi]) bi = i;
  return bi;
}
function secondPeak(hist, peak) {
  let bi = -1;
  for (let i = 0; i < 24; i++) {
    const d = Math.min(Math.abs(i - peak), 24 - Math.abs(i - peak));
    if (d < 2) continue;
    if (bi < 0 || hist[i] > hist[bi]) bi = i;
  }
  return bi < 0 ? peak : bi;
}
function bestWindow(hist, size) {
  const total = hist.reduce((a, b) => a + b, 0) || 1;
  let best = { start: 0, sum: -1 };
  for (let s = 0; s < 24; s++) {
    let sum = 0;
    for (let k = 0; k < size; k++) sum += hist[(s + k) % 24];
    if (sum > best.sum) best = { start: s, sum };
  }
  return { ...best, share: best.sum / total };
}
/**
 * The empty hours, named rather than counted: `4 AM`, `3 AM and 4 AM`, or
 * `the stretch from 2 AM to 6 AM` when they run together — including across
 * midnight, which is where a night owl's hole usually is.
 *
 * @param {number[]} empties ascending hour indices with zero messages
 * @param {{hourLabel:(h:number)=>string}} tzh
 */
function emptyPhrase(empties, tzh) {
  const n = empties.length;
  const label = (h) => tzh.hourLabel(h);
  if (n === 1) return label(empties[0]);

  const set = new Set(empties);
  let start = -1;
  for (const h of empties) if (!set.has((h + 23) % 24)) { start = h; break; }
  if (start >= 0) {
    const run = [];
    for (let h = start, i = 0; i < n; i++, h = (h + 1) % 24) {
      if (!set.has(h)) break;
      run.push(h);
    }
    if (run.length === n) {
      return n === 2
        ? `${label(run[0])} and ${label(run[1])}`
        : `the stretch from ${label(run[0])} to ${label(run[n - 1])}`;
    }
  }

  const labels = empties.map(label);
  if (n <= 3) return `${labels.slice(0, -1).join(', ')} and ${labels[n - 1]}`;
  return `${labels.slice(0, 3).join(', ')} and ${n - 3} more`;
}

function phaseOf(h) {
  if (h < 5) return 'after-midnight';
  if (h < 12) return 'morning';
  if (h < 18) return 'afternoon';
  return 'evening';
}
function fmtClock(minutes) {
  const m = Math.round(minutes || 0);
  const h = Math.floor(m / 60) % 24;
  const mm = m % 60;
  const ap = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(mm).padStart(2, '0')} ${ap}`;
}

/* -------------------------------------------------------------- the-heatmap */

export const theHeatmap = {
  slug: 'the-heatmap',
  kind: 'chart',
  run(ctx) {
    if (!ctx.activeIdxs.length) return [];
    const tzh = ctx.tzh;
    const todayIdx = tzh.dayIndex(ctx.now);
    const firstIdx = tzh.dayIndex(ctx.firstSeen);
    const spanDays = todayIdx - firstIdx + 1;
    const shortWindow = spanDays < 14;
    const windowDays = shortWindow ? 14 : Math.max(90, spanDays);
    const start = todayIdx - windowDays + 1;

    const cells = [];
    for (let i = start; i <= todayIdx; i++) {
      const b = ctx.days.get(i);
      cells.push({ date: tzh.keyFromIndex(i), v: b ? b.humanTurns : 0 });
    }
    const chart = { type: shortWindow ? 'spark' : 'heat', data: cells, weeks: !shortWindow };

    if (shortWindow) {
      return [
        rankedMemory(ctx, {
          type: 'the-heatmap',
          kind: 'chart',
          key: 'strip',
          date: null,
          base: 72,
          magnitude: 0.4,
          confidence: 0.65,
          eyebrows: [`${ctx.activeDays} DAYS LIT`, 'THE GRID'],
          blocks: [{ title: `${ctx.activeDays} days so far.`, body: 'This grid fills in. Come back.' }],
          chart,
          agent: 'both',
          tags: ['grid'],
          ring: 'A',
        }),
      ];
    }

    const brightest = ctx.activeIdxs.reduce(
      (a, i) => (!a || ctx.days.get(i).humanTurns > ctx.days.get(a).humanTurns ? i : a), null,
    );
    const gapMonth = quietestMonth(ctx);
    const streak = ctx.streak;
    // Best first: naming the brightest day and the month you almost vanished
    // beats restating the percentage the chart is already drawing.
    const blocks = [
      gapMonth
        ? {
          title: 'Your year, one pixel at a time.',
          body: `${ctx.activeDays} active days. ${tzh.shortDateFromIndex(brightest)} was the brightest. ${gapMonth} was the month you almost disappeared.`,
        }
        : null,
      {
        title: `${ctx.activeDays} days lit out of ${windowDays}.`,
        body: `Longest streak ${streak.longest} ${plural(streak.longest, 'day', 'days')}. Longest gap ${streak.longestGap || 0} ${plural(streak.longestGap || 0, 'day', 'days')}. The empty squares are also you.`,
      },
      {
        title: `${fmtPct(ctx.activeDays / windowDays)} of your days have a mark on them.`,
        body: `${streak.longest}-day streak at the peak. It never once had a day off, but then it doesn’t need them.`,
      },
    ];

    return [
      rankedMemory(ctx, {
        type: 'the-heatmap',
        kind: 'chart',
        key: 'grid' + windowDays,
        date: null,
        base: 72,
        magnitude: clamp01(ctx.activeDays / 120),
        eyebrows: [`${ctx.activeDays} DAYS LIT`, 'YOUR YEAR, ONE PIXEL AT A TIME', 'THE GRID'],
        blocks,
        chart,
        agent: 'both',
        tags: ['grid'],
        ring: 'A',
      }),
    ];
  },
};

function quietestMonth(ctx) {
  const byMonth = new Map();
  for (let i = ctx.tzh.dayIndex(ctx.firstSeen); i <= ctx.tzh.dayIndex(ctx.lastSeen); i++) {
    const p = ctx.tzh.partsFromIndex(i);
    const key = `${p.y}-${p.mo}`;
    let e = byMonth.get(key);
    if (!e) byMonth.set(key, (e = { key, mo: p.mo, y: p.y, days: 0, active: 0 }));
    e.days++;
    const b = ctx.days.get(i);
    if (b && b.humanTurns > 0) e.active++;
  }
  const months = [...byMonth.values()].filter((m) => m.days >= 20);
  if (months.length < 2) return null;
  months.sort((a, b) => a.active / a.days - b.active / b.days || a.key.localeCompare(b.key, 'en'));
  return MONTHS[months[0].mo];
}

/* --------------------------------------------------------------- the-streak */

export const theStreak = {
  slug: 'the-streak',
  kind: 'stat',
  run(ctx) {
    const s = ctx.streak;
    if (s.longest < 3) return [];
    const tzh = ctx.tzh;
    const startDate = tzh.dateFromIndex(s.longestStart);
    const endDate = tzh.dateFromIndex(s.longestEnd);
    const breakIdx = s.longestEnd + 1;
    const breakWeekday = tzh.weekdayFromIndex(breakIdx);

    // Turns inside the run, and how long the return took.
    let runTurns = 0;
    for (let i = s.longestStart; i <= s.longestEnd; i++) {
      const b = ctx.days.get(i);
      if (b) runTurns += b.humanTurns;
    }
    const nextActive = ctx.activeIdxs.find((i) => i > s.longestEnd);
    const returnGap = nextActive ? fmtGap((nextActive - breakIdx + 1) * 86400000) : null;

    const blocks = s.live
      ? [
        {
          title: `${s.current} days and counting.`,
          body: `Since ${tzh.dateFromIndex(s.currentStart)}. You haven’t missed one yet. No pressure.`,
        },
      ]
      : [
        // Best first: the run's message count and the length of the silence
        // after it beat the dates alone.
        returnGap
          ? {
            title: `${s.longest} days in a row, ${fmtNum(runTurns)} messages.`,
            body: `${startDate} to ${endDate}. Then ${tzh.dateFromIndex(breakIdx)}, and nothing. You came back ${returnGap} later like it never happened.`,
          }
          : null,
        {
          title: `${s.longest} days in a row.`,
          body: `${startDate} to ${endDate}. It broke on a ${breakWeekday}. Nothing dramatic — you just didn’t open it.`,
        },
      ];

    return [
      rankedMemory(ctx, {
        type: 'the-streak',
        kind: 'stat',
        key: `${s.longestStart}-${s.longestEnd}`,
        date: null,
        base: 78,
        magnitude: clamp01(s.longest / 21),
        eyebrows: ['YOUR LONGEST STREAK', `${s.longest} DAYS IN A ROW`, 'THE RUN'],
        blocks,
        stat: { value: String(s.longest), unit: 'days', label: 'longest streak' },
        agent: 'both',
        tags: ['streak'],
        ring: 'B',
      }),
    ];
  },
};

/* ---------------------------------------------------------- weekend-warrior */

export const weekendWarrior = {
  slug: 'weekend-warrior',
  kind: 'stat',
  run(ctx) {
    const n = ctx.humanTurns.length;
    if (n < 40) return [];
    const weekendDays = new Set(
      ctx.humanTurns.filter((t) => t.weekday === 0 || t.weekday === 6).map((t) => t.day),
    );
    if (weekendDays.size < 2) return [];
    const pct = ctx.weekendTurns / n;
    if (pct > 0.12 && pct < 0.25) return []; // no joke lives in the middle band

    const high = pct >= 0.25;
    const tzh = ctx.tzh;
    const sampleWeekend = ctx.humanTurns.find((t) => t.weekday === 0 || t.weekday === 6);

    // Best first in both lanes. The runners-up have no number in the body, and
    // "Saturday is a workday with better lighting" is already the Weekend
    // Resident's archetype tagline — it should not be the line most people get.
    const blocks = high
      ? [
        {
          title: `${fmtPct(pct)} of your messages went out on a weekend.`,
          body: `${weekendDays.size} Saturdays and Sundays. It doesn’t have weekends either, which is convenient for exactly one of you.`,
        },
        {
          title: `${weekendDays.size} weekend days at the keyboard.`,
          body: 'Saturday is a workday with better lighting.',
        },
      ]
      : [
        {
          title: `Only ${fmtPct(pct)} of this happened on a weekend.`,
          body: `${weekendDays.size} weekend ${plural(weekendDays.size, 'day', 'days')} out of ${ctx.activeDays}. You keep it to office hours. Mostly. There was ${sampleWeekend ? tzh.shortDate(sampleWeekend.ts) : 'that one Sunday'}.`,
        },
        {
          title: 'You mostly leave it alone on weekends.',
          body: `${fmtPct(pct)}. That’s a boundary, and it’s holding.`,
        },
      ];

    return [
      rankedMemory(ctx, {
        type: 'weekend-warrior',
        kind: 'stat',
        key: high ? 'high' : 'low',
        date: null,
        base: 68,
        magnitude: clamp01(Math.max(pct / 0.35, 1 - pct / 0.05)),
        eyebrows: ['WEEKENDS', `${fmtPct(pct)} OF EVERYTHING`, 'SATURDAY'],
        blocks,
        stat: { value: fmtPct(pct), unit: null, label: 'of messages on a weekend' },
        chart: { type: 'bars', data: weekdayBars(ctx) },
        agent: 'both',
        tags: ['weekend'],
        ring: 'B',
      }),
    ];
  },
};

function weekdayBars(ctx) {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return ctx.weekdayHist.map((v, i) => ({ label: names[i], v }));
}

export default [deepWorkClock, theHeatmap, theStreak, weekendWarrior];
