import test from 'node:test';
import assert from 'node:assert/strict';
import { words, detectLang, langName } from '../src/detectors/_util.js';

/**
 * Tokenization and language detection for people who do not write in English.
 *
 * The bug this file exists to prevent: `[\p{L}\p{N}]+` sees a whole Chinese
 * sentence as one token, so a Chinese user's `wordCount` is 2, their median
 * prompt is "two words", and every archetype in the feed calls them terse.
 * Han/Kana/Thai/Khmer/Lao/Myanmar now go through Intl.Segmenter; everything
 * else keeps the regex, which is both correct and much faster.
 */

/* ------------------------------------------------------------ the six-language table */

const SENTENCES = [
  // [label, text, expected token count, expected language code]
  ['EN', 'can you fix the login bug please', 7, 'en'],
  ['DE', 'kannst du bitte den Login-Fehler beheben, danke', 7, 'de'],
  ['ES', 'puedes arreglar el error de inicio de sesión, por favor gracias', 11, 'es'],
  ['RU', 'почини пожалуйста баг с логином, спасибо', 6, 'ru'],
  ['ZH', '请帮我修复这个登录错误，谢谢', 8, 'zh'],
  ['JA', 'ログインのバグを直してください、ありがとう', 9, 'ja'],
];

test('the same sentence in six languages yields a comparable word count', () => {
  for (const [label, text, n, code] of SENTENCES) {
    assert.equal(words(text).length, n, `${label}: ${JSON.stringify(words(text))}`);
    assert.equal(detectLang(text), code, `${label} language`);
  }
});

test('CJK sentences are no longer one token — the terse-user bug', () => {
  // Before segmentation both of these were 2 tokens, which is what made every
  // CJK user score as a two-word tyrant.
  for (const [, text, , code] of SENTENCES.filter((s) => s[3] === 'zh' || s[3] === 'ja')) {
    assert.ok(words(text).length >= 6, `${code} must not collapse to a handful of tokens`);
  }
  assert.deepEqual(
    words('请帮我修复这个登录错误，谢谢'),
    ['请', '帮', '我', '修复', '这个', '登录', '错误', '谢谢'],
  );
  // Punctuation is dropped: the fullwidth comma is not a word.
  assert.ok(!words('请帮我修复这个登录错误，谢谢').includes('，'));
  // Kana and Han inside one Japanese sentence stay in one stream.
  assert.ok(words('ログインのバグを直してください、ありがとう').includes('ログイン'));
});

/* ---------------------------------------------------------------------- mixed scripts */

test('mixed CJK + Latin segments across the script boundary', () => {
  assert.deepEqual(words('修复这个bug please'), ['修复', '这个', 'bug', 'please']);
  assert.equal(detectLang('修复这个bug please'), 'mixed', 'two scripts genuinely compete');

  // Latin punctuation and casing still behave inside mixed text.
  assert.deepEqual(words('Fix 登录 NOW'), ['fix', '登录', 'now']);
  // A Latin identifier next to Han does not swallow the Han, or vice versa.
  assert.deepEqual(words('src/auth.js 有 bug'), ['src', 'auth', 'js', '有', 'bug']);
});

test('the regex path survives inside mixed text — hyphens and apostrophes hold', () => {
  // Intl.Segmenter splits "well-known" in two. The Latin part of a mixed string
  // must not inherit that, or token counts would depend on whether a Chinese
  // character happened to appear elsewhere in the same message.
  assert.deepEqual(words("don't touch well-known 修复"), ["don't", 'touch', 'well-known', '修复']);
  assert.equal(words("don't touch well-known").length, 2 + 1);
});

/* ------------------------------------------------------------- other writing systems */

test('Korean is space-delimited and takes the fast path', () => {
  const ko = '한국어로 로그인 버그를 고쳐주세요, 감사합니다';
  assert.equal(words(ko).length, 5);
  assert.equal(detectLang(ko), 'ko');
});

test('Arabic and Hebrew are right-to-left, not unreadable', () => {
  const ar = 'مرحبا هل يمكنك إصلاح خطأ تسجيل الدخول من فضلك';
  assert.equal(words(ar).length, 9);
  assert.equal(detectLang(ar), 'ar');

  const he = 'שלום האם אתה יכול לתקן את הבאג';
  assert.equal(words(he).length, 7);
  assert.equal(detectLang(he), 'he');
});

test('Devanagari matras stay attached to their consonant', () => {
  const hi = 'क्या आप लॉगिन बग ठीक कर सकते हैं';
  // The virama and the vowel signs are \p{M}. Without them a word breaks apart.
  assert.deepEqual(words(hi), ['क्या', 'आप', 'लॉगिन', 'बग', 'ठीक', 'कर', 'सकते', 'हैं']);
  assert.equal(detectLang(hi), 'hi');
});

test('Thai has no spaces either, and is segmented', () => {
  const th = 'ช่วยแก้ไขข้อผิดพลาดการเข้าสู่ระบบด้วยครับ';
  assert.ok(words(th).length >= 8, `Thai collapsed: ${JSON.stringify(words(th))}`);
  // 'th' is not a code we claim; saying "mixed" is more honest than guessing.
  assert.equal(detectLang(th), 'mixed');
});

/* ------------------------------------------------------- existing behaviour, unbroken */

test('Latin and Cyrillic tokenization is byte-for-byte what it was', () => {
  assert.deepEqual(words('Коммит и Пуш!'), ['коммит', 'и', 'пуш']);
  assert.equal(words('привет мир, hello world').length, 4);
  assert.equal(words("emoji 🚀 don't break it").length, 4);
  assert.deepEqual(words("emoji 🚀 don't break it"), ['emoji', "don't", 'break', 'it']);
  assert.deepEqual(words('well-known state-of-the-art'), ['well-known', 'state-of-the-art']);
  assert.deepEqual(words('it’s O’Brien'), ['it’s', 'o’brien']);
  assert.equal(words('деплой на прод в 3 часа ночи, срочно, пожалуйста').length, 9);
  assert.equal(detectLang('коммит и пуш пожалуйста'), 'ru');
  assert.equal(detectLang('commit and push please'), 'en');
});

test('a decomposed accent composes and stays one token', () => {
  // NFD input: "e" + combining acute, "i" + combining diaeresis. NFC folds
  // them back together, and the \p{M} continuation would have kept them as one
  // token even if it had not.
  assert.deepEqual(words("cafe\u0301 nai\u0308ve"), ["caf\u00e9", "na\u00efve"]);
  assert.equal(words("cafe\u0301").length, 1);
});

test('empty, null and digit-only input', () => {
  assert.deepEqual(words(''), []);
  assert.deepEqual(words(null), []);
  assert.deepEqual(words(undefined), []);
  assert.deepEqual(words('   \n\t  '), []);
  assert.deepEqual(words('!!! ??? ***'), []);
  assert.equal(detectLang(''), 'none');
  assert.equal(detectLang(null), 'none');
  assert.equal(detectLang('!!!'), 'none');
  assert.equal(detectLang('123 456'), 'none', 'digits name no language');
});

/* ------------------------------------------------------------------ language naming */

test('Latin-script languages are told apart by function words and diacritics', () => {
  const cases = [
    ['peux-tu corriger l’erreur de connexion, merci', 'fr'],
    ['você pode corrigir o erro de login, obrigado', 'pt'],
    ['puoi correggere l’errore di accesso, grazie', 'it'],
    ['kun je alsjeblieft de inlogfout oplossen, bedankt', 'nl'],
    ['kan du fixa inloggningsfelet, tack', 'sv'],
    ['czy możesz naprawić ten błąd logowania, proszę', 'pl'],
    ['lütfen giriş hatasını düzeltebilir misin, teşekkürler', 'tr'],
  ];
  for (const [text, code] of cases) {
    assert.equal(detectLang(text), code, JSON.stringify(text));
  }
});

test('weak Latin signal is English, not a guess', () => {
  // No function words at all — a bare identifier soup. Claiming a language here
  // would be inventing information.
  assert.equal(detectLang('refactor parser tokenizer benchmark'), 'en');
  assert.equal(detectLang('ok'), 'en');
  assert.equal(detectLang('git rebase origin main'), 'en');
  // One stray foreign word does not flip a sentence.
  assert.equal(detectLang('the danke button is broken on this page'), 'en');
});

test('Ukrainian is separated from Russian by its own letters', () => {
  assert.equal(detectLang('будь ласка, виправ цю помилку і додай тест'), 'uk');
  assert.equal(detectLang('почини пожалуйста этот баг и добавь тест'), 'ru');
});

test('Japanese and Chinese are separated by the presence of kana', () => {
  assert.equal(detectLang('この関数を修正してください'), 'ja');
  assert.equal(detectLang('请修复这个函数'), 'zh');
});

test('detectLang only ever returns a code langName can name', () => {
  const ALLOWED = new Set(['en', 'ru', 'de', 'es', 'fr', 'pt', 'it', 'zh', 'ja', 'ko',
    'ar', 'he', 'hi', 'tr', 'pl', 'uk', 'nl', 'sv', 'mixed', 'none']);
  const corpus = [
    ...SENTENCES.map((s) => s[1]),
    '修复这个bug please', '한국어로 로그인', 'שלום', 'क्या आप', 'ช่วยแก้ไข', '',
    '123', 'peux-tu corriger', 'grazie mille', 'dziękuję bardzo', 'Ελληνικά κείμενο',
  ];
  for (const text of corpus) {
    const code = detectLang(text);
    assert.ok(ALLOWED.has(code), `unclaimed code ${code} for ${JSON.stringify(text)}`);
    const name = langName(code);
    assert.equal(typeof name, 'string');
    assert.ok(name.length > 0);
  }
  assert.equal(langName('de'), 'German');
  assert.equal(langName('zh'), 'Chinese');
  assert.equal(langName('ja'), 'Japanese');
  assert.equal(langName('uk'), 'Ukrainian');
  assert.equal(langName('sv'), 'Swedish');
  assert.equal(langName('mixed'), 'mixed');
});

/* ------------------------------------------------------------------- determinism */

test('same text in, same tokens out — every time, in both paths', () => {
  for (const [, text] of SENTENCES) {
    const first = words(text);
    for (let i = 0; i < 20; i++) assert.deepEqual(words(text), first);
  }
  // The run regex is global and stateful; a leaked lastIndex would show up here.
  const zh = '请帮我修复这个登录错误，谢谢';
  assert.deepEqual(words(zh), words(zh));
  assert.deepEqual(words('修复 a 修复 b 修复'), ['修复', 'a', '修复', 'b', '修复']);
});

/* ---------------------------------------------------- Intl.Segmenter is missing */

test('without Intl.Segmenter, CJK degrades to code points instead of throwing', async () => {
  const saved = Intl.Segmenter;
  try {
    // A fresh module instance, loaded while Segmenter does not exist, so the
    // lazy cache inside _util.js is populated with the fallback.
    delete Intl.Segmenter;
    const mod = await import('../src/detectors/_util.js?no-segmenter');

    // One token per ideograph: wrong, but a great deal closer than one token
    // per sentence, and it never throws.
    const zh = mod.words('请帮我修复这个登录错误，谢谢');
    assert.deepEqual(zh, ['请', '帮', '我', '修', '复', '这', '个', '登', '录', '错', '误', '谢', '谢']);
    assert.equal(mod.detectLang('请帮我修复这个登录错误，谢谢'), 'zh');

    // Latin is unaffected — it never touched the Segmenter in the first place.
    assert.deepEqual(mod.words("emoji 🚀 don't break it"), ['emoji', "don't", 'break', 'it']);
    assert.equal(mod.words('can you fix the login bug please').length, 7);
    assert.equal(mod.detectLang('kannst du bitte den Login-Fehler beheben, danke'), 'de');

    // Mixed text still splits at the script boundary.
    assert.deepEqual(mod.words('修复这个bug please'), ['修', '复', '这', '个', 'bug', 'please']);

    // truncate() shares the same graceful-degradation contract.
    assert.equal(mod.truncate('abcdefghij', 5), 'abcd…');
  } finally {
    Intl.Segmenter = saved;
  }
});

test('a Segmenter that throws is caught, not propagated', async () => {
  const saved = Intl.Segmenter;
  try {
    Intl.Segmenter = function Broken() { throw new Error('no ICU data'); };
    const mod = await import('../src/detectors/_util.js?broken-segmenter');
    assert.deepEqual(mod.words('修复bug'), ['修', '复', 'bug']);
    assert.equal(mod.words('plain latin text').length, 3);
  } finally {
    Intl.Segmenter = saved;
  }
});

/* -------------------------------------------------------------- performance guard */

test('Latin text never pays for the CJK path', () => {
  const line = 'can you fix the login bug in src/auth.js please, it keeps throwing';
  const N = 50000;

  // Warm the JIT so the measurement is of steady state, not of compilation.
  for (let i = 0; i < 2000; i++) words(line);

  const t0 = process.hrtime.bigint();
  let n = 0;
  for (let i = 0; i < N; i++) n += words(line).length;
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  assert.equal(n, N * 14);
  assert.ok(ms < 700, `${N} Latin words() calls took ${ms.toFixed(0)}ms — the CJK path is leaking into Latin text`);
});
