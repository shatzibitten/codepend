/**
 * Shared, dependency-free machinery for every detector.
 *
 * Everything in here is pure and deterministic. No Math.random, no Date.now —
 * two runs over the same corpus must produce byte-identical output, and there
 * is a test that proves it.
 */

/* ------------------------------------------------------------------ hashing */

/**
 * FNV-1a over UTF-16 code units. Stable across Node and browsers.
 * @param {string} s
 * @returns {number} uint32
 */
export function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Deterministic variant pick: title+body block. */
export function pickBlock(id, blocks) {
  return blocks[hash32(id + '|v') % blocks.length];
}

/** Deterministic eyebrow pick (independent of the block — eyebrows are structural). */
export function pickEyebrow(id, eyebrows) {
  return eyebrows[hash32(id + '|e') % eyebrows.length];
}

/** Deterministic pick from an arbitrary list with a caller-chosen salt. */
export function pickSalted(id, salt, list) {
  return list[hash32(id + '|' + salt) % list.length];
}

/* -------------------------------------------------------------------- math */

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => (Number.isFinite(v) ? clamp(v, 0, 1) : 0);

/** Median of a numeric array. Does not mutate. */
export function median(arr) {
  if (!arr.length) return 0;
  const a = arr.slice().sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Nearest-rank percentile, p in 0..1. */
export function percentile(arr, p) {
  if (!arr.length) return 0;
  const a = arr.slice().sort((x, y) => x - y);
  const i = clamp(Math.ceil(p * a.length) - 1, 0, a.length - 1);
  return a[i];
}

/* --------------------------------------------------------- text + language */

// Letters and digits, with internal apostrophes/hyphens. \p{L} covers Cyrillic
// natively — no transliteration, no latin1, no mojibake.
//
// A token may only START with a letter or a digit, but it may CONTINUE with a
// combining mark: Devanagari matras and the virama, Hebrew niqqud and Arabic
// harakat are \p{M}, and without this "लॉगिन" shatters into three tokens. On
// NFC text with no combining marks this is character-for-character the old
// `[\p{L}\p{N}]+`, so Latin and Cyrillic counts are untouched — and a lone
// combining mark still cannot become a word, which is what keeps emoji
// variation selectors out of the token stream.
const LETTER = '[\\p{L}\\p{N}][\\p{L}\\p{N}\\p{M}]*';
const WORD_RE = new RegExp(`${LETTER}(?:[’'\\-]${LETTER})*`, 'gu');

// Scripts that do not put spaces between words: Han (+ the two iteration marks
// that behave like ideographs), Hiragana, Katakana, halfwidth Katakana, Thai,
// Lao, Myanmar, Khmer, and the astral CJK extension planes. Hangul is NOT here —
// Korean is space-delimited and the regex path handles it correctly.
const UNSEG =
  '\\u3005\\u3006\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff66-\\uff9f' +
  '\\u0e00-\\u0e7f\\u0e80-\\u0eff\\u1000-\\u109f\\u1780-\\u17ff\\u{20000}-\\u{3ffff}';

// Cheap pre-check: one test, no allocation, no capture. Every Latin/Cyrillic
// turn in the corpus pays exactly this and nothing more.
const UNSEG_RE = new RegExp(`[${UNSEG}]`, 'u');
// Maximal runs of unsegmented script. Everything between them keeps WORD_RE.
const UNSEG_RUN_RE = new RegExp(`[${UNSEG}]+`, 'gu');

let wordSegmenter; // undefined = not tried yet, false = unavailable
function getWordSegmenter() {
  if (wordSegmenter === undefined) {
    try {
      wordSegmenter =
        typeof Intl !== 'undefined' && Intl.Segmenter
          ? new Intl.Segmenter(undefined, { granularity: 'word' })
          : false;
    } catch {
      wordSegmenter = false;
    }
  }
  return wordSegmenter;
}

/** Tokens of one unsegmented-script run. Never throws. */
function segmentRun(run) {
  const seg = getWordSegmenter();
  if (seg) {
    try {
      const out = [];
      for (const s of seg.segment(run)) {
        if (s.isWordLike) out.push(s.segment.toLowerCase());
      }
      return out;
    } catch {
      wordSegmenter = false; // do not pay for a broken Segmenter twice
    }
  }
  // Fallback: one token per code point. Wrong, but far closer to the truth than
  // one token per sentence — a CJK character is roughly a morpheme.
  return Array.from(run, (c) => c.toLowerCase());
}

/** Regex-path tokens, appended into `out`. */
function pushRegexWords(out, chunk) {
  const m = chunk.match(WORD_RE);
  if (m) for (const w of m) out.push(w.toLowerCase());
}

/**
 * The one tokenizer. `String.prototype.split(' ')` is banned in this codebase.
 *
 * Latin, Cyrillic, Greek, Arabic, Hebrew, Hangul and friends take the regex
 * path — it is correct for them and several times faster. Text that contains
 * Han/Kana/Thai/Khmer/Lao/Myanmar is cut into script runs; the unsegmented runs
 * go through Intl.Segmenter, everything around them still takes the regex path,
 * so "well-known" and "don't" stay single tokens even in mixed text.
 *
 * @param {string} text
 * @returns {string[]} NFC-normalized, lowercased tokens
 */
export function words(text) {
  if (!text) return [];
  const s = text.normalize('NFC');
  if (!UNSEG_RE.test(s)) {
    return (s.match(WORD_RE) || []).map((w) => w.toLowerCase());
  }
  const out = [];
  let last = 0;
  UNSEG_RUN_RE.lastIndex = 0;
  let m;
  while ((m = UNSEG_RUN_RE.exec(s)) !== null) {
    if (m.index > last) pushRegexWords(out, s.slice(last, m.index));
    for (const w of segmentRun(m[0])) out.push(w);
    last = m.index + m[0].length;
  }
  if (last < s.length) pushRegexWords(out, s.slice(last));
  return out;
}

// The n-gram miner joins its tokens with a space, because that is what a phrase
// looks like in every script that uses spaces. In the ones that don't, the join
// is an artefact of our own tokenizer and it shows: the top Chinese catchphrase
// rendered as «修复 认证 模 块» instead of «修复认证模块». Undo it at the point
// of display only — the mined phrase itself keeps the spaces, because they are
// what makes it a stable key and what `isSubPhrase` matches on.
const UNSEG_JOIN_RE = new RegExp(`([${UNSEG}])[ ]+(?=[${UNSEG}])`, 'gu');

/**
 * A mined n-gram, as a person of that language would write it.
 * Latin, Cyrillic and Hangul phrases pass through untouched.
 * @param {string} phrase
 */
export function displayPhrase(phrase) {
  const s = String(phrase || '');
  return UNSEG_RE.test(s) ? s.replace(UNSEG_JOIN_RE, '$1') : s;
}

/* ------------------------------------------------------------ script census */

const SC_NONE = 0;
const SC_LATIN = 1;
const SC_CYRILLIC = 2;
const SC_HAN = 3;
const SC_KANA = 4;
const SC_HANGUL = 5;
const SC_ARABIC = 6;
const SC_HEBREW = 7;
const SC_DEVANAGARI = 8;
const SC_OTHER = 9;

/** Script of one code point. Digits and punctuation are SC_NONE. */
function scriptOf(cp) {
  if (cp < 0xc0) {
    if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) return SC_LATIN;
    return SC_NONE;
  }
  if (cp <= 0x24f || (cp >= 0x1e00 && cp <= 0x1eff)) return SC_LATIN; // + Ext-A/B, Additional
  if (cp >= 0x300 && cp <= 0x36f) return SC_NONE; // combining marks belong to no script
  if (cp >= 0x400 && cp <= 0x52f) return SC_CYRILLIC;
  if (cp >= 0x590 && cp <= 0x5ff) return SC_HEBREW;
  if ((cp >= 0x600 && cp <= 0x6ff) || (cp >= 0x750 && cp <= 0x77f) ||
      (cp >= 0xfb50 && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfeff)) return SC_ARABIC;
  if (cp >= 0x900 && cp <= 0x97f) return SC_DEVANAGARI;
  if ((cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0xff66 && cp <= 0xff9f)) return SC_KANA;
  if (cp === 0x3005 || cp === 0x3006 ||
      (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x20000 && cp <= 0x3ffff)) return SC_HAN;
  if ((cp >= 0x1100 && cp <= 0x11ff) || (cp >= 0x3130 && cp <= 0x318f) ||
      (cp >= 0xac00 && cp <= 0xd7a3)) return SC_HANGUL;
  if (cp >= 0x370 && cp <= 0x3ff) return SC_OTHER; // Greek — named honestly as 'mixed'
  return SC_OTHER;
}

/** Dominant script of a single token; SC_NONE for pure digits. */
function tokenScript(tok) {
  const seen = new Array(10).fill(0);
  for (const ch of tok) {
    const sc = scriptOf(ch.codePointAt(0));
    if (sc !== SC_NONE) seen[sc]++;
  }
  let best = SC_NONE;
  let bestN = 0;
  for (let i = 1; i < seen.length; i++) {
    if (seen[i] > bestN) { best = i; bestN = seen[i]; }
  }
  return best;
}

/* ------------------------------------------------- Latin-script attribution */

// High-signal function words. Deliberately small: these are tie-breakers, not a
// language model. Words shared across sibling languages ("de", "no", "la") are
// left out on purpose — they carry no signal and only add noise.
const LATIN_HINTS = [
  ['en', ['the', 'and', 'you', 'is', 'are', 'to', 'of', 'it', 'that', 'this', 'please',
    'can', 'could', 'thanks', 'thank', 'i', 'we', 'my', 'for', 'with', 'what', 'why',
    'how', 'fix', 'add', 'make', 'but', 'have', 'does', 'need', 'want', 'should',
    'would', 'now', 'just', 'here', 'there', 'about', 'from', 'was', 'been']],
  ['de', ['der', 'die', 'das', 'und', 'nicht', 'ist', 'ich', 'du', 'kannst', 'kann',
    'bitte', 'danke', 'für', 'aber', 'eine', 'einen', 'wird', 'sind', 'auch', 'noch',
    'schon', 'warum', 'wie', 'was', 'habe', 'hast', 'muss', 'soll', 'sehr', 'mehr',
    'beheben', 'fehler', 'machen', 'wenn', 'dann', 'oder', 'über', 'nach', 'zum',
    'zur', 'den', 'dem', 'des', 'ein', 'wir', 'jetzt', 'nochmal']],
  ['es', ['el', 'los', 'las', 'que', 'por', 'para', 'gracias', 'puedes', 'puede',
    'pero', 'cómo', 'qué', 'también', 'muy', 'más', 'hola', 'favor', 'una', 'esto',
    'este', 'esta', 'está', 'están', 'hacer', 'arreglar', 'ahora', 'todo',
    'porque', 'cuando', 'dónde', 'sesión', 'usted', 'tengo', 'quiero', 'necesito']],
  ['pt', ['você', 'não', 'obrigado', 'obrigada', 'uma', 'isso', 'então', 'muito',
    'mais', 'olá', 'corrigir', 'erro', 'fazer', 'pode', 'são', 'está', 'também',
    'com', 'para', 'porque', 'quando', 'onde', 'agora', 'tudo', 'quero', 'preciso',
    'ficou', 'aqui', 'meu', 'minha', 'seu']],
  ['fr', ['le', 'les', 'des', 'une', 'est', 'pas', 'vous', 'je', 'ne', 'qui', 'pour',
    'avec', 'merci', 'plaît', 'peux', 'peut', 'corriger', 'erreur', 'bonjour', 'dans',
    'sur', 'mais', 'très', 'bien', 'cette', 'être', 'faire', 'aux', 'nous', 'ça',
    'alors', 'toujours', 'aussi', 'quand', 'pourquoi', 'comment']],
  ['it', ['il', 'lo', 'gli', 'che', 'non', 'per', 'con', 'una', 'sono', 'grazie',
    'puoi', 'errore', 'ciao', 'questo', 'questa', 'anche', 'molto', 'più',
    'perché', 'della', 'del', 'sei', 'fare', 'correggere', 'adesso', 'quando',
    'voglio', 'devo']],
  ['nl', ['het', 'een', 'niet', 'ik', 'jij', 'dat', 'deze', 'voor', 'kun', 'kunt',
    'alsjeblieft', 'bedankt', 'dank', 'maar', 'wat', 'hoe', 'waarom', 'moet', 'ook',
    'nog', 'graag', 'fout', 'oplossen', 'wordt', 'zijn', 'hebben', 'naar',
    'heb', 'mijn']],
  ['sv', ['och', 'att', 'inte', 'jag', 'är', 'det', 'för', 'med', 'tack', 'hej',
    'som', 'till', 'på', 'vad', 'hur', 'varför', 'fel', 'snälla', 'ska',
    'har', 'kan', 'den', 'ett', 'nu', 'också', 'göra', 'fixa']],
  ['pl', ['nie', 'jest', 'że', 'się', 'dla', 'przez', 'dziękuję', 'proszę', 'czy',
    'jak', 'ale', 'tylko', 'bardzo', 'błąd', 'napraw', 'mogę', 'możesz', 'jeszcze',
    'teraz', 'gdzie', 'dlaczego', 'jestem', 'chcę', 'trzeba']],
  ['tr', ['bir', 've', 'bu', 'için', 'ile', 'değil', 'lütfen', 'teşekkür',
    'teşekkürler', 'nasıl', 'var', 'yok', 'olarak', 'hata', 'düzelt', 'çok',
    'şimdi', 'ama', 'daha', 'sonra', 'misin', 'musun', 'yapabilir']],
];

const LATIN_SETS = LATIN_HINTS.map(([code, list]) => [code, new Set(list)]);

// Presence of a diacritic is worth about one function word. Counted once per
// character class, so a single long word cannot swing the verdict.
const DIACRITICS = [
  ['ñ', { es: 2 }], ['ß', { de: 3 }], ['ä', { de: 1, sv: 1 }], ['ö', { de: 1, sv: 1, tr: 0.5 }],
  ['ü', { de: 1, tr: 0.5 }], ['ã', { pt: 2 }], ['õ', { pt: 2 }], ['ç', { pt: 1, fr: 1, tr: 0.5 }],
  ['é', { fr: 1, es: 0.5, pt: 0.5 }], ['è', { fr: 1, it: 1 }], ['à', { fr: 0.5, it: 1 }],
  ['ò', { it: 1 }], ['ù', { fr: 0.5, it: 1 }], ['û', { fr: 1 }], ['œ', { fr: 2 }],
  ['å', { sv: 2 }], ['ı', { tr: 2 }], ['ğ', { tr: 2 }], ['ş', { tr: 2 }],
  ['ą', { pl: 2 }], ['ę', { pl: 2 }], ['ł', { pl: 2 }], ['ń', { pl: 2 }],
  ['ś', { pl: 2 }], ['ż', { pl: 2 }], ['ź', { pl: 2 }], ['ć', { pl: 1.5 }],
];

/** Which Latin-script language, if any of them speak up loudly enough. */
function latinLang(toks) {
  const score = new Map();
  for (const [code] of LATIN_SETS) score.set(code, 0);
  for (const tok of toks) {
    for (const [code, set] of LATIN_SETS) {
      if (set.has(tok)) score.set(code, score.get(code) + 1);
    }
  }
  const joined = toks.join(' ');
  for (const [ch, weights] of DIACRITICS) {
    if (joined.includes(ch)) {
      for (const code in weights) score.set(code, score.get(code) + weights[code]);
    }
  }
  const en = score.get('en');
  let best = 'en';
  let bestScore = en;
  for (const [code] of LATIN_SETS) {
    // Strictly greater keeps ties with English, and with an earlier language in
    // the fixed list above, resolving the same way on every run.
    if (code !== 'en' && score.get(code) > bestScore) {
      best = code;
      bestScore = score.get(code);
    }
  }
  // Two function words is the floor. Below that we are guessing, and the honest
  // answer for unknown Latin text is the default.
  if (best === 'en' || bestScore < 2 || bestScore <= en) return 'en';
  return best;
}

const UK_ONLY = /[іїєґ]/; // Ukrainian letters that Russian does not have

/**
 * Language of a run of text: script census first, then function words for the
 * Latin block. Returns 'en' when Latin signal is weak and 'mixed' when two
 * scripts genuinely compete — it never claims more than it can see.
 *
 * @returns {'en'|'ru'|'de'|'es'|'fr'|'pt'|'it'|'zh'|'ja'|'ko'|'ar'|'he'|'hi'|'tr'|'pl'|'uk'|'nl'|'sv'|'mixed'|'none'}
 */
export function detectLang(text) {
  const toks = words(text);
  if (!toks.length) return 'none';

  const counts = new Array(10).fill(0);
  const latin = [];
  for (const t of toks) {
    const sc = tokenScript(t);
    if (sc === SC_NONE) continue;
    counts[sc]++;
    if (sc === SC_LATIN) latin.push(t);
  }

  // Han and Kana are one family — Japanese mixes them inside a single sentence.
  const cjk = counts[SC_HAN] + counts[SC_KANA];
  const families = [
    [SC_LATIN, counts[SC_LATIN]],
    [SC_CYRILLIC, counts[SC_CYRILLIC]],
    [SC_HAN, cjk],
    [SC_HANGUL, counts[SC_HANGUL]],
    [SC_ARABIC, counts[SC_ARABIC]],
    [SC_HEBREW, counts[SC_HEBREW]],
    [SC_DEVANAGARI, counts[SC_DEVANAGARI]],
    [SC_OTHER, counts[SC_OTHER]],
  ];
  let total = 0;
  for (const [, n] of families) total += n;
  if (!total) return 'none'; // digits only

  let top = SC_NONE;
  let topN = 0;
  for (const [sc, n] of families) {
    if (n > topN) { top = sc; topN = n; }
  }
  if (topN / total < 0.6) return 'mixed';

  switch (top) {
    case SC_LATIN: return latinLang(latin);
    case SC_CYRILLIC: return UK_ONLY.test(toks.join(' ')) ? 'uk' : 'ru';
    // Any kana at all settles Japanese vs Chinese; Chinese never uses it.
    case SC_HAN: return counts[SC_KANA] > 0 ? 'ja' : 'zh';
    case SC_HANGUL: return 'ko';
    case SC_ARABIC: return 'ar';
    case SC_HEBREW: return 'he';
    case SC_DEVANAGARI: return 'hi';
    default: return 'mixed'; // a script we do not name — say so rather than guess
  }
}

const LANG_NAMES = {
  en: 'English', ru: 'Russian', uk: 'Ukrainian', de: 'German', es: 'Spanish',
  fr: 'French', pt: 'Portuguese', it: 'Italian', nl: 'Dutch', sv: 'Swedish',
  pl: 'Polish', tr: 'Turkish', zh: 'Chinese', ja: 'Japanese', ko: 'Korean',
  ar: 'Arabic', he: 'Hebrew', hi: 'Hindi', mixed: 'mixed', none: 'none',
};

/** Human-readable name for a language code. */
export function langName(code) {
  return LANG_NAMES[code] || code;
}

let segmenter = null;
function graphemes(s) {
  if (segmenter === null) {
    segmenter =
      typeof Intl !== 'undefined' && Intl.Segmenter
        ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
        : false;
  }
  if (segmenter) return Array.from(segmenter.segment(s), (x) => x.segment);
  return Array.from(s); // code-point fallback — still never splits a surrogate pair
}

/** Truncate on a grapheme boundary, appending a real ellipsis. */
export function truncate(s, max) {
  const g = graphemes(s);
  if (g.length <= max) return s;
  return g.slice(0, max - 1).join('').trimEnd() + '…';
}

/** Collapse whitespace so a quote fits on a card. */
export function flatten(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/** Same, but also drops leading punctuation — real prompts start mid-thought. */
export function flattenQuote(s) {
  const flat = flatten(s);
  const trimmed = flat.replace(/^[\s.,;:!?"'`«»\-–—*#>]+/, '').trim();
  // A message that is *only* punctuation — a lone "?" is a real thing people send — used to
  // strip to nothing and render as an empty pair of quotation marks. Keep the original: the
  // leading-punctuation trim is cosmetic, and it must never delete the whole quote.
  return trimmed || flat.trim();
}

/* -------------------------------------------------------------- formatting */

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const THIN = ' '; // thin space, for grouping large numbers

/** `21 910` — thin-space grouped at or above 10 000, plain below. */
export function fmtNum(n) {
  const v = Math.round(n || 0);
  if (Math.abs(v) < 10000) return String(v);
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, THIN);
}

/** `1.2M`, `6.8B` — for token counts that would otherwise be unreadable. */
export function fmtBig(n) {
  const v = Math.round(n || 0);
  if (v >= 1e9) return trimZero((v / 1e9).toFixed(1)) + 'B';
  if (v >= 1e6) return trimZero((v / 1e6).toFixed(1)) + 'M';
  if (v >= 1e4) return fmtNum(v);
  return String(v);
}
const trimZero = (s) => s.replace(/\.0$/, '');

/** `$3,450` above $100 (no cents), `$12.40` below. */
export function fmtMoney(v) {
  const n = Math.max(0, v || 0);
  if (n >= 100) return '$' + Math.round(n).toLocaleString('en-US');
  if (n >= 1) return '$' + n.toFixed(2);
  return '$' + n.toFixed(2);
}

/** Integer percent, no decimal. */
export function fmtPct(fraction) {
  return Math.round((fraction || 0) * 100) + '%';
}

/** `4h 12m` / `12m` / `45s`. */
export function fmtDuration(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

/** Humanized gap between two instants: `two minutes`, `an hour`, `three days`. */
export function fmtGap(ms) {
  const s = Math.round(Math.abs(ms) / 1000);
  if (s < 45) return `${s} seconds`;
  const m = Math.round(s / 60);
  if (m === 1) return 'a minute';
  if (m < 45) return `${spell(m)} minutes`;
  const h = Math.round(m / 60);
  if (h === 1) return 'an hour';
  if (h < 22) return `${spell(h)} hours`;
  const d = Math.round(h / 24);
  if (d === 1) return 'a day';
  if (d < 45) return `${spell(d)} days`;
  const mo = Math.round(d / 30);
  if (mo === 1) return 'a month';
  return `${spell(mo)} months`;
}

const SPELLED = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve'];
/** Spell out small numbers; prose reads better that way. */
export function spell(n) {
  return n >= 0 && n <= 12 ? SPELLED[n] : fmtNum(n);
}

export function plural(n, one, many) {
  return n === 1 ? one : many;
}

/** `«коммит и пуш»` — guillemets, whitespace-flattened, grapheme-safe truncation. */
export function fmtQuote(text, max = 180) {
  return '«' + truncate(flattenQuote(text), max) + '»';
}

/* ------------------------------------------------------- local-time helpers */

/**
 * Timezone helper. All date math in codepend is LOCAL — "3 a.m." must mean
 * 3 a.m. where the person lives, not in UTC.
 *
 * Offsets are memoized per UTC hour, which is exact everywhere except within
 * the single hour a DST transition happens (where it is off by at most the
 * transition size, for at most one bucket).
 *
 * @param {string} tz IANA zone id
 */
export function makeTz(tz) {
  let dtf;
  try {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch {
    dtf = new Intl.DateTimeFormat('en-US', {
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }
  const cache = new Map();

  function rawOffset(ts) {
    const p = {};
    for (const x of dtf.formatToParts(new Date(ts))) p[x.type] = x.value;
    const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    return asUTC - Math.floor(ts / 1000) * 1000;
  }

  function offset(ts) {
    const bucket = Math.floor(ts / 3600000);
    let o = cache.get(bucket);
    if (o === undefined) {
      o = rawOffset(bucket * 3600000);
      cache.set(bucket, o);
    }
    return o;
  }

  /** Local calendar fields for an instant. */
  function parts(ts) {
    const d = new Date(ts + offset(ts));
    return {
      y: d.getUTCFullYear(),
      mo: d.getUTCMonth(),
      d: d.getUTCDate(),
      h: d.getUTCHours(),
      mi: d.getUTCMinutes(),
      wd: d.getUTCDay(),
    };
  }

  /** Integer day number in local time. Differences are exact day counts. */
  function dayIndex(ts) {
    return Math.floor((ts + offset(ts)) / 86400000);
  }

  /** `YYYY-MM-DD` for a day index. */
  function keyFromIndex(idx) {
    const d = new Date(idx * 86400000);
    return (
      d.getUTCFullYear() + '-' +
      String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(d.getUTCDate()).padStart(2, '0')
    );
  }

  function partsFromIndex(idx) {
    const d = new Date(idx * 86400000);
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), wd: d.getUTCDay(), h: 0, mi: 0 };
  }

  const api = {
    tz,
    offset,
    parts,
    dayIndex,
    keyFromIndex,
    partsFromIndex,
    dayKey: (ts) => keyFromIndex(dayIndex(ts)),
    hour: (ts) => parts(ts).h,
    weekday: (ts) => parts(ts).wd,
    isWeekend: (ts) => {
      const w = parts(ts).wd;
      return w === 0 || w === 6;
    },
    /** `February 6, 2026` */
    date: (ts) => {
      const p = parts(ts);
      return `${MONTHS[p.mo]} ${p.d}, ${p.y}`;
    },
    /** `Feb 6` */
    shortDate: (ts) => {
      const p = parts(ts);
      return `${MONTHS_SHORT[p.mo]} ${p.d}`;
    },
    /** `February` */
    monthName: (ts) => MONTHS[parts(ts).mo],
    /** `Sunday` */
    weekdayName: (ts) => WEEKDAYS[parts(ts).wd],
    /** `3:47 AM` */
    time: (ts) => {
      const p = parts(ts);
      const ap = p.h < 12 ? 'AM' : 'PM';
      const h12 = p.h % 12 === 0 ? 12 : p.h % 12;
      return `${h12}:${String(p.mi).padStart(2, '0')} ${ap}`;
    },
    /** `3 PM` — for hour labels, where minutes are noise. */
    hourLabel: (h) => {
      const ap = h < 12 ? 'AM' : 'PM';
      const h12 = h % 12 === 0 ? 12 : h % 12;
      return `${h12} ${ap}`;
    },
    dateFromIndex: (idx) => {
      const p = partsFromIndex(idx);
      return `${MONTHS[p.mo]} ${p.d}, ${p.y}`;
    },
    shortDateFromIndex: (idx) => {
      const p = partsFromIndex(idx);
      return `${MONTHS_SHORT[p.mo]} ${p.d}`;
    },
    weekdayFromIndex: (idx) => WEEKDAYS[partsFromIndex(idx).wd],
  };
  return api;
}

/** `today` / `yesterday` / `3 days ago` — relative to now, in local days. */
export function relDay(tzh, ts, now) {
  const d = tzh.dayIndex(now) - tzh.dayIndex(ts);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 30) return `${d} days ago`;
  if (d < 60) return 'a month ago';
  if (d < 365) return `${Math.round(d / 30)} months ago`;
  const y = Math.round(d / 365);
  return y === 1 ? 'a year ago' : `${y} years ago`;
}

/** `six months` / `3 weeks` — a span, not a distance from now. */
export function fmtSpan(days) {
  if (days < 14) return `${days} ${plural(days, 'day', 'days')}`;
  if (days < 60) return `${Math.round(days / 7)} weeks`;
  if (days < 365) return `${Math.round(days / 30)} months`;
  const y = days / 365;
  return y < 1.5 ? 'a year' : `${(Math.round(y * 10) / 10).toString().replace(/\.0$/, '')} years`;
}

/* ---------------------------------------------------------- quote scoring */

const CODE_FENCE = /```|\n {4}\S/;
const URL_RE = /https?:\/\/|www\./i;
const ABS_PATH = /[/\\]|(^|\s)~\//;
const FILENAME = /\b[\w-]+\.(js|ts|tsx|jsx|md|json|py|go|rs|css|html|mp4|png|jpg|sh|yml|yaml|toml|txt|pbxproj)\b/i;
const LONG_ID = /[\w-]{24,}|\b\d{6,}\b/;

/**
 * §1.7 shared quote score. Higher is more screenshot-shaped.
 * @param {{text:string, redacted?:boolean}} turn
 */
export function quoteScore(turn) {
  const text = flattenQuote(turn.text || '');
  const g = text.length;
  let s = 1;
  s *= g >= 8 && g <= 160 ? 1 : 0.35;
  s *= CODE_FENCE.test(turn.text || '') || URL_RE.test(text) || ABS_PATH.test(text) ? 0.25 : 1;
  // A filename or a 30-character id in the quote reads as a log line, not a
  // sentence. It is the fastest way to make a beautiful card look like a crash.
  s *= FILENAME.test(text) || LONG_ID.test(text) ? 0.3 : 1;
  s *= /[?？]\s*$/.test(text) ? 1.25 : 1;
  s *= isAllCaps(text) ? 0.5 : 1;
  s *= turn.redacted ? 0.6 : 1;
  return s;
}

function isAllCaps(t) {
  const letters = t.replace(/[^\p{L}]/gu, '');
  if (letters.length < 6) return false;
  return letters === letters.toUpperCase() && letters !== letters.toLowerCase();
}

/**
 * Best quote from a pool. Ties broken by hash — never by array order.
 * @param {Array} pool turns with {text, ts, sessionId}
 * @param {(t:any)=>number} [bonus] extra multiplier per turn
 */
export function bestQuote(pool, bonus) {
  let best = null;
  let bestScore = -1;
  let bestTie = 0;
  for (const t of pool) {
    const sc = quoteScore(t) * (bonus ? bonus(t) : 1);
    if (sc <= 0) continue;
    const tie = hash32((t.sessionId || '') + ':' + t.ts);
    if (sc > bestScore + 1e-9 || (Math.abs(sc - bestScore) < 1e-9 && tie > bestTie)) {
      best = t;
      bestScore = sc;
      bestTie = tie;
    }
  }
  return best;
}

/* ------------------------------------------------------------ memory factory */

/**
 * Build a Memory from a detector spec. Handles id, seed, variant selection and
 * the weight formula (§1.4) so no detector has to.
 *
 * @param {object} ctx  the shared context from src/stats.js
 * @param {object} spec
 * @returns {object} Memory
 */
export function makeMemory(ctx, spec) {
  const id = `${spec.type}:${spec.key}`;
  const seed = hash32(id);
  const blocks = (spec.blocks || []).filter(Boolean);
  const block = spec.block || pickBlock(id, blocks);
  const eyebrow = spec.eyebrow || pickEyebrow(id, spec.eyebrows || ['']);

  const base = spec.base;
  const recencyMul = spec.recencyMul != null ? spec.recencyMul : recencyFor(ctx, spec.date);
  const magnitudeMul = 0.8 + 0.4 * clamp01(spec.magnitude == null ? 1 : spec.magnitude);
  const confidenceMul = spec.confidence == null ? 1 : spec.confidence;
  const weight = clamp(Math.round(base * recencyMul * magnitudeMul * confidenceMul), 0, 100);

  return {
    id,
    type: spec.type,
    kind: spec.kind,
    date: spec.date == null ? null : spec.date,
    weight,
    eyebrow,
    title: block.title,
    body: block.body == null ? null : block.body,
    stat: spec.stat || null,
    quote: spec.quote || null,
    chart: spec.chart || null,
    seed,
    agent: spec.agent === undefined ? null : spec.agent,
    project: spec.project === undefined ? null : spec.project,
    tags: spec.tags || [],
    shareable: spec.shareable !== false,
    // internal, stripped before the payload leaves detect.js
    _mag: magnitudeMul,
    _base: base,
    _ring: spec.ring || 'A',
  };
}

function recencyFor(ctx, date) {
  if (date == null) return 1;
  const age = ctx.tzh.dayIndex(ctx.now) - ctx.tzh.dayIndex(date);
  if (age <= 14) return 1.15;
  if (age <= 180) return 1.0;
  return 0.9;
}

/** Quote object for a Memory, redacted and shaped. */
export function quoteOf(ctx, turn, who) {
  if (!turn) return null;
  const text = ctx.redact(String(turn.text || ''));
  return {
    text: truncate(flattenQuote(text), 180),
    who: who || 'you',
    ts: turn.ts,
    project: turn.project || null,
  };
}
