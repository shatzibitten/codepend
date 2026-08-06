/**
 * catchphrase-yours · catchphrase-its · the-verb (the fallback for both)
 *
 * The n-gram miner itself lives in _ngram.js. This file is only about which
 * phrase gets a card and what the card says.
 */

import {
  hash32, fmtNum, fmtSpan, fmtQuote, clamp01, relDay, plural, words, displayPhrase,
} from './_util.js';
import { rankedMemory } from './_rank.js';
import { isStop } from './_stopwords.js';

const DAY = 86400000;

/* ------------------------------------------------------- catchphrase-yours */

export const catchphraseYours = {
  slug: 'catchphrase-yours',
  kind: 'quote',
  run(ctx) {
    if (ctx.paranoid) return []; // a repeated phrase is identifying
    const n = ctx.humanTurns.length;
    let cands = ctx.ngramHuman.slice();
    if (n < 20) cands = cands.filter((c) => c.n >= 2);
    if (!cands.length) return firstVerb(ctx);

    const picked = [cands[0]];
    const second = cands.find(
      (c) => c !== cands[0] && c.score >= 0.6 * cands[0].score && !overlaps(c.phrase, cands[0].phrase),
    );
    if (second) picked.push(second);

    const degraded = n < 20 || cands[0].df < 3;
    return picked.map((c) => card(ctx, c, degraded));
  },
};

function overlaps(a, b) {
  const A = new Set(a.split(' '));
  for (const t of b.split(' ')) if (A.has(t)) return true;
  return false;
}

function card(ctx, c, degraded) {
  const tzh = ctx.tzh;
  const spanDays = Math.max(1, Math.round((c.lastTs - c.firstTs) / DAY));
  // `c.phrase` stays space-joined everywhere it is a key; only what the reader
  // sees is written the way their language writes it (see displayPhrase).
  const shown = displayPhrase(c.phrase);
  const quoted = fmtQuote(shown, 60);
  // Best first: "the tools changed, you didn't" is the only variant that puts
  // the phrase in the context of everything else that moved around it.
  const blocks = [
    c.projects.length && c.models.length
      ? {
        title: `${quoted} — ${fmtNum(c.df)} times.`,
        body: `Across ${c.projects.length} ${plural(c.projects.length, 'project', 'projects')} and ${c.models.length} different ${plural(c.models.length, 'model', 'models')}. The tools changed. You didn’t.`,
      }
      : null,
    {
      title: quoted,
      body: `${fmtNum(c.df)} times. First on ${tzh.shortDate(c.firstTs)}, most recently ${relDay(tzh, c.lastTs, ctx.now)}. You have a house style and this is it.`,
    },
    {
      title: quoted,
      body: `You’ve typed this ${fmtNum(c.df)} times in ${fmtSpan(spanDays)}. It has never once been phrased as a request.`,
    },
    c.n <= 2
      ? {
        title: quoted,
        body: `${fmtNum(c.df)} times. ${c.n === 2 ? 'Two words' : 'One word'}. It always knew what you meant.`,
      }
      : null,
  ];

  return rankedMemory(ctx, {
    type: 'catchphrase-yours',
    kind: 'quote',
    key: c.phrase,
    date: c.lastTs,
    base: 83,
    magnitude: clamp01(c.df / Math.max(1, 0.08 * ctx.humanTurns.length)),
    confidence: degraded ? 0.65 : 1,
    eyebrows: ['YOUR CATCHPHRASE', 'YOU SAY THIS A LOT', `${c.df} TIMES`],
    blocks,
    quote: { text: shown, who: 'you', ts: c.lastTs, project: c.lastProject || null },
    agent: 'both',
    project: c.projects.length === 1 ? c.projects[0] : null,
    tags: ['phrase'],
    ring: 'A',
  });
}

/* -------------------------------------------------------------- the-verb */

/**
 * The most common first word of a prompt. Serves double duty: the documented
 * fallback for catchphrase-yours, and the `the-verb` seedling (§4.2). Same id
 * both ways, so detect.js dedupes it for free.
 */
export function firstVerb(ctx) {
  if (ctx.humanTurns.length < 5) return [];
  const counts = new Map();
  for (const t of ctx.humanTurns) {
    const w = t.tokens[0];
    if (!w || isStop(w)) continue;
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  if (!counts.size) return [];
  const list = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'en'),
  );
  const [word, n] = list[0];
  if (n < 2) return [];
  const total = ctx.humanTurns.length;
  const [word2, n2] = list[1] || [null, 0];

  // The old title was "You open with «fix» 15 times out of 1104" — which counts
  // *times* out of *messages*, two different units, and left the reader doing
  // arithmetic to find out that 1104 was the message total. Same numbers, one
  // unit, subject first.
  const opener = `${fmtNum(n)} of your ${fmtNum(total)} ${plural(total, 'message', 'messages')} start with ${fmtQuote(word, 40)}.`;

  return [
    rankedMemory(ctx, {
      type: 'the-verb',
      kind: 'stat',
      key: word,
      date: null,
      base: 58,
      magnitude: clamp01(n / (0.2 * total)),
      eyebrows: ['HOW YOU START'],
      // Best first: the runner-up gives the number something to be measured
      // against, which the bare count never had.
      blocks: [
        word2 && n2 >= 2 && n2 < n
          ? {
            title: opener,
            body: `Your next most common opener is ${fmtQuote(word2, 30)}, and it only managed ${fmtNum(n2)}. No preamble, no hello — it has learned to expect that.`,
          }
          : null,
        {
          title: opener,
          body: 'No preamble, no hello. It has learned to expect that.',
        },
      ],
      stat: { value: fmtNum(n), unit: null, label: `prompts start with “${word}”` },
      agent: 'both',
      tags: ['seedling'],
      ring: 'A',
    }),
  ];
}

/* --------------------------------------------------------- catchphrase-its */

export const catchphraseIts = {
  slug: 'catchphrase-its',
  kind: 'quote',
  run(ctx) {
    const cands = ctx.ngramAgent
      .map((c) => ({ ...c, rank: c.score * (c.n >= 3 && c.n <= 6 ? 1.25 : 1) }))
      .sort((a, b) => b.rank - a.rank || a.phrase.localeCompare(b.phrase, 'en'));
    if (!cands.length) return [];
    const c = cands[0];
    if (c.df < 5) return [];

    const tzh = ctx.tzh;
    const spanDays = Math.max(1, Math.round((c.lastTs - c.firstTs) / DAY));
    const shown = ctx.redact(displayPhrase(c.phrase));
    const quoted = fmtQuote(shown, 70);
    const interrupted = countInterruptedAfter(ctx, c);

    // Best first: how many of its tics you cut off is a fact about the pair of
    // you; the other two are facts about it.
    const blocks = [
      interrupted > 0
        ? {
          title: `${quoted} — ${fmtNum(c.df)} times.`,
          body: `You interrupted ${fmtNum(interrupted)} of those. Draw your own conclusions.`,
        }
        : null,
      {
        title: `It has said ${quoted} ${fmtNum(c.df)} times.`,
        body: `Same words, same order, ${fmtSpan(spanDays)} apart. It doesn’t know it has a tic.`,
      },
      {
        title: quoted,
        body: `${fmtNum(c.df)} times. You have never once replied to it.`,
      },
    ];

    return [
      rankedMemory(ctx, {
        type: 'catchphrase-its',
        kind: 'quote',
        key: c.phrase,
        date: c.lastTs,
        base: 79,
        magnitude: clamp01(c.df / Math.max(1, 0.15 * ctx.agentTurns.length)),
        eyebrows: ['ITS CATCHPHRASE', 'IT SAYS THIS A LOT', `${c.df} TIMES`],
        blocks,
        // The agent's boilerplate isn't the user's private data, so this card
        // survives paranoid mode — but the pull-quote slot stays empty, because
        // "zero quotes under --redact paranoid" is a promise we make in the UI.
        quote: ctx.paranoid
          ? null
          : { text: shown, who: 'agent', ts: c.lastTs, project: null },
        agent: 'both',
        tags: ['phrase'],
        ring: 'B',
      }),
    ];
  },
};

/** How many of the phrase's occurrences you cut off within two minutes. */
function countInterruptedAfter(ctx, c) {
  if (!ctx.interrupts.length || !c.docTs) return 0;
  const ints = ctx.interrupts;
  let hit = 0;
  for (const ts of c.docTs) {
    for (const it of ints) {
      if (it.ts >= ts && it.ts <= ts + 120000) { hit++; break; }
      if (it.ts > ts + 120000) break;
    }
  }
  return hit;
}

export default [catchphraseYours, catchphraseIts];
