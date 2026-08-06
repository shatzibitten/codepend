/**
 * The n-gram miner (catalog §3).
 *
 * The hardest thing in the catalog to get right, because it must work
 * identically for «коммит и пуш» and "looks good ship it". Every design choice
 * below exists to survive Russian inflection and agent boilerplate at once.
 */

import { words, hash32 } from './_util.js';
import { isStop, AGENT_BLOCKLIST } from './_stopwords.js';

// Agent messages are long; catchphrases live near the start ("You're absolutely
// right", "Perfect!"). Capping keeps the miner linear on a 4 GB corpus.
const MAX_TOKENS_PER_DOC = 300;
const MAX_N = 4;
const TOP_CANDIDATES = 60;

/** Strip everything that is structure rather than voice, before tokenizing. */
export function stripStructure(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')      // fenced code
    .replace(/`[^`\n]*`/g, ' ')           // inline code
    .replace(/https?:\/\/\S+/g, ' ')      // urls
    .replace(/\S+@\S+\.\S+/g, ' ')        // emails
    // Anything containing a slash or backslash is a path, not a phrase. This is
    // blunt on purpose: a path that survives to the miner becomes a card title.
    .replace(/\S*[/\\]\S*/g, ' ')
    .replace(/\S+\.[a-z]{2,4}\b/gi, ' ')  // bare filenames (foo.mp4, app.tsx)
    .replace(/^\s*#{1,6}\s+/gm, ' ')      // md headings
    .replace(/^\s*[-*+]\s+/gm, ' ')       // list markers
    .replace(/^\s*\d+[.)]\s+/gm, ' ')     // ordered list markers
    .replace(/^\s*[+-]{1,3}\s/gm, ' ');   // diff prefixes
}

/**
 * How much of a document the miner will ever look at.
 *
 * `ngramsOf` stops after MAX_TOKENS_PER_DOC (300) tokens, so everything past
 * that is stripped and split for nothing. Agent messages are long — this corpus
 * held 7.9 MB of them against 1.0 MB of human text — and doing the structural
 * regex work on all of it cost ~2s of a ~3.5s run.
 *
 * 3000 characters is the safe floor for 300 tokens in every script we support:
 * ~545 tokens of Latin prose at 5.5 chars/token, and far more for Chinese,
 * where a token is one or two characters. So this never changes the result,
 * it only stops us reading past the point the budget already cut off.
 */
const MAX_CHARS_PER_DOC = 3000;

/** Split into sentences so n-grams never cross a boundary. */
function sentences(text) {
  const t = text.length > MAX_CHARS_PER_DOC ? text.slice(0, MAX_CHARS_PER_DOC) : text;
  return stripStructure(t)
    .split(/[.!?…\n\r]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const HAS_LONG_NUMBER = /\d{3,}/;

/**
 * Short all-hiragana tokens are Japanese grammatical glue — particles and
 * inflectional tails (し, て, もら, を, の, は) that the segmenter emits as
 * separate tokens. Joined into an n-gram they produce fragments like
 * «してもら», which is not a phrase anyone said. A stopword list can't catch
 * these because inflection generates them combinatorially.
 *
 * The 2-character bound is what keeps real hiragana words — ありがとう,
 * すみません, おはよう — out of the filter.
 *
 * @param {string} t
 * @returns {boolean}
 */
function isGlue(t) {
  if (t.length <= 2 && /^[\u3040-\u309f]+$/.test(t)) return true;
  // A single alphabetic character is a preposition or an initial in every
  // alphabetic script — «к», «a», «y». Never the thing someone is known for
  // saying. (CJK is exempt: there one character is a whole word.)
  return t.length === 1 && /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}]$/u.test(t);
}

function ngramsOf(text, maxN) {
  const out = [];
  let budget = MAX_TOKENS_PER_DOC;
  for (const sent of sentences(text)) {
    if (budget <= 0) break;
    const toks = words(sent).slice(0, budget);
    budget -= toks.length;
    for (let n = 1; n <= maxN; n++) {
      for (let i = 0; i + n <= toks.length; i++) {
        const slice = toks.slice(i, i + n);
        if (isStop(slice[0]) || isStop(slice[n - 1])) continue;
        if (slice.every(isStop)) continue;
        if (isGlue(slice[0]) || isGlue(slice[n - 1])) continue;
        let bad = false;
        for (const t of slice) if (HAS_LONG_NUMBER.test(t)) { bad = true; break; }
        if (bad) continue;
        out.push(slice.join(' '));
      }
    }
  }
  return out;
}

/**
 * Mine repeated phrases.
 *
 * @param {Array<{text:string, ts:number, project?:string|null, model?:string|null, sessionId?:string}>} docs
 *   One document = one turn. A phrase repeated six times inside one prompt counts
 *   once — this single rule kills 90% of the garbage.
 * @param {object} [opts]
 * @param {number} [opts.minDf] minimum document frequency
 * @param {number} [opts.maxN] largest n-gram
 * @param {boolean} [opts.agentSide] apply the agent boilerplate filters
 * @param {Set<string>} [opts.preamble] phrases from first-agent-messages to drop
 * @returns {Array<{phrase:string,n:number,df:number,score:number,docs:number[],firstTs:number,lastTs:number,projects:string[],models:string[]}>}
 */
export function mineNgrams(docs, opts = {}) {
  const minDf = opts.minDf == null ? 3 : opts.minDf;
  const maxN = opts.maxN == null ? MAX_N : opts.maxN;
  const df = new Map();

  // Pass 1 — document frequency only. Cheap, no index arrays.
  const perDoc = [];
  for (let i = 0; i < docs.length; i++) {
    const set = new Set(ngramsOf(docs[i].text, maxN));
    perDoc.push(set);
    for (const p of set) df.set(p, (df.get(p) || 0) + 1);
  }

  let cands = [];
  for (const [phrase, count] of df) {
    if (count < minDf) continue;
    const n = phrase.split(' ').length;
    if (opts.agentSide) {
      if (n === 1 && AGENT_BLOCKLIST.has(phrase)) continue;
      if (opts.preamble && opts.preamble.has(phrase)) continue;
    }
    cands.push({ phrase, n, df: count, score: count * Math.pow(n, 1.4) });
  }
  if (!cands.length) return [];

  // Deterministic ordering before any top-N cut.
  cands.sort((a, b) => b.score - a.score || a.phrase.localeCompare(b.phrase, 'en'));
  cands = cands.slice(0, TOP_CANDIDATES);

  // Collapse maximal phrases: drop P when it is a sub-phrase of a Q that is
  // nearly as frequent. Prevents "commit and" / "and push" / "commit and push"
  // all shipping.
  const kept = [];
  for (const p of cands) {
    let covered = false;
    for (const q of cands) {
      if (q === p || q.n <= p.n) continue;
      if (!isSubPhrase(p.phrase, q.phrase)) continue;
      if (p.df <= 1.15 * q.df) { covered = true; break; }
    }
    if (!covered) kept.push(p);
  }

  // Russian inflection makes single words unreliable; phrases are stable.
  const bestMulti = kept.find((c) => c.n >= 2);
  const ranked = kept.filter((c) => c.n >= 2 || !bestMulti || c.score >= 3 * bestMulti.score);
  if (!ranked.length) return [];

  // Pass 2 — attach provenance for the top survivors only.
  const wanted = new Map(ranked.slice(0, 12).map((c) => [c.phrase, c]));
  for (const c of wanted.values()) {
    c.docs = [];
    c.docTs = [];
    c.firstTs = Infinity;
    c.lastTs = -Infinity;
    c.lastProject = null;
    c.projects = new Set();
    c.models = new Set();
  }
  for (let i = 0; i < docs.length; i++) {
    for (const phrase of perDoc[i]) {
      const c = wanted.get(phrase);
      if (!c) continue;
      c.docs.push(i);
      c.docTs.push(docs[i].ts);
      if (docs[i].ts < c.firstTs) c.firstTs = docs[i].ts;
      // `lastProject` travels with `lastTs`. The `projects` set is sorted for
      // determinism, so `projects[0]` is alphabetical — using it to caption a
      // quote stamped `lastTs` attributed «ship it» to a project called
      // a "3d-print" project purely because "3" sorts first.
      if (docs[i].ts > c.lastTs) {
        c.lastTs = docs[i].ts;
        c.lastProject = docs[i].project || null;
      }
      if (docs[i].project) c.projects.add(docs[i].project);
      if (docs[i].model) c.models.add(docs[i].model);
    }
  }
  return ranked.slice(0, 12).map((c) => ({
    ...c,
    projects: [...(c.projects || [])].sort(),
    models: [...(c.models || [])].sort(),
    tie: hash32(c.phrase),
  }));
}

function isSubPhrase(small, big) {
  return (' ' + big + ' ').includes(' ' + small + ' ');
}

/**
 * Phrases that show up in the first agent message of most sessions: system
 * preamble, not personality.
 * @param {string[]} firstMessages
 * @param {number} sessionCount
 */
export function preamblePhrases(firstMessages, sessionCount) {
  if (!sessionCount) return new Set();
  const df = new Map();
  for (const m of firstMessages) {
    for (const p of new Set(ngramsOf(m, MAX_N))) df.set(p, (df.get(p) || 0) + 1);
  }
  const out = new Set();
  const cut = 0.6 * sessionCount;
  for (const [p, c] of df) if (c > cut) out.add(p);
  return out;
}

/** Token-set Jaccard similarity, for déjà-vu detection. */
export function jaccard(aTokens, bTokens) {
  const A = aTokens instanceof Set ? aTokens : new Set(aTokens);
  const B = bTokens instanceof Set ? bTokens : new Set(bTokens);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}
