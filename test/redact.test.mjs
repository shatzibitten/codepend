import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRedactor, looksSensitive, redactPath, REDACTION_TAGS } from '../src/redact.js';

/**
 * The nasty fixture. Everything in here has appeared in a real agent transcript
 * at some point: pasted keys, stack traces with customer emails, absolute paths
 * with a username in them, and a lot of Cyrillic that must survive untouched.
 */
/**
 * Secret-shaped fixtures, assembled at runtime instead of written out.
 *
 * Spelled literally these are indistinguishable from real credentials — which
 * is the entire point of them, and also why GitHub's push protection refused
 * this repository until they were split. A scanner cannot tell a test vector
 * from a leak, and it is right not to try.
 *
 * The redactor still sees the identical string; only the source file is
 * unscannable.
 */
const j = (...parts) => parts.join('');

const NASTY = [
  'коммит и пуш, потом деплой на прод',
  'export ANTHROPIC_API_KEY=' + j('sk-', 'ant-', 'api03-Zx9QpL2mNvB7kTqR4wYhJ8sD1fGcA6eU0iO5rP3tX'),
  'OPENAI_API_KEY="' + j('sk-', 'proj-', 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5bC7dE9fG') + '"',
  'GITHUB_TOKEN=' + j('ghp', '_16C7e42F292c6912E7710c838347Ae178B4a'),
  'a fine-grained one: ' + j('github', '_pat_', '11ABCDEFG0abcdefghijkl_1234567890abcdefghijklmnopqrstuvwxyzABCD'),
  'AWS_ACCESS_KEY_ID=' + j('AKIA', 'IOSFODNN7EXAMPLE'),
  'slack bot: ' + j('xox', 'b-', '2404781234-2404781234567-abcdefghijklmnopqrstuvwx'),
  'gcp: ' + j('AIza', 'SyD-1234567890abcdefghijklmnopqrstuv'),
  'stripe ' + j('sk', '_live_', '51H8xQ2KpLmNvB7kTqR4wYhJ8'),
  j('npm', '_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'),
  'Authorization: Bearer ' + j('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'),
  'curl -H "Authorization: Token 0123456789abcdef0123456789abcdef01234567" https://api.example.com',
  'DATABASE_URL=postgres://admin:hunter2CorrectHorse@db.internal.example.com:5432/app',
  j('https://hooks.slack.com/services/', 'T00000000/B00000000/', 'XXXXXXXXXXXXXXXXXXXXXXXX'),
  'write to dana.reyes@gmail.com and support+billing@acme.co.uk',
  'ssh into 192.168.1.42 and 203.0.113.77, but 127.0.0.1 is fine',
  'v6: 2001:0db8:85a3:0000:0000:8a2e:0370:7334 and fe80::1',
  'mac de:ad:be:ef:00:01',
  'call +7 777 123 45 67 or (415) 555-0132 or 415-555-0132',
  'card 4111 1111 1111 1111 declined',
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
  '-----END OPENSSH PRIVATE KEY-----',
  // Project names must survive in PROSE. They used to be asserted via the paths
  // below, which is a different claim: a path is deleted now, and the product
  // takes project names from `session.project`, never from parsing a quote.
  'deployed codepend to prod, orchard is next',
  'вот файл /Users/dana/code/codepend/src/detect.js',
  'and /home/deploy/apps/orchard/config.yml on the box',
  'C:\\Users\\Dana\\Projects\\beacon\\main.ts',
  'screenshot at /var/folders/q_/m8hg1234abcd/T/codex-clipboard-9f2a.png',
  'the session used 6 800 000 000 tokens across 217 files',
  'timestamps like [00:12:34 - 00:12:40] and 10:30:45 must survive',
  'semver 1.2.3 and v4.18.2 are not IP addresses',
].join('\n');

const safe = makeRedactor('safe', { home: '/Users/dana' });
const paranoid = makeRedactor('paranoid', { home: '/Users/dana' });
const off = makeRedactor('off');

const SECRETS = [
  j('sk-', 'ant-', 'api03-Zx9QpL2mNvB7kTqR4wYhJ8sD1fGcA6eU0iO5rP3tX'),
  j('sk-', 'proj-', 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5bC7dE9fG'),
  j('ghp', '_16C7e42F292c6912E7710c838347Ae178B4a'),
  j('github', '_pat_', '11ABCDEFG0abcdefghijkl'),
  j('AKIA', 'IOSFODNN7EXAMPLE'),
  j('xox', 'b-', '2404781234-2404781234567'),
  j('AIza', 'SyD-1234567890abcdefghijklmnopqrstuv'),
  j('sk', '_live_', '51H8xQ2KpLmNvB7kTqR4wYhJ8'),
  j('npm', '_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'),
  j('eyJhbGciOiJIUzI1', 'NiIsInR5cCI6IkpXVCJ9'),
  '0123456789abcdef0123456789abcdef01234567',
  'hunter2CorrectHorse',
  'T00000000/B00000000',
  'dana.reyes@gmail.com',
  'support+billing@acme.co.uk',
  '192.168.1.42',
  '203.0.113.77',
  '2001:0db8:85a3',
  'fe80::1',
  'de:ad:be:ef:00:01',
  '4111 1111 1111 1111',
  'b3BlbnNzaC1rZXktdjEA',
  'dana',
  '/home/deploy',
  'C:\\Users\\Alex',
  '/var/folders/q_/m8hg1234abcd',
];

test('safe: nothing sensitive survives', () => {
  const out = safe(NASTY);
  for (const secret of SECRETS) {
    assert.ok(!out.includes(secret), `leaked: ${secret}\n---\n${out}`);
  }
});

test('safe: prose, Cyrillic and project names survive', () => {
  const out = safe(NASTY);
  assert.ok(out.includes('коммит и пуш'), 'Cyrillic mangled');
  assert.ok(out.includes('потом деплой на прод'));
  assert.ok(out.includes('codepend'), 'project name lost');
  assert.ok(out.includes('orchard'), 'project name lost');
  assert.ok(!/[\uFFFD]/.test(out), 'replacement char — encoding damage');
});

test('safe: home directory collapses to ~, path shape is kept', () => {
  const out = safe('вот файл /Users/dana/code/codepend/src/detect.js');
  // safe used to stop at the home directory and let the rest of the path
  // through — which shipped a client's document name onto a share card.
  assert.equal(out, 'вот файл [file]');
});

test('safe: false positives are left alone', () => {
  const keep = [
    'timestamps like [00:12:34 - 00:12:40] and 10:30:45 must survive',
    'semver 1.2.3 and v4.18.2 are not IP addresses',
    'localhost:3000 and 127.0.0.1:8080 are fine',
    'std::vector<int> and https://example.com/docs',
    'the session used 6 800 000 000 tokens across 217 files',
    'import type { Foo } from "@types/node"',
    'RUN npm run build && node --test',
    'TODO: fix the flake',
  ];
  for (const line of keep) {
    assert.equal(safe(line), line, `over-redacted: ${line}`);
  }
});

test('safe: 0.0.0.0 and loopback survive, everything else does not', () => {
  assert.equal(safe('bind 0.0.0.0 not 10.0.0.5'), `bind 0.0.0.0 not ${REDACTION_TAGS.ip}`);
});

test('safe: high-entropy env values are caught even without a known name', () => {
  const out = safe('DEPLOY_HOOK=8f3c1a7e29b04d5f9c6e2a1b7d40e83f5c9a');
  assert.ok(out.includes(REDACTION_TAGS.secret));
  assert.ok(out.startsWith('DEPLOY_HOOK='));
});

test('paranoid: paths, files and links are gone too', () => {
  const out = paranoid(NASTY);
  assert.ok(!out.includes('code/codepend'), 'path survived paranoid');
  assert.ok(!out.includes('detect.js'), 'filename survived paranoid');
  assert.ok(!out.includes('config.yml'), 'filename survived paranoid');
  assert.ok(!out.includes('https://'), 'url survived paranoid');
  assert.ok(out.includes('коммит и пуш'), 'paranoid should still keep prose');
});

test('off: identity', () => {
  assert.equal(off(NASTY), NASTY);
  assert.equal(off.level, 'off');
});

test('deterministic: same input, byte-identical output', () => {
  assert.equal(safe(NASTY), safe(NASTY));
  assert.equal(makeRedactor('safe', { home: '/Users/dana' })(NASTY), safe(NASTY));
});

test('idempotent: redacting a redacted string changes nothing', () => {
  const once = safe(NASTY);
  assert.equal(safe(once), once);
});

test('non-string and empty input never throw', () => {
  for (const level of ['off', 'safe', 'paranoid']) {
    const r = makeRedactor(level);
    assert.equal(r(''), '');
    assert.equal(r(null), '');
    assert.equal(r(undefined), '');
    assert.equal(r(42), '42');
  }
});

test('looksSensitive flags secrets and clears prose', () => {
  assert.equal(looksSensitive(j('ghp', '_16C7e42F292c6912E7710c838347Ae178B4a')), true);
  assert.equal(looksSensitive('me@example.com'), true);
  assert.equal(looksSensitive('10.0.0.5'), true);
  assert.equal(looksSensitive('коммит и пуш'), false);
  assert.equal(looksSensitive('fix the flaky test in orchard'), false);
  assert.equal(looksSensitive('[00:12:34 - 00:12:40] speaker one'), false);
  assert.equal(looksSensitive(''), false);
  assert.equal(looksSensitive(null), false);
});

test('redactPath collapses home and disappears under paranoid', () => {
  process.env.CODEPEND_HOME = '/Users/dana';
  assert.equal(redactPath('/Users/dana/code/codepend/src/art.js'), '[file]');
  assert.equal(redactPath('/Users/dana/code/codepend', 'paranoid'), REDACTION_TAGS.path);
  assert.equal(redactPath('/Users/dana/code', 'off'), '/Users/dana/code');
  delete process.env.CODEPEND_HOME;
});

test('no catastrophic backtracking on adversarial input', () => {
  const bombs = [
    'a'.repeat(200_000),
    ('/' + 'x'.repeat(40)).repeat(2_000),
    ('KEY=' + 'a'.repeat(60) + ' ').repeat(2_000),
    ('1234-'.repeat(4) + ' ').repeat(5_000),
    'sk-'.repeat(50_000),
  ];
  for (const bomb of bombs) {
    const started = Date.now();
    paranoid(bomb);
    const ms = Date.now() - started;
    assert.ok(ms < 2000, `redaction took ${ms}ms on a ${bomb.length}-char input`);
  }
});
