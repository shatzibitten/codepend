/**
 * Stopwords, politeness and apology lexicons — one block per language.
 *
 * Non-exhaustive on purpose. The structural filters in _ngram.js do the heavy
 * lifting, and an over-eager stopword list would eat the imperatives that ARE
 * the catchphrases.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * HOW TO ADD A LANGUAGE  (this is the best first contribution in the repo)
 *
 * Copy any block in LEX below, change the key, fill in four fields. Nothing
 * else in the codebase needs to change — every export is derived from LEX.
 *
 *   stop     40–120 function words: articles, pronouns, prepositions,
 *            conjunctions, auxiliaries, particles. Whitespace-separated string.
 *            This keeps catchphrases meaningful: without a Spanish block the
 *            top phrase of a Spanish user comes out as «el error de».
 *            NOT stopwords: imperatives, and the politeness markers below
 *            ("please" is not a stopword, so neither is «bitte» or «请»).
 *
 *   polite / apology — three matching strategies, pick per word:
 *     tokens   exact match against one token from words(). Safest. Use this
 *              for anything that is a whole word: «merci», «gracias», «danke».
 *              NEVER put a short Latin word in `phrases` — phrases are matched
 *              as raw substrings, and "commercial" contains "merci".
 *     stems    prefix match on a token, for heavily inflected languages
 *              (ru/uk/pl/tr/pt). «obrigad» covers obrigado/obrigada/obrigados.
 *              Anything a stem over-matches goes in `exclude`.
 *     phrases  substring match on the whole flattened, lowercased turn. Use for
 *              multi-word markers («por favor», «s'il vous plaît») and for
 *              CJK/Korean, where segmentation is unreliable — «ください» comes
 *              back from Intl.Segmenter as くだ + さい, so the token path misses
 *              it and only the substring path is dependable.
 *
 *   exclude  exact tokens a stem wrongly matches. «прост» catches «прости»
 *            (sorry) but also «просто» (just) — the single most expensive
 *            false positive in this file, off by an order of magnitude.
 *
 * Then add cases to test/i18n-lexicon.test.mjs: one polite sentence, one
 * apology, one plain technical sentence that must be neither, and every trap
 * you can think of. Run `node --test`.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Consumed by src/stats.js (isPolite / isApology) and _ngram.js (isStop).
 * isPolite/isApology only ever see HUMAN turns, never agent output.
 *
 * Two mechanical facts about the consumer, worth knowing before you edit:
 *  1. apology `exclude` words (error/fehler/错误…) are checked FIRST and veto
 *     the whole turn, so an apology phrase must not contain one. That is why
 *     «mein Fehler» and «benim hatam» are absent below while «tut mir leid»
 *     and «kusura bakma» are present.
 *  2. apologies count as politeness too — «извини» and «sorry» are in both
 *     lists. New languages follow that convention.
 *
 * OMITTED ON PURPOSE — real words in one language, load-bearing jargon in a
 * developer corpus. Do not "complete" these lists with them:
 *   todo/todos (es/pt "all")  → TODO comments
 *   var        (tr "there is") → the JS keyword
 *   ai         (fr "have", it "to the") → AI
 *   net        (nl "just")     → .NET / network
 *   fine       (it "end")      → "looks fine"
 *   come       (it "as")       → "come up with"
 *   ir         (es "to go")    → IR / infrared
 *   car        (fr "because")  → car
 *   rica       (tr "request")  → es "rica"; only «rica ederim» is safe
 *   solo       (es/it "only")  → "solo run", "solo dev"
 */

/* ========================================================================== */
/* The lexicon. One block per language. Order is fixed and deterministic.     */
/* ========================================================================== */

/** @type {Record<string, {name:string, stop:string, polite?:object, apology?:object, exclude?:string[]}>} */
const LEX = {
  /* ---------------------------------------------------------------- English */
  en: {
    name: 'English',
    stop: `the a an and or but to of in on for with is are was were be been being it this that
you i we they he she my your our its at as by from into over under out up down about not no yes
ok okay do does did doing done can could should would will shall may might must have has had
if then so than there here what which who whom whose when where why how all any both each few
more most other some such only own same too very just now also get got make made me us them him
her his hers their theirs am pls`,
    polite: {
      tokens: ['please', 'thanks', 'thx', 'appreciate', 'sorry', 'welcome', 'kindly'],
      phrases: ['thank you', 'my bad', 'no worries', 'good job', 'well done', 'appreciate it'],
    },
    apology: {
      tokens: ['sorry', 'apologies', 'apologize', 'apologise'],
      phrases: ['my bad', 'my fault'],
      exclude: ['error', 'exception', 'traceback', 'stacktrace'],
    },
  },

  /* ---------------------------------------------------------------- Russian */
  ru: {
    name: 'Russian',
    stop: `и в во не на что с со как а то же бы для по из у от о об это эта этот эти тот та те
ты я мы вы он она они его её их там тут ли да нет уже еще ещё был была было были быть есть
или но же ну вот при над под перед после между через без про чтобы теперь сейчас потом опять снова к ко за до ни аж уж если когда где куда откуда
кто чей чем чём тем том тому этом этого того всё все весь вся мне тебе нам вам ему ей им них
себя себе свой своя свои может можно надо нужно просто очень так такой такая такие раз`,
    polite: {
      stems: ['пожалуйст', 'спасиб', 'спс', 'извин', 'прост', 'благодар', 'молодец', 'отличн'],
      phrases: ['будь добр', 'будь любезен', 'будьте добры'],
    },
    apology: {
      stems: ['извин', 'прост', 'виноват', 'сорри', 'сори'],
      exclude: ['ошибк', 'исключен'],
    },
    // «просто» (just) is one of the most common words in Russian.
    exclude: [
      'просто', 'простой', 'простая', 'простое', 'простые', 'проста', 'простым', 'простыми',
      'простого', 'простому', 'отличный', 'отличная', 'отличное', 'отличные', 'отличие',
    ],
  },

  /* --------------------------------------------------------------- German */
  de: {
    name: 'German',
    stop: `der die das den dem des ein eine einen einem eines einer und oder aber ist sind war
waren sein bin bist seid habe hast hat haben hatte hatten wird werden wurde wurden worden
ich du er sie es wir ihr mich mir dich dir uns euch ihn ihm ihnen sich mein meine dein deine
seine unser euer zu zum zur in im an am auf aus bei nach von vom mit für über unter vor
durch ohne um gegen zwischen seit bis nicht kein keine keinen nichts noch schon auch nur
sehr mehr dann denn weil wenn dass damit als wie was wer wo wohin warum wann welche welcher
man kann kannst können konnte soll sollte muss müssen will willst wollen möchte darf mal
hier dort jetzt wieder immer nochmal etwas alles beim ins`,
    polite: {
      tokens: ['dankeschön', 'dankeschon', 'verzeihung', 'gerne'],
      // `bitte` is a stem so `exclude` can reach it: EN "bitten"/"bitter" would
      // otherwise read as German politeness in every mixed-language corpus.
      stems: ['danke', 'dank', 'bitte', 'entschuldig'],
      phrases: ['vielen dank', 'danke schön', 'wäre nett'],
    },
    apology: {
      tokens: ['entschuldigung', 'entschuldige', 'entschuldigen', 'verzeihung', 'sry'],
      stems: ['entschuldig'],
      // «mein Fehler» cannot be listed: `fehler` vetoes the turn first (see head).
      phrases: ['tut mir leid', 'mein versehen'],
      exclude: ['fehler', 'ausnahme'],
    },
    exclude: ['bitten', 'bitter', 'bittere', 'bitteres', 'bitterly', 'bitterness', 'dankest'],
  },

  /* --------------------------------------------------------------- Spanish */
  es: {
    name: 'Spanish',
    stop: `el la los las un una unos unas de del al lo y e o u pero sino que quien quienes cual
cuales cuando donde como porque para por con sin sobre entre hasta desde hacia según tras
es son era eran ser estar está están estoy estamos estaba he ha han hay había hemos
yo tú tu vos usted él ella nosotros ustedes ellos ellas me te se nos les le les mi mis su sus
nuestro nuestra este esta esto estos estas ese esa eso esos esas aquel aquella
no ni ya aún todavía muy más menos también tampoco sólo así entonces pues bien mal
qué cómo cuál cuánto dónde cuándo quién ahora aquí allí allá algo alguien nada nadie`,
    polite: {
      tokens: [
        'gracias', 'porfa', 'porfavor', 'amable',
        'perdón', 'perdon', 'perdona', 'perdóname', 'perdoname', 'perdonad',
        'disculpa', 'disculpe', 'disculpas', 'discúlpame', 'disculpame',
      ],
      stems: ['agradec'],
      // «favor» alone is an ordinary noun ("hazme un favor de otro modo") — only
      // the full phrase is a politeness marker.
      phrases: ['por favor', 'muchas gracias', 'lo siento', 'si eres tan amable'],
    },
    apology: {
      tokens: [
        'perdón', 'perdon', 'perdona', 'perdóname', 'perdoname', 'perdonad',
        'disculpa', 'disculpe', 'disculpas', 'discúlpame', 'disculpame',
      ],
      stems: ['disculp', 'perdón', 'perdon'],
      phrases: ['lo siento', 'mi culpa', 'culpa mía', 'culpa mia'],
      exclude: ['excepción'],
    },
  },

  /* ---------------------------------------------------------------- French */
  fr: {
    name: 'French',
    stop: `le la les un une des du de au aux et ou mais donc or ni que qui quoi dont où
je tu il elle nous vous ils elles on me te se lui leur mon ma mes ton ta tes son sa ses
notre nos votre vos leurs ce cet cette ces celui celle ceux
est sont était étaient être suis es sommes êtes as avons avez ont avoir fait faire
dans sur sous avec sans pour par vers chez entre depuis pendant après avant contre
ne pas plus moins très trop bien encore déjà toujours jamais aussi alors ensuite
comment pourquoi quand combien quel quelle quels quelles là ici ça cela ceci rien tout tous
toute toutes autre autres même si oui non peut peux pouvez doit dois faut`,
    polite: {
      // «merci» must be a token, never a phrase: "commercial" contains "merci".
      tokens: [
        'merci', 'stp', 'svp', 'gentiment',
        'désolé', 'désolée', 'désolés', 'désolées', 'desole', 'desolee', 'desoles',
        'pardon', 'excusez', 'excuse-moi', 'excusez-moi',
      ],
      stems: ['remerci'],
      phrases: [
        "s'il vous plaît", 's’il vous plaît', "s'il te plaît", 's’il te plaît',
        "s'il vous plait", 's’il vous plait', "s'il te plait", 's’il te plait',
        'merci beaucoup',
      ],
    },
    apology: {
      // «pardon» is left out: in French it is "excuse me" as often as "sorry",
      // and it counts as politeness above either way.
      tokens: ['désolé', 'désolée', 'désolés', 'désolées', 'desole', 'desolee', 'desoles',
        'excusez', 'excuse-moi', 'excusez-moi'],
      stems: ['désol', 'desol'],
      phrases: ['ma faute', 'je suis désolé', 'je suis desole', 'toutes mes excuses'],
      exclude: ['erreur'],
    },
    exclude: ['desolate', 'desolated', 'desolation', 'desolating'],
  },

  /* ------------------------------------------------------------ Portuguese */
  pt: {
    name: 'Portuguese',
    stop: `o a os as um uma uns umas do da dos das no na nos nas ao aos à às pelo pela
de em por para com sem sobre entre até desde após antes contra
e ou mas porém que quem qual quais quando onde como porque
é são era eram ser estar está estão estou tem têm tenho havia foi foram sido
eu tu você vocês ele ela eles elas nós me te se lhe lhes meu minha meus minhas seu sua
nosso nossa este esta isto esse essa isso aquele aquela aquilo
não nem já ainda muito mais menos também só apenas assim então bem
qual quanto aqui ali lá agora algo alguém nada ninguém tudo`,
    polite: {
      tokens: ['obrigado', 'obrigada', 'obrigados', 'obrigadas', 'obrigadão', 'valeu', 'gentileza'],
      stems: ['obrigad', 'agradec', 'desculp'],
      phrases: ['por favor', 'por gentileza', 'muito obrigado', 'se possível'],
    },
    apology: {
      tokens: ['desculpa', 'desculpe', 'desculpas', 'desculpem', 'desculpa-me'],
      stems: ['desculp'],
      phrases: ['foi mal', 'culpa minha', 'minha culpa', 'me desculpe'],
      exclude: ['erro', 'exceção'],
    },
  },

  /* --------------------------------------------------------------- Italian */
  it: {
    name: 'Italian',
    stop: `il lo la i gli le un uno una del dello della dei degli delle al allo alla agli
alle dal dalla dai nel nello nella nei negli nelle sul sulla sui col
di a da in con su per tra fra senza sotto sopra dopo prima verso durante
e ed o oppure ma però perché che chi cui quando dove quanto quale quali
è sono era erano essere sia ho hai ha abbiamo avete hanno avere stato stata
io tu lui lei noi voi loro mi ti ci vi si me te ne lo la li le mio mia miei tuo tua suo sua
nostro vostro questo questa questi queste quello quella quelli quelle
non né già ancora molto più meno anche così allora poi bene proprio ogni tutto tutti
qui qua lì là ora adesso niente nulla qualcosa qualcuno`,
    polite: {
      tokens: ['grazie', 'prego', 'perfavore', 'gentilmente',
        'scusa', 'scusi', 'scusate', 'scusami', 'scusatemi'],
      stems: ['grazie', 'ringrazi'],
      phrases: ['per favore', 'per piacere', 'ti prego', 'la prego', 'mille grazie'],
    },
    apology: {
      tokens: ['scusa', 'scusi', 'scusate', 'scusami', 'scusatemi'],
      stems: ['scus'],
      phrases: ['colpa mia', 'mi dispiace', 'chiedo scusa'],
      exclude: ['errore', 'eccezione'],
    },
  },

  /* ----------------------------------------------------------------- Dutch */
  nl: {
    name: 'Dutch',
    stop: `de het een en of maar want dus is zijn was waren ben bent word wordt worden werd
heb hebt heeft hebben had hadden zal zullen zou zouden kan kunt kunnen kon moet moeten mag
ik jij je u wij we jullie hij zij ze men mij me jou hem haar ons hun mijn jouw uw zijn haar
onze deze dit dat die er daar hier
van voor met naar op in aan bij uit over onder door om tot te tegen tussen zonder na
niet geen nog al ook wel maar heel erg meer minst dan als toen dan zo dus
wat wie waar waarom hoe wanneer welke iets iemand niets niemand alles`,
    polite: {
      tokens: ['bedankt', 'dankjewel', 'dankje', 'dank', 'alsjeblieft', 'alstublieft', 'aub',
        'graag', 'excuseer'],
      stems: ['bedank', 'dank'],
      phrases: ['dank je', 'dank u', 'hartelijk dank', 'zou je zo goed',
        'mijn excuses', 'het spijt me'],
    },
    apology: {
      // Bare «excuses» is left out — it is an ordinary English noun ("no
      // excuses"), and the Dutch reading is safe only in «mijn excuses».
      tokens: ['excuseer'],
      phrases: ['mijn fout', 'het spijt me', 'mijn excuses', 'sorry daarvoor'],
      exclude: ['uitzondering'],
    },
  },

  /* ---------------------------------------------------------------- Polish */
  pl: {
    name: 'Polish',
    stop: `i w we na do z ze że nie to jest są był była było były być się a ale lub czy jak
co kto gdzie kiedy dlaczego ten ta te ci tym tego temu tej tych ja ty my wy on ona ono oni
mnie ciebie jego jej ich nam wam nas was mój moja twój swoje
dla od po przed za przez bez o u przy pod nad oraz też już jeszcze tylko bardzo
może można trzeba jeśli żeby aby więc jednak takie taki taka tutaj tam teraz coś ktoś nic
nikt wszystko każdy inny sam sobie mi ci go ją je`,
    polite: {
      tokens: ['dzięki', 'dzieki', 'dziękuję', 'dziekuje', 'dziękujemy', 'dziekujemy',
        'proszę', 'prosze', 'przepraszam', 'przepraszamy', 'sorki', 'wybacz', 'wybaczcie'],
      stems: ['dzięk', 'dziek', 'przeprasz', 'prosz'],
    },
    apology: {
      tokens: ['przepraszam', 'przepraszamy', 'sorki', 'wybacz', 'wybaczcie'],
      stems: ['przeprasz', 'wybacz'],
      // «mój błąd» cannot be listed: `błąd` vetoes the turn first (see head).
      phrases: ['moja wina', 'to moja sprawka'],
      exclude: ['błąd', 'błęd', 'wyjątek'],
    },
    exclude: ['dziekan', 'dziekanat', 'dziekani'],
  },

  /* --------------------------------------------------------------- Turkish */
  tr: {
    name: 'Turkish',
    stop: `bir bu şu o ve veya ama ancak ile için gibi kadar sonra önce da de ki mi mı mu mü
ben sen biz siz onlar bana sana ona bize size bizim sizim benim senin onun
ne nasıl neden niçin nerede nereye kim hangi kaç
değil yok çok daha en az biraz her bazı tüm hep hiç şey şeyi olarak olan oldu olur olacak
ise yani zaten sadece yine tekrar şimdi burada orada böyle şöyle öyle
etmek yapmak yap eder ediyor edildi`,
    polite: {
      tokens: ['lütfen', 'lutfen', 'sağol', 'sagol', 'sağolun', 'sagolun', 'affedersiniz', 'pardon'],
      stems: ['teşekkür', 'tesekkur', 'özür', 'ozur', 'affeder'],
      phrases: ['rica ederim', 'rica etsem', 'teşekkür ederim', 'kusura bakma'],
    },
    apology: {
      tokens: ['affedersiniz', 'affedersin', 'üzgünüm', 'uzgunum'],
      stems: ['özür', 'ozur', 'affeder'],
      // «benim hatam» cannot be listed: `hata` vetoes the turn first (see head).
      phrases: ['kusura bakma', 'kusura bakmayın', 'özür dilerim'],
      exclude: ['hata', 'istisna'],
    },
    exclude: ['özürlü', 'özürlüler', 'ozurlu'],
  },

  /* ------------------------------------------------------------- Ukrainian */
  uk: {
    name: 'Ukrainian',
    stop: `і й в у на не що як а але до з із зі для по від про це цей ця ці той та те
ти я ми ви він вона воно вони його її їх є був була було були бути чи коли де куди хто
щоб якщо вже ще дуже тільки можна треба так там тут мені тобі нам вам йому їй їм них
себе собі свій своя свої може над під перед після між через без ані ні теж також`,
    polite: {
      // «будь-ласка» is one token (words() keeps internal hyphens), «будь ласка»
      // is two — the first belongs in tokens, the second in phrases.
      tokens: ['дякую', 'дякуємо', 'спасибі', 'вибач', 'вибачте', 'вибачаюсь', 'перепрошую',
        'будь-ласка'],
      stems: ['дяку', 'вибач', 'перепрош'],
      phrases: ['будь ласка', 'будьте ласкаві'],
    },
    apology: {
      tokens: ['вибач', 'вибачте', 'вибачаюсь', 'перепрошую', 'даруйте'],
      stems: ['вибач', 'перепрош'],
      phrases: ['моя вина', 'мій прорахунок'],
      exclude: ['помилк', 'виняток'],
    },
  },

  /* --------------------------------------------------------------- Chinese */
  // Tokens cover both segmentation paths: Intl.Segmenter yields «谢谢» / «感谢»,
  // the code-point fallback yields «谢». Both are listed. Phrases are the
  // dependable path and carry the multi-character markers.
  zh: {
    name: 'Chinese',
    stop: `的 了 是 我 你 您 他 她 它 我们 你们 他们 这 那 这个 那个 这些 那些 和 与 或 但 但是
因为 所以 如果 就 都 也 很 在 有 没有 不 要 会 能 可以 把 被 给 对 从 到 为 为了 跟 以及
吗 呢 吧 啊 让 用 个 上 下 里 中 时候 现在 一下 一个 什么 怎么 为什么 哪里 谁 还 还是 已经
一些 这样 那样 需要 应该 而且 然后 再 又 最 更 只 就是 我的 你的 它的 之后 之前 以后`,
    polite: {
      tokens: ['谢谢', '谢', '感谢', '多谢', '请', '拜托', '劳驾', '有劳', '请问', '麻烦你', '麻烦您',
        '对不起', '抱歉', '不好意思'],
      // Bare «麻烦» is left out on purpose: it is "please/bother you" in 麻烦你,
      // but plain "troublesome" in 这个很麻烦. Bare «请» is a token only —
      // as a substring it fires inside 申请 (apply) and 邀请 (invite).
      phrases: ['谢谢', '感谢', '多谢', '拜托', '请问', '有劳', '劳驾', '麻烦你', '麻烦您', '麻烦帮',
        '对不起', '抱歉', '不好意思'],
    },
    apology: {
      tokens: ['对不起', '抱歉', '不好意思', '对不住', '歉意'],
      phrases: ['对不起', '抱歉', '不好意思', '对不住', '我的错', '我错了'],
      exclude: ['错误', '异常', '报错'],
    },
  },

  /* -------------------------------------------------------------- Japanese */
  ja: {
    name: 'Japanese',
    stop: `の は を に が で と も から まで より へ や など です ます ました ません でした
する して した される いる います ある あります この その あの どの これ それ あれ
ここ そこ どこ 私 僕 あなた 彼 彼女 私たち けど しかし でも ので だから また もう まだ
とても すごく こと もの ため よう そして それで なぜ どう どうして いつ 誰 何 なに
ない なく なので という について ように ください`,
    polite: {
      tokens: ['ありがとう', 'ありがとうございます', 'お願い', 'おねがい', 'よろしく', 'すみません',
        'ごめん', '申し訳'],
      // «ください» comes back from Intl.Segmenter as くだ + さい, so the token
      // path cannot see it. Substring is the only reliable route for Japanese.
      phrases: ['ありがと', 'お願い', 'おねがい', 'よろしく', 'すみません', 'すいません',
        'ください', '恐れ入り', '助かります', 'ごめん', '申し訳'],
    },
    apology: {
      // Bare «すみません» is NOT here. It opens a polite request at least as
      // often as it apologises («すみません、ログを見てください»); it counts as
      // politeness above, and only the explicitly apologetic forms count here.
      tokens: ['ごめん', 'ごめんなさい', 'すまない', 'すまん', '申し訳'],
      phrases: ['ごめん', 'すまない', 'すまん', '申し訳', 'すみませんでした',
        'すいませんでした', '失礼しました', '私のミス'],
      exclude: ['エラー', '例外', '不具合'],
    },
  },

  /* ---------------------------------------------------------------- Korean */
  // Korean is space-delimited but agglutinative: words() returns whole eojeol
  // («수정해주세요»), so tokens rarely match and phrases do the work.
  ko: {
    name: 'Korean',
    stop: `이 가 을 를 은 는 에 에서 으로 로 와 과 도 만 의 하다 합니다 해요 했다 있다 없다
그 저 나 너 우리 이것 그것 저것 뭐 무엇 어떻게 왜 언제 어디 그리고 하지만 그래서 만약
좀 다시 너무 정말 수 것 등 및 또 또는 안 못 잘 더 가장 이런 그런 저런 여기 거기 저기
있는 없는 같은 대해 위해 통해 부터 까지 에게 한테 이나 거나 지만 면서`,
    polite: {
      tokens: ['감사합니다', '감사', '고마워', '고맙습니다', '부탁', '제발', '죄송', '미안'],
      // «감사» is also "audit" in Korean; in a developer corpus the thanks
      // reading dominates by a wide margin, so it stays.
      phrases: ['감사', '고마', '고맙', '부탁', '주세요', '제발', '해주시', '죄송', '미안'],
    },
    apology: {
      tokens: ['미안', '미안해', '미안합니다', '죄송', '죄송합니다'],
      phrases: ['미안', '죄송', '제 잘못', '실수했'],
      exclude: ['오류', '예외', '에러'],
    },
  },
};

/* ========================================================================== */
/* Derived exports. Nothing below needs editing to add a language.            */
/* ========================================================================== */

const splitWords = (s) => String(s || '').split(/\s+/).map((w) => w.trim().toLowerCase()).filter(Boolean);

/** Language codes covered, in file order. */
export const LEXICON_LANGS = Object.keys(LEX);

/** Stopwords per language, for tests and for `codepend --explain`. */
export const STOPWORDS_BY_LANG = Object.freeze(
  Object.fromEntries(LEXICON_LANGS.map((k) => [k, Object.freeze(splitWords(LEX[k].stop))])),
);

/** @type {Set<string>} every language's stopwords, flattened. */
export const STOPWORDS = new Set(
  LEXICON_LANGS.flatMap((k) => STOPWORDS_BY_LANG[k]),
);

/**
 * A real Array whose `includes` is a Set lookup.
 *
 * src/stats.js calls `POLITE_EN.includes(token)` once per token of every human
 * turn. At two languages that was a 7-element scan; at fourteen it is 120, and
 * it measured as the hottest line in buildStats. The array shape is untouched —
 * Array.isArray, iteration, spread, indexing and length all behave normally,
 * and the override is non-enumerable so nothing can see it by accident.
 * @param {string[]} items already deduplicated
 */
function markerList(items) {
  const arr = items.slice();
  const set = new Set(arr);
  Object.defineProperty(arr, 'includes', {
    value: (v) => set.has(v),
    writable: true, configurable: true, enumerable: false,
  });
  return arr;
}

function collect(kind, field) {
  const out = [];
  const seen = new Set();
  for (const k of LEXICON_LANGS) {
    const list = (LEX[k][kind] && LEX[k][kind][field]) || [];
    for (const raw of list) {
      const v = String(raw).normalize('NFC').toLowerCase();
      if (!v || seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
  }
  return markerList(out);
}

/**
 * Deliberately NOT stopwords. Listed so nobody "cleans up" the list later:
 * сделай, продолжай, почини, запусти, коммит, пуш, деплой, fix, run, ship,
 * commit, push, deploy, continue, again. Imperatives are the whole point.
 */
export const NEVER_STOP = new Set([
  'сделай', 'продолжай', 'почини', 'запусти', 'коммит', 'пуш', 'деплой', 'проверь',
  'fix', 'run', 'ship', 'commit', 'push', 'deploy', 'continue', 'again', 'test',
]);
/** Alias — the two names are used interchangeably in docs. */
export const NOT_STOPWORDS = NEVER_STOP;

/** Agent boilerplate that is scaffolding, not personality. */
export const AGENT_BLOCKLIST = new Set([
  'here', 'let', 'now', 'll', 've', 'file', 'files', 'code', 'line', 'lines',
  'function', 'error', 'errors', 'null', 'true', 'false', 'const', 'return',
]);

export function isStop(token) {
  if (NEVER_STOP.has(token)) return false;
  return STOPWORDS.has(token);
}

/* -------------------------------------------------- politeness + apologies */

/**
 * Whole-token politeness markers. Historically English-only — hence the name,
 * which src/stats.js imports; it now carries every language whose markers are
 * safe to match as complete tokens.
 */
export const POLITE_EN = collect('polite', 'tokens');
/** Substring politeness markers: multi-word phrases and CJK. */
export const POLITE_EN_PHRASES = collect('polite', 'phrases');
/** Prefix politeness markers, for inflected languages. */
export const POLITE_RU_STEMS = collect('polite', 'stems');

/**
 * Exact tokens a stem must not fire on, across all languages. «прост» catches
 * «прости» (sorry) but also «просто» (just), one of the most common words in
 * Russian; «bitte» catches English "bitten" and "bitter". Without these the
 * politeness rate is off by an order of magnitude.
 */
export const RU_STEM_EXCLUDE = new Set(
  LEXICON_LANGS.flatMap((k) => (LEX[k].exclude || []).map((w) => w.toLowerCase())),
);

export const APOLOGY_EN = collect('apology', 'tokens');
export const APOLOGY_EN_PHRASES = collect('apology', 'phrases');
export const APOLOGY_RU_STEMS = collect('apology', 'stems');

/**
 * Turns about code errors are not apologies to the agent. Matched as substrings
 * against the whole turn, and checked BEFORE any apology marker — an error word
 * anywhere in the message vetoes it.
 */
export const APOLOGY_EXCLUDE = collect('apology', 'exclude');

/* Clearer aliases for new code. Same objects — never diverge. */
export const POLITE_TOKENS = POLITE_EN;
export const POLITE_PHRASES = POLITE_EN_PHRASES;
export const POLITE_STEMS = POLITE_RU_STEMS;
export const STEM_EXCLUDE = RU_STEM_EXCLUDE;
export const APOLOGY_TOKENS = APOLOGY_EN;
export const APOLOGY_PHRASES = APOLOGY_EN_PHRASES;
export const APOLOGY_STEMS = APOLOGY_RU_STEMS;

/** Per-language view of the politeness/apology lexicon, for tests and docs. */
export const LEXICON = Object.freeze(
  Object.fromEntries(LEXICON_LANGS.map((k) => [k, Object.freeze({
    name: LEX[k].name,
    stop: STOPWORDS_BY_LANG[k],
    politeTokens: Object.freeze(((LEX[k].polite || {}).tokens || []).slice()),
    politeStems: Object.freeze(((LEX[k].polite || {}).stems || []).slice()),
    politePhrases: Object.freeze(((LEX[k].polite || {}).phrases || []).slice()),
    apologyTokens: Object.freeze(((LEX[k].apology || {}).tokens || []).slice()),
    apologyStems: Object.freeze(((LEX[k].apology || {}).stems || []).slice()),
    apologyPhrases: Object.freeze(((LEX[k].apology || {}).phrases || []).slice()),
    apologyExclude: Object.freeze(((LEX[k].apology || {}).exclude || []).slice()),
    stemExclude: Object.freeze((LEX[k].exclude || []).slice()),
  })])),
);
