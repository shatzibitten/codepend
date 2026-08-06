/**
 * @module redact
 *
 * codepend never uploads anything, so redaction is not about protecting you from
 * us — it's about what happens 30 seconds later, when you screenshot the page
 * and post it. Everything here exists because a real corpus contains real
 * secrets: absolute paths with your username, an API key you pasted into a
 * prompt at 2 AM, the customer email in a stack trace.
 *
 * Three levels:
 *   off       — pass through untouched (your machine, your call)
 *   safe      — DEFAULT. secrets, credentials, emails, IPs, phone numbers and
 *               file paths gone. Prose and project names stay.
 *               Paths go because the home directory is not the sensitive part:
 *               `~/Downloads/<client>/<contract>.docx` has no username in it and
 *               is still the last thing you want on a screenshot.
 *   paranoid  — the above, plus every path, filename and URL.
 *
 * Pure and deterministic: same input, same output, forever. No I/O, no clock,
 * no randomness. Runs in Node and in the browser.
 */

/** Redaction is destructive by design; each tag says what used to be there. */
const TAG = {
  email: '[email]',
  secret: '[secret]',
  token: '[token]',
  key: '[private key]',
  jwt: '[jwt]',
  ip: '[ip]',
  mac: '[mac]',
  phone: '[phone]',
  card: '[card]',
  webhook: '[webhook url]',
  tmp: '[tmp path]',
  path: '[path]',
  file: '[file]',
  link: '[link]',
};

/* ------------------------------------------------------------------ *
 * Detectors
 * ------------------------------------------------------------------ */

/** Names that make a `KEY=value` pair a credential regardless of entropy. */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASS|PWD|CRED|AUTH|SESSION|COOKIE|PRIVATE|SIGNATURE|SALT|DSN|BEARER)/;

/** Shannon entropy in bits/char. ~3.2+ over 20 chars means "not a word". */
function entropy(s) {
  const freq = new Map();
  for (const ch of s) freq.set(ch, (freq.get(ch) || 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Luhn check — keeps 16 random digits from being mistaken for a card number. */
function luhn(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/**
 * Ordered rule list. Order matters: structured secrets first (so a key inside a
 * URL is caught as a key), broad shapes last.
 * `hint` is a cheap substring pre-check — most turns match no rule at all, and
 * this runs over every human turn in a 4.6 GB corpus.
 * @type {{re: RegExp, to: string|((...m:any[])=>string), hint?: string}[]}
 */
const SAFE_RULES = [
  // PEM blocks. Greedy across newlines on purpose — the whole block goes.
  {
    hint: '-----BEGIN',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    to: TAG.key,
  },
  { hint: '-----BEGIN', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/g, to: TAG.key },
  { hint: 'AGE-SECRET-KEY', re: /AGE-SECRET-KEY-1[0-9A-Z]{20,}/g, to: TAG.key },

  // Vendor-shaped tokens. Cheap, exact, and the ones people actually paste.
  { hint: 'sk-ant', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g, to: TAG.secret },
  { hint: 'sk-', re: /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, to: TAG.secret },
  { hint: '_live_', re: /\b[a-z]{2}_live_[A-Za-z0-9]{12,}/g, to: TAG.secret },
  { hint: '_test_', re: /\b[a-z]{2}_test_[A-Za-z0-9]{12,}/g, to: TAG.secret },
  { hint: 'gh', re: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, to: TAG.secret },
  { hint: 'github_pat_', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, to: TAG.secret },
  { hint: 'glpat-', re: /\bglpat-[A-Za-z0-9_-]{16,}/g, to: TAG.secret },
  { hint: 'AKIA', re: /\bAKIA[0-9A-Z]{16}\b/g, to: TAG.secret },
  { hint: 'ASIA', re: /\bASIA[0-9A-Z]{16}\b/g, to: TAG.secret },
  { hint: 'xox', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, to: TAG.secret },
  { hint: 'AIza', re: /\bAIza[0-9A-Za-z_-]{30,}/g, to: TAG.secret },
  { hint: 'npm_', re: /\bnpm_[A-Za-z0-9]{30,}/g, to: TAG.secret },
  { hint: 'hf_', re: /\bhf_[A-Za-z0-9]{30,}/g, to: TAG.secret },
  { hint: 'dop_v1_', re: /\bdop_v1_[a-f0-9]{40,}/g, to: TAG.secret },
  { hint: 'SG.', re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, to: TAG.secret },

  // JWTs. Three-part is the common shape; two-part unsigned still leaks claims.
  { hint: 'eyJ', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+)?/g, to: TAG.jwt },

  // Authorization headers of any flavour. No `hint` — the scheme word varies.
  { re: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9\-._~+/]{16,}={0,2}/gi, to: (_m, scheme) => `${scheme} ${TAG.token}` },

  // Webhooks are URLs whose path *is* the credential.
  {
    hint: '://',
    re: /https?:\/\/(?:hooks\.slack\.com|discord(?:app)?\.com\/api\/webhooks|[\w.-]*\.webhook\.office\.com)\/\S+/gi,
    to: TAG.webhook,
  },
  // Credentials embedded in a connection string.
  {
    hint: '://',
    re: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi,
    to: (_m, scheme) => `${scheme}${TAG.secret}@`,
  },

  // KEY=value pairs: named credentials, or anything that doesn't look like a
  // word. Separator may be `=` or `:`, so no cheap hint is available.
  {
    re: /\b([A-Z][A-Z0-9_]{2,})(\s*[:=]\s*)(['"]?)([^\s'"`,;]{8,})\3/g,
    to: (m, name, sep, q, val) => {
      const named = SECRET_NAME.test(name);
      const random = val.length >= 20 && entropy(val) >= 3.2 && /\d/.test(val) && /[A-Za-z]/.test(val);
      return named || random ? `${name}${sep}${TAG.secret}` : m;
    },
  },

  // Email. `@types/node` and `@mentions` don't match — a dotted TLD is required.
  { hint: '@', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g, to: TAG.email },

  // Payment cards, Luhn-gated so token counts survive.
  {
    re: /\b(?:\d{13,19}|\d{4}(?:[ -]\d{4}){2,3}(?:[ -]\d{1,4})?)\b/g,
    to: (m) => {
      const digits = m.replace(/\D/g, '');
      return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? TAG.card : m;
    },
  },

  // Phone numbers. Requires a `+`, parens, or dashed US shape — bare digit runs
  // are almost always line counts, ports or token totals.
  { hint: '+', re: /\+\d{1,3}[\s.-]?\(?\d{2,4}\)?(?:[\s.-]?\d{2,4}){2,3}\b/g, to: TAG.phone },
  { re: /\(\d{3}\)\s?\d{3}[- ]?\d{4}\b/g, to: TAG.phone },
  { re: /\b\d{3}-\d{3}-\d{4}\b/g, to: TAG.phone },

  { hint: ':', re: /\b(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b/g, to: TAG.mac },

  // IPv6. Matched loosely, then validated in the replacer — a strict regex
  // either misses `fe80::1` or eats `[00:12:34 - 00:12:40]` transcript stamps
  // and `10:30:45` clock times. Only `::` compression or a full 8 groups counts.
  {
    hint: ':',
    re: /(?<![\w:.])[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,7}(?:%\w+)?(?![\w.])/g,
    to: (m) => {
      const groups = m.replace(/%.*$/, '').split(':').length;
      return m.includes('::') || groups >= 8 ? TAG.ip : m;
    },
  },

  // IPv4, octet-validated. Loopback and 0.0.0.0 stay: they identify nobody and
  // they're half the dev-server URLs in any corpus.
  {
    hint: '.',
    re: /(?<![\w.-])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\w.-])/g,
    to: (m) => (m === '127.0.0.1' || m === '0.0.0.0' || m === '255.255.255.255' ? m : TAG.ip),
  },

  // macOS per-user temp dirs carry an opaque user hash.
  { hint: '/var/folders/', re: /\/var\/folders\/\S+/g, to: TAG.tmp },
];

/**
 * A path with two or more segments, tolerating the two things real paths have
 * and the old pattern did not: spaces inside a segment (`My Documents`) and
 * non-ASCII filenames (`договор_итог.docx`).
 *
 * Bounded to three interior spaces so it stops at the end of the path instead of
 * eating the sentence that follows it.
 */
const DEEP_PATH_RE = /(?<![:\w/])(?:~|\.{1,2})?(?:\/[\p{L}\p{N}._@+-]+){2,}\/?/gu;

/**
 * The space-tolerant variant, kept separate and anchored hard.
 *
 * Allowing spaces in the general pattern is how `and/or something, 3/4 done`
 * becomes a file path. This one only fires on something rooted at `~/` or `/`
 * that *ends in a file extension*, which is the shape `My Documents/….docx`
 * has and prose does not.
 */
const SPACED_PATH_RE =
  /(?<![:\w/])(?:~|\.{1,2})?(?:\/[\p{L}\p{N}._@+-]+(?:[ \t][\p{L}\p{N}._@+-]+){0,3})+\.[A-Za-z0-9]{1,8}\b/gu;

/**
 * Paths at safe level.
 *
 * Collapsing `/Users/you` to `~` was the whole rule, which quietly assumed the
 * rest of a path is harmless. It is not: a real quote in the corpus was
 * `@~/Downloads/<folder>/<date>_reply_<client>.docx …`, and it reached a share
 * card intact — the home directory was gone and the client's document name was
 * not. Nothing downstream needs the path either:
 * project names come from `session.project`, not from parsing prose.
 *
 * So a deep path becomes `[file]` and a bare `/Users/you` still becomes `~`,
 * which keeps `cd ~` style prose readable.
 */
const HOME_RULES = [
  { hint: '/', re: SPACED_PATH_RE, to: TAG.file },
  { hint: '/', re: DEEP_PATH_RE, to: TAG.file },
  { hint: '\\', re: /\b[A-Za-z]:\\[^\s"'`]+/g, to: TAG.file },
  { hint: '/', re: /\/(?:Users|home)\/[^/\s"'`:*?<>|]+/g, to: '~' },
  { hint: ':\\', re: /\b[A-Za-z]:\\Users\\[^\\/\s"'`]+/g, to: '~' },
];

const PARANOID_RULES = [
  { hint: '://', re: /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, to: TAG.link },
  { hint: '\\', re: /\b[A-Za-z]:\\[^\s"'`]+/g, to: TAG.path },
  { hint: '/', re: /(?:~|\.{1,2})?(?:\/[\w.@+-]+){2,}\/?/g, to: TAG.path },
  {
    hint: '.',
    re: /\b[\w-]+\.(?:js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|swift|cpp|hpp|cs|php|sh|zsh|bash|json|ya?ml|toml|ini|env|md|txt|html?|css|scss|sql|xml|lock|log|csv|pdf|png|jpe?g|svg)\b/gi,
    to: TAG.file,
  },
];

/**
 * Escape a literal string for use inside a RegExp.
 * @param {string} s
 */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function apply(text, rules) {
  let out = text;
  for (const rule of rules) {
    if (rule.hint && out.indexOf(rule.hint) === -1) continue;
    out = out.replace(rule.re, rule.to);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * Build a redactor.
 *
 * @param {'off'|'safe'|'paranoid'} [level='safe']
 * @param {{ home?: string }} [opts] `home` overrides the detected home dir,
 *   which is the only environment-dependent input. Pass it in tests.
 * @returns {((text: string) => string) & { level: string }}
 */
export function makeRedactor(level = 'safe', opts = {}) {
  const lvl = level || 'safe';

  if (lvl === 'off') {
    const passthrough = (text) => (typeof text === 'string' ? text : text == null ? '' : String(text));
    passthrough.level = 'off';
    return passthrough;
  }

  // The literal home path is checked first so `/Users/someone-else/` (which the
  // generic rule also catches) never masks the fact that this one is *yours*.
  const home = opts.home ?? detectHome();
  const homeRules = home && home !== '/' ? [{ hint: home, re: new RegExp(escapeRe(home), 'g'), to: '~' }, ...HOME_RULES] : HOME_RULES;

  const rules = lvl === 'paranoid' ? [...SAFE_RULES, ...homeRules, ...PARANOID_RULES] : [...SAFE_RULES, ...homeRules];

  /** @param {string} text */
  const redact = (text) => {
    if (typeof text !== 'string') return text == null ? '' : String(text);
    if (text.length === 0) return text;
    return apply(text, rules);
  };
  redact.level = lvl;
  return redact;
}

/**
 * True if the text contains anything the redactor would strip.
 * The share card refuses to render a string that trips this, even at
 * `--redact off` — nothing gets posted to the internet that we'd have hidden.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksSensitive(text) {
  if (typeof text !== 'string' || !text) return false;
  for (const rule of SAFE_RULES) {
    if (rule.hint && text.indexOf(rule.hint) === -1) continue;
    rule.re.lastIndex = 0;
    // Function replacers self-validate (Luhn, octets, IPv6 shape), so a plain
    // `test` would over-report. Compare the replacement instead.
    if (typeof rule.to === 'function') {
      if (text.replace(rule.re, rule.to) !== text) return true;
    } else {
      const hit = rule.re.test(text);
      rule.re.lastIndex = 0;
      if (hit) return true;
    }
  }
  return false;
}

/**
 * Collapse a filesystem path for display: home to `~`, and (at paranoid) gone.
 * @param {string} p
 * @param {'off'|'safe'|'paranoid'} [level]
 */
export function redactPath(p, level = 'safe') {
  if (typeof p !== 'string' || !p) return '';
  if (level === 'off') return p;
  if (level === 'paranoid') return TAG.path;
  return apply(p, [{ re: new RegExp(escapeRe(detectHome()), 'g'), to: '~' }, ...HOME_RULES]);
}

/** Home directory, without importing `node:os` into the browser bundle. */
function detectHome() {
  const env = typeof process !== 'undefined' && process.env ? process.env : {};
  return env.CODEPEND_HOME || env.HOME || env.USERPROFILE || '';
}

export const REDACTION_TAGS = TAG;
