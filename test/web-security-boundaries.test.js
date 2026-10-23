'use strict';

// Re-audit of the four previously reported web security items, plus the AI HTML
// sink. Each test states what was actually reproduced.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const html = read('public/index.html');
const adminSession = require('../lib/admin-session');
const { createRateLimiter, clientAddress } = require('../lib/request-rate-limit');

function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'missing ' + name);
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced ' + name);
}

// ---------------------------------------------------------------------------
// 1. api/quote.js advanced-field gating
// ---------------------------------------------------------------------------

test('advanced quote fields are gated on a signed session, not a request header', () => {
  const source = read('api/quote.js');
  // The old gate read X-Username / X-User-Id, which the client sets from
  // localStorage. `curl -H 'X-Username: anyone'` passed it.
  assert.doesNotMatch(source, /function hasLoggedInHeaders/);
  assert.doesNotMatch(extractFunction(source, 'hasVerifiedSession'), /x-username|x-user-id/i);
  assert.match(source, /adminSession\.requireAuthenticatedSession\(req\)/);
  assert.match(source, /allowAdvancedEntryAnalysis = hasVerifiedSession\(req\)/);
});

test('a forged identity header cannot unlock advanced quote fields', () => {
  const quote = require('../api/quote');
  const spoofed = {
    headers: {
      'x-username': 'someone',
      'x-user-id': 'aaaaaaaaaaaaaaaaaaaa',
      cookie: ''
    }
  };
  assert.equal(quote.__test.hasVerifiedSession(spoofed), false);
  assert.equal(quote.__test.hasVerifiedSession({ headers: {} }), false);
});

test('the gate fails closed when no session secret is configured', () => {
  const quote = require('../api/quote');
  const previous = process.env.SESSION_SECRET;
  delete process.env.SESSION_SECRET;
  try {
    assert.equal(quote.__test.hasVerifiedSession({ headers: { cookie: 'ac_sess=anything' } }), false);
  } finally {
    if (previous === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous;
  }
});

test('a genuine signed session does unlock the advanced fields', () => {
  const quote = require('../api/quote');
  const previous = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'test-secret-for-boundary-check';
  try {
    const token = adminSession.createSessionToken({ userId: 'u-1', username: 'demo', isAdmin: false });
    assert.ok(token, 'a token must be issued when the secret is set');
    assert.equal(quote.__test.hasVerifiedSession({ headers: { cookie: 'ac_sess=' + token } }), true);
    // And a token signed with a different secret must not.
    process.env.SESSION_SECRET = 'a-different-secret';
    assert.equal(quote.__test.hasVerifiedSession({ headers: { cookie: 'ac_sess=' + token } }), false);
  } finally {
    if (previous === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous;
  }
});

test('redaction removes every advanced field it claims to', () => {
  const quote = require('../api/quote');
  const result = quote.__test.redactAdvancedQuoteFields({
    last: 1000,
    respectZone: { low: 1, high: 2 },
    tradingPlan: {
      entry: 990,
      half_candle_level: 995,
      respect_quality_score: 7,
      respect_quality_label: 'kuat',
      refinement_notes: 'internal',
      bearish_respect_warning: 'internal'
    }
  });
  assert.equal(result.respectZone, undefined);
  assert.equal(result.tradingPlan.half_candle_level, undefined);
  assert.equal(result.tradingPlan.respect_quality_score, undefined);
  assert.equal(result.tradingPlan.refinement_notes, undefined);
  assert.equal(result.tradingPlan.bearish_respect_warning, undefined);
  // Ordinary plan data survives redaction.
  assert.equal(result.tradingPlan.entry, 990);
  assert.equal(result.last, 1000);
});

// ---------------------------------------------------------------------------
// 2. api/register-user.js rate limit and input bounds
// ---------------------------------------------------------------------------

test('registration is rate limited, keyed only on what the server observed', () => {
  const source = read('api/register-user.js');
  assert.match(source, /registrationLimiter\.check\(clientAddress\(req\)\)/);
  assert.match(source, /status\(429\)/);
  // Keying on anything from the body would let a caller mint a fresh bucket per
  // request, which is a limit that bounds nothing.
  assert.doesNotMatch(source, /limiter\.check\([^)]*body/);
  assert.doesNotMatch(source, /limiter\.check\([^)]*username/);
});

test('the limiter actually refuses once the window is full', () => {
  const limiter = createRateLimiter({ windowMs: 60000, max: 3 });
  assert.deepEqual([limiter.check('ip'), limiter.check('ip'), limiter.check('ip'), limiter.check('ip')],
    [true, true, true, false]);
  // A different caller has its own budget.
  assert.equal(limiter.check('other-ip'), true);
});

test('the limiter key cannot be chosen by the caller', () => {
  // C1: headers are trusted ONLY behind a trusted proxy hop. A direct caller
  // (no trusted peer) cannot choose its bucket via X-Forwarded-For.
  assert.equal(clientAddress({ headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' } }), 'unknown');
  assert.equal(clientAddress({ headers: {} }), 'unknown');
  // Behind the local nginx hop, the LAST XFF entry (appended by the trusted hop)
  // is used — never the client-supplied first entry.
  assert.equal(
    clientAddress({ headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } }),
    '10.0.0.1'
  );
  // Control characters cannot be smuggled into the bucket key.
  assert.doesNotMatch(
    clientAddress({ headers: { 'x-forwarded-for': 'a\u0000b' }, socket: { remoteAddress: '127.0.0.1' } }),
    /[\u0000-\u001F]/
  );
});

test('a stored password hash must look like the digest the client sends', () => {
  // Read the pattern from source rather than requiring the handler: the
  // endpoint pulls in @supabase/supabase-js, which is not installed for unit
  // tests.
  const source = read('api/register-user.js');
  const declared = source.match(/const PASSWORD_HASH_RE = (\/.+\/[a-z]*);/);
  assert.ok(declared, 'PASSWORD_HASH_RE is not declared');
  const PASSWORD_HASH_RE = new RegExp(declared[1].slice(1, declared[1].lastIndexOf('/')), 'i');
  assert.match(source, /!PASSWORD_HASH_RE\.test\(passwordHash\)/);
  assert.equal(PASSWORD_HASH_RE.test('a'.repeat(64)), true);
  assert.equal(PASSWORD_HASH_RE.test('A'.repeat(64)), true);
  assert.equal(PASSWORD_HASH_RE.test('z'.repeat(64)), false, 'z is not hex');
  assert.equal(PASSWORD_HASH_RE.test('a'.repeat(63)), false);
  assert.equal(PASSWORD_HASH_RE.test('a'.repeat(100000)), false, 'unbounded input must be refused');
});

test('the rate-limit refusal reveals nothing about which usernames exist', () => {
  const source = read('api/register-user.js');
  const start = source.indexOf('status(429)');
  const refusal = source.slice(start, source.indexOf('\n', start));
  assert.doesNotMatch(refusal, /username|sudah digunakan|tidak tersedia/i);
});

// ---------------------------------------------------------------------------
// 3. AI HTML sink
// ---------------------------------------------------------------------------

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext([
  extractFunction(html, 'normalizeTechnicalLabels'),
  extractFunction(html, 'sanitizeAIHtml')
].join('\n'), sandbox);

test('document-controlling elements cannot survive the AI HTML sanitizer', () => {
  // Each of these was reproduced passing through the previous sanitizer.
  const payloads = {
    'base': '<base href="https://evil.example/">',
    'meta refresh': '<meta http-equiv="refresh" content="0;url=https://evil.example">',
    'style': '<style>body{display:none}</style>',
    'link': '<link rel="stylesheet" href="https://evil.example/x.css">',
    'svg': '<svg onload=alert(1)></svg>',
    'template': '<template><img src=x onerror=alert(1)></template>',
    'iframe': '<iframe src="https://evil.example"></iframe>'
  };
  for (const [name, payload] of Object.entries(payloads)) {
    assert.equal(sandbox.sanitizeAIHtml(payload).trim(), '', name + ' survived');
  }
});

test('a dangerous URL scheme is neutralised even when entity-encoded', () => {
  // The old rule matched the literal text "javascript:", so an entity-encoded
  // scheme the browser decodes but the regex does not went straight through.
  [
    '<a href="javascript:alert(1)">x</a>',
    '<a href="javas&#99;ript:alert(1)">x</a>',
    '<a href="java&#115;cript:alert(1)">x</a>',
    '<a href="JaVaScRiPt:alert(1)">x</a>',
    '<a href=" javascript:alert(1)">x</a>',
    '<a href="vbscript:msgbox(1)">x</a>',
    '<a href="data:text/html,x">x</a>'
  ].forEach(payload => {
    const out = sandbox.sanitizeAIHtml(payload);
    assert.doesNotMatch(out, /javascript|vbscript|data:/i, payload);
    assert.match(out, /href="#"/, payload);
  });
});

test('inline event handlers are still stripped', () => {
  ['<img src=x onerror=alert(1)>', '<p onclick="alert(1)">x</p>', '<b ONMOUSEOVER=\'alert(1)\'>x</b>']
    .forEach(payload => {
      assert.doesNotMatch(sandbox.sanitizeAIHtml(payload), /onerror|onclick|onmouseover/i, payload);
    });
});

test('ordinary analysis markup is left alone', () => {
  assert.equal(sandbox.sanitizeAIHtml('<p>Harga <b>1.200</b> naik.</p>'), '<p>Harga <b>1.200</b> naik.</p>');
  assert.match(sandbox.sanitizeAIHtml('<a href="https://idx.co.id">IDX</a>'), /href="https:\/\/idx\.co\.id"/);
  assert.match(sandbox.sanitizeAIHtml('<a href="/dashboard">Dashboard</a>'), /href="\/dashboard"/);
});

// ---------------------------------------------------------------------------
// 4. Boundaries that must stay server-side
// ---------------------------------------------------------------------------

test('every privileged action is decided by the signed session, never by a claim', () => {
  const adminUsers = read('api/admin-users.js');
  ['resolvePatternMapAccess', 'foreignUpload', 'fundamentalsUpload'].forEach(fn => {
    assert.match(extractFunction(adminUsers, fn), /requireBudiAdmin\(req\)/, fn);
  });
  // Maintenance writes require an admin session and a same-origin request.
  const maintenance = read('api/maintenance-settings.js');
  assert.match(maintenance, /requireAdminSession\(req\)/);
  assert.match(maintenance, /isSameOrigin\(req\)/);
});

test('the client never treats its own stored admin flag as authorization', () => {
  // localStorage may be consulted to skip a request that would certainly be
  // refused, but the answer must always come from the server.
  const patternMap = read('public/pattern-map.js');
  assert.match(patternMap, /data\.access === 'admin'/);
  assert.match(patternMap, /String\(data\.username \|\| ''\)\.toLowerCase\(\) === 'budi'/);
  // The localStorage read is an optimisation and is documented as one.
  assert.match(patternMap, /never grant access/i);
});
