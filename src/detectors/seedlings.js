/**
 * Seedlings (§4.2) — six cheap detectors that need almost nothing.
 *
 * They are held out of the feed whenever better cards exist, and promoted the
 * moment the feed would otherwise fall below MIN_FEED. Every one of them is a
 * real card with real copy. Not one of them says "not enough data."
 */

import {
  fmtNum, fmtPct, fmtDuration, fmtQuote, clamp01, plural, median,
} from './_util.js';
import { rankedMemory } from './_rank.js';
import { firstVerb } from './catchphrase.js';

export const firstDay = {
  slug: 'first-day',
  kind: 'stat',
  run(ctx) {
    if (!ctx.mainSessions.length) return [];
    const tzh = ctx.tzh;
    const firstIdx = tzh.dayIndex(ctx.firstSeen);
    const b = ctx.days.get(firstIdx);
    const turns = b ? b.humanTurns : 0;
    const minutes = b ? b.minutes : 0;
    if (!turns) return [];
    return [
      rankedMemory(ctx, {
        type: 'first-day',
        kind: 'stat',
        key: tzh.keyFromIndex(firstIdx),
        date: ctx.firstSeen,
        base: 60,
        magnitude: 0.6,
        eyebrows: ['YOUR FIRST DAY'],
        blocks: [{
          title: tzh.dateFromIndex(firstIdx),
          body: `${fmtNum(turns)} ${plural(turns, 'message', 'messages')}, ${fmtDuration(minutes * 60000)}. Everything on this page starts here.`,
        }],
        stat: { value: fmtNum(turns), unit: 'messages', label: 'on day one' },
        agent: 'both',
        tags: ['seedling'],
        ring: 'A',
      }),
    ];
  },
};

export const theVerb = {
  slug: 'the-verb',
  kind: 'stat',
  run: (ctx) => firstVerb(ctx),
};

export const questionRate = {
  slug: 'question-rate',
  kind: 'stat',
  run(ctx) {
    const n = ctx.humanTurns.length;
    if (n < 10) return [];
    const q = ctx.humanTurns.filter((t) => t.question).length;
    const rate = q / n;
    return [
      rankedMemory(ctx, {
        type: 'question-rate',
        kind: 'stat',
        key: String(q),
        date: null,
        base: 56,
        magnitude: clamp01(rate / 0.4),
        eyebrows: ['QUESTIONS'],
        blocks: [{
          title: `${fmtPct(rate)} of what you type ends in a question mark.`,
          body: 'The rest are instructions.',
        }],
        stat: { value: fmtPct(rate), unit: null, label: 'questions' },
        agent: 'both',
        tags: ['seedling'],
        ring: 'A',
      }),
    ];
  },
};

export const promptLength = {
  slug: 'prompt-length',
  kind: 'stat',
  run(ctx) {
    const n = ctx.humanTurns.length;
    if (n < 10) return [];
    const med = Math.max(1, Math.round(median(ctx.turnWordCounts)));
    let longest = ctx.humanTurns[0];
    let shortest = ctx.humanTurns[0];
    for (const t of ctx.humanTurns) {
      if (t.wordCount > longest.wordCount) longest = t;
      if (t.wordCount > 0 && t.wordCount < shortest.wordCount) shortest = t;
    }
    const shortQuote = ctx.paranoid
      ? `${shortest.wordCount} ${plural(shortest.wordCount, 'word', 'words')}`
      : fmtQuote(ctx.redact(shortest.text), 40);
    return [
      rankedMemory(ctx, {
        type: 'prompt-length',
        kind: 'stat',
        key: String(med),
        date: null,
        base: 55,
        magnitude: clamp01(med / 55),
        eyebrows: ['YOUR AVERAGE ASK'],
        blocks: [{
          title: `${med} ${plural(med, 'word', 'words')}.`,
          body: `Your longest was ${fmtNum(longest.wordCount)}. Your shortest was ${shortQuote}, and it worked.`,
        }],
        stat: { value: String(med), unit: 'words', label: 'median prompt' },
        agent: 'both',
        tags: ['seedling'],
        ring: 'A',
      }),
    ];
  },
};

export const toolSpread = {
  slug: 'tool-spread',
  kind: 'stat',
  run(ctx) {
    if (ctx.toolCalls < 10 || !ctx.toolList.length) return [];
    const top = ctx.toolList[0];
    const share = top.n / ctx.toolCalls;
    return [
      rankedMemory(ctx, {
        type: 'tool-spread',
        kind: 'stat',
        key: String(ctx.toolList.length),
        date: null,
        base: 54,
        magnitude: clamp01(share),
        eyebrows: ['THE TOOLBOX'],
        blocks: [{
          title: `${ctx.toolList.length} different tools, ${top.name} doing ${fmtPct(share)} of the work.`,
          body: 'You have a favorite and you’re not subtle about it.',
        }],
        stat: { value: String(ctx.toolList.length), unit: 'tools', label: 'in rotation' },
        chart: { type: 'bars', data: ctx.toolList.slice(0, 8).map((t) => ({ label: t.name, v: t.n })) },
        agent: 'both',
        tags: ['seedling'],
        ring: 'A',
      }),
    ];
  },
};

export const sessionCadence = {
  slug: 'session-cadence',
  kind: 'stat',
  run(ctx) {
    if (ctx.mainSessions.length < 3) return [];
    const durs = ctx.mainSessions.map((s) => s.durationMs);
    const med = median(durs);
    const shortAndOften = med < 30 * 60000;
    return [
      rankedMemory(ctx, {
        type: 'session-cadence',
        kind: 'stat',
        key: String(ctx.mainSessions.length),
        date: null,
        base: 53,
        magnitude: clamp01(ctx.mainSessions.length / 100),
        eyebrows: ['YOUR RHYTHM'],
        blocks: [{
          title: `${fmtNum(ctx.mainSessions.length)} sessions, median ${fmtDuration(med)}.`,
          body: `Short and often, or long and rare — you’re the ${shortAndOften ? 'first' : 'second'} kind.`,
        }],
        stat: { value: fmtDuration(med), unit: null, label: 'median session' },
        agent: 'both',
        tags: ['seedling'],
        ring: 'A',
      }),
    ];
  },
};

export default [firstDay, theVerb, questionRate, promptLength, toolSpread, sessionCadence];
