'use strict';

// ===========================================================================
// WHAT EACH AI SURFACE SHOWS WHEN SOMETHING GOES WRONG.
//
// The reported symptom was a Portfolio AI answer replaced by
//   "Jalur AI utama sedang sibuk. Ringkasan lokal ditampilkan."
// The old client produced that line for EVERY non-2xx: an expired session, a
// quota refusal, a server missing its API key and a genuine provider outage all
// came out as "the AI is busy" with a local summary stapled underneath. That
// hides the actionable failures and makes the fallback label meaningless.
//
// The Stock Analysis client had a separate defect: `await response.json()` was
// unguarded, so a platform HTML error page surfaced as an assistant bubble
// reading "Unexpected token '<' ... is not valid JSON".
//
// These tests execute the real decision functions and the real deterministic
// summary, extracted from the shipped sources. LOCAL / STATIC ONLY.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const portfolioSource = read('public/portfolio-ai-runtime-v2.js');
const stockSource = read('public/stock-analysis-ai.js');

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, 'function must exist: ' + signature);
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced braces for ' + signature);
}

function load(source, signatures, extras) {
  const body = signatures.map(sig => extractFunction(source, sig)).join('\n');
  const sandbox = Object.assign({ console }, extras || {});
  vm.createContext(sandbox);
  const exportLines = signatures.map((sig) => {
    const name = sig.replace(/^(async )?function /, '').replace('(', '');
    return 'this.' + name + ' = ' + name + ';';
  }).join('\n');
  vm.runInContext(body + '\n' + exportLines, sandbox);
  return sandbox;
}

const portfolioFailure = load(portfolioSource, ['function classifyFailure(']).classifyFailure;
const stockFailure = load(stockSource, ['function describeFailure(']).describeFailure;

const respond = status => ({ status });

// =================== ACTIONABLE FAILURES ARE NOT "AI BUSY" ================

test('an expired session is reported as an expired session on both surfaces', () => {
  const portfolio = portfolioFailure(respond(401), { code: 'AI_ACCESS_DENIED', error: 'Autentikasi diperlukan.' }, null);
  assert.equal(portfolio.fallback, false, 'an auth failure must not be dressed up as a provider outage');
  assert.match(portfolio.status, /sesi/i);
  assert.doesNotMatch(portfolio.status, /sibuk/i);

  const stock = stockFailure(respond(401), { code: 'AI_ACCESS_DENIED' }, null);
  assert.equal(stock.retryable, false, 'retrying will not fix an expired session');
  assert.match(stock.text, /login/i);
});

test('a blocked or unapproved account is told why, without a fake local answer', () => {
  const portfolio = portfolioFailure(respond(403), { error: 'Akun belum di-approve admin.' }, null);
  assert.equal(portfolio.fallback, false);
  assert.match(portfolio.status, /approve/i);

  const stock = stockFailure(respond(403), { error: 'Akun sedang diblokir.' }, null);
  assert.equal(stock.retryable, false);
  assert.match(stock.text, /blokir/i);
});

test('a quota refusal reports the wait instead of claiming the AI is unavailable', () => {
  const payload = { code: 'AI_RATE_LIMITED', retry_after_seconds: 42 };
  const portfolio = portfolioFailure(respond(429), payload, null);
  assert.equal(portfolio.fallback, false);
  assert.match(portfolio.status, /42 detik/);

  const stock = stockFailure(respond(429), payload, null);
  assert.equal(stock.retryable, false, 'an immediate retry would just be refused again');
  assert.match(stock.text, /42 detik/);
});

test('a quota refusal without a wait hint still reads as a quota problem', () => {
  const portfolio = portfolioFailure(respond(429), { code: 'AI_RATE_LIMITED' }, null);
  assert.match(portfolio.status, /Terlalu banyak pertanyaan/);
  assert.doesNotMatch(portfolio.status, /NaN|undefined/);
});

test('a server missing its API key points at the admin, not at a busy provider', () => {
  const portfolio = portfolioFailure(respond(503), { code: 'AI_NOT_CONFIGURED' }, null);
  assert.equal(portfolio.fallback, false);
  assert.match(portfolio.status, /admin/i);

  const stock = stockFailure(respond(503), { code: 'AI_NOT_CONFIGURED' }, null);
  assert.equal(stock.retryable, false);
  assert.match(stock.text, /admin/i);
});

test('asking a follow-up before an analysis exists is an instruction, not an outage', () => {
  const stock = stockFailure(respond(400), { code: 'AI_STOCK_SNAPSHOT_MISSING' }, null);
  assert.equal(stock.retryable, false);
  assert.match(stock.text, /analisis/i);
});

// ============ GENUINE PROVIDER FAILURE DOES EARN THE FALLBACK ============

test('a genuine provider outage is the case that earns the local summary', () => {
  const payload = { code: 'AI_MODELS_FAILED_SAFE_STOP', provider_failed: true, attempted_count: 3 };
  const portfolio = portfolioFailure(respond(503), payload, null);
  assert.equal(portfolio.fallback, true);
  assert.match(portfolio.status, /Ringkasan lokal/);

  const stock = stockFailure(respond(503), payload, null);
  assert.equal(stock.retryable, true, 'a transient outage is worth retrying');
});

test('every model timing out also earns the local summary', () => {
  const payload = { code: 'AI_ALL_MODELS_TIMED_OUT', provider_failed: true, timed_out_count: 3 };
  assert.equal(portfolioFailure(respond(503), payload, null).fallback, true);
  assert.equal(stockFailure(respond(503), payload, null).retryable, true);
});

test('a client-side abort and a dead connection both fall back and stay retryable', () => {
  const abort = { name: 'AbortError' };
  assert.equal(portfolioFailure(null, {}, abort).fallback, true);
  assert.equal(stockFailure(null, {}, abort).retryable, true);
  assert.equal(portfolioFailure(null, {}, new Error('Failed to fetch')).fallback, true);
  assert.match(portfolioFailure(null, {}, new Error('Failed to fetch')).status, /Koneksi/i);
});

test('a platform error page (no JSON body, 5xx) still produces a labelled fallback', () => {
  // response.json() failed, so `data` is the empty object the guard supplies.
  const portfolio = portfolioFailure(respond(504), {}, null);
  assert.equal(portfolio.fallback, true);
  assert.doesNotMatch(portfolio.status, /Unexpected token|JSON/i, 'a parse error must never reach the user');

  const stock = stockFailure(respond(504), {}, null);
  assert.equal(stock.retryable, true);
  assert.doesNotMatch(stock.text, /Unexpected token|JSON/i);
});

// ==================== DETERMINISTIC PORTFOLIO FIXTURES ===================

const portfolioHelpers = load(
  portfolioSource,
  ['function money(', 'function positive(', 'function finiteNumber(', 'function localFallback(']
);
const localFallback = portfolioHelpers.localFallback;

function summarize(plans) {
  let risk = 0;
  let value = 0;
  let missingRisk = 0;
  let missingValue = 0;
  let withPrice = 0;
  plans.forEach((plan) => {
    const r = portfolioHelpers.finiteNumber(plan.estimatedMaxLossIdr);
    const c = portfolioHelpers.finiteNumber(plan.capitalIdr);
    if (r === null) missingRisk += 1; else risk += r;
    if (c === null) missingValue += 1; else value += c;
    if (portfolioHelpers.positive(plan.currentPriceIdr)) withPrice += 1;
  });
  return {
    plan_count: plans.length,
    positions_with_price: withPrice,
    positions_missing_price: plans.length - withPrice,
    positions_missing_risk_value: missingRisk,
    positions_missing_capital_value: missingValue,
    total_estimated_risk: risk,
    total_estimated_risk_is_partial: missingRisk > 0,
    total_position_value: value,
    total_position_value_is_partial: missingValue > 0
  };
}
const fixture = plans => ({ plans, summary: summarize(plans) });

const ONE = [{ ticker: 'BBCA', entryPriceIdr: 9000, stopLossIdr: 8600, lots: 5, currentPriceIdr: 9150, estimatedMaxLossIdr: 200000, capitalIdr: 4500000 }];
const THREE = ONE.concat([
  { ticker: 'TLKM', entryPriceIdr: 3000, stopLossIdr: 2850, lots: 10, currentPriceIdr: 2600, estimatedMaxLossIdr: 150000, capitalIdr: 3000000 },
  { ticker: 'ASII', entryPriceIdr: 5000, stopLossIdr: null, lots: 2, currentPriceIdr: null, estimatedMaxLossIdr: null, capitalIdr: 1000000 }
]);
const MANY = Array.from({ length: 22 }, (_, i) => ({
  ticker: 'T' + String.fromCharCode(65 + (i % 26)) + String.fromCharCode(66 + ((i * 3) % 24)),
  entryPriceIdr: 1000 + i, stopLossIdr: 900 + i, lots: 1 + i,
  currentPriceIdr: i % 3 === 0 ? null : 1000 + i,
  estimatedMaxLossIdr: i % 5 === 0 ? null : 10000 * (i + 1),
  capitalIdr: 100000 * (i + 1)
}));

test('an empty portfolio says what is missing and invents nothing', () => {
  const reply = localFallback('Bagaimana kondisi portofolio ku?', fixture([]));
  assert.match(reply, /Belum ada posisi/);
  assert.doesNotMatch(reply, /Rp 0/, 'an empty portfolio must not be summarised as zero risk');
});

test('a single position is summarised from its own stored numbers only', () => {
  const reply = localFallback('Posisi mana yang risikonya paling besar?', fixture(ONE));
  assert.match(reply, /BBCA/);
  assert.match(reply, /Rp 200\.000/);
  assert.match(reply, /4\.44%/, 'the entry-to-stop distance is computed, not guessed');
  assert.match(reply, /bukan harga real-time/i);
});

test('a three-position portfolio flags the incomplete parts of its own totals', () => {
  const reply = localFallback('Ringkas risiko portofolioku.', fixture(THREE));
  assert.match(reply, /belum lengkap/i, 'a partial risk total must announce that it is partial');
  assert.match(reply, /1 posisi belum punya nilai risiko tersimpan/);
  assert.match(reply, /1 posisi/, 'the missing-price count must be reported');
  assert.match(reply, /TLKM|BBCA/);
});

test('a 22-position portfolio still produces a bounded, honest summary', () => {
  const reply = localFallback('Apakah alokasi portofolio saya terlalu terkonsentrasi?', fixture(MANY));
  assert.ok(reply.length < 2000, 'the local summary must stay readable, got ' + reply.length);
  assert.match(reply, /belum lengkap/i);
  assert.match(reply, /posisi belum punya harga|belum dapat dinilai penuh/i);
});

test('a portfolio where no position has a stored risk does not fabricate a priority', () => {
  const plans = [
    { ticker: 'BBCA', entryPriceIdr: 9000, stopLossIdr: null, lots: 5, estimatedMaxLossIdr: null, capitalIdr: null },
    { ticker: 'TLKM', entryPriceIdr: 3000, stopLossIdr: null, lots: 1, estimatedMaxLossIdr: null, capitalIdr: null }
  ];
  const reply = localFallback('Posisi mana yang risikonya paling besar?', fixture(plans));
  assert.match(reply, /belum ada posisi dengan estimasi risiko tersimpan/i);
  assert.doesNotMatch(reply, /BBCA memiliki estimasi risiko nominal terbesar/);
});

test('a genuine zero risk is reported as zero, not as missing', () => {
  const plans = [{ ticker: 'BBCA', entryPriceIdr: 9000, stopLossIdr: 8600, lots: 1, estimatedMaxLossIdr: 0, capitalIdr: 900000 }];
  const context = fixture(plans);
  assert.equal(context.summary.total_estimated_risk, 0);
  assert.equal(context.summary.total_estimated_risk_is_partial, false, 'a real 0 is a reading, not a gap');
  const reply = localFallback('Ringkas risiko portofolioku.', context);
  assert.match(reply, /Rp 0/);
  assert.doesNotMatch(reply, /belum lengkap/i);
});

test('the local summary never claims a percentage it cannot compute', () => {
  const plans = [{ ticker: 'BBCA', entryPriceIdr: 9000, stopLossIdr: 8600, lots: 1, estimatedMaxLossIdr: 50000, capitalIdr: null }];
  const reply = localFallback('Ringkas risiko portofolioku.', fixture(plans));
  assert.doesNotMatch(reply, /% dari nilai posisi/, 'no denominator means no percentage');
});

test('the local summary is labelled as local and never as an AI answer', () => {
  const reply = localFallback('Bagaimana kondisi portofolio ku?', fixture(THREE));
  assert.match(reply, /bukan jawaban AI/i);
});

// ======================= CONVERSATION / SEND STATE =======================

test('a local fallback turn is not replayed to the model as conversation history', () => {
  const sandbox = load(portfolioSource, ['function historyForRequest('], {
    state: {
      messages: [
        { role: 'user', content: 'pertanyaan satu' },
        { role: 'assistant', content: 'jawaban model asli' },
        { role: 'user', content: 'pertanyaan dua' },
        { role: 'assistant', content: 'ringkasan lokal', local: true },
        { role: 'user', content: 'pertanyaan tiga' }
      ]
    }
  });
  const history = sandbox.historyForRequest();
  assert.equal(history.some(row => row.local), false);
  assert.equal(history.some(row => row.content === 'ringkasan lokal'), false);
  assert.equal(history[history.length - 1].content, 'pertanyaan dua', 'the in-flight question is excluded');
});

test('the send lock, clear-chat and retry wiring are all present and consistent', () => {
  assert.match(portfolioSource, /if \(!text \|\| state\.sending\) return;/, 'duplicate sends must be refused');
  assert.match(portfolioSource, /if \(state\.controller\) \{ try \{ state\.controller\.abort\(\); \}/, 'clear chat must cancel an in-flight request');
  assert.match(portfolioSource, /state\.lastQuestion = ''/, 'clear chat must drop the retry target');
  assert.match(portfolioSource, /sendMessage\(state\.lastQuestion, \{ retry: true \}\)/, 'retry must resend the last question with the retry flag');
  assert.match(portfolioSource, /if \(state\.sending \|\| !state\.lastQuestion\) return;/, 'retry must respect the send lock');
  assert.match(stockSource, /if \(sending\) return;/);
  assert.match(stockSource, /send\(question, \{ retry: true \}\)/);
});

test('a successful answer clears the previous failure state', () => {
  const success = portfolioSource.slice(portfolioSource.indexOf('// A successful answer clears'));
  assert.match(success, /showRetry\(false\)/, 'the retry affordance must disappear on success');
  assert.match(success, /setStatus\(/, 'the status line must be replaced on success');
});

test('a retry does not duplicate the question bubble on the stock surface', () => {
  assert.match(stockSource, /if \(!isRetry\) appendUser\(message\);/);
});

test('only a real model answer is written into stored stock chat history', () => {
  assert.match(stockSource, /if \(data\.local_fallback !== true\) \{[\s\S]*?writeHistory\(ticker, history\);/);
});

// ============================ RENDER SAFETY ==============================

function loadRenderer() {
  const body = { nodeType: 1, matches() { return false; }, querySelectorAll() { return []; } };
  const document = {
    readyState: 'complete', body,
    head: { appendChild() {} },
    createElement() { return { id: '', textContent: '', style: {}, appendChild() {} }; },
    addEventListener() {}
  };
  class MutationObserver { observe() {} }
  const window = {};
  const context = vm.createContext({ window, document, MutationObserver, console });
  vm.runInContext(read('public/ai-chat-renderer.js'), context, { filename: 'ai-chat-renderer.js' });
  return window.AutoCuanAI;
}

test('a hostile provider payload cannot become active markup in either chat', () => {
  const renderer = loadRenderer();
  const payloads = [
    '<script>alert(1)</script>',
    '<iframe src="https://evil.example"></iframe>',
    '<svg onload=alert(1)></svg>',
    '<img src=x onerror=alert(1)>',
    '<a href="javascript:alert(1)">klik</a>',
    '<a href="&#106;avascript:alert(1)">klik</a>',
    '<a href="java&Tab;script:alert(1)">klik</a>',
    '<object data="data:text/html;base64,PHNjcmlwdD4="></object>',
    '<form action="/steal"><input name="p"></form>',
    '<base href="https://evil.example/">',
    '<meta http-equiv="refresh" content="0;url=https://evil.example">'
  ];
  payloads.forEach((payload) => {
    const html = renderer.renderMarkdown(payload);
    assert.doesNotMatch(html, /<script|<iframe|<svg|<object|<form|<base|<meta|<img/i, 'active markup survived: ' + payload);
    // An `onload=` inside escaped text is inert; only a handler on a real tag
    // is a finding, so the check is anchored to an unescaped element.
    assert.doesNotMatch(html, /<[a-z][^>]*\son\w+\s*=/i, 'an inline handler survived: ' + payload);
    assert.doesNotMatch(html, /<a[^>]+href\s*=\s*["']?\s*javascript:/i, 'a javascript: URL survived: ' + payload);
    assert.match(html, /&lt;/, 'the payload must still be visible as inert, escaped text');
    // The renderer emits only its own block elements; nothing from the payload
    // may reach the DOM as a tag.
    const tags = (html.match(/<\/?([a-z0-9]+)/gi) || []).map(t => t.replace(/<\/?/, '').toLowerCase());
    tags.forEach((tag) => {
      assert.ok(
        ['p', 'h3', 'ul', 'ol', 'li', 'strong', 'em', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'div', 'dl', 'dt', 'dd'].includes(tag),
        'unexpected tag "' + tag + '" from payload: ' + payload
      );
    });
  });
});

test('a truncated or empty provider answer renders without throwing', () => {
  const renderer = loadRenderer();
  [' ', '', '###', '| a | b |', '**unterminated', '- ', '\n\n\n'].forEach((value) => {
    assert.equal(typeof renderer.renderMarkdown(value), 'string');
  });
});

// ============================== RESPONSIVE ===============================

test('neither AI panel can scroll the page sideways on mobile', () => {
  assert.match(portfolioSource, /@media\(max-width:620px\)/, 'a phone breakpoint must exist');
  assert.match(portfolioSource, /overflow-x:auto/, 'wide content scrolls inside its own container');
  assert.match(portfolioSource, /#page-ai \.ai-user\{max-width:92%\}|max-width:92%/);
  // Every fixed pixel width in the phone breakpoint would be a horizontal
  // overflow risk; the panel is expressed in percentages and viewport units.
  const mobile = portfolioSource.match(/@media\(max-width:620px\)\{([^]*?)\}\}/);
  assert.ok(mobile, 'the phone breakpoint must be locatable');
  // Only the rule body, never the media condition itself.
  assert.doesNotMatch(mobile[1], /[^-]width:\s*\d{3,}px/, 'a fixed wide width would overflow a phone viewport');
  assert.doesNotMatch(mobile[1], /min-width:\s*\d{3,}px/, 'a wide min-width cannot shrink below a phone viewport');

  const renderer = read('public/ai-chat-renderer.js');
  assert.match(renderer, /\.ai-table-wrap\{max-width:100%;overflow:auto/, 'wide tables must scroll inside their wrapper');
  assert.match(renderer, /@media\(max-width:640px\)\{\.ai-rich-text\{max-width:100%/);
});

test('the fallback badge is styled on both surfaces so the label is visible, not just semantic', () => {
  assert.match(portfolioSource, /\.ai-fallback-badge\{/);
  assert.match(portfolioSource, /Ringkasan lokal — bukan jawaban AI/);
  assert.match(stockSource, /Ringkasan lokal — bukan jawaban AI/);
});
