/**
 * How the two of you actually behave with each other.
 *
 * the-interruption · the-politeness · the-compaction · two-tongues ·
 * longest-thought · the-swarm
 */

import {
  fmtNum, fmtPct, fmtSpan, fmtQuote, clamp01, plural, median,
  truncate, flatten, langName, hash32, spell,
} from './_util.js';
import { rankedMemory } from './_rank.js';
import { peakSwarm } from './_archetypes.js';

/* ---------------------------------------------------------- the-interruption */

export const theInterruption = {
  slug: 'the-interruption',
  kind: 'stat',
  run(ctx) {
    const n = ctx.interrupts.length;
    const turns = ctx.humanTurns.length;
    const patientLane = n < 5 && turns >= 100;
    if (n < 5 && !patientLane) return [];

    const perTurn = turns ? n / turns : 0;
    const durs = ctx.interruptsWithDuration.map((i) => i.durationMs / 1000);
    const haveDurations = n > 0 && durs.length / n >= 0.5;
    const medianSec = durs.length ? Math.round(median(durs)) : 0;
    const maxSec = durs.length ? Math.round(Math.max(...durs)) : 0;
    const perN = Math.max(1, Math.round(turns / Math.max(1, n)));

    // Best first (see _rank.js). The median-patience line is the only one that
    // could not have been written about anybody else, so it leads whenever the
    // logs carried durations for at least half the interrupts.
    const blocks = patientLane || perTurn < 0.02
      ? [
        {
          title: `You’ve interrupted it ${fmtNum(n)} times. Total.`,
          body: `Out of ${fmtNum(turns)} messages. You let it finish. Almost always. That’s rarer than you think.`,
        },
      ]
      : [
        haveDurations
          ? {
            title: `Median patience: ${humanSecs(medianSec)}.`,
            body: `It started answering. You knew within ${humanSecs(medianSec)} that it was wrong. The longest you ever let it run before pulling the cord was ${humanSecs(maxSec)}.`,
          }
          : null,
        {
          title: `You stopped it mid-sentence ${fmtNum(n)} times.`,
          body: `Once every ${perN} messages. It never took it personally.`,
        },
        {
          title: `${fmtNum(n)} interruptions.`,
          body: 'Every one of them was you deciding, faster than it could type, that this was not the answer.',
        },
      ];

    return [
      rankedMemory(ctx, {
        type: 'the-interruption',
        kind: 'stat',
        key: String(n),
        date: null,
        base: 87,
        magnitude: clamp01(perTurn / 0.12),
        confidence: patientLane ? 0.65 : 1,
        eyebrows: [`${n} TIMES YOU HIT ESCAPE`, 'PATIENCE', 'THE STOP BUTTON'],
        blocks,
        stat: { value: fmtNum(n), unit: null, label: 'times you hit escape' },
        agent: 'both',
        tags: ['interrupt'],
        ring: 'B',
      }),
    ];
  },
};

/** `11 seconds` / `90 minutes` / `3 hours` — a duration a person would say aloud. */
function humanSecs(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  if (s < 90) return `${s} ${plural(s, 'second', 'seconds')}`;
  const m = Math.round(s / 60);
  if (m < 120) return `${m} ${plural(m, 'minute', 'minutes')}`;
  const h = Math.round(s / 3600);
  return `${h} ${plural(h, 'hour', 'hours')}`;
}

/* ------------------------------------------------------------ the-politeness */

/** `about once a week` — how often a thing that happens `days` apart happens. */
function cadenceOf(days) {
  if (!Number.isFinite(days) || days <= 0) return 'constantly';
  if (days < 1.5) return 'about once a day';
  if (days < 4) return 'every few days';
  if (days < 11) return 'about once a week';
  if (days < 24) return 'every couple of weeks';
  if (days < 46) return 'about once a month';
  return `about once every ${Math.round(days / 30)} months`;
}

export const thePoliteness = {
  slug: 'the-politeness',
  kind: 'stat',
  run(ctx) {
    const turns = ctx.humanTurns.length;
    if (turns < 20) return [];
    const n = ctx.politeTurns;
    const rate = n / turns;
    const months = Math.max(1, Math.round(ctx.spanDays / 30));
    const everyN = Math.max(2, Math.round(turns / Math.max(1, n)));
    const cadence = cadenceOf(ctx.spanDays / Math.max(1, n));

    // Four lanes, and none of them is silence. The 1–4 % band used to return
    // nothing at all ("no joke lives there") — which is backwards: someone who
    // thanks a program about once a week is the most relatable person in the
    // corpus, and this is the card people ask for by name. Zero and heavy stay
    // in their own lanes because they are genuinely different jokes.
    const lane = n === 0 ? 'zero' : rate < 0.01 ? 'rare' : rate < 0.04 ? 'sometimes' : 'high';

    // Blocks are ordered best-first in every lane (see _rank.js).
    const blocks = {
      zero: [
        {
          title: 'You have never said thank you.',
          body: `${fmtNum(turns)} messages. Not once. In fairness, it has never asked.`,
        },
      ],
      rare: [
        ctx.agentPolite > 0
          ? {
            title: `${spell(n)} thank-yous in ${months} ${plural(months, 'month', 'months')}.`,
            body: `It has thanked you ${fmtNum(ctx.agentPolite)} times in the same period. Someone here has better manners and it isn’t the human.`,
          }
          : null,
        {
          title: `You said please ${spell(n)} times.`,
          body: `In ${fmtSpan(ctx.spanDays)}. Across ${fmtNum(turns)} messages. It has never brought it up.`,
        },
      ],
      sometimes: [
        {
          title: `You thank it ${cadence}.`,
          body: `${fmtNum(n)} polite messages out of ${fmtNum(turns)} — one every ${everyN}. Not often enough to be a habit, far too regular to be an accident.`,
        },
        ctx.agentPolite > 0
          ? {
            title: `${fmtNum(n)} of your ${fmtNum(turns)} messages had a please in them.`,
            body: `It said thank you ${fmtNum(ctx.agentPolite)} times over the same ${months} ${plural(months, 'month', 'months')}. One of you is running a script and one of you means it.`,
          }
          : null,
        {
          title: `${fmtPct(rate)} of what you type is polite.`,
          body: `The other ${fmtPct(1 - rate)} is instructions. Nobody taught you which messages deserve a please. You decided.`,
        },
      ],
      high: [
        {
          title: `You say please to a program ${fmtNum(n)} ${plural(n, 'time', 'times')}.`,
          body: `${fmtPct(rate)} of your messages. You know it can’t tell. You do it anyway. Keep doing it.`,
        },
        {
          title: `${fmtNum(n)} thank-${plural(n, 'you', 'yous')}.`,
          body: 'Somewhere a linguist is taking notes. Everyone else is just a little charmed.',
        },
      ],
    }[lane];

    return [
      rankedMemory(ctx, {
        type: 'the-politeness',
        kind: 'stat',
        key: lane,
        date: null,
        base: 77,
        magnitude: clamp01(Math.max(rate / 0.06, 1 - rate / 0.005)),
        eyebrows: ['MANNERS', `${n} ${plural(n, 'TIME', 'TIMES')}`, 'THE MAGIC WORD'],
        blocks,
        stat: { value: fmtNum(n), unit: null, label: 'polite messages' },
        agent: 'both',
        tags: ['manners'],
        ring: 'B',
      }),
    ];
  },
};

/* ------------------------------------------------------------ the-compaction */

export const theCompaction = {
  slug: 'the-compaction',
  kind: 'stat',
  run(ctx) {
    const n = ctx.compactions;
    if (n < 2) return [];
    // Longest uninterrupted run of human turns in a session that later compacted.
    let maxTurns = 0;
    for (const s of ctx.sessions) {
      if (!s.compactions) continue;
      const info = ctx.sessionInfo.get(s.id);
      if (info && info.humanCount > maxTurns) maxTurns = info.humanCount;
    }
    // Best first: the only variant that carries a second number leads.
    const blocks = [
      maxTurns > 0
        ? {
          title: `${fmtNum(n)} times it forgot everything you’d told it.`,
          body: `Longest run before a wipe: ${fmtNum(maxTurns)} messages. You started over. It didn’t notice it had started over.`,
        }
        : null,
      {
        title: `Its memory was wiped ${fmtNum(n)} times.`,
        body: 'Mid-project, mid-thought. Each time you explained it all again from the top. You never once complained.',
      },
      {
        title: `${fmtNum(n)} clean slates.`,
        body: 'Every one of them cost you the context you’d spent an hour building. This is the part nobody warns you about.',
      },
    ];

    return [
      rankedMemory(ctx, {
        type: 'the-compaction',
        kind: 'stat',
        key: String(n),
        date: null,
        base: 67,
        magnitude: clamp01(n / 15),
        eyebrows: ['MEMORY LOSS', `${n} TIMES`, 'IT FORGOT'],
        blocks,
        stat: { value: fmtNum(n), unit: null, label: 'context wipes' },
        agent: 'both',
        tags: ['memory'],
        ring: 'B',
      }),
    ];
  },
};

/* --------------------------------------------------------------- two-tongues */

/**
 * Script family of a language code. Two codes in different families were told
 * apart by the script census, which cannot be wrong; two codes in the same
 * family were told apart by function words, which can.
 */
const FAMILY = {
  en: 'latin', de: 'latin', es: 'latin', fr: 'latin', pt: 'latin', it: 'latin',
  nl: 'latin', sv: 'latin', pl: 'latin', tr: 'latin',
  ru: 'cyrillic', uk: 'cyrillic',
  zh: 'han', ja: 'han', ko: 'hangul',
  ar: 'arabic', he: 'hebrew', hi: 'devanagari',
};

/**
 * Can we honestly claim these two codes are two languages?
 *
 * `en` is detectLang's default for Latin text whose function words did not
 * reach the confidence floor, so in a Latin-script corpus the `en` bucket is
 * part English and part "short Spanish sentence we could not place". Measured
 * on the synthetic corpora in test/i18n-pipeline.test.mjs, a MONOLINGUAL
 * Spanish user comes out 66 % es / 34 % en — which would print "you think in
 * Spanish and specify in English" to somebody who has never typed an English
 * word. Every other pair rests on evidence that cannot be a fallback: a
 * different script, or two languages that both cleared the floor.
 *
 * The cost is a genuine German-and-English bilingual, who now gets no card. A
 * card that is right is worth more than a card that is often there.
 */
function distinguishable(a, b) {
  const fa = FAMILY[a];
  const fb = FAMILY[b];
  if (!fa || !fb) return false;
  if (fa !== fb) return true;
  return fa !== 'latin' || (a !== 'en' && b !== 'en');
}

export const twoTongues = {
  slug: 'two-tongues',
  kind: 'stat',
  run(ctx) {
    const counts = ctx.langCounts;
    // Every language detectLang can name, not just the two it used to. `mixed`
    // and `none` are not languages — `mixed` still gets its own chart bar.
    const pairs = Object.entries(counts)
      .filter(([code, n]) => n > 0 && FAMILY[code])
      .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
      .slice(0, 2);
    if (pairs.length < 2) return [];
    if (!distinguishable(pairs[0][0], pairs[1][0])) return [];
    const total = pairs[0][1] + pairs[1][1];
    if (!total) return [];
    const minority = pairs[1];
    if (minority[1] < 15) return [];
    const minorityShare = minority[1] / total;
    if (minorityShare < 0.12) return [];

    const [aCode, aN] = pairs[0];
    const [bCode, bN] = pairs[1];
    const langA = langName(aCode);
    const langB = langName(bCode);

    // Do you switch language right after cutting it off?
    const shift = postInterruptShift(ctx, bCode, bN / total);

    const byLang = (code) =>
      ctx.humanTurns.filter((t) => t.lang === code).map((t) => t.wordCount);
    const medA = median(byLang(aCode));
    const medB = median(byLang(bCode));
    const longLang = medA >= medB ? langA : langB;
    const shortLang = medA >= medB ? langB : langA;

    // Best first: the post-interrupt shift is a finding about the person; the
    // percentage split is already printed in the stat slot below it.
    const blocks = [
      shift
        ? {
          title: `You switch to ${shift.lang} when it gets it wrong.`,
          body: `Baseline ${fmtPct(shift.base)}. Right after you cut it off: ${fmtPct(shift.after)}. Some part of you thinks it’ll understand better in the other language.`,
        }
        : null,
      {
        title: `You think in ${langA} and specify in ${langB}.`,
        body: `${fmtNum(aN)} messages in one, ${fmtNum(bN)} in the other. Your longest prompts are ${longLang}. Your shortest are ${shortLang}.`,
      },
      {
        title: `${fmtPct(aN / total)} ${langA}, ${fmtPct(bN / total)} ${langB}.`,
        body: 'You switch mid-thread, sometimes mid-sentence. It has never once asked you to pick one.',
      },
    ];

    return [
      rankedMemory(ctx, {
        type: 'two-tongues',
        kind: 'stat',
        key: `${aCode}-${bCode}`,
        date: null,
        base: 71,
        magnitude: clamp01(minorityShare / 0.4),
        eyebrows: ['TWO LANGUAGES', `${fmtPct(aN / total)}/${fmtPct(bN / total)}`, 'CODE-SWITCHING'],
        blocks,
        stat: { value: `${fmtPct(aN / total)} / ${fmtPct(bN / total)}`, unit: null, label: `${langA} / ${langB}` },
        chart: {
          type: 'bars',
          data: [
            { label: langA, v: aN },
            { label: langB, v: bN },
            { label: 'mixed', v: counts.mixed || 0 },
          ].filter((d) => d.v > 0),
        },
        agent: 'both',
        tags: ['language'],
        ring: 'B',
      }),
    ];
  },
};

function postInterruptShift(ctx, code, baseShare) {
  if (!ctx.interrupts.length) return null;
  let hits = 0;
  let total = 0;
  for (const it of ctx.interrupts) {
    const next = ctx.humanTurns.find((t) => t.ts > it.ts && t.ts - it.ts < 10 * 60000);
    if (!next) continue;
    total++;
    if (next.lang === code) hits++;
  }
  if (total < 8) return null;
  const after = hits / total;
  if (after - baseShare < 0.15) return null;
  return { lang: langName(code), base: baseShare, after };
}

/* ----------------------------------------------------------- longest-thought */

export const longestThought = {
  slug: 'longest-thought',
  kind: 'stat',
  run(ctx) {
    let best = null;
    for (const r of ctx.reasoning) {
      if (!best || r.chars > best.chars) best = r;
    }
    // Claude reports thinking only as a per-session character total, so if no
    // single reasoning block is available we fall back to the biggest session.
    let sessionFallback = null;
    if (!best || best.chars < 1500) {
      for (const s of ctx.sessions) {
        if (!sessionFallback || s.thinkingChars > sessionFallback.thinkingChars) sessionFallback = s;
      }
      if (!sessionFallback || sessionFallback.thinkingChars < 1500) {
        if (!best || best.chars < 1500) return [];
      }
    }

    const tzh = ctx.tzh;
    const useBlock = best && best.chars >= 1500;
    const chars = useBlock ? best.chars : sessionFallback.thinkingChars;
    const ts = useBlock ? best.ts : sessionFallback.startedAt;
    const project = (useBlock ? best.project : sessionFallback.project) || 'one project';
    const headline = useBlock ? extractHeadline(best.text) : null;

    const prompt = lastBefore(ctx.humanTurns, ts);
    const reply = firstAfter(ctx.agentTurns, ts);
    const replyWords = reply ? reply.text.split(/\s+/).filter(Boolean).length : 0;
    const promptWords = prompt ? prompt.wordCount : 0;
    const ratio = promptWords ? Math.max(1, Math.round(chars / (promptWords * 5))) : null;

    // Best first. Codex's own bolded headline is the best copy in the corpus —
    // it is the agent's private voice, verbatim — so it leads whenever there is
    // one, which is what the `block:` override below used to do by hand.
    const blocks = [
      headline
        ? {
          title: fmtQuote(ctx.redact(headline), 80),
          body: `${fmtNum(chars)} characters under that heading, on ${tzh.date(ts)}. You never saw most of it.`,
        }
        : null,
      prompt && !ctx.paranoid
        ? {
          title: `${fmtNum(chars)} characters of thinking. For one answer.`,
          body: `${tzh.date(ts)}, ${project}. That’s what it took to reply to ${fmtQuote(ctx.redact(prompt.text), 70)}. The reply itself was ${fmtNum(replyWords)} words.`,
        }
        : null,
      ratio
        ? {
          title: `It thought for ${fmtNum(chars)} characters before saying anything.`,
          // "N× that length" compared a word count to a character count and read
          // as nonsense. State both units plainly instead.
          body: `You asked ${fmtNum(promptWords)} words. It wrote ${fmtNum(chars)} characters of private thought before it wrote one word back to you.`,
        }
        : null,
    ];
    if (!blocks.some(Boolean)) return [];

    return [
      rankedMemory(ctx, {
        type: 'longest-thought',
        kind: 'stat',
        key: String(ts),
        date: ts,
        base: 66,
        magnitude: clamp01(chars / 12000),
        eyebrows: ['THE LONGEST THOUGHT', `${fmtNum(chars)} CHARACTERS`, 'IT THOUGHT ABOUT IT'],
        blocks,
        agent: useBlock ? best.agent : sessionFallback.agent,
        project: useBlock ? best.project : sessionFallback.project,
        stat: { value: fmtNum(chars), unit: 'chars', label: 'longest single thought' },
        tags: ['thinking'],
        ring: 'B',
      }),
    ];
  },
};

/** Codex reasoning often opens with a bolded headline: "**Planning safe …**". */
function extractHeadline(text) {
  const m = /^\s*\*\*(.+?)\*\*/.exec(text) || /\*\*(.{6,90}?)\*\*/.exec(text);
  return m ? flatten(m[1]) : null;
}
function lastBefore(arr, ts) {
  let out = null;
  for (const t of arr) {
    if (t.ts > ts) break;
    out = t;
  }
  return out;
}
function firstAfter(arr, ts) {
  for (const t of arr) if (t.ts >= ts) return t;
  return null;
}

/* ---------------------------------------------------------------- the-swarm */

export const theSwarm = {
  slug: 'the-swarm',
  kind: 'stat',
  run(ctx) {
    const n = ctx.subagents;
    if (n < 3) return [];
    const { peak, peakTs, exact } = peakSwarm(ctx);
    const atOnce = exact ? 'running at once' : 'in a single sitting';
    const tzh = ctx.tzh;
    // You saw the summary, not the transcript — that is literally the ratio.
    const readPct = ctx.subagentWords
      ? clamp01(ctx.subagentSummaryWords / ctx.subagentWords)
      : null;

    // Best first: "they wrote 40 000 words to each other and you read 6 % of it"
    // is the whole card. The generic line is the floor, not the coin flip.
    const blocks = [
      peakTs && readPct != null && ctx.subagentWords > 0
        ? {
          title: `${fmtNum(n)} agents, working for one of you.`,
          body: `Peak headcount ${peak}, on ${tzh.date(peakTs)}. They wrote ${fmtNum(ctx.subagentWords)} words to each other. You read ${fmtPct(readPct)} of it.`,
        }
        : null,
      peakTs
        ? {
          title: `You spawned ${fmtNum(n)} sub-agents.`,
          body: `On ${tzh.date(peakTs)} you had ${peak} of them ${atOnce}. You were managing a team you never hired and never paid.`,
        }
        : null,
      {
        title: `It made ${fmtNum(n)} copies of itself for you.`,
        body: 'Most of them finished. You only ever saw the summary.',
      },
    ];

    return [
      rankedMemory(ctx, {
        type: 'the-swarm',
        kind: 'stat',
        key: String(n),
        date: peakTs,
        base: 75,
        magnitude: clamp01(n / 40),
        eyebrows: ['THE SWARM', `${n} SUB-AGENTS`, 'DELEGATION'],
        blocks,
        stat: { value: fmtNum(n), unit: null, label: 'sub-agents spawned' },
        agent: 'both',
        tags: ['swarm'],
        ring: 'C',
      }),
    ];
  },
};

export default [theInterruption, thePoliteness, theCompaction, twoTongues, longestThought, theSwarm];
