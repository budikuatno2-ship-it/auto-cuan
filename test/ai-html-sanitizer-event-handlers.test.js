'use strict';

// ===========================================================================
// Security regression: sanitizeAIHtml() (public/index.html) stripped inline
// event handlers with two rules that both required WHITESPACE before the
// handler name:
//
//     output = output.replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '');
//     output = output.replace(/\s+on\w+\s*=\s*[^\s>]*/gi, '');
//
// The HTML tokenizer is more permissive than that. It accepts `/` as an
// attribute separator, and it lets an attribute begin immediately after a
// quoted value. So these three survived sanitisation and FIRED in Chromium
// when assigned through innerHTML:
//
//     <img/src=x/onerror=...>        <img src=x/onerror=...>        <img src="x"onerror=...>
//
// The output of the AI model is passed through this function and rendered with
// innerHTML, and the chat transcript is persisted in localStorage and
// re-rendered, so a payload steered into the model's reply by the user's own
// prompt kept executing on every reload of that browser.
//
// This test is string-level and deterministic. The browser confirmation that
// each payload actually executed pre-fix, and none do post-fix, was run
// separately against real Chromium.
//
// LOCAL / STATIC ONLY. No browser, network, or backend involvement.
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, 'expected to find ' + signature);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces for ' + signature);
}

function loadSanitizer() {
  const sandbox = {
    String, RegExp, parseInt, Math, Number, JSON,
    // Cosmetic label pass; irrelevant to the security behaviour under test.
    normalizeTechnicalLabels: (value) => value
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction(html, 'function sanitizeAIHtml('), sandbox);
  return sandbox.sanitizeAIHtml;
}

// Does ANY inline event handler survive inside a tag? Deliberately does not
// assume whitespace before the handler — that assumption is the bug itself.
function survivingHandlers(markup) {
  const found = [];
  const tagPattern = /<([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let tag;
  while ((tag = tagPattern.exec(markup)) !== null) {
    const attrs = tag[2];
    const handlerPattern = /(?:^|[\s/"'])(on[a-zA-Z0-9_:.-]*)\s*=/gi;
    let handler;
    while ((handler = handlerPattern.exec(attrs)) !== null) found.push(handler[1].toLowerCase());
  }
  return found;
}

const MISSING_IMAGE = '/__missing__.png';
const NL = String.fromCharCode(10);
const TAB = String.fromCharCode(9);
const FORMFEED = String.fromCharCode(12);

const HANDLER_PAYLOADS = [
  ['space separator', '<img src="' + MISSING_IMAGE + '" onerror="alert(1)">'],
  ['slash separator', '<img/src="' + MISSING_IMAGE + '"/onerror="alert(1)">'],
  ['slash before handler', '<img src="' + MISSING_IMAGE + '"/onerror="alert(1)">'],
  ['no separator after double quote', '<img src="' + MISSING_IMAGE + '"onerror="alert(1)">'],
  ['no separator after single quote', "<img src='" + MISSING_IMAGE + "'onerror='alert(1)'>"],
  ['newline separator', '<img src="' + MISSING_IMAGE + '"' + NL + 'onerror="alert(1)">'],
  ['tab separator', '<img src="' + MISSING_IMAGE + '"' + TAB + 'onerror="alert(1)">'],
  ['formfeed separator', '<img src="' + MISSING_IMAGE + '"' + FORMFEED + 'onerror="alert(1)">'],
  ['double slash', '<img//src="' + MISSING_IMAGE + '"//onerror="alert(1)">'],
  ['unquoted handler value', '<img src=' + MISSING_IMAGE + '/onerror=alert(1)>'],
  ['mixed case handler', '<img src="' + MISSING_IMAGE + '"/OnErRoR="alert(1)">'],
  ['body onload', '<body/onload="alert(1)">'],
  ['details ontoggle', '<details open/ontoggle="alert(1)">'],
  ['input onfocus', '<input autofocus/onfocus="alert(1)">'],
  ['div onmouseover', '<div/onmouseover="alert(1)">hover</div>'],
  ['handler before src', '<img/onerror="alert(1)"/src="' + MISSING_IMAGE + '">']
];

test('no inline event handler survives, whatever separator precedes it', () => {
  const sanitizeAIHtml = loadSanitizer();
  HANDLER_PAYLOADS.forEach(([name, payload]) => {
    const output = sanitizeAIHtml(payload);
    assert.deepEqual(
      survivingHandlers(output), [],
      'handler survived sanitisation for "' + name + '": ' + JSON.stringify(output)
    );
  });
});

test('the whitespace-only rules alone would not have caught these', () => {
  // Guards the test itself: if someone reverts the fix, these payloads must
  // still be recognised as dangerous by survivingHandlers().
  const legacyStrip = (value) => String(value)
    .replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/\s+on\w+\s*=\s*[^\s>]*/gi, '');

  const missedByLegacy = HANDLER_PAYLOADS
    .filter(([, payload]) => survivingHandlers(legacyStrip(payload)).length > 0)
    .map(([name]) => name);

  assert.ok(missedByLegacy.length > 0,
    'the payload set must contain cases the old whitespace-only rules missed, or this test proves nothing');
});

test('dangerous elements and URL schemes stay blocked', () => {
  const sanitizeAIHtml = loadSanitizer();
  assert.doesNotMatch(sanitizeAIHtml('<svg onload="alert(1)">'), /<svg/i);
  assert.doesNotMatch(sanitizeAIHtml('<iframe src="https://evil.example"></iframe>'), /<iframe/i);
  assert.doesNotMatch(sanitizeAIHtml('<base href="https://evil.example/">'), /<base/i);
  assert.doesNotMatch(sanitizeAIHtml('<form action="https://evil.example"></form>'), /<form/i);
  assert.match(sanitizeAIHtml('<a href="javascript:alert(1)">x</a>'), /href="#"/);
  // Entity-encoded scheme, which an earlier fix already covered.
  assert.match(sanitizeAIHtml('<a href="javas&#99;ript:alert(1)">x</a>'), /href="#"/);
});

test('legitimate analysis markup is preserved unchanged', () => {
  const sanitizeAIHtml = loadSanitizer();

  const kept = [
    '<p class="text-sm text-gray-300">BBCA ditutup di 9.800.</p>',
    '<div class="ai-content"><strong>Entry:</strong> 9.750 <br> <b>SL:</b> 9.500</div>',
    '<span class="text-emerald-400">Support 9.500</span>',
    '<a href="https://example.com/berita">baca</a>',
    '<ul><li>MA20 di 9.700</li><li>RSI 55</li></ul>'
  ];
  kept.forEach((markup) => {
    const output = sanitizeAIHtml(markup);
    assert.deepEqual(survivingHandlers(output), []);
    // Structure and the numbers inside it must survive intact.
    assert.match(output, /<(p|div|span|a|ul)\b/, 'element must be preserved: ' + markup);
  });

  assert.match(sanitizeAIHtml('<p>Entry 9.750</p>'), /9\.750/);
  assert.match(sanitizeAIHtml('<a href="https://example.com/x">y</a>'), /href="https:\/\/example\.com\/x"/);
});

test('prose that merely mentions an on-something is not mangled', () => {
  const sanitizeAIHtml = loadSanitizer();
  // The handler strip is scoped to the inside of a tag, so body text is safe.
  const prose = '<p>Strategi buy on weakness: onclick= bukan atribut di sini.</p>';
  const output = sanitizeAIHtml(prose);
  assert.match(output, /buy on weakness/);
  assert.match(output, /onclick=/, 'text content must not be rewritten');
});

test('closing tags and attribute values survive the per-tag rewrite', () => {
  const sanitizeAIHtml = loadSanitizer();
  const output = sanitizeAIHtml('<div class="a b"><span data-x="1">t</span></div>');
  assert.match(output, /<\/span>/);
  assert.match(output, /<\/div>/);
  assert.match(output, /class="a b"/);
  assert.match(output, /data-x="1"/);
});
