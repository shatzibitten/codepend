/**
 * The things you used, and where it all went.
 *
 * spirit-tool · project-constellation · model-loyalty · file-most-touched
 */

import {
  fmtNum, fmtPct, fmtDuration, clamp01, plural, relDay, hash32,
} from './_util.js';
import { rankedMemory, firstOf } from './_rank.js';
import { TOOL_PERSONALITY } from '../stats.js';

/* -------------------------------------------------------------- spirit-tool */

export const spiritTool = {
  slug: 'spirit-tool',
  kind: 'award',
  run(ctx) {
    if (!ctx.toolList.length) return [];
    const top = ctx.toolList[0];
    const second = ctx.toolList[1] || null;
    const isNew = ctx.toolCalls < 10;

    const runnerUp = second && second.n >= 0.35 * top.n
      ? ` Runner-up: ${second.name}, ${fmtNum(second.n)}.`
      : '';

    const blocks = isNew
      ? [{
        title: `So far: ${top.name}.`,
        body: `${fmtNum(top.n)} calls in. Too early to call it a personality trait. Give it a week.`,
      }]
      : [{
        title: `${top.name} — ${fmtNum(top.n)} calls`,
        body: (TOOL_PERSONALITY[top.name] || TOOL_PERSONALITY.Other) + runnerUp,
      }];

    return [
      rankedMemory(ctx, {
        type: 'spirit-tool',
        kind: 'award',
        key: top.name,
        date: null,
        base: 80,
        magnitude: clamp01(top.n / Math.max(1, ctx.toolCalls) * 1.5),
        confidence: isNew ? 0.65 : 1,
        eyebrow: 'YOUR SPIRIT TOOL',
        eyebrows: ['YOUR SPIRIT TOOL'],
        blocks,
        stat: { value: fmtNum(top.n), unit: 'calls', label: top.name },
        chart: { type: 'bars', data: ctx.toolList.slice(0, 8).map((t) => ({ label: t.name, v: t.n })) },
        agent: 'both',
        tags: ['tools'],
        ring: 'A',
      }),
    ];
  },
};

/* ------------------------------------------------------ project-constellation */

export const projectConstellation = {
  slug: 'project-constellation',
  kind: 'chart',
  run(ctx) {
    const list = ctx.projectList;
    if (!list.length) return [];
    const total = ctx.totalMinutes || 1;
    const top = list[0];
    const share = top.minutes / total;
    const hours = Math.round(ctx.totalHours);

    const donut = list.slice(0, 6).map((p) => ({ label: p.name, v: Math.round(p.minutes) }));
    if (list.length > 6) {
      donut.push({
        label: 'other',
        v: Math.round(list.slice(6).reduce((a, p) => a + p.minutes, 0)),
      });
    }

    let blocks;
    if (list.length === 1) {
      blocks = [{
        title: `One project. ${fmtNum(hours)} hours.`,
        body: `${top.name}, and nothing else. Focus, or a very specific kind of trouble.`,
      }];
    } else if (share >= 0.7) {
      blocks = [{
        title: `It’s basically been ${top.name} this whole time.`,
        body: `${fmtPct(share)} of your hours. The other ${list.length - 1} projects were day trips.`,
      }];
    } else {
      const visitedOnce = list.filter((p) => p.sessions === 1).length;
      // Best first, same rule as the blocks: a count from this corpus beats a
      // rule of thumb that would be true of anybody.
      const tail = firstOf([
        visitedOnce >= 2 ? `${visitedOnce} of them you visited exactly once.` : null,
        list.length >= 5 ? 'The bottom three got less time than a lunch break.' : null,
        'The tail is longer than you’d guess.',
      ]);
      blocks = [
        {
          title: `${top.name} took ${fmtPct(share)} of everything.`,
          body: `${list.length} projects in total. ${tail}`,
        },
        {
          title: `${list.length} projects, ${fmtNum(hours)} hours.`,
          body: `${top.name} got ${fmtDuration(top.minutes * 60000)} of them. Everything else split the rest.`,
        },
      ];
    }

    return [
      rankedMemory(ctx, {
        type: 'project-constellation',
        kind: 'chart',
        key: String(list.length),
        date: null,
        base: 74,
        magnitude: clamp01(list.length / 8),
        eyebrows: ['WHERE IT ALL WENT', `${list.length} PROJECTS`, 'THE MAP'],
        blocks,
        chart: { type: 'donut', data: donut },
        stat: { value: String(list.length), unit: plural(list.length, 'project', 'projects'), label: 'touched' },
        agent: 'both',
        project: null,
        tags: ['projects'],
        ring: 'A',
      }),
    ];
  },
};

/* ------------------------------------------------------------- model-loyalty */

export const modelLoyalty = {
  slug: 'model-loyalty',
  kind: 'chart',
  run(ctx) {
    const list = ctx.modelList;
    if (!list.length) return [];
    const tzh = ctx.tzh;
    const totalSessions = list.reduce((a, m) => a + m.sessions, 0) || 1;
    const top = list[0];
    const bars = list.slice(0, 6).map((m) => ({ label: m.name, v: m.sessions }));

    const sw = detectSwitch(ctx, list);
    const topShare = top.sessions / totalSessions;
    let blocks;
    let eyebrows;
    /** The model the copy is about — the badge has to agree with the headline. */
    let subject = top.name;
    let subjectShare = topShare;

    if (sw) {
      subject = sw.newModel;
      subjectShare = sw.shareSince;
      eyebrows = ['THE SWITCH', 'YOUR MODEL'];
      // Two tellings of the same switch, both naming both models, both dated:
      // equal strength, so they share a rank and the hash picks (see _rank.js).
      blocks = [
        {
          rank: 2,
          title: `You left ${sw.oldModel} on ${tzh.dateFromIndex(sw.day)}.`,
          body: `${sw.newModel} has had ${fmtPct(sw.shareSince)} of your conversations since. You never wrote a goodbye.`,
        },
        {
          rank: 2,
          title: `${sw.newModel}, ${fmtPct(sw.shareSince)} of the time since ${tzh.shortDateFromIndex(sw.day)}.`,
          body: `Before that it was ${sw.oldModel}, ${fmtPct(sw.oldShareBefore)} of everything. Something changed that week.`,
        },
      ];
    } else if (topShare >= 0.55) {
      eyebrows = ['YOUR MODEL', 'LOYALTY', 'THE DEFAULT'];
      const triedOthers = list.length > 1;
      blocks = [
        {
          title: `${top.name}, ${fmtPct(topShare)} of everything.`,
          body: triedOthers
            ? `${fmtNum(top.sessions)} sessions. You have tried others. You came back every time.`
            : `${fmtNum(top.sessions)} sessions. Every single one.`,
        },
        {
          title: 'You’ve never really switched.',
          body: `${top.name} for ${ctx.spanDays} days and ${fmtNum(ctx.mainSessions.length)} sessions. That’s not a default. That’s a preference.`,
        },
      ];
    } else {
      // No dominant model and no clean switch: the honest story is the spread.
      // Claiming loyalty here — or a "switch" inferred from a two-session week —
      // is the fastest way to lose someone who knows their own history.
      const gone = abandoned(ctx, list);
      eyebrows = ['THE ROTATION', `${list.length} MODELS`, 'NO FAVOURITES'];
      // Best first: an abandoned model with a date on it is a story.
      blocks = [
        gone
          ? {
            title: `You haven’t opened ${gone.name} since ${tzh.shortDate(gone.lastTs)}.`,
            body: `${fmtNum(gone.sessions)} sessions together, then nothing. It’s ${top.name} now, and that’s only ${fmtPct(topShare)} of the time.`,
          }
          : null,
        {
          title: `${fmtNum(list.length)} models, no clear favourite.`,
          body: `${top.name} leads with ${fmtPct(topShare)}. You switch when something new lands and you never look back for long.`,
        },
      ];
    }

    return [
      rankedMemory(ctx, {
        type: 'model-loyalty',
        kind: 'chart',
        key: sw ? 'switch:' + sw.day : (topShare >= 0.55 ? 'faithful:' : 'rotation:') + top.name,
        date: null,
        base: sw ? 80 : 70,
        magnitude: clamp01(topShare),
        eyebrows,
        blocks,
        chart: { type: 'bars', data: bars },
        stat: { value: subject, unit: null, label: `${fmtPct(subjectShare)} of sessions` },
        agent: 'both',
        tags: ['models'],
        ring: 'A',
      }),
    ];
  },
};

/**
 * A switch worth a card is a change of *era*, not a quiet week.
 *
 * The previous version compared two 7-day windows and accepted a window with
 * two sessions in it. On this corpus that reported "before Jun 16 it was
 * claude-opus-4-8, almost exclusively" — from exactly two claude sessions on
 * Jun 15, ignoring the four preceding months of gpt-5.3. So: split on the whole
 * history either side, and demand a real majority and a real sample on both.
 */
function detectSwitch(ctx, list) {
  if (list.length < 2) return null;
  const points = [];
  for (const s of ctx.mainSessions) {
    if (!s.models.length) continue;
    points.push({ day: ctx.tzh.dayIndex(s.startedAt), model: s.models[0] });
  }
  if (points.length < 12) return null;
  points.sort((a, b) => a.day - b.day);

  const MIN_SIDE = 5;
  const dominant = (arr) => {
    if (arr.length < MIN_SIDE) return null;
    const tally = new Map();
    for (const p of arr) tally.set(p.model, (tally.get(p.model) || 0) + 1);
    const [name, n] = [...tally.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'en'))[0];
    const share = n / arr.length;
    return share >= 0.5 ? { name, share } : null;
  };

  for (const d of [...new Set(points.map((p) => p.day))].sort((a, b) => a - b)) {
    const before = points.filter((p) => p.day < d);
    const after = points.filter((p) => p.day >= d);
    const oldM = dominant(before);
    const newM = dominant(after);
    if (!oldM || !newM || oldM.name === newM.name) continue;
    // The new era must genuinely displace the old one, not just outnumber it.
    const oldShareAfter = after.filter((p) => p.model === oldM.name).length / after.length;
    if (oldShareAfter > 0.15) continue;
    return {
      day: d,
      oldModel: oldM.name,
      newModel: newM.name,
      shareSince: newM.share,
      oldShareBefore: oldM.share,
    };
  }
  return null;
}

/** A model with real history that has gone quiet for two months or more. */
function abandoned(ctx, list) {
  const cutoff = ctx.now - 60 * 86400000;
  const gone = list
    .filter((m) => m.sessions >= 3 && m.lastTs < cutoff)
    .sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name, 'en'));
  return gone[0] || null;
}

/* --------------------------------------------------------- file-most-touched */

export const fileMostTouched = {
  slug: 'file-most-touched',
  kind: 'stat',
  run(ctx) {
    if (ctx.paranoid) return []; // filenames are paths
    if (!ctx.fileList.length) return [];
    const top = ctx.fileList[0];
    if (top.count < 5) return [];
    const second = ctx.fileList[1] || null;
    const safe = ctx.redact(top.path);
    const parts = safe.split(/[/\\]/).filter(Boolean);
    const filename = parts[parts.length - 1] || safe;
    const dir = parts.length > 1 ? parts.slice(0, -1).slice(-2).join('/') : 'the repo root';
    const tzh = ctx.tzh;

    // Best first: the comparison with the runner-up is what turns an edit count
    // into a verdict.
    const blocks = [
      second
        ? {
          title: `${fmtNum(top.count)} edits to one file.`,
          body: `${filename}. The next-most-edited file got ${fmtNum(second.count)}. This one was the problem.`,
        }
        : null,
      {
        title: `${filename} — ${fmtNum(top.count)} edits.`,
        body: `In ${dir}. First touched ${tzh.shortDate(top.firstTs)}, last ${relDay(tzh, top.lastTs, ctx.now)}. At some point it stopped being your file.`,
      },
      {
        title: filename,
        body: `Edited ${fmtNum(top.count)} times across ${top.days.size} ${plural(top.days.size, 'day', 'days')}. If this project has a heart, that’s where it is.`,
      },
    ];

    return [
      rankedMemory(ctx, {
        type: 'file-most-touched',
        kind: 'stat',
        // The id is inlined into the page and survives into share links, so it
        // must never carry the raw path — that leaked an absolute /Users/<name>
        // into the HTML even though the visible card only ever showed the
        // basename. Filename + a hash of the full path keeps ids unique.
        key: `${filename}:${hash32(top.path)}`,
        date: top.lastTs,
        base: 69,
        magnitude: clamp01(top.count / Math.max(1, 0.1 * ctx.totalTouches)),
        eyebrows: ['THE FILE', `${top.count} EDITS`, 'GROUND ZERO'],
        blocks,
        stat: { value: fmtNum(top.count), unit: 'edits', label: filename },
        agent: 'both',
        tags: ['files'],
        ring: 'B',
      }),
    ];
  },
};

export default [spiritTool, projectConstellation, modelLoyalty, fileMostTouched];
