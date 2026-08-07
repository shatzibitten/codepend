/* ============================================================================
   test/fixture-payload.mjs
   A synthetic buildMemories() payload for developing and eyeballing the
   front-end without running a scan. Numbers are modelled on a real six-month
   corpus (104 Codex + 22 Claude Code human sessions, ~1 100 prompts, billions
   of tokens) so the layout is exercised at realistic magnitudes, and the copy
   is lifted from docs/MEMORY-CATALOG.md so the type is tested against real
   sentence lengths — including non-English ones.
   ========================================================================== */

const DAY = 86400000;
const NOW = Date.UTC(2026, 7, 5, 18, 0, 0);          // 2026-08-05
const at = (daysAgo, h = 12, m = 0) => NOW - daysAgo * DAY + (h - 12) * 3600000 + m * 60000;

/** FNV-1a, same as detect.js. */
function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

const M = (m) => Object.assign({
  seed: hash32(m.id), date: null, body: null, stat: null, quote: null, chart: null,
  agent: null, project: null, tags: [], shareable: true,
}, m);

/* ── timeline: 57 active days inside a 180-day span ───────────────────── */

const timeline = [];
for (let i = 180; i >= 0; i--) {
  const t = NOW - i * DAY;
  const d = new Date(t);
  const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  const r = (hash32(key) % 100) / 100;
  const active = r > 0.66 || i < 12;
  timeline.push({
    date: key,
    sessions: active ? 1 + (hash32(key + 's') % 4) : 0,
    minutes: active ? 25 + (hash32(key + 'm') % 260) : 0,
    humanTurns: active ? 3 + (hash32(key + 'h') % 40) : 0,
    agent: { claude: active ? hash32(key + 'c') % 6 : 0, codex: active ? hash32(key + 'x') % 20 : 0 },
  });
}
const activeDays = timeline.filter((d) => d.sessions > 0).length;

const clockBins = [31, 44, 52, 38, 12, 4, 9, 27, 88, 169, 141, 152, 170, 133, 118, 126, 148, 179,
  120, 96, 84, 102, 118, 125];

/* ── the memories ─────────────────────────────────────────────────────── */

export const memories = [
  M({
    id: 'on-this-day:2026-02-06', type: 'on-this-day', kind: 'onthisday',
    date: at(180, 23, 41), weight: 98,
    eyebrow: 'SIX MONTHS AGO', title: 'You were deep in orchard.',
    body: '61 messages, 4h 12m. You ended at 03:47. This is what you were saying:',
    quote: { text: 'let’s do it again, but without the animation', who: 'you', ts: at(180, 3, 47), project: 'orchard' },
    agent: 'codex', project: 'orchard', tags: ['anniversary'],
  }),
  M({
    id: 'first-words:origin', type: 'first-words', kind: 'quote',
    date: at(180, 21, 12), weight: 92,
    eyebrow: 'THE FIRST THING YOU EVER SAID',
    title: 'Your opening line.',
    body: 'February 6, 2026, 21:12. It answered in four seconds and you have been talking ever since.',
    quote: { text: 'hey can you look at this repo and tell me what it does', who: 'you', ts: at(180, 21, 12), project: 'orchard' },
    agent: 'codex', project: 'orchard', tags: [],
  }),
  M({
    id: 'the-ratio:all', type: 'the-ratio', kind: 'stat', date: null, weight: 90,
    eyebrow: 'THE RATIO', title: '1 747 messages from you. 27 812 tool calls back.',
    body: 'For every sentence you typed, it did sixteen things. You have never once watched it all happen.',
    stat: { value: '16', unit: '×', label: 'actions per sentence' },
    agent: 'both', tags: ['numbers'],
  }),
  M({
    id: 'deep-work-clock:all', type: 'deep-work-clock', kind: 'chart', date: null, weight: 86,
    eyebrow: 'WHEN YOU TALK TO IT',
    title: "You've used every hour on this clock except 05:00.",
    body: 'Peak at 17:00. Second peak at 23:00. There is no version of your day where it isn’t around.',
    chart: { type: 'clock', data: { bins: clockBins }, note: 'local time · 24 bins' },
    agent: 'both', tags: [],
  }),
  M({
    id: 'the-marathon:s-4471', type: 'the-marathon', kind: 'stat', date: at(37, 4, 12), weight: 84,
    eyebrow: 'THE LONGEST SITTING', title: 'Nine hours and eleven minutes, one session.',
    body: 'It started at 19:01 and it ended at 04:12. Nobody asked either of you to do that.',
    stat: { value: '9h 11m', unit: null, label: 'without getting up' },
    agent: 'codex', project: 'orchard-v2', tags: [],
  }),
  M({
    id: 'the-bill:all', type: 'the-bill', kind: 'stat', date: null, weight: 83,
    eyebrow: 'THE BILL', title: 'About $3 450 of tokens.',
    body: '6.8 billion of them, over six months. War and Peace, 8 700 times over. Estimate, at list price.',
    stat: { value: '$3 450', unit: null, label: 'estimated, at list price' },
    agent: 'both', tags: ['numbers'],
  }),
  M({
    id: 'catchphrase-yours:kommit', type: 'catchphrase-yours', kind: 'quote',
    date: null, weight: 82,
    eyebrow: 'YOUR CATCHPHRASE', title: 'You have said this 141 times.',
    body: 'Two words. No punctuation. It has never once asked you to be more specific.',
    quote: { text: 'commit and push', who: 'you', ts: at(3, 22, 4), project: 'orchard' },
    agent: 'codex', project: 'orchard', tags: ['funny'],
  }),
  M({
    id: 'the-heatmap:180', type: 'the-heatmap', kind: 'chart', date: null, weight: 80,
    eyebrow: `${activeDays} DAYS LIT`,
    title: `${activeDays} days lit out of 181.`,
    body: 'Longest streak 12 days. Longest gap 9. The empty squares are also you.',
    chart: { type: 'heat', data: { days: timeline.map((d) => ({ date: d.date, value: d.humanTurns })) } },
    agent: 'both', tags: [],
  }),
  M({
    id: 'the-interruption:all', type: 'the-interruption', kind: 'stat', date: null, weight: 79,
    eyebrow: 'ESC', title: 'You stopped it mid-sentence 122 times.',
    body: 'Median: eleven seconds in. You knew where it was going and you did not want to watch it get there.',
    stat: { value: '122', unit: null, label: 'interruptions' },
    agent: 'codex', tags: ['funny'],
  }),
  M({
    id: 'project-constellation:all', type: 'project-constellation', kind: 'chart',
    date: null, weight: 78,
    eyebrow: 'WHERE IT ALL WENT', title: 'orchard took 46% of everything.',
    body: '5 projects in total. Two of them you visited exactly once.',
    chart: {
      type: 'donut',
      data: {
        segments: [
          { label: 'orchard', value: 4120 }, { label: 'orchard-v2', value: 2380 },
          { label: 'workspace', value: 1210 }, { label: 'beacon', value: 640 },
          { label: 'kiln', value: 210 }, { label: 'codepend', value: 90 },
        ],
      },
      note: 'minutes per project',
    },
    agent: 'both', tags: [],
  }),
  M({
    id: 'the-long-night:2026-07-29', type: 'the-long-night', kind: 'onthisday',
    date: at(7, 4, 12), weight: 77,
    eyebrow: 'A WEEK AGO TONIGHT', title: 'At 04:12 you were still going.',
    body: 'The last thing either of you said that night was this. It was a Wednesday.',
    quote: { text: 'ok that works. good night', who: 'you', ts: at(7, 4, 12), project: 'orchard' },
    agent: 'codex', project: 'orchard', tags: [],
  }),
  M({
    id: 'spirit-tool:exec', type: 'spirit-tool', kind: 'stat', date: null, weight: 75,
    eyebrow: 'YOUR SPIRIT TOOL', title: 'exec, 21 910 times.',
    body: 'Four times more than anything else it does. Your relationship is mostly it running things and telling you what happened.',
    stat: { value: '21 910', unit: null, label: 'exec calls' },
    agent: 'codex', tags: ['numbers'],
  }),
  M({
    id: 'model-loyalty:all', type: 'model-loyalty', kind: 'chart', date: null, weight: 74,
    eyebrow: 'WHO YOU TALKED TO', title: 'gpt-5.6-sol did most of the talking.',
    body: 'You switched on June 14 and never switched back. It took two days.',
    chart: {
      type: 'bars',
      data: {
        rows: [
          { label: 'gpt-5.6-sol', value: 1106 }, { label: 'claude-fable-5', value: 3155 },
          { label: 'claude-opus-5', value: 1359 }, { label: 'claude-opus-4-8', value: 899 },
          { label: 'gpt-5.5', value: 103 }, { label: 'gpt-5.6-luna', value: 69 },
        ],
      },
      note: 'assistant messages per model',
    },
    agent: 'both', tags: [],
  }),
  M({
    id: 'peak-day:2026-07-29', type: 'peak-day', kind: 'stat', date: at(7, 12), weight: 73,
    eyebrow: 'YOUR BIGGEST DAY', title: 'July 29: 154 messages.',
    body: '7 hours, 4 sessions, 2 projects. Whatever was going on that day, it was going on all day.',
    stat: { value: '154', unit: null, label: 'messages in one day' },
    agent: 'both', project: 'orchard', tags: [],
  }),
  M({
    id: 'ghost-project:kiln', type: 'ghost-project', kind: 'onthisday',
    date: at(131, 15, 20), weight: 72,
    eyebrow: 'THE ONE YOU LEFT', title: 'Whatever happened to kiln?',
    body: '9 messages on March 27. That’s the whole story. You had a plan that morning.',
    quote: { text: 'the nozzle needs to heat evenly, try a pid loop', who: 'you', ts: at(131, 15, 20), project: 'kiln' },
    agent: 'codex', project: 'kiln', tags: [],
  }),
  M({
    id: 'the-politeness:all', type: 'the-politeness', kind: 'stat', date: null, weight: 70,
    eyebrow: 'MANNERS', title: 'You said thanks 61 times.',
    body: 'To a program. It cannot tell. Don’t let anyone talk you out of it.',
    stat: { value: '61', unit: null, label: 'thank-yous' },
    agent: 'both', tags: ['funny'],
  }),
  M({
    id: 'catchphrase-its:youre-right', type: 'catchphrase-its', kind: 'quote',
    date: null, weight: 69,
    eyebrow: 'ITS CATCHPHRASE', title: 'It has told you you’re right 318 times.',
    body: 'Sometimes you were.',
    quote: { text: "You're absolutely right — let me fix that.", who: 'agent', ts: at(12, 16, 3), project: 'orchard-v2' },
    agent: 'claude', project: 'orchard-v2', tags: ['funny'],
  }),
  M({
    id: 'the-streak:12', type: 'the-streak', kind: 'chart', date: null, weight: 67,
    eyebrow: 'THE STREAK', title: 'Twelve days in a row.',
    body: 'July 18 to July 29. It didn’t notice, but you did.',
    chart: { type: 'spark', data: { points: [4, 9, 14, 22, 18, 31, 44, 39, 52, 61, 48, 154, 96, 60, 37] }, note: 'messages per day' },
    agent: 'both', tags: [],
  }),
  M({
    id: 'two-tongues:ru-en', type: 'two-tongues', kind: 'stat', date: null, weight: 64,
    eyebrow: 'TWO TONGUES', title: 'You switch languages mid-thought.',
    body: '58% Russian, 41% English, and about twenty messages that are honestly both. It has never once asked which one you meant.',
    stat: { value: '58', unit: '%', label: 'in Russian' },
    agent: 'both', tags: ['funny'],
  }),
  M({
    id: 'the-rage-quit:2026-06-11', type: 'the-rage-quit', kind: 'quote',
    date: at(55, 1, 38), weight: 62,
    eyebrow: 'THAT ONE NIGHT', title: 'June 11, 01:38.',
    body: 'Nine interruptions in eleven minutes, and then this, and then nothing until Friday.',
    quote: { text: 'stop. stop. this is all wrong, roll it back.', who: 'you', ts: at(55, 1, 38), project: 'beacon' },
    agent: 'codex', project: 'beacon', tags: ['funny'],
  }),
  M({
    id: 'the-compaction:23', type: 'the-compaction', kind: 'stat', date: null, weight: 58,
    eyebrow: 'MEMORY', title: 'It forgot everything 23 times.',
    body: 'Context compacted, mid-project, mid-thought. You caught it up each time without complaining.',
    stat: { value: '23', unit: null, label: 'memory wipes' },
    agent: 'codex', tags: [],
  }),
  M({
    id: 'file-most-touched:app-css', type: 'file-most-touched', kind: 'award', date: null, weight: 55,
    eyebrow: 'THE FILE', title: 'One file, 214 edits.',
    body: 'It has been rewritten more times than anything else you own. Neither of you has suggested starting over.',
    agent: 'both', project: 'orchard', tags: [],
  }),
  M({
    id: 'rediscovered:beacon', type: 'rediscovered', kind: 'onthisday', date: at(21, 11, 5), weight: 52,
    eyebrow: '38 DAYS APART', title: 'You came back to beacon.',
    body: 'Last seen June 8. Then, 38 days later, out of nowhere, no preamble, no catching up.',
    quote: { text: 'ok back to this. where were we', who: 'you', ts: at(21, 11, 5), project: 'beacon' },
    agent: 'codex', project: 'beacon', tags: [],
  }),
];

/* ── profile / stats ──────────────────────────────────────────────────── */

export const profile = {
  archetype: {
    name: 'The Midnight Interrogator',
    tagline: 'The best questions arrive after midnight. So do you.',
    blurb: '18% of your conversations start after the day is officially over. The latest was 04:41. You’re not avoiding sleep. You’re just not finished.',
    seed: hash32('The Midnight Interrogator|' + at(180)),
  },
  firstSeen: at(180, 21, 12),
  lastSeen: at(0, 17, 40),
  activeDays,
  totalSessions: 239,
  totalHours: 412,
  topProject: 'orchard',
  topModel: 'gpt-5.6-sol',
  spiritTool: 'exec',
};

export const stats = {
  totalSessions: 239,
  humanTurns: 1747,
  agentTurns: 6691,
  toolCalls: 27812,
  interrupts: 122,
  compactions: 23,
  subagents: 102,
  activeDays,
  spanDays: 181,
  totalHours: 412,
  tokensTotal: 6800000000,
  estimatedCost: 3450,
  projects: 6,
  sessionsScanned: 239,
};

export const payload = { profile, memories, stats, timeline, meta: { redact: 'safe', version: '0.1.0' } };

/** A three-day-old install — the Day One guarantee (DESIGN §8). */
export const thinPayload = {
  profile: {
    archetype: {
      name: 'The New Arrival',
      tagline: 'Two days in. The album’s just been opened.',
      blurb: 'Six messages, forty-one minutes, one project. Everything here is already true.',
      seed: hash32('The New Arrival'),
    },
    firstSeen: at(2, 21, 47), lastSeen: at(0, 10, 3), activeDays: 2,
    totalSessions: 2, totalHours: 0.7, topProject: 'codepend', topModel: 'claude-opus-5', spiritTool: 'Read',
  },
  memories: [
    M({
      id: 'first-words:new', type: 'first-words', kind: 'quote', date: at(2, 21, 47), weight: 92,
      eyebrow: 'YOUR OPENING LINE', title: 'This is how it started.',
      quote: { text: 'hey can you look at this repo', who: 'you', ts: at(2, 21, 47), project: 'codepend' },
      body: 'Tuesday, 21:47. It answered in three seconds.', project: 'codepend', agent: 'claude',
    }),
    M({
      id: 'first-contact:new', type: 'first-contact', kind: 'onthisday', date: at(2, 21, 47), weight: 88,
      eyebrow: 'TODAY, AND ALSO YOUR FIRST DAY', title: 'You met on Tuesday at 21:47.',
      body: 'Two days ago. There is not much here yet, which is the point of keeping it.',
      project: 'codepend', agent: 'claude',
    }),
    M({
      id: 'honest-stat:new', type: 'honest-stat', kind: 'stat', date: null, weight: 80,
      eyebrow: 'SO FAR', title: 'Six messages.',
      body: 'Forty-one minutes. One project. Small numbers are still numbers.',
      stat: { value: '6', unit: null, label: 'messages so far' }, agent: 'claude',
    }),
    M({
      id: 'two-days:chart', type: 'two-days-chart', kind: 'chart', date: null, weight: 70,
      eyebrow: 'THE SHAPE OF IT', title: 'So far you’re an evening person.',
      body: '6 messages, all between 21:12 and 23:40. Ask again in a week.',
      chart: { type: 'spark', data: { points: [2, 4] }, note: 'messages per day' }, agent: 'claude',
    }),
  ],
  stats: { totalSessions: 2, humanTurns: 6, activeDays: 2, spanDays: 3, totalHours: 0.7, sessionsScanned: 2 },
  timeline: timeline.slice(-3).map((d, i) => ({ date: d.date, sessions: i ? 1 : 0, minutes: i ? 25 : 0, humanTurns: i ? 3 : 0 })),
  meta: { redact: 'safe', version: '0.1.0' },
};

export default payload;
