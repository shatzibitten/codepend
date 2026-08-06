/**
 * The archetype award card, and the share card that closes the feed.
 *
 * The archetype always fires — §5 guarantees it, and The Everyday Companion is
 * written so that getting it feels earned rather than residual.
 */

import { fmtNum, plural } from './_util.js';
import { rankedMemory } from './_rank.js';
import { pickArchetype } from './_archetypes.js';

export const archetype = {
  slug: 'archetype',
  kind: 'award',
  run(ctx) {
    const a = ctx.archetype || (ctx.archetype = pickArchetype(ctx));
    return [
      rankedMemory(ctx, {
        type: 'archetype',
        kind: 'award',
        key: a.name,
        date: null,
        base: 90,
        magnitude: 1,
        eyebrow: 'THE READ',
        eyebrows: ['THE READ'],
        blocks: [{ title: a.name, body: a.blurb }],
        stat: { value: a.name, unit: null, label: a.tagline },
        agent: 'both',
        tags: ['archetype', 'pinned'],
        ring: 'A',
      }),
    ];
  },
};

export const shareCard = {
  slug: 'share-card',
  kind: 'award',
  run(ctx) {
    const a = ctx.archetype || (ctx.archetype = pickArchetype(ctx));
    const s = ctx.stats;
    const days = Math.max(1, ctx.daysSinceFirst || ctx.spanDays);
    const bits = [
      `${fmtNum(days)} ${plural(days, 'day', 'days')}`,
      `${fmtNum(s.sessions)} ${plural(s.sessions, 'session', 'sessions')}`,
      `${fmtNum(s.humanTurns)} ${plural(s.humanTurns, 'message', 'messages')}`,
      `${fmtNum(Math.round(s.totalHours))} ${plural(Math.round(s.totalHours), 'hour', 'hours')}`,
    ];
    return [
      rankedMemory(ctx, {
        type: 'share-card',
        kind: 'award',
        key: a.name + ':' + days,
        date: null,
        base: 40,
        magnitude: 1,
        eyebrow: 'IT REMEMBERS',
        eyebrows: ['IT REMEMBERS'],
        blocks: [{ title: a.name, body: bits.join(' · ') }],
        stat: { value: a.name, unit: null, label: 'made with codepend · 100% offline' },
        agent: 'both',
        tags: ['share', 'pinned', 'last'],
        shareable: true,
        ring: 'A',
      }),
    ];
  },
};

export default [archetype, shareCard];
