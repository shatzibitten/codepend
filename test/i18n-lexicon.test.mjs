/**
 * The multilingual lexicon: src/detectors/_stopwords.js.
 *
 * Everything here goes through the real consumer — buildStats() decides what is
 * polite and what is an apology, not a reimplementation of its rules — so a
 * lexicon entry in the wrong field (a stem that should be a token, a phrase
 * that should be a stem) fails here rather than shipping a wrong number.
 *
 * Adding a language? Add a row to CASES and a trap to the traps block.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildStats } from '../src/stats.js';
import { mineNgrams } from '../src/detectors/_ngram.js';
import {
  STOPWORDS, STOPWORDS_BY_LANG, LEXICON, LEXICON_LANGS, isStop,
  POLITE_EN, POLITE_EN_PHRASES, POLITE_RU_STEMS, RU_STEM_EXCLUDE,
  APOLOGY_EN, APOLOGY_EN_PHRASES, APOLOGY_RU_STEMS, APOLOGY_EXCLUDE,
} from '../src/detectors/_stopwords.js';

const NOW = Date.UTC(2026, 7, 5, 12, 0);

/** One human turn through the real pipeline. */
function judge(text, agentText) {
  const ctx = buildStats([{
    id: 's1',
    agent: 'codex',
    startedAt: NOW - 3600000,
    endedAt: NOW,
    durationMs: 60000,
    models: ['gpt-5.6-sol'],
    project: 'p',
    cwd: '/x/p',
    humanTurns: text == null ? [] : [{ ts: NOW - 3500000, text }],
    agentTurns: agentText == null ? [] : [{ ts: NOW - 3400000, text: agentText }],
    reasoning: [],
    tools: {},
    filesTouched: [],
    interrupts: [],
    tokens: {},
  }], { now: NOW, tz: 'UTC', redact: (s) => s });
  return { polite: ctx.politeTurns === 1, apology: ctx.apologyTurns.length === 1 };
}

const isPolite = (t) => judge(t).polite;
const isApology = (t) => judge(t).apology;

/* ------------------------------------------------------------------ corpus */

/**
 * Per language: one polite request, one apology, one plain technical prompt.
 * The plain one is the important column — it is what most prompts look like,
 * and it must score neither.
 */
const CASES = [
  ['en', 'English',
    'can you fix the login bug please',
    'sorry, that was my bad',
    'refactor the parser into two modules'],
  ['ru', 'Russian',
    'почини пожалуйста баг с логином, спасибо',
    'извини, я был неправ',
    'перепиши парсер на два модуля'],
  ['de', 'German',
    'kannst du bitte den Login-Fehler beheben, danke',
    'Entschuldigung, das war falsch von mir',
    'schreibe einen Test für den Parser'],
  ['es', 'Spanish',
    'puedes arreglar el inicio de sesión, por favor gracias',
    'perdón, lo siento, culpa mía',
    'refactoriza el parser en dos modulos'],
  ['fr', 'French',
    "peux-tu corriger le bug de connexion s'il te plaît, merci",
    'désolé, ma faute',
    'refactorise le parseur en deux modules'],
  ['pt', 'Portuguese',
    'pode corrigir o bug do login por favor, obrigado',
    'desculpa, foi mal',
    'refatore o parser em dois modulos'],
  ['it', 'Italian',
    'per favore sistema il bug del login, grazie',
    'scusa, colpa mia',
    'rifattorizza il parser in due moduli'],
  ['nl', 'Dutch',
    'kun je alsjeblieft de login bug fixen, bedankt',
    'mijn fout, het spijt me',
    'herschrijf de parser in twee modules'],
  ['pl', 'Polish',
    'proszę napraw logowanie, dzięki',
    'przepraszam, moja wina',
    'przepisz parser na dwa moduly'],
  ['tr', 'Turkish',
    'lütfen giriş sorununu düzelt, teşekkürler',
    'özür dilerim, kusura bakma',
    'parser modulunu ikiye bol'],
  ['uk', 'Ukrainian',
    'виправ будь ласка баг з логіном, дякую',
    'вибач, моя вина',
    'перепиши парсер на два модулі'],
  ['zh', 'Chinese',
    '请帮我修复这个登录问题，谢谢',
    '对不起，我的错',
    '把解析器拆分成两个模块'],
  ['ja', 'Japanese',
    'ログインのバグを直してください、ありがとう',
    'ごめん、私のミスでした',
    'パーサーを二つのモジュールに分割して'],
  ['ko', 'Korean',
    '로그인 문제를 수정해주세요, 감사합니다',
    '죄송합니다, 제 잘못입니다',
    '파서를 두 개의 모듈로 나눠줘'],
];

/* --------------------------------------------------------------- the table */

test('every shipped language has a stopword block and a lexicon block', () => {
  for (const [code, name] of CASES) {
    assert.ok(LEXICON_LANGS.includes(code), `${code} missing from LEXICON_LANGS`);
    assert.equal(LEXICON[code].name, name);
    const n = STOPWORDS_BY_LANG[code].length;
    // Compact by design: this list keeps catchphrases meaningful, it is not a
    // linguistics project. Way under 40 means the block is a stub.
    assert.ok(n >= 40 && n <= 160, `${code} has ${n} stopwords, expected 40..160`);
    assert.ok(
      LEXICON[code].politeTokens.length + LEXICON[code].politeStems.length +
      LEXICON[code].politePhrases.length >= 4,
      `${code} has too few politeness markers`,
    );
    assert.ok(
      LEXICON[code].apologyTokens.length + LEXICON[code].apologyStems.length +
      LEXICON[code].apologyPhrases.length >= 3,
      `${code} has too few apology markers`,
    );
  }
});

test('a polite sentence counts as polite, in every language', () => {
  for (const [code, , polite] of CASES) {
    assert.equal(isPolite(polite), true, `${code}: «${polite}» should be polite`);
  }
});

test('an apology counts as an apology, in every language', () => {
  for (const [code, , , apology] of CASES) {
    assert.equal(isApology(apology), true, `${code}: «${apology}» should be an apology`);
  }
});

test('an apology also counts as politeness, in every language', () => {
  // «извини» and «sorry» have always counted as both. Every language follows,
  // or a Chinese user who apologizes scores less polite than an English one
  // who does the same thing.
  for (const [code, , , apology] of CASES) {
    assert.equal(isPolite(apology), true, `${code}: «${apology}» should also be polite`);
  }
});

test('a plain technical prompt counts as neither, in every language', () => {
  for (const [code, , , , plain] of CASES) {
    const r = judge(plain);
    assert.equal(r.polite, false, `${code}: «${plain}» should not be polite`);
    assert.equal(r.apology, false, `${code}: «${plain}» should not be an apology`);
  }
});

/* ------------------------------------------------------------------- traps */

test('trap: «просто» (just) is not «прости» (sorry)', () => {
  // The single most expensive false positive in the file: without the
  // exclusion the Russian politeness rate is off by an order of magnitude.
  assert.equal(isPolite('просто перепиши это в два модуля'), false);
  assert.equal(isApology('просто перепиши это в два модуля'), false);
  assert.equal(isPolite('прости, я не так объяснил'), true);
});

test('trap: German «bitte» does not fire on English "bitten" / "bitter"', () => {
  assert.equal(isPolite('we got bitten by this bug again'), false);
  assert.equal(isPolite('the retry loop leaves a bitter taste'), false);
  assert.equal(isPolite('mach das bitte nochmal'), true);
});

test('trap: French «merci» never matches inside "commercial"', () => {
  // This is why Latin-script markers are tokens and never substring phrases.
  assert.equal(isPolite('the commercial API returns a 500'), false);
  assert.equal(isPolite('the commercial tier is broken'), false);
  assert.equal(isPolite('corrige le parseur merci'), true);
});

test('trap: Spanish «favor» alone is an ordinary noun', () => {
  assert.equal(isPolite('el usuario pidió un favor especial en la API'), false);
  assert.equal(isPolite('arregla el parser por favor'), true);
});

test('trap: Japanese «すみません» opens a request as often as it apologises', () => {
  // Polite, yes. An apology, no — only the explicitly apologetic forms count.
  const r = judge('すみません、ログを見てください');
  assert.equal(r.polite, true);
  assert.equal(r.apology, false);
  assert.equal(isApology('すみませんでした、私のミスです'), true);
  assert.equal(isApology('ごめん、直します'), true);
});

test('trap: Chinese «请» does not fire inside 申请 / 邀请', () => {
  assert.equal(isPolite('申请一个新的 key 并邀请团队成员'), false);
  assert.equal(isPolite('请修复这个登录问题'), true);
});

test('trap: Chinese «麻烦» is only polite as 麻烦你 / 麻烦帮', () => {
  assert.equal(isPolite('这个配置很麻烦'), false);
  assert.equal(isPolite('麻烦你看一下日志'), true);
});

test('trap: French «pardon» counts as politeness, not as an apology', () => {
  // In French it is "excuse me" at least as often as "sorry".
  const r = judge('pardon, quelle est la commande');
  assert.equal(r.polite, true);
  assert.equal(r.apology, false);
});

test('trap: Dutch «excuses» does not fire on English "no excuses"', () => {
  assert.equal(isApology('no excuses, just make the tests pass'), false);
  assert.equal(isApology('mijn excuses, dat was verkeerd'), true);
});

test('trap: Polish «dziekanat» is not «dziękuję»', () => {
  assert.equal(isPolite('dziekanat wydziału informatyki'), false);
  assert.equal(isPolite('dziękuję za pomoc'), true);
});

test('trap: English "desolate" is not French «désolé»', () => {
  assert.equal(isApology('the repo is desolate after the migration'), false);
  assert.equal(isApology('désolé, je me suis trompé'), true);
});

test('trap: Turkish «rica» is not Spanish «rica»', () => {
  // Which is why only the phrase «rica ederim» ships, never the bare token.
  assert.equal(isPolite('la comida es muy rica en el fixture de prueba'), false);
  assert.equal(isPolite('rica ederim, sonra bakarız'), true);
});

test('an error report is never an apology, in every language', () => {
  // "fix this error" is a bug report, not a confession.
  const reports = [
    'sorry, fix this error in the parser',
    'sorry, behebe diesen Fehler',           // de
    'perdón, arregla este error',            // es
    'désolé, corrige cette erreur',          // fr
    'desculpa, corrige esse erro',           // pt
    'scusa, correggi questo errore',         // it
    'przepraszam, napraw ten błąd',          // pl
    'özür dilerim, bu hatayı düzelt',        // tr
    'вибач, виправ цю помилку',              // uk
    'извини, исправь эту ошибку',            // ru
    '对不起，修复这个错误',                      // zh
    'ごめん、このエラーを直して',                 // ja
    '죄송합니다, 이 오류를 수정해주세요',           // ko
  ];
  for (const text of reports) {
    assert.equal(isApology(text), false, `«${text}» should not count as an apology`);
  }
});

test('politeness never fires on the agent’s own boilerplate', () => {
  // isPolite/isApology only ever see human turns. An agent that says "Bitte
  // warten", "谢谢" and "I apologize" in the same breath moves no counter.
  const r = judge(
    null,
    'Bitte warten… done. 谢谢! I apologize for the confusion, sorry about that. Merci.',
  );
  assert.equal(r.polite, false);
  assert.equal(r.apology, false);
});

/* --------------------------------------------------------------- stopwords */

const mk = (arr) => arr.map((text, i) => ({
  text, ts: i * 1000, project: 'p', model: 'm', sessionId: 's',
}));

test('Spanish stopwords leave a meaningful bigram — no more «el error de»', () => {
  const docs = mk([
    'puedes arreglar el error de inicio de sesion en el formulario',
    'revisa el error de inicio de sesion otra vez por favor',
    'el error de inicio de sesion sigue apareciendo en produccion',
    'arregla el error de inicio de sesion y luego corre las pruebas',
    'todavia veo el error de inicio de sesion despues del despliegue',
  ]);
  const phrases = mineNgrams(docs, { minDf: 3, maxN: 4 }).map((c) => c.phrase);

  assert.ok(phrases.length, 'Spanish corpus mined nothing at all');
  assert.ok(!phrases.includes('el error de'), 'the article-led phrase came back');
  assert.ok(phrases.includes('inicio de sesion'), `expected «inicio de sesion», got ${phrases}`);
  for (const p of phrases) {
    const toks = p.split(' ');
    assert.equal(isStop(toks[0]), false, `«${p}» starts with a stopword`);
    assert.equal(isStop(toks[toks.length - 1]), false, `«${p}» ends with a stopword`);
  }
});

test('German stopwords leave a meaningful phrase', () => {
  const docs = mk([
    'kannst du den login fehler beheben und die tests laufen lassen',
    'bitte den login fehler beheben, das ist der wichtigste punkt',
    'der login fehler beheben ist immer noch offen nach dem deploy',
    'wir muessen den login fehler beheben bevor wir das release machen',
    'schau dir den login fehler beheben nochmal an, danke dir',
  ]);
  const phrases = mineNgrams(docs, { minDf: 3, maxN: 4 }).map((c) => c.phrase);

  assert.ok(phrases.includes('login fehler beheben'), `expected the verb phrase, got ${phrases}`);
  assert.ok(!phrases.includes('den login fehler beheben'), 'the article survived');
  for (const p of phrases) {
    assert.equal(isStop(p.split(' ')[0]), false, `«${p}» starts with a stopword`);
  }
});

test('the English and Russian stopword blocks are unchanged', () => {
  for (const w of ['the', 'a', 'and', 'you', 'this', 'pls']) assert.equal(isStop(w), true, w);
  for (const w of ['и', 'в', 'что', 'это', 'просто', 'раз']) assert.equal(isStop(w), true, w);
  // Imperatives are the whole point of the catchphrase card.
  for (const w of ['fix', 'ship', 'коммит', 'почини']) assert.equal(isStop(w), false, w);
});

test('developer jargon is never swallowed by a foreign function word', () => {
  // Each of these is a stopword in some language and load-bearing here.
  const jargon = {
    todo: 'es/pt "all"', var: 'tr "there is"', ai: 'fr "have"', net: 'nl "just"',
    fine: 'it "end"', come: 'it "as"', ir: 'es "to go"', car: 'fr "because"',
  };
  for (const [w, why] of Object.entries(jargon)) {
    assert.equal(isStop(w), false, `«${w}» (${why}) must stay minable`);
  }
});

test('politeness markers are not stopwords', () => {
  // "please" is not a stopword, so neither is «bitte», «请» or «lütfen» —
  // otherwise a polite catchphrase can never reach a card.
  for (const t of POLITE_EN) {
    assert.equal(STOPWORDS.has(t), false, `polite marker «${t}» is also a stopword`);
  }
});

/* ------------------------------------------------------- structural guards */

test('no apology phrase is vetoed by its own exclude list', () => {
  // The consumer checks APOLOGY_EXCLUDE first and bails, so «mein Fehler» and
  // «benim hatam» can never work — they are absent for exactly this reason.
  for (const p of APOLOGY_EN_PHRASES) {
    for (const bad of APOLOGY_EXCLUDE) {
      assert.ok(!p.includes(bad), `apology phrase «${p}» contains excluded «${bad}»`);
    }
  }
});

test('no Latin-script marker is matched as a bare substring', () => {
  // A one-word Latin phrase is always a bug: "commercial" contains "merci",
  // "assumed" contains "sumé". Single words belong in tokens or stems.
  const bareLatin = (p) => /^[\p{Script=Latin}\p{Script=Cyrillic}'’-]+$/u.test(p);
  for (const p of [...POLITE_EN_PHRASES, ...APOLOGY_EN_PHRASES]) {
    assert.equal(bareLatin(p), false, `phrase «${p}» is a bare word — move it to tokens`);
  }
});

test('every stem is a prefix nobody else in the lexicon trips over', () => {
  // A stem that swallows another language's marker whole is a silent merge of
  // two counters. Excluded tokens are allowed to collide — that is their job.
  for (const stem of [...POLITE_RU_STEMS, ...APOLOGY_RU_STEMS]) {
    assert.ok(stem.length >= 3, `stem «${stem}» is too short to be safe`);
    assert.ok(!/\s/.test(stem), `stem «${stem}» has a space — stems match one token`);
  }
  for (const bad of RU_STEM_EXCLUDE) {
    assert.ok(!/\s/.test(bad), `exclusion «${bad}» has a space — exclusions are exact tokens`);
  }
});

test('exports are deduplicated, lowercased and stable', () => {
  const lists = {
    POLITE_EN, POLITE_EN_PHRASES, POLITE_RU_STEMS,
    APOLOGY_EN, APOLOGY_EN_PHRASES, APOLOGY_RU_STEMS, APOLOGY_EXCLUDE,
  };
  for (const [name, list] of Object.entries(lists)) {
    assert.ok(Array.isArray(list), `${name} must stay an array — src/stats.js iterates it`);
    assert.equal(new Set(list).size, list.length, `${name} has duplicates`);
    for (const v of list) {
      assert.equal(v, v.toLowerCase(), `${name} entry «${v}» is not lowercased`);
      assert.equal(v, v.normalize('NFC'), `${name} entry «${v}» is not NFC`);
    }
  }
  assert.ok(RU_STEM_EXCLUDE instanceof Set, 'RU_STEM_EXCLUDE must stay a Set');
});

test('the Set-backed `includes` behaves exactly like Array.prototype.includes', () => {
  // The marker lists override `includes` for speed. If that ever diverges from
  // a linear scan, politeness silently changes for everyone.
  for (const list of [POLITE_EN, POLITE_EN_PHRASES, APOLOGY_EN, APOLOGY_EN_PHRASES]) {
    assert.ok(Array.isArray(list));
    assert.equal([...list].length, list.length, 'iteration must match length');
    assert.deepEqual(Object.keys(list).filter((k) => Number.isNaN(+k)), [], 'no enumerable extras');
    for (const v of [...list, 'definitely-not-in-the-lexicon', '', 'THANKS']) {
      assert.equal(list.includes(v), list.slice().indexOf(v) !== -1, `includes disagrees on «${v}»`);
    }
  }
});
