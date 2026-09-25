'use strict';

/**
 * AI answer format contract (/tanya, /analisa, /opini).
 *
 * Two properties are pinned here because both were missing before this change
 * and both are invisible until a user reads a bad answer:
 *
 *   1. GROUNDING — the prompt must carry the unified score, the trade plan
 *      levels, and the bandarmologi verdict, so the AI reasons about the same
 *      numbers the web card shows instead of inventing its own.
 *   2. LENGTH — the prompt must state a short, mobile-readable budget, and the
 *      provider call must enforce a token ceiling. A prompt alone is a request;
 *      the cap is what actually stops a wall of text.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const marketContext = require('../lib/market-context-service');

// ---------------------------------------------------------------------------
// Grounding: the screener facts reach the prompt
// ---------------------------------------------------------------------------

function withTempRoot(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-prompt-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content));
    }
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const SCREENER_ROW = {
  ticker: 'BBCA',
  category: 'Swing Konglo',
  unified_score: 84,
  unified_score_grade: 'A',
  swing_tier: 'SWING_READY',
  entry_low: 8600,
  entry_high: 8750,
  stop_loss: 8400,
  tp1: 9200,
  tp2: 9600,
  risk_reward: 2.1,
  bandar_label: 'Accumulation',
  bandar_consistent_windows: ['7D', '1M'],
  volume_ratio_20d: 1.8
};

test('extractScreenerFacts reads the unified score and the plan levels', () => {
  const facts = marketContext.extractScreenerFacts(SCREENER_ROW);
  assert.strictEqual(facts.score, 84);
  assert.strictEqual(facts.grade, 'A');
  assert.strictEqual(facts.entry_low, 8600);
  assert.strictEqual(facts.entry_high, 8750);
  assert.strictEqual(facts.stop_loss, 8400);
  assert.strictEqual(facts.tp1, 9200);
  assert.strictEqual(facts.tp2, 9600);
  assert.strictEqual(facts.risk_reward, 2.1);
  assert.strictEqual(facts.bandar_label, 'Accumulation');
  assert.deepStrictEqual(facts.bandar_windows, ['7D', '1M']);
});

test('extractScreenerFacts falls back through the score aliases', () => {
  // An un-refreshed snapshot may predate unified_score but still carry the
  // alias the engine syncs, so the AI still grounds on the card's number.
  assert.strictEqual(marketContext.extractScreenerFacts({ score: 70 }).score, 70);
  assert.strictEqual(marketContext.extractScreenerFacts({ daytrade_score: 65 }).score, 65);
  assert.strictEqual(marketContext.extractScreenerFacts({ combined_score: 60 }).score, 60);
  assert.strictEqual(marketContext.extractScreenerFacts({}).score, null);
});

test('extractScreenerFacts never invents a value for a missing field', () => {
  const facts = marketContext.extractScreenerFacts({ ticker: 'X' });
  for (const key of ['score', 'grade', 'entry_low', 'entry_high', 'stop_loss', 'tp1', 'tp2', 'risk_reward', 'bandar_label']) {
    assert.strictEqual(facts[key], null, key + ' must be null, not a default');
  }
  assert.deepStrictEqual(facts.bandar_windows, []);
});

test('renderContext emits a SKOR UNIFIED line from the screener facts', () => {
  const html = marketContext.renderContext([{
    ticker: 'BBCA', available: true, technical: null, bandar: null,
    screener: marketContext.extractScreenerFacts(SCREENER_ROW)
  }]);
  assert.match(html, /SKOR UNIFIED: 84\/100/, 'must state the score');
  assert.match(html, /grade A/, 'must state the grade');
});

test('renderContext emits a RENCANA TRADE line with Entry, SL, TP1, TP2 and R/R', () => {
  const html = marketContext.renderContext([{
    ticker: 'BBCA', available: true, technical: null, bandar: null,
    screener: marketContext.extractScreenerFacts(SCREENER_ROW)
  }]);
  assert.match(html, /RENCANA TRADE:/);
  assert.match(html, /Entry 8\.600-8\.750/, 'entry range must be formatted with thousand separators');
  assert.match(html, /SL 8\.400/);
  assert.match(html, /TP1 9\.200/);
  assert.match(html, /TP2 9\.600/);
  assert.match(html, /R\/R 2\.1/);
});

test('renderContext emits a STATUS BANDARMOLOGI line in Indonesian', () => {
  const html = marketContext.renderContext([{
    ticker: 'BBCA', available: true, technical: null, bandar: null,
    screener: marketContext.extractScreenerFacts(SCREENER_ROW)
  }]);
  assert.match(html, /STATUS BANDARMOLOGI: Akumulasi/, 'must translate Accumulation for the user');
  assert.match(html, /konsisten 7D & 1M/, 'must state multi-window agreement');
});

test('bandar verdicts map to the terms the web card badge uses', () => {
  const map = { Accumulation: 'Akumulasi', Distribution: 'Distribusi', Mixed: 'Campuran' };
  for (const [en, id] of Object.entries(map)) {
    const html = marketContext.renderContext([{
      ticker: 'T', available: true, technical: null, bandar: null,
      screener: marketContext.extractScreenerFacts({ bandar_label: en })
    }]);
    assert.match(html, new RegExp('STATUS BANDARMOLOGI: ' + id), en + ' must render as ' + id);
  }
});

test('renderContext omits plan/score lines when the screener row is absent', () => {
  const html = marketContext.renderContext([{
    ticker: 'BBCA', available: true, bandar: null,
    technical: { date: '2026-09-24', close: 8750, changePct: 1.2, ma20: 8600, volumeRatio: 1.8 },
    screener: null
  }]);
  assert.ok(html.includes('BBCA'), 'technical line still renders');
  assert.ok(!html.includes('SKOR UNIFIED'), 'must not print a score it does not have');
  assert.ok(!html.includes('RENCANA TRADE'), 'must not print a plan it does not have');
});

test('findScreenerRow locates a ticker across every snapshot bucket', () => {
  const snapshot = {
    daytrade: [{ ticker: 'AAA', unified_score: 1 }],
    swing: [{ ticker: 'BBB', unified_score: 2 }],
    top5: [{ ticker: 'CCC', unified_score: 3 }]
  };
  withTempRoot({ 'data/screener-latest.json': snapshot }, (dir) => {
    assert.strictEqual(marketContext.findScreenerRow(dir, 'AAA').unified_score, 1);
    assert.strictEqual(marketContext.findScreenerRow(dir, 'BBB').unified_score, 2);
    assert.strictEqual(marketContext.findScreenerRow(dir, 'CCC').unified_score, 3);
    assert.strictEqual(marketContext.findScreenerRow(dir, 'ZZZ'), null);
  });
});

test('findScreenerRow is null-safe when the snapshot is missing or corrupt', () => {
  withTempRoot({}, (dir) => {
    assert.strictEqual(marketContext.findScreenerRow(dir, 'AAA'), null);
  });
  withTempRoot({ 'data/screener-latest.json': '{ not json' }, (dir) => {
    assert.strictEqual(marketContext.findScreenerRow(dir, 'AAA'), null, 'corrupt JSON must not throw');
  });
});

test('buildSnapshot marks a row available when only the screener facts exist', () => {
  withTempRoot({
    'data/screener-latest.json': { swing: [SCREENER_ROW] }
  }, (dir) => {
    const snap = marketContext.buildSnapshot(dir, 'BBCA');
    assert.strictEqual(snap.available, true, 'a screener row alone makes the snapshot usable');
    assert.strictEqual(snap.screener.score, 84);
  });
});

// ---------------------------------------------------------------------------
// Length: the prompt states a budget and the provider enforces a ceiling
// ---------------------------------------------------------------------------

test('the system prompt states an explicit paragraph and word budget', () => {
  const src = read('lib/telegram-interactive-bot.js');
  const m = src.match(/const MARKET_ANALYSIS_SYSTEM = \(([\s\S]*?)\n\);/);
  assert.ok(m, 'MARKET_ANALYSIS_SYSTEM must exist');
  const prompt = m[1];
  assert.match(prompt, /MAKSIMAL 3 paragraf/, 'must cap the paragraph count');
  assert.match(prompt, /120 kata/, 'must cap the word count');
  assert.match(prompt, /Jangan menulis pembuka/, 'must forbid preamble');
  assert.match(prompt, /Langung ke isi|Langsung ke isi/, 'must ask for a direct answer');
});

/**
 * The prompt is a `'...' + '...'` concatenation, so a phrase can straddle two
 * source lines. Join the string literals before asserting on wording.
 */
function systemPromptText() {
  const src = read('lib/telegram-interactive-bot.js');
  const m = src.match(/const MARKET_ANALYSIS_SYSTEM = \(([\s\S]*?)\n\);/);
  assert.ok(m, 'MARKET_ANALYSIS_SYSTEM must exist');
  return (m[1].match(/'((?:[^'\\]|\\.)*)'/g) || [])
    .map((lit) => lit.slice(1, -1))
    .join('');
}

test('the system prompt instructs the model to quote the grounded fields', () => {
  const prompt = systemPromptText();
  assert.match(prompt, /SKOR UNIFIED/, 'must reference the unified score');
  assert.match(prompt, /RENCANA TRADE/, 'must reference the trade plan');
  assert.match(prompt, /STATUS BANDARMOLOGI/, 'must reference the bandarmologi verdict');
  assert.match(prompt, /jangan mengarang level sendiri/, 'must forbid inventing levels');
});

test('the system prompt keeps the existing readability rules', () => {
  // Regression guard: the mobile-readability rules predate this change and must
  // survive the rewrite.
  const prompt = systemPromptText();
  assert.match(prompt, /nyaman dibaca di layar HP/);
  assert.match(prompt, /tanpa tanda bintang/);
  assert.match(prompt, /tanpa titik koma/);
  assert.match(prompt, /Jangan tambahkan angka di luar data/);
});

test('callByok applies a token cap to market-analysis answers', () => {
  const src = read('lib/telegram-interactive-bot.js');
  const start = src.indexOf('async function callByok');
  assert.ok(start > -1);
  const body = src.slice(start, start + 3000);
  assert.match(body, /answerTokenCap/, 'must compute a cap');
  assert.match(body, /maxOutputTokens: answerTokenCap/, 'Gemini must receive the cap');
  assert.match(body, /maxTokens: answerTokenCap/, 'OpenAI-style providers must receive the cap');
  assert.match(body, /extra: \{ maxOutputTokens: answerTokenCap \}/, 'the VPS fallback body must carry the cap');
});

test('the cap only applies to market-analysis calls', () => {
  // Free-form calls without marketAnalysis must keep provider defaults, so this
  // change cannot silently truncate unrelated AI features.
  const src = read('lib/telegram-interactive-bot.js');
  const start = src.indexOf('async function callByok');
  const body = src.slice(start, start + 3000);
  assert.match(body, /const answerTokenCap = \(opts2 && opts2\.marketAnalysis\) \? \d+ : undefined;/,
    'cap must be conditional on marketAnalysis');
});

/**
 * Locate a command's dispatch branch. `indexOf("command === 'tanya'")` also hits
 * the quota pre-check (`quotaCommand = command === 'tanya' || ...`), which sits
 * far above the real handler and would make the assertions vacuous.
 */
function commandBranch(command) {
  const src = read('lib/telegram-interactive-bot.js');
  const marker = "} else if (command === '" + command + "') {";
  const start = src.indexOf(marker);
  assert.ok(start > -1, 'dispatch branch for /' + command + ' must exist');
  // The branch ends at the next `} else if (` or the closing of the chain.
  const rest = src.slice(start + marker.length);
  const nextBranch = rest.search(/\n\s*\} else if \(|\n\s*\}\n\n/);
  return nextBranch === -1 ? rest : rest.slice(0, nextBranch);
}

test('/tanya requests the market-analysis prompt and the grounded context', () => {
  // /tanya is where users ask "skor saham ini berapa"; without marketAnalysis it
  // would skip both the grounding rules and the length cap.
  const body = commandBranch('tanya');
  assert.match(body, /marketAnalysis: true/, '/tanya must use the market-analysis prompt');
  assert.match(body, /buildInjectionWithRoots/, '/tanya must use the grounded injection');
});

test('/opini passes the resolved screener path so grounding cannot drift', () => {
  const body = commandBranch('opini');
  assert.match(body, /buildInjectionWithRoots/, '/opini must use the grounded injection');
  assert.match(body, /screenerPath: roots\.screener/, '/opini must reuse the resolved snapshot path');
  assert.match(body, /marketAnalysis: true/, '/opini must keep the market-analysis prompt');
});

test('buildInjectionWithRoots honours an explicit screener path', () => {
  const altRow = Object.assign({}, SCREENER_ROW, { ticker: 'ZZZZ', unified_score: 42 });
  withTempRoot({
    'data/daily-candles/ZZZZ.json': [{ date: '2026-09-24', close: 1000, high: 1010, low: 990, volume: 1000 }],
    'data/screener-alt.json': { swing: [altRow] }
  }, (dir) => {
    const res = marketContext.buildInjectionWithRoots(dir, 'ZZZZ skor berapa', {
      screenerPath: path.join(dir, 'data', 'screener-alt.json')
    });
    assert.deepStrictEqual(res.tickers, ['ZZZZ']);
    assert.match(res.context, /SKOR UNIFIED: 42\/100/,
      'the explicit snapshot path must be the one that grounds the prompt');
  });
});
