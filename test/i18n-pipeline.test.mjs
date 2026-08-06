/**
 * The multilingual claim, end to end.
 *
 * test/i18n-words.test.mjs proves the tokenizer segments CJK; this file proves
 * the *pipeline* does something sensible with the result. One synthetic corpus
 * per language — 40 sessions of realistic prompts, including polite ones,
 * apologetic ones and one repeated catchphrase — goes through buildMemories,
 * and every claim the README makes about non-English users is checked against
 * the cards that actually come out.
 *
 * These are the numbers on HEAD before the i18n work, measured with this exact
 * corpus, and the reason each assertion below exists:
 *
 *   lang | detected | median prompt | terse rate | polite | apology | archetype*
 *   -----+----------+---------------+------------+--------+---------+-----------
 *   zh   | mixed    |  1 word       | 1.00       |   0    |   0     | Two-Word Tyrant
 *   ja   | mixed    |  1 word       | 1.00       |   0    |   0     | Two-Word Tyrant
 *   ko   | mixed    |  5 words      | 0.65       |   0    |   0     | Two-Word Tyrant
 *   de   | en       |  8 words      | 0.24       |   0    |   0     | —
 *   es   | en       |  8 words      | 0.18       |   0    |   0     | —
 *   fr   | en       |  7 words      | 0.18       |   0    |   0     | —
 *   pt   | en       |  8 words      | 0.18       |   0    |   0     | —
 *
 *   (*) with the corpus shifted into working hours, so that `terse` rather
 *       than `night` decides the archetype — which is what `daytime()` below
 *       exists for.
 *
 * A whole Chinese sentence counted as one word, so every CJK user was a
 * Two-Word Tyrant; no Latin language but English could reach a politeness or
 * apology card at all. If a future change puts any of those numbers back, one
 * of the assertions below fails and names the language.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMemories } from '../src/detect.js';
import { buildStats } from '../src/stats.js';
import { words, detectLang, displayPhrase } from '../src/detectors/_util.js';
import {
  isStop, POLITE_EN_PHRASES, APOLOGY_EN_PHRASES, APOLOGY_EXCLUDE,
} from '../src/detectors/_stopwords.js';
import { pickArchetype } from '../src/detectors/_archetypes.js';

const TZ = 'Asia/Almaty'; // UTC+5, no DST
const OFFSET = 5 * 3600000;
const at = (y, m, d, h = 12, mi = 0) => Date.UTC(y, m - 1, d, h, mi) - OFFSET;
const NOW = at(2026, 8, 5, 18, 30);
const OPTS = { now: NOW, tz: TZ, redact: (s) => s };

/* ========================================================================== */
/* The corpora. One block per language, same shape as _stopwords.js LEX.       */
/*                                                                            */
/* `plain` must contain NO politeness and NO apology marker — it is the        */
/* false-positive guard. `tenWord` is one prompt of roughly ten words, the     */
/* unit the "a 10-word Chinese sentence is not 1 word" claim is about.         */
/* ========================================================================== */

const CORPORA = {
  en: {
    plain: [
      'fix the login bug in the auth module',
      'run the tests and show me the output',
      'why does the build fail on CI but not locally',
      'add a retry to the fetch helper',
      'write a unit test for the cache eviction path',
      'explain what this regular expression actually matches',
      'the migration script drops the index, check it',
      'split the session parser into its own file',
    ],
    polite: [
      'can you fix the login in the auth module please',
      'thanks, that worked. now do the same for the signup page',
      'please add a retry to the fetch helper, thank you',
      'thank you for the fix, one more thing',
    ],
    apology: [
      'sorry, I meant the other file',
      'my bad, the branch was stale',
      'sorry, ignore that, wrong repository',
    ],
    catch: 'commit and push',
    tenWord: 'can you please fix the login bug in the auth module',
    content: ['commit', 'push', 'login', 'auth', 'module', 'bug', 'fix'],
  },

  de: {
    plain: [
      'behebe den Login-Fehler im Auth-Modul',
      'führe die Tests aus und zeig mir die Ausgabe',
      'warum schlägt der Build auf CI fehl, aber lokal nicht',
      'füge dem Fetch-Helper einen Retry hinzu',
      'schreibe einen Unit-Test für die Cache-Invalidierung',
      'erkläre mir was dieser reguläre Ausdruck macht',
      'das Migrationsskript löscht den Index, schau dir das an',
      'teile den Session-Parser in eine eigene Datei auf',
    ],
    polite: [
      'kannst du bitte den Login im Auth-Modul reparieren',
      'danke, das hat funktioniert. mach jetzt dasselbe für die Registrierung',
      'bitte füge dem Fetch-Helper einen Retry hinzu, vielen Dank',
      'danke schön für die Änderung, noch eine Sache',
    ],
    apology: [
      'entschuldige, ich meinte die andere Datei',
      'tut mir leid, der Branch war veraltet',
      'entschuldigung, ignoriere das, falsches Repository',
    ],
    catch: 'commit und push',
    tenWord: 'kannst du bitte den Login-Fehler im Auth-Modul schnell beheben',
    content: ['commit', 'push', 'login-fehler', 'auth-modul', 'beheben', 'login'],
  },

  es: {
    plain: [
      'arregla el error de inicio de sesión en el módulo de autenticación',
      'ejecuta las pruebas y muéstrame la salida',
      'por qué falla la compilación en CI pero no en local',
      'añade un reintento al helper de fetch',
      'escribe una prueba unitaria para la caché',
      'explica qué hace esta expresión regular',
      'el script de migración borra el índice, revísalo',
      'separa el parser de sesiones en su propio archivo',
    ],
    polite: [
      'puedes arreglar el inicio de sesión por favor',
      'gracias, funcionó. ahora haz lo mismo con el registro',
      'por favor añade un reintento al helper, muchas gracias',
      'muchas gracias por el arreglo, una cosa más',
    ],
    apology: [
      'perdón, me refería al otro archivo',
      'disculpa, la rama estaba desactualizada',
      'lo siento, ignora eso, repositorio equivocado',
    ],
    catch: 'haz commit y push',
    tenWord: 'puedes arreglar el inicio de sesión en el módulo por favor',
    content: ['commit', 'push', 'haz', 'arreglar', 'inicio', 'sesión', 'módulo', 'puedes'],
  },

  fr: {
    plain: [
      'corrige le bug de connexion dans le module authentification',
      'lance les tests et montre-moi la sortie',
      'pourquoi la compilation échoue sur CI mais pas en local',
      'ajoute une nouvelle tentative au helper fetch',
      'écris un test unitaire pour le cache',
      'explique ce que fait cette expression régulière',
      'le script de migration supprime index, vérifie-le',
      'sépare le parseur de sessions dans son propre fichier',
    ],
    polite: [
      "peux-tu corriger la connexion s'il te plaît",
      'merci, ça a marché. fais pareil pour inscription',
      "s'il vous plaît ajoute une tentative au helper, merci beaucoup",
      'merci beaucoup pour le correctif, encore une chose',
    ],
    apology: [
      "désolé, je parlais de l'autre fichier",
      'ma faute, la branche était périmée',
      'désolé, ignore ça, mauvais dépôt',
    ],
    catch: 'commit et push',
    tenWord: "peux-tu corriger le bug de connexion dans le module s'il te plaît",
    content: ['commit', 'push', 'connexion', 'module', 'corriger', 'bug', 'peux-tu'],
  },

  pt: {
    plain: [
      'corrija o erro de login no módulo de autenticação',
      'rode os testes e mostre a saída',
      'por que a build falha no CI mas não localmente',
      'adicione uma nova tentativa ao helper de fetch',
      'escreva um teste unitário para o cache',
      'explique o que essa expressão regular faz',
      'o script de migração apaga o índice, verifique',
      'separe o parser de sessões em um arquivo próprio',
    ],
    polite: [
      'você pode corrigir o login por favor',
      'obrigado, funcionou. agora faça o mesmo no cadastro',
      'por favor adicione uma tentativa ao helper, muito obrigado',
      'muito obrigado pela correção, mais uma coisa',
    ],
    apology: [
      'desculpa, eu quis dizer o outro arquivo',
      'foi mal, o branch estava desatualizado',
      'desculpe, ignore isso, repositório trocado',
    ],
    catch: 'faça commit e push',
    tenWord: 'você pode corrigir o login no módulo de autenticação por favor',
    content: ['commit', 'push', 'faça', 'corrigir', 'login', 'módulo', 'autenticação', 'pode'],
  },

  ru: {
    plain: [
      'почини баг с логином в модуле авторизации',
      'запусти тесты и покажи вывод',
      'почему сборка падает на CI но не локально',
      'добавь повтор запроса в хелпер fetch',
      'напиши юнит-тест для кэша',
      'объясни что делает это регулярное выражение',
      'миграция удаляет индекс, проверь это',
      'вынеси парсер сессий в отдельный файл',
    ],
    polite: [
      'почини пожалуйста логин в модуле авторизации',
      'спасибо, сработало. теперь то же самое для регистрации',
      'пожалуйста добавь повтор запроса, спасибо большое',
      'большое спасибо за фикс, ещё одна вещь',
    ],
    apology: [
      'извини, я имел в виду другой файл',
      'сорри, ветка была устаревшая',
      'прости, игнорируй это, не тот репозиторий',
    ],
    catch: 'коммит и пуш',
    tenWord: 'почини пожалуйста баг с логином в модуле авторизации сейчас',
    content: ['коммит', 'пуш', 'почини', 'логином', 'модуле', 'авторизации', 'баг'],
  },

  zh: {
    plain: [
      '修复认证模块里的登录问题',
      '运行测试并把输出给我看',
      '为什么在持续集成上构建失败但本地没问题',
      '给这个辅助函数加上重试逻辑',
      '为缓存淘汰写一个单元测试',
      '解释一下这个正则表达式到底匹配什么',
      '迁移脚本把索引删掉了，检查一下',
      '把会话解析器拆成单独的文件',
    ],
    polite: [
      '请帮我修复认证模块里的登录问题',
      '谢谢，成功了。现在对注册页面做同样的处理',
      '请给这个辅助函数加上重试，谢谢',
      '非常感谢你的修复，还有一件事',
    ],
    apology: [
      '对不起，我说的是另一个文件',
      '抱歉，那个分支是旧的',
      '不好意思，忽略刚才那条，仓库不对',
    ],
    catch: '提交并推送',
    tenWord: '请修复认证模块里面的登录问题并且运行测试',
    content: ['修复', '认证', '模块', '登录', '提交', '推送', '问题', '测试'],
  },

  ja: {
    plain: [
      '認証モジュールのログインバグを直して',
      'テストを実行して出力を見せて',
      'ビルドがローカルでは通るのに失敗する理由を調べて',
      'ヘルパー関数にリトライを追加して',
      'キャッシュ破棄のユニットテストを書いて',
      'この正規表現が何にマッチするか説明して',
      'マイグレーションがインデックスを消しているので確認して',
      'セッションパーサーを別のファイルに分けて',
    ],
    polite: [
      '認証モジュールのログインを直してください',
      'ありがとう、うまくいきました。次は登録ページも同じようにお願い',
      'ヘルパーにリトライを追加してください、よろしくお願いします',
      '修正ありがとうございます、もう一つお願いがあります',
    ],
    apology: [
      'ごめん、別のファイルのことでした',
      'すみませんでした、ブランチが古かったです',
      '申し訳ない、さっきのは無視してください',
    ],
    catch: 'コミットしてプッシュ',
    tenWord: '認証モジュールのログインバグを直してからテストを実行してください',
    content: ['認証', 'モジュール', 'ログイン', 'バグ', 'テスト', 'コミット', 'プッシュ', '直し'],
  },

  ko: {
    plain: [
      '인증 모듈의 로그인 버그를 고쳐줘',
      '테스트를 실행하고 출력을 보여줘',
      '로컬에서는 되는데 빌드가 실패하는 이유를 알아봐',
      '헬퍼 함수에 재시도 로직을 추가해',
      '캐시 만료에 대한 유닛 테스트를 작성해',
      '이 정규식이 무엇을 매칭하는지 설명해',
      '마이그레이션 스크립트가 인덱스를 지우니까 확인해',
      '세션 파서를 별도 파일로 분리해',
    ],
    polite: [
      '인증 모듈의 로그인을 고쳐주세요',
      '감사합니다, 잘 됐어요. 이제 가입 페이지도 똑같이 해주세요',
      '헬퍼에 재시도를 추가해주세요, 감사합니다',
      '수정해주셔서 감사합니다, 한 가지만 더 부탁드려요',
    ],
    apology: [
      '미안, 다른 파일을 말한 거였어',
      '죄송합니다, 브랜치가 오래된 거였어요',
      '제 잘못이에요, 방금 건 무시해주세요',
    ],
    catch: '커밋하고 푸시',
    tenWord: '인증 모듈의 로그인 버그를 고쳐주시고 테스트도 실행해주세요',
    content: ['인증', '모듈의', '로그인', '버그를', '커밋하고', '푸시', '테스트를'],
  },
};

const LANGS = Object.keys(CORPORA);

/* ------------------------------------------------------------ corpus builder */

const AGENT_TEXT =
  'Done. I read the file, made the change and ran the test suite. ' +
  'Here is a summary of what I did and why, in some detail. '.repeat(6);

const PROJECTS = ['orchard', 'beacon', 'kiln'];

/**
 * ~40 sessions in one language: two plain prompts, a polite one every third
 * session, an apology every sixth, the ten-word prompt, and the catchphrase in
 * nine sessions out of ten. Indices only — no clock, no randomness.
 * @param {string} code
 * @param {number} [nSessions]
 */
function corpusFor(code, nSessions = 40) {
  const L = CORPORA[code];
  const sessions = [];
  let day = 0;
  for (let s = 0; s < nSessions; s++) {
    day += s % 5 === 0 ? 2 : 1;
    const start = at(2026, 2, 6, [9, 12, 17, 22, 2][s % 5]) + day * 86400000;
    const prompts = [];
    const push = (text) => prompts.push({ ts: start + prompts.length * 240000, text });

    push(L.plain[s % L.plain.length]);
    push(L.plain[(s + 3) % L.plain.length]);
    if (s % 3 === 0) push(L.polite[((s / 3) | 0) % L.polite.length]);
    if (s % 6 === 1) push(L.apology[(((s - 1) / 6) | 0) % L.apology.length]);
    push(L.tenWord);
    if (s % 10 !== 7) push(L.catch);
    push(L.plain[(s + 5) % L.plain.length]);

    const end = prompts[prompts.length - 1].ts + 180000;
    const project = PROJECTS[s % PROJECTS.length];
    sessions.push({
      id: `${code}-s${s}`,
      agent: s % 4 === 0 ? 'claude' : 'codex',
      source: `/tmp/${code}-${s}.jsonl`,
      title: null,
      cwd: `/Users/x/code/${project}`,
      project,
      gitBranch: 'main',
      startedAt: start,
      endedAt: end,
      durationMs: end - start,
      models: [s < nSessions / 2 ? 'gpt-5.6-sol' : 'claude-opus-5'],
      cliVersion: '1.0.0',
      humanTurns: prompts,
      agentTurns: prompts.map((p, k) => ({ ts: p.ts + 45000, text: `${AGENT_TEXT} Step ${k}.` })),
      reasoning: [{ ts: start + 1000, text: '**Checking the module**\n' + 'thinking '.repeat(300) }],
      tools: { exec_command: 8, apply_patch: 3, read: 5 },
      filesTouched: [`/Users/x/code/${project}/src/index.js`],
      interrupts: s % 7 === 0 ? [{ ts: start + 120000, durationMs: 9000 + s * 100 }] : [],
      tokens: { in: 40000, out: 9000, cacheRead: 900000, cacheWrite: 0, reasoning: 3000 },
      compactions: s % 9 === 0 ? 1 : 0,
      subagents: s % 8 === 0 ? 2 : 0,
      thinkingChars: 2400,
      forkedFrom: null,
      isSidechain: false,
    });
  }
  return sessions;
}

/** Same corpus, moved into working hours so `night` cannot decide the archetype. */
function daytime(sessions) {
  const mv = (t) => t - 10 * 3600000;
  const moveAll = (arr) => arr.map((x) => ({ ...x, ts: mv(x.ts) }));
  return sessions.map((s) => ({
    ...s,
    startedAt: mv(s.startedAt),
    endedAt: mv(s.endedAt),
    humanTurns: moveAll(s.humanTurns),
    agentTurns: moveAll(s.agentTurns),
    reasoning: moveAll(s.reasoning),
    interrupts: moveAll(s.interrupts),
  }));
}

const byType = (out, type) => out.archive.find((m) => m.type === type) || null;

/* ========================================================================== */
/* Per-language claims                                                        */
/* ========================================================================== */

for (const code of LANGS) {
  const L = CORPORA[code];

  test(`${code}: a ten-word sentence counts as words, not as one token`, () => {
    const toks = words(L.tenWord);
    assert.ok(
      toks.length >= 6,
      `${code}: words() found ${toks.length} tokens in a ten-word sentence: ${JSON.stringify(toks)}`,
    );
    // Every prompt in the corpus must survive tokenization with something in it.
    for (const text of [...L.plain, ...L.polite, ...L.apology, L.catch]) {
      assert.ok(words(text).length >= 2, `${code}: "${text}" tokenized to fewer than 2 words`);
    }
  });

  test(`${code}: detectLang names the language`, () => {
    assert.equal(detectLang(L.tenWord), code);
  });

  test(`${code}: word counts, the-ratio and the median prompt are sane`, () => {
    const sessions = corpusFor(code);
    const ctx = buildStats(sessions, OPTS);
    const out = buildMemories(sessions, OPTS);

    assert.ok(ctx.humanTurns.length > 200, `${code}: only ${ctx.humanTurns.length} human turns`);

    // A one-word median is the CJK failure: a whole sentence read as one token.
    assert.ok(
      out.stats.medianPromptWords >= 4,
      `${code}: median prompt is ${out.stats.medianPromptWords} words`,
    );
    // …and the terse rate is the same failure seen from the other side.
    const terseRate = ctx.terseTurns / ctx.humanTurns.length;
    assert.ok(terseRate < 0.95, `${code}: ${(terseRate * 100).toFixed(0)}% of prompts read as terse`);

    // the-ratio: agent words per human word. It was 100+ for CJK, because the
    // denominator was collapsing to one token a sentence.
    assert.ok(
      out.stats.ratio >= 2 && out.stats.ratio <= 40,
      `${code}: the-ratio is ${out.stats.ratio} to one`,
    );
    assert.ok(out.stats.yourWords > 1000, `${code}: yourWords is only ${out.stats.yourWords}`);
  });

  test(`${code}: politeness and apology cards fire`, () => {
    const sessions = corpusFor(code);
    const ctx = buildStats(sessions, OPTS);
    const out = buildMemories(sessions, OPTS);

    assert.ok(ctx.politeTurns >= 20, `${code}: politeTurns = ${ctx.politeTurns}`);
    assert.ok(ctx.apologyTurns.length >= 5, `${code}: apologyTurns = ${ctx.apologyTurns.length}`);

    const polite = byType(out, 'the-politeness');
    assert.ok(polite, `${code}: no the-politeness card`);
    assert.ok(polite.title.length > 0);

    const apology = byType(out, 'the-apology');
    assert.ok(apology, `${code}: no the-apology card`);
  });

  test(`${code}: a plain technical prompt is neither polite nor an apology`, () => {
    // The false-positive guard. A lexicon that fires on «solo», «todo» or
    // «просто» makes every corpus in that language look courteous.
    const sessions = CORPORA[code].plain.map((text, i) => ({
      id: `${code}-plain-${i}`,
      agent: 'codex',
      startedAt: at(2026, 3, 1, 12) + i * 86400000,
      endedAt: at(2026, 3, 1, 13) + i * 86400000,
      durationMs: 3600000,
      project: 'p',
      cwd: '/Users/x/code/p',
      models: ['gpt-5.6-sol'],
      humanTurns: [{ ts: at(2026, 3, 1, 12, 30) + i * 86400000, text }],
      agentTurns: [{ ts: at(2026, 3, 1, 12, 31) + i * 86400000, text: AGENT_TEXT }],
      reasoning: [],
      tools: {},
      filesTouched: [],
      interrupts: [],
      tokens: {},
      compactions: 0,
      subagents: 0,
      thinkingChars: 0,
      isSidechain: false,
    }));
    const ctx = buildStats(sessions, OPTS);
    assert.equal(ctx.humanTurns.length, CORPORA[code].plain.length);
    assert.equal(
      ctx.politeTurns, 0,
      `${code}: ${ctx.politeTurns} of ${ctx.humanTurns.length} plain prompts read as polite`,
    );
    assert.equal(
      ctx.apologyTurns.length, 0,
      `${code}: plain prompts read as apologies: ${ctx.apologyTurns.map((t) => t.text).join(' | ')}`,
    );
  });

  test(`${code}: the catchphrase is a phrase, not a pile of function words`, () => {
    const sessions = corpusFor(code);
    const out = buildMemories(sessions, OPTS);
    const card = byType(out, 'catchphrase-yours');
    assert.ok(card, `${code}: no catchphrase card`);

    const phrase = card.quote ? card.quote.text : '';
    assert.ok(phrase, `${code}: catchphrase card carries no quote`);

    const toks = words(phrase);
    assert.ok(toks.length >= 2, `${code}: catchphrase «${phrase}» is ${toks.length} token(s)`);

    // «el error de» was the whole point: a phrase of articles and prepositions.
    const stops = toks.filter(isStop).length;
    assert.ok(
      stops * 2 <= toks.length,
      `${code}: catchphrase «${phrase}» is ${stops}/${toks.length} stopwords`,
    );
    assert.ok(
      toks.some((t) => L.content.includes(t)),
      `${code}: catchphrase «${phrase}» carries no content word (tokens: ${JSON.stringify(toks)})`,
    );
  });

  test(`${code}: the archetype is not decided by a broken word count`, () => {
    const sessions = daytime(corpusFor(code));
    const ctx = buildStats(sessions, OPTS);
    ctx.archetype = pickArchetype(ctx);
    assert.notEqual(
      ctx.archetype.name, 'The Two-Word Tyrant',
      `${code}: median prompt ${ctx.features._raw.verbose} words, terse feature ${ctx.features.terse}`,
    );
  });

  test(`${code}: the same corpus twice produces byte-identical memories`, () => {
    const a = JSON.stringify(buildMemories(corpusFor(code), OPTS));
    const b = JSON.stringify(buildMemories(corpusFor(code), OPTS));
    assert.equal(a, b);
  });
}

/* ========================================================================== */
/* Cross-cutting                                                              */
/* ========================================================================== */

test('a mined CJK phrase is displayed the way its language writes it', () => {
  // The miner joins tokens with a space because that is what a phrase looks
  // like in every script that uses one. Chinese and Japanese do not.
  assert.equal(displayPhrase('修复 认证 模 块'), '修复认证模块');
  assert.equal(displayPhrase('認証 モジュール の ログイン'), '認証モジュールのログイン');
  // Korean is space-delimited — leave it alone.
  assert.equal(displayPhrase('인증 모듈의 로그인'), '인증 모듈의 로그인');
  assert.equal(displayPhrase('commit and push'), 'commit and push');
  assert.equal(displayPhrase('коммит и пуш'), 'коммит и пуш');
  // Latin next to Han keeps its space: "fetch 函数" is two words in any reading.
  assert.equal(displayPhrase('fetch 函数 加上'), 'fetch 函数加上');

  for (const code of ['zh', 'ja']) {
    const card = byType(buildMemories(corpusFor(code), OPTS), 'catchphrase-yours');
    assert.ok(card, `${code}: no catchphrase card`);
    assert.ok(
      !/\s/.test(card.quote.text),
      `${code}: catchphrase «${card.quote.text}» still carries the miner's spaces`,
    );
  }
});

/** Interleave two single-language corpora into one bilingual history. */
function bilingual(a, b) {
  const left = corpusFor(a, 20);
  const right = corpusFor(b, 20).map((s) => ({ ...s, id: 'b-' + s.id }));
  return [...left, ...right];
}

test('two-tongues fires across a script boundary, in any language', () => {
  for (const [a, b] of [['ru', 'en'], ['zh', 'en'], ['ja', 'en'], ['ko', 'en'], ['ru', 'zh']]) {
    const out = buildMemories(bilingual(a, b), OPTS);
    const card = byType(out, 'two-tongues');
    assert.ok(card, `${a}+${b}: no two-tongues card`);
    assert.ok(
      !/\bmixed\b/.test(card.stat.label),
      `${a}+${b}: two-tongues could not name a language — "${card.stat.label}"`,
    );
  }
});

test('two-tongues does not accuse a monolingual user of code-switching', () => {
  // detectLang defaults to `en` for Latin text whose function words did not
  // clear the confidence floor, so a monolingual Spanish corpus reads as ~66 %
  // es / ~34 % en. Naming that "Spanish and English" would be a lie, and the
  // card is suppressed rather than guessed. Same for every Latin language.
  for (const code of ['es', 'de', 'fr', 'pt', 'it']) {
    if (!CORPORA[code]) continue;
    const out = buildMemories(corpusFor(code), OPTS);
    const card = byType(out, 'two-tongues');
    assert.equal(card, null, `${code}: monolingual corpus produced «${card && card.title}»`);
  }
});

/** One session, one prompt — the smallest thing buildStats will accept. */
function oneTurn(text) {
  const ts = at(2026, 3, 1, 12, 30);
  return [{
    id: 'one',
    agent: 'codex',
    startedAt: ts - 60000,
    endedAt: ts + 60000,
    durationMs: 120000,
    project: 'p',
    cwd: '/Users/x/code/p',
    models: ['gpt-5.6-sol'],
    humanTurns: [{ ts, text }],
    agentTurns: [{ ts: ts + 1000, text: AGENT_TEXT }],
    reasoning: [],
    tools: {},
    filesTouched: [],
    interrupts: [],
    tokens: {},
    compactions: 0,
    subagents: 0,
    thinkingChars: 0,
    isSidechain: false,
  }];
}

test('every phrase in the lexicon still reaches stats.js', () => {
  // stats.js matches the 157 phrase markers with one compiled alternation
  // rather than 157 substring scans. The verdicts must be identical to the
  // list it was compiled from, including for entries carrying regex
  // metacharacters (`s'il vous plaît`, `desculpa-me`) and CJK.
  for (const p of POLITE_EN_PHRASES) {
    const ctx = buildStats(oneTurn(`ok ${p} ok`), OPTS);
    assert.equal(ctx.politeTurns, 1, `politeness phrase not matched: «${p}»`);
  }
  for (const p of APOLOGY_EN_PHRASES) {
    const ctx = buildStats(oneTurn(`ok ${p} ok`), OPTS);
    assert.equal(ctx.apologyTurns.length, 1, `apology phrase not matched: «${p}»`);
  }
  for (const bad of APOLOGY_EXCLUDE) {
    // An error word vetoes the turn even when an apology marker is right there.
    const ctx = buildStats(oneTurn(`sorry, ${bad} again`), OPTS);
    assert.equal(ctx.apologyTurns.length, 0, `apology exclude not honoured: «${bad}»`);
  }
});

test('every language reaches a feed of real cards, not a wall of seedlings', () => {
  for (const code of LANGS) {
    const out = buildMemories(corpusFor(code), OPTS);
    assert.ok(out.memories.length >= 12, `${code}: feed is only ${out.memories.length} cards`);
    for (const m of out.memories) {
      assert.ok(m.title && m.title.trim(), `${code}: ${m.type} has an empty title`);
      assert.ok(!/undefined|NaN|\[object/.test(m.title + ' ' + (m.body || '')),
        `${code}: ${m.type} copy is broken — ${m.title} || ${m.body}`);
    }
  }
});
