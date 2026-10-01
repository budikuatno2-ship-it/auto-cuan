'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const runner = require('../tools/one-time-ai-research-all');

// ============================================================
// HELPERS
// ============================================================

async function tmpdir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ai-research-test-'));
}

function makeCandle(day, close, volume) {
  volume = volume || 1000000;
  return {
    time: Math.floor(Date.parse(day + 'T00:00:00Z') / 1000),
    date: day,
    open: close - 2, high: close + 3, low: close - 4,
    close, volume
  };
}

function makeCandles(count, baseClose) {
  baseClose = baseClose || 1000;
  const candles = [];
  for (let i = 0; i < count; i++) {
    // Generate unique dates spanning multiple months
    const baseDate = new Date('2026-04-01');
    baseDate.setDate(baseDate.getDate() + i);
    const day = baseDate.toISOString().slice(0, 10);
    candles.push(makeCandle(day, baseClose + i * 5, 500000 + i * 10000));
  }
  return candles;
}


// ============================================================
// TICKER PARSER TESTS
// ============================================================

test('parseTickers handles newline-separated tickers', () => {
  const result = runner.parseTickers('BBCA\nBBRI\nTLKM');
  assert.deepEqual(result, ['BBCA', 'BBRI', 'TLKM']);
});

test('parseTickers handles comma-separated tickers', () => {
  const result = runner.parseTickers('BBCA,BBRI,TLKM');
  assert.deepEqual(result, ['BBCA', 'BBRI', 'TLKM']);
});

test('parseTickers handles mixed comma and newline', () => {
  const result = runner.parseTickers('BBCA, BBRI\nTLKM, ASII');
  assert.deepEqual(result, ['BBCA', 'BBRI', 'TLKM', 'ASII']);
});

test('parseTickers ignores blank lines', () => {
  const result = runner.parseTickers('BBCA\n\n\nBBRI\n\nTLKM');
  assert.deepEqual(result, ['BBCA', 'BBRI', 'TLKM']);
});

test('parseTickers ignores comment lines starting with #', () => {
  const result = runner.parseTickers('# Blue chips\nBBCA\n# Skip\nBBRI');
  assert.deepEqual(result, ['BBCA', 'BBRI']);
});

test('parseTickers strips .JK suffix', () => {
  const result = runner.parseTickers('BBCA.JK\nBBRI.jk\nTLKM');
  assert.deepEqual(result, ['BBCA', 'BBRI', 'TLKM']);
});

test('parseTickers normalizes to uppercase', () => {
  const result = runner.parseTickers('bbca\nBbri\ntlkm');
  assert.deepEqual(result, ['BBCA', 'BBRI', 'TLKM']);
});

test('parseTickers deduplicates while preserving order', () => {
  const result = runner.parseTickers('BBCA\nBBRI\nBBCA\nTLKM\nBBRI');
  assert.deepEqual(result, ['BBCA', 'BBRI', 'TLKM']);
});

test('parseTickers handles empty/null input', () => {
  assert.deepEqual(runner.parseTickers(''), []);
  assert.deepEqual(runner.parseTickers(null), []);
  assert.deepEqual(runner.parseTickers(undefined), []);
});

test('parseTickers handles Windows line endings', () => {
  const result = runner.parseTickers('BBCA\r\nBBRI\r\nTLKM');
  assert.deepEqual(result, ['BBCA', 'BBRI', 'TLKM']);
});


// ============================================================
// ENV VALIDATION TESTS
// ============================================================

test('missing SHITERU_API_KEY fails cleanly', async () => {
  const origKey = process.env.SHITERU_API_KEY;
  const origUrl = process.env.SHITERU_BASE_URL;
  process.env.SHITERU_API_KEY = '';
  process.env.SHITERU_BASE_URL = 'https://test.example.com/v1';
  try {
    const result = await runner.run({
      mode: 'observe', tickers: 'BBCA', models: 'test-model',
      dryRun: false, all: false, limit: 1, force: true,
      tickersFile: null, concurrency: 1, includeRawCandles: false,
      maxOutputTokens: 100, temperature: 0.2
    });
    assert.equal(result.error, 'SHITERU_API_KEY missing');
  } finally {
    process.env.SHITERU_API_KEY = origKey || '';
    process.env.SHITERU_BASE_URL = origUrl || '';
    process.exitCode = 0;
  }
});

test('missing SHITERU_BASE_URL fails cleanly', async () => {
  const origKey = process.env.SHITERU_API_KEY;
  const origUrl = process.env.SHITERU_BASE_URL;
  process.env.SHITERU_API_KEY = 'sk_test';
  process.env.SHITERU_BASE_URL = '';
  try {
    const result = await runner.run({
      mode: 'observe', tickers: 'BBCA', models: 'test-model',
      dryRun: false, all: false, limit: 1, force: true,
      tickersFile: null, concurrency: 1, includeRawCandles: false,
      maxOutputTokens: 100, temperature: 0.2
    });
    assert.equal(result.error, 'SHITERU_BASE_URL missing');
  } finally {
    process.env.SHITERU_API_KEY = origKey || '';
    process.env.SHITERU_BASE_URL = origUrl || '';
    process.exitCode = 0;
  }
});


// ============================================================
// DRY-RUN TESTS
// ============================================================

test('dry-run builds payload and does not call API', async () => {
  const dir = await tmpdir();
  const origOutput = process.env.AI_RESEARCH_OUTPUT_DIR;
  const origCache = process.env.DAYTRADE_CACHE_DIR;
  process.env.AI_RESEARCH_OUTPUT_DIR = dir;
  process.env.DAYTRADE_CACHE_DIR = dir + '/cache';

  // Write cache file for BBCA
  const candles = makeCandles(60, 9000);
  await runner.writeCacheFile(dir + '/cache', 'BBCA', candles);

  try {
    const result = await runner.run({
      mode: 'observe', tickers: 'BBCA', models: 'test-model',
      dryRun: true, all: false, limit: 1, force: true,
      tickersFile: null, concurrency: 1, includeRawCandles: false,
      maxOutputTokens: 100, temperature: 0.2
    });
    assert.equal(result.completed_jobs, 1);
    assert.equal(result.failed_jobs, 0);
    assert.equal(result.dry_run, true);

    // Check JSONL was written
    const jsonl = await fs.readFile(path.join(dir, new Date().toISOString().slice(0, 10), 'results.jsonl'), 'utf8');
    const rows = jsonl.trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ticker, 'BBCA');
    assert.equal(rows[0].model, 'test-model');
    assert.equal(rows[0].ai_result, null); // No API call
    assert.ok(rows[0].deterministic_summary); // Payload built
    assert.ok(rows[0].raw_response_preview.includes('DRY RUN'));
  } finally {
    process.env.AI_RESEARCH_OUTPUT_DIR = origOutput || '';
    process.env.DAYTRADE_CACHE_DIR = origCache || '';
  }
});


// ============================================================
// CHECKPOINT TESTS
// ============================================================

test('checkpoint skips completed ticker/model', async () => {
  const dir = await tmpdir();
  const outputDir = path.join(dir, 'output', new Date().toISOString().slice(0, 10));
  await fs.mkdir(outputDir, { recursive: true });

  // Pre-save checkpoint with BBCA::test-model completed
  await runner.saveCheckpoint(outputDir, {
    completed: { 'BBCA::test-model': true }
  });

  const origOutput = process.env.AI_RESEARCH_OUTPUT_DIR;
  const origCache = process.env.DAYTRADE_CACHE_DIR;
  process.env.AI_RESEARCH_OUTPUT_DIR = path.join(dir, 'output');
  process.env.DAYTRADE_CACHE_DIR = dir + '/cache';

  const candles = makeCandles(60, 9000);
  await runner.writeCacheFile(dir + '/cache', 'BBCA', candles);

  try {
    const result = await runner.run({
      mode: 'observe', tickers: 'BBCA', models: 'test-model',
      dryRun: true, all: false, limit: 1, force: false,
      tickersFile: null, concurrency: 1, includeRawCandles: false,
      maxOutputTokens: 100, temperature: 0.2
    });
    assert.equal(result.skipped_jobs, 1);
    assert.equal(result.completed_jobs, 0);
  } finally {
    process.env.AI_RESEARCH_OUTPUT_DIR = origOutput || '';
    process.env.DAYTRADE_CACHE_DIR = origCache || '';
  }
});

test('checkpoint key format is ticker::model', () => {
  assert.equal(runner.checkpointKey('BBCA', 'qwen-3.7-max'), 'BBCA::qwen-3.7-max');
  assert.equal(runner.checkpointKey('GOTO', 'deepseek-v4-pro'), 'GOTO::deepseek-v4-pro');
});


// ============================================================
// MODEL FAILURE CONTINUES TESTS
// ============================================================

test('model failure continues to next ticker/model', async () => {
  const dir = await tmpdir();
  const origOutput = process.env.AI_RESEARCH_OUTPUT_DIR;
  const origCache = process.env.DAYTRADE_CACHE_DIR;
  const origUrl = process.env.SHITERU_BASE_URL;
  const origKey = process.env.SHITERU_API_KEY;
  process.env.AI_RESEARCH_OUTPUT_DIR = dir;
  process.env.DAYTRADE_CACHE_DIR = dir + '/cache';
  process.env.SHITERU_BASE_URL = 'http://127.0.0.1:1/v1'; // will fail immediately
  process.env.SHITERU_API_KEY = 'sk_test_fail';

  const candles = makeCandles(60, 9000);
  await runner.writeCacheFile(dir + '/cache', 'BBCA', candles);
  await runner.writeCacheFile(dir + '/cache', 'BBRI', candles);

  try {
    const result = await runner.run({
      mode: 'observe', tickers: 'BBCA,BBRI', models: 'fail-model',
      dryRun: false, all: false, limit: 2, force: true,
      tickersFile: null, concurrency: 1, includeRawCandles: false,
      maxOutputTokens: 100, temperature: 0.2
    });
    // Both should fail but run should complete (not crash)
    assert.ok(result.failed_jobs >= 2, 'Expected at least 2 failed jobs, got ' + result.failed_jobs);
    assert.equal(result.total_tickers, 2);
  } finally {
    process.env.AI_RESEARCH_OUTPUT_DIR = origOutput || '';
    process.env.DAYTRADE_CACHE_DIR = origCache || '';
    process.env.SHITERU_BASE_URL = origUrl || '';
    process.env.SHITERU_API_KEY = origKey || '';
  }
});


// ============================================================
// JSONL WRITER TESTS
// ============================================================

test('JSONL writer appends valid rows', async () => {
  const dir = await tmpdir();
  await fs.mkdir(dir, { recursive: true });

  await runner.appendJSONL(dir, { ticker: 'BBCA', model: 'm1', result: 'ok' });
  await runner.appendJSONL(dir, { ticker: 'BBRI', model: 'm2', result: 'fail' });

  const content = await fs.readFile(path.join(dir, 'results.jsonl'), 'utf8');
  const lines = content.trim().split('\n');
  assert.equal(lines.length, 2);

  const row1 = JSON.parse(lines[0]);
  assert.equal(row1.ticker, 'BBCA');
  const row2 = JSON.parse(lines[1]);
  assert.equal(row2.ticker, 'BBRI');
});


// ============================================================
// DEFAULT PAYLOAD: LAST 30 CANDLES + NOTABLE EVENTS (NO FULL RAW)
// ============================================================

test('default prompt does not include full 90D raw candles', () => {
  const candles = makeCandles(90, 5000);
  const payload = runner.buildDeterministicPayload('BBCA', candles, { includeRawCandles: false });
  assert.equal(payload.full_90d_candles, undefined);
  assert.ok(payload.last_30_candles);
  assert.equal(payload.last_30_candles.length, 30);
  assert.equal(payload.last_10_candles, undefined);
});

test('default payload includes notable_events_90d', () => {
  const candles = makeCandles(90, 5000);
  const payload = runner.buildDeterministicPayload('BBCA', candles, { includeRawCandles: false });
  assert.ok(Array.isArray(payload.notable_events_90d));
  assert.ok(payload.notable_events_90d.length >= 3); // at least 90d_high, 90d_low, highest_volume
  const labels = payload.notable_events_90d.map(e => e.label);
  assert.ok(labels.includes('90d_high'));
  assert.ok(labels.includes('90d_low'));
  assert.ok(labels.includes('highest_volume'));
});

test('--include-raw-candles includes full candle array', () => {
  const candles = makeCandles(90, 5000);
  const payload = runner.buildDeterministicPayload('BBCA', candles, { includeRawCandles: true });
  assert.ok(payload.full_90d_candles);
  assert.equal(payload.full_90d_candles.length, 90);
  // Still includes last_30 and notable events
  assert.ok(payload.last_30_candles);
  assert.equal(payload.last_30_candles.length, 30);
  assert.ok(Array.isArray(payload.notable_events_90d));
});


// ============================================================
// OUTPUT PATHS AND GITIGNORE
// ============================================================

test('output paths are under data/ai-research', () => {
  const dir = runner.getOutputDir('./data/ai-research');
  assert.ok(dir.replace(/\\/g, '/').includes('data/ai-research'));
  assert.ok(dir.includes(new Date().toISOString().slice(0, 10)));
});

test('output directory includes date', () => {
  const dir = runner.getOutputDir('/tmp/ai-research');
  const today = new Date().toISOString().slice(0, 10);
  assert.ok(dir.replace(/\\/g, '/').endsWith(today));
});


// ============================================================
// API URL BUILDER TESTS
// ============================================================

test('buildApiUrl appends /chat/completions to base URL', () => {
  assert.equal(
    runner.buildApiUrl('https://api.shiteru.ai/v1'),
    'https://api.shiteru.ai/v1/chat/completions'
  );
});

test('buildApiUrl does not double-append if already ends with /chat/completions', () => {
  assert.equal(
    runner.buildApiUrl('https://api.shiteru.ai/v1/chat/completions'),
    'https://api.shiteru.ai/v1/chat/completions'
  );
});

test('buildApiUrl strips trailing slashes', () => {
  assert.equal(
    runner.buildApiUrl('https://api.shiteru.ai/v1/'),
    'https://api.shiteru.ai/v1/chat/completions'
  );
});

test('buildApiUrl returns empty string for empty input', () => {
  assert.equal(runner.buildApiUrl(''), '');
  assert.equal(runner.buildApiUrl(null), '');
});


// ============================================================
// PARSE AI RESPONSE TESTS
// ============================================================

test('parseAIResponse handles valid JSON', () => {
  const input = '{"ticker":"BBCA","bias":"bullish"}';
  const result = runner.parseAIResponse(input);
  assert.equal(result.ticker, 'BBCA');
  assert.equal(result.bias, 'bullish');
});

test('parseAIResponse handles JSON in markdown code block', () => {
  const input = '```json\n{"ticker":"BBRI","bias":"neutral"}\n```';
  const result = runner.parseAIResponse(input);
  assert.equal(result.ticker, 'BBRI');
});

test('parseAIResponse handles JSON with leading text', () => {
  const input = 'Here is the analysis:\n{"ticker":"TLKM","bias":"bearish"}';
  const result = runner.parseAIResponse(input);
  assert.equal(result.ticker, 'TLKM');
});

test('parseAIResponse returns null for garbage', () => {
  assert.equal(runner.parseAIResponse('not json at all'), null);
  assert.equal(runner.parseAIResponse(''), null);
  assert.equal(runner.parseAIResponse(null), null);
});

test('parseAIResponse handles valid JSON followed by extra prose', () => {
  const input = '{"ticker":"BBCA","bias":"bullish","quality_score":75}\n\nThis analysis shows a bullish bias with strong volume confirmation. The ticker is approaching resistance.';
  const result = runner.parseAIResponse(input);
  assert.equal(result.ticker, 'BBCA');
  assert.equal(result.bias, 'bullish');
  assert.equal(result.quality_score, 75);
});

test('parseAIResponse handles JSON followed by prose with braces in prose', () => {
  const input = '{"ticker":"GOTO","bias":"neutral"}\n\nNote: the setup {unclear} may need revalidation. Risk is {high} if volume drops.';
  const result = runner.parseAIResponse(input);
  assert.equal(result.ticker, 'GOTO');
  assert.equal(result.bias, 'neutral');
});

test('parseAIResponse handles JSON followed by newlines and disclaimer', () => {
  const input = '{"ticker":"TLKM","setup_type":"watchlist","not_financial_advice":true}\n\n---\nDisclaimer: This is not financial advice. Past performance does not guarantee future results.';
  const result = runner.parseAIResponse(input);
  assert.equal(result.ticker, 'TLKM');
  assert.equal(result.not_financial_advice, true);
});

test('parseAIResponse handles nested JSON objects with trailing text', () => {
  const input = '{"ticker":"ASII","technical_breakdown":{"trend_view":"uptrend","momentum_view":"strong"},"bias":"bullish"}\n\nAdditional context: the market is showing strength.';
  const result = runner.parseAIResponse(input);
  assert.equal(result.ticker, 'ASII');
  assert.equal(result.technical_breakdown.trend_view, 'uptrend');
});

test('parseAIResponse handles JSON with escaped quotes followed by prose', () => {
  const input = '{"ticker":"BBRI","final_verdict":"Wait for \\"breakout\\" confirmation"}\n\nThe above analysis is research only.';
  const result = runner.parseAIResponse(input);
  assert.equal(result.ticker, 'BBRI');
  assert.ok(result.final_verdict.includes('breakout'));
});

test('parseAIResponse handles fenced json block with prose after fence', () => {
  const input = '```json\n{"ticker":"ADRO","bias":"bearish"}\n```\n\nPlease note this is just research.';
  const result = runner.parseAIResponse(input);
  assert.equal(result.ticker, 'ADRO');
  assert.equal(result.bias, 'bearish');
});

test('parseAIResponse rejects response with no JSON object', () => {
  assert.equal(runner.parseAIResponse('The analysis could not be completed due to insufficient data.'), null);
  assert.equal(runner.parseAIResponse('Error: model timeout'), null);
  assert.equal(runner.parseAIResponse('[1, 2, 3]'), null); // array, not object
});

test('parseAIResponse rejects malformed JSON even with braces', () => {
  assert.equal(runner.parseAIResponse('{ticker: BBCA, bias: bullish}'), null);
  assert.equal(runner.parseAIResponse('{"ticker": "BBCA", "bias":}'), null);
});

test('extractFirstBalancedJSON extracts first object from mixed content', () => {
  const input = 'prefix {"a":1,"b":{"c":2}} suffix {"d":3}';
  const result = runner.extractFirstBalancedJSON(input);
  assert.equal(result, '{"a":1,"b":{"c":2}}');
});

test('extractFirstBalancedJSON handles strings with braces inside', () => {
  const input = '{"msg":"hello {world}","val":42} extra';
  const result = runner.extractFirstBalancedJSON(input);
  assert.equal(result, '{"msg":"hello {world}","val":42}');
  assert.deepEqual(JSON.parse(result), { msg: 'hello {world}', val: 42 });
});

test('extractFirstBalancedJSON returns null for no braces', () => {
  assert.equal(runner.extractFirstBalancedJSON('no json here'), null);
  assert.equal(runner.extractFirstBalancedJSON(null), null);
  assert.equal(runner.extractFirstBalancedJSON(''), null);
});

test('extractFirstBalancedJSON returns null for unbalanced braces', () => {
  assert.equal(runner.extractFirstBalancedJSON('{"incomplete": true'), null);
  assert.equal(runner.extractFirstBalancedJSON('{{{'), null);
});


// ============================================================
// DETERMINISTIC PAYLOAD TESTS
// ============================================================

test('buildDeterministicPayload produces required fields', () => {
  const candles = makeCandles(60, 5000);
  const payload = runner.buildDeterministicPayload('BBCA', candles, {});
  assert.equal(payload.ticker, 'BBCA');
  assert.equal(payload.board, 'UTAMA');
  assert.equal(payload.candle_count, 60);
  assert.ok(payload.last_close > 0);
  assert.ok(payload.previous_close > 0);
  assert.ok(payload['90d_high'] > 0);
  assert.ok(payload['90d_low'] > 0);
  assert.ok(payload['20d_high'] > 0);
  assert.ok(payload['5d_high'] > 0);
  assert.ok(payload.volume_latest > 0);
  assert.ok(payload.avg_volume_5d > 0);
  assert.ok(payload.avg_volume_20d > 0);
  assert.ok(payload.volume_ratio >= 0);
  assert.ok(typeof payload.price_change_1d === 'number');
  assert.ok(typeof payload.price_change_5d === 'number');
  assert.ok(typeof payload.price_change_20d === 'number');
  assert.ok(Array.isArray(payload.last_30_candles));
  assert.equal(payload.last_30_candles.length, 30);
  assert.ok(Array.isArray(payload.notable_events_90d));
  assert.ok(Array.isArray(payload.candle_notes));
});

test('buildDeterministicPayload with minimum candles (20)', () => {
  const candles = makeCandles(20, 3000);
  const payload = runner.buildDeterministicPayload('GOTO', candles, {});
  assert.equal(payload.ticker, 'GOTO');
  assert.equal(payload.candle_count, 20);
  assert.ok(payload.last_close > 0);
});


// ============================================================
// CACHE READ/WRITE TESTS
// ============================================================

test('cache write and read roundtrip works', async () => {
  const dir = await tmpdir();
  const candles = makeCandles(90, 8000);
  await runner.writeCacheFile(dir, 'ASII', candles);

  const result = await runner.readCacheFile(dir, 'ASII');
  assert.equal(result.hit, true);
  assert.ok(result.candles.length >= 20);
  assert.ok(result.candles.length <= 90);
  assert.equal(result.candles[0].close, candles[0].close);
});

test('cache read returns miss for non-existent file', async () => {
  const dir = await tmpdir();
  const result = await runner.readCacheFile(dir, 'NONEXISTENT');
  assert.equal(result.hit, false);
  assert.deepEqual(result.candles, []);
});

// ============================================================
// NORMALIZE CANDLES TESTS
// ============================================================

test('normalizeCandles filters invalid entries', () => {
  const input = [
    { time: 1000, open: 100, high: 110, low: 90, close: 105, volume: 500 },
    { time: NaN, open: 'abc', high: 110, low: 90, close: 105, volume: 500 },
    null,
    { time: 2000, open: 200, high: 210, low: 190, close: 205, volume: 600 }
  ];
  const result = runner.normalizeCandles(input);
  assert.equal(result.length, 2);
  assert.equal(result[0].time, 1000);
  assert.equal(result[1].time, 2000);
});


// ============================================================
// CLI ARGS PARSING TESTS
// ============================================================

test('parseArgs handles all flags correctly', () => {
  const argv = [
    'node', 'script.js',
    '--mode', 'observe',
    '--tickers-file', 'data/tickers.txt',
    '--models', 'qwen-3.7-max,gpt-5.5',
    '--limit', '20',
    '--concurrency', '2',
    '--max-output-tokens', '3000',
    '--temperature', '0.5',
    '--all', '--force', '--dry-run', '--include-raw-candles'
  ];
  const args = runner.parseArgs(argv);
  assert.equal(args.mode, 'observe');
  assert.equal(args.tickersFile, 'data/tickers.txt');
  assert.equal(args.models, 'qwen-3.7-max,gpt-5.5');
  assert.equal(args.limit, 20);
  assert.equal(args.concurrency, 2);
  assert.equal(args.maxOutputTokens, 3000);
  assert.equal(args.temperature, 0.5);
  assert.equal(args.all, true);
  assert.equal(args.force, true);
  assert.equal(args.dryRun, true);
  assert.equal(args.includeRawCandles, true);
});

test('parseArgs defaults are sensible', () => {
  const args = runner.parseArgs(['node', 'script.js']);
  assert.equal(args.mode, 'observe');
  assert.equal(args.all, false);
  assert.equal(args.force, false);
  assert.equal(args.dryRun, false);
  assert.equal(args.includeRawCandles, false);
  assert.equal(args.tickersFile, null);
});



// ============================================================
// 90D NOTABLE EVENTS EXTRACTION TESTS
// ============================================================

test('extract90DNotableEvents identifies 90D high and low candles', () => {
  const candles = makeCandles(90, 1000);
  // Last candle has highest close/high, first has lowest
  const events = runner.extract90DNotableEvents(candles, {});
  const labels = events.map(e => e.label);
  assert.ok(labels.includes('90d_high'));
  assert.ok(labels.includes('90d_low'));
  // 90d_high should be the last candle (highest price due to uptrend in makeCandles)
  const highEvent = events.find(e => e.label === '90d_high');
  assert.ok(highEvent.high > 0);
});

test('extract90DNotableEvents identifies highest volume candle', () => {
  const candles = makeCandles(60, 2000);
  // Inject a massive volume spike at index 30
  candles[30].volume = 99999999;
  const events = runner.extract90DNotableEvents(candles, {});
  const highVol = events.find(e => e.label === 'highest_volume');
  assert.ok(highVol);
  assert.equal(highVol.volume, 99999999);
});

test('extract90DNotableEvents finds top 3 volume spikes', () => {
  const candles = makeCandles(60, 2000);
  const avgVol = candles.reduce((s, c) => s + c.volume, 0) / candles.length;
  // Inject 4 spikes (>2x average)
  candles[10].volume = avgVol * 5;
  candles[20].volume = avgVol * 4;
  candles[30].volume = avgVol * 3;
  candles[40].volume = avgVol * 2.5;
  const events = runner.extract90DNotableEvents(candles, { vol20: avgVol });
  const spikeLabels = events.filter(e => e.label.startsWith('volume_spike'));
  assert.ok(spikeLabels.length >= 2); // at least 2-3 spikes (highest_volume takes one)
});

test('extract90DNotableEvents detects breakout candle', () => {
  const candles = makeCandles(60, 3000);
  // Create a breakout candle near the end: strong green, high volume, close near high
  const idx = 55;
  const avgVol = candles.reduce((s, c) => s + c.volume, 0) / candles.length;
  candles[idx].open = 3200;
  candles[idx].high = 3350;
  candles[idx].low = 3190;
  candles[idx].close = 3340; // close near high, body > 65% of range
  candles[idx].volume = avgVol * 2;
  const events = runner.extract90DNotableEvents(candles, { vol20: avgVol });
  const breakout = events.find(e => e.label === 'breakout_candle');
  assert.ok(breakout, 'Should detect breakout candle');
  assert.equal(breakout.close, 3340);
});

test('extract90DNotableEvents detects fakeout candle', () => {
  const candles = makeCandles(60, 3000);
  // Create a fakeout: new high but close below prev close
  const idx = 55;
  candles[idx - 1].high = 3200;
  candles[idx - 1].close = 3180;
  candles[idx].open = 3250;
  candles[idx].high = 3300; // new high > prev high
  candles[idx].low = 3100;
  candles[idx].close = 3120; // close < prev close, red candle
  const events = runner.extract90DNotableEvents(candles, {});
  const fakeout = events.find(e => e.label === 'fakeout_candle');
  assert.ok(fakeout, 'Should detect fakeout candle');
});

test('extract90DNotableEvents detects rejection candle', () => {
  const candles = makeCandles(60, 3000);
  // Create a rejection: long upper wick, close in lower third
  const idx = 55;
  const avgVol = candles.reduce((s, c) => s + c.volume, 0) / candles.length;
  candles[idx].open = 3100;
  candles[idx].high = 3400; // range = 300
  candles[idx].low = 3100;
  candles[idx].close = 3130; // close near low, upper wick > 50% of range
  candles[idx].volume = avgVol * 1.2;
  const events = runner.extract90DNotableEvents(candles, { vol20: avgVol });
  const rejection = events.find(e => e.label === 'rejection_candle');
  assert.ok(rejection, 'Should detect rejection candle');
});

test('extract90DNotableEvents includes 60D high/low when enough data', () => {
  const candles = makeCandles(90, 1000);
  // Make 60D window have a different high than 90D
  candles[0].high = 99999; // 90D high but outside 60D window
  const events = runner.extract90DNotableEvents(candles, {});
  const labels = events.map(e => e.label);
  assert.ok(labels.includes('90d_high'));
  // 60d_high should appear since it differs from 90D high
  assert.ok(labels.includes('60d_high'));
});

test('extract90DNotableEvents handles small candle arrays gracefully', () => {
  const candles = makeCandles(5, 1000);
  const events = runner.extract90DNotableEvents(candles, {});
  assert.ok(Array.isArray(events));
  assert.ok(events.length >= 3); // still produces 90d_high, 90d_low, highest_volume
});

test('extract90DNotableEvents detects demand touches', () => {
  const candles = makeCandles(60, 5000);
  const demandLevel = 4980; // near the low of first candles
  // Make a candle that touches demand and recovers
  candles[50].low = demandLevel - 5;
  candles[50].close = demandLevel + 30;
  const events = runner.extract90DNotableEvents(candles, { majorDemand: demandLevel, vol20: 500000 });
  const demandTouch = events.find(e => e.label === 'demand_touch' || e.label === 'demand_touch_recent');
  assert.ok(demandTouch, 'Should detect demand touch candle');
});

test('extract90DNotableEvents event entries have correct shape', () => {
  const candles = makeCandles(60, 5000);
  const events = runner.extract90DNotableEvents(candles, {});
  for (const e of events) {
    assert.ok(e.date, 'event must have date');
    assert.ok(e.label, 'event must have label');
    assert.ok(typeof e.open === 'number', 'event must have numeric open');
    assert.ok(typeof e.high === 'number', 'event must have numeric high');
    assert.ok(typeof e.low === 'number', 'event must have numeric low');
    assert.ok(typeof e.close === 'number', 'event must have numeric close');
    assert.ok(typeof e.volume === 'number', 'event must have numeric volume');
  }
});



// ============================================================
// STREAMING PARSER TESTS (parseStreamChunks)
// ============================================================

test('parseStreamChunks assembles content from SSE delta chunks', () => {
  const chunk1 = JSON.stringify({ choices: [{ delta: { content: '{"ticker":' } }] });
  const chunk2 = JSON.stringify({ choices: [{ delta: { content: '"BBCA"}' } }] });
  const sse = 'data: ' + chunk1 + '\ndata: ' + chunk2 + '\ndata: [DONE]\n';
  const result = runner.parseStreamChunks(sse);
  assert.equal(result.content, '{"ticker":"BBCA"}');
  assert.equal(result.raw, '{"ticker":"BBCA"}');
});

test('parseStreamChunks handles empty SSE text', () => {
  const result = runner.parseStreamChunks('');
  assert.equal(result.content, null);
  assert.equal(result.usage, null);
});

test('parseStreamChunks handles null input', () => {
  const result = runner.parseStreamChunks(null);
  assert.equal(result.content, null);
});

test('parseStreamChunks skips non-data lines', () => {
  const sse = [
    ': comment line',
    '',
    'data: {"choices":[{"delta":{"content":"hello"}}]}',
    'event: ping',
    'data: {"choices":[{"delta":{"content":" world"}}]}',
    'data: [DONE]'
  ].join('\n');
  const result = runner.parseStreamChunks(sse);
  assert.equal(result.content, 'hello world');
});

test('parseStreamChunks extracts usage from final chunk', () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"ok"}}]}',
    'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150}}',
    'data: [DONE]'
  ].join('\n');
  const result = runner.parseStreamChunks(sse);
  assert.equal(result.content, 'ok');
  assert.deepEqual(result.usage, { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
});

test('parseStreamChunks handles NVIDIA-style response with model field', () => {
  const sse = [
    'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","model":"z-ai/glm-5.2","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
    'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","model":"z-ai/glm-5.2","choices":[{"index":0,"delta":{"content":"{\\"bias\\":\\"bullish\\"}"},"finish_reason":null}]}',
    'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","model":"z-ai/glm-5.2","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":200,"completion_tokens":80,"total_tokens":280}}',
    'data: [DONE]'
  ].join('\n');
  const result = runner.parseStreamChunks(sse);
  assert.equal(result.content, '{"bias":"bullish"}');
  assert.equal(result.usage.total_tokens, 280);
});

test('parseStreamChunks ignores malformed JSON lines gracefully', () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"A"}}]}',
    'data: {broken json here',
    'data: {"choices":[{"delta":{"content":"B"}}]}',
    'data: [DONE]'
  ].join('\n');
  const result = runner.parseStreamChunks(sse);
  assert.equal(result.content, 'AB');
});

// ============================================================
// FAIL-FAST GUARD TESTS
// ============================================================

test('createFailFastTracker stops model after 5 consecutive 402 errors', () => {
  const tracker = runner.createFailFastTracker();
  for (let i = 0; i < 4; i++) {
    const stopped = tracker.recordError('bad-model', { message: 'AI API HTTP 402: payment required', statusCode: 402 });
    assert.equal(stopped, false);
    assert.equal(tracker.isStopped('bad-model'), false);
  }
  const stopped = tracker.recordError('bad-model', { message: 'AI API HTTP 402: payment required', statusCode: 402 });
  assert.equal(stopped, true);
  assert.equal(tracker.isStopped('bad-model'), true);
  assert.ok(tracker.getStopReason('bad-model').includes('402'));
  assert.ok(tracker.getStopReason('bad-model').includes('5'));
});

test('createFailFastTracker resets counter on success', () => {
  const tracker = runner.createFailFastTracker();
  tracker.recordError('model-x', { statusCode: 502 });
  tracker.recordError('model-x', { statusCode: 502 });
  tracker.recordError('model-x', { statusCode: 502 });
  tracker.recordSuccess('model-x');
  for (let i = 0; i < 4; i++) {
    tracker.recordError('model-x', { statusCode: 502 });
  }
  assert.equal(tracker.isStopped('model-x'), false);
  tracker.recordError('model-x', { statusCode: 502 });
  assert.equal(tracker.isStopped('model-x'), true);
});

test('createFailFastTracker only triggers on 402/403/502/504', () => {
  const tracker = runner.createFailFastTracker();
  for (let i = 0; i < 10; i++) {
    tracker.recordError('model-500', { statusCode: 500 });
  }
  assert.equal(tracker.isStopped('model-500'), false);
  for (let i = 0; i < 10; i++) {
    tracker.recordError('model-429', { statusCode: 429 });
  }
  assert.equal(tracker.isStopped('model-429'), false);
});

test('createFailFastTracker works with 403 and 504', () => {
  const tracker = runner.createFailFastTracker();
  for (let i = 0; i < 5; i++) {
    tracker.recordError('model-403', { statusCode: 403 });
  }
  assert.equal(tracker.isStopped('model-403'), true);
  for (let i = 0; i < 5; i++) {
    tracker.recordError('model-504', { statusCode: 504 });
  }
  assert.equal(tracker.isStopped('model-504'), true);
});

test('createFailFastTracker tracks models independently', () => {
  const tracker = runner.createFailFastTracker();
  for (let i = 0; i < 5; i++) {
    tracker.recordError('model-a', { statusCode: 402 });
  }
  assert.equal(tracker.isStopped('model-a'), true);
  assert.ok(!tracker.isStopped('model-b'));
});

test('createFailFastTracker getState returns all model states', () => {
  const tracker = runner.createFailFastTracker();
  tracker.recordError('m1', { statusCode: 402 });
  tracker.recordSuccess('m2');
  const state = tracker.getState();
  assert.ok(state.m1);
  assert.equal(state.m1.consecutive, 1);
  assert.ok(state.m2);
  assert.equal(state.m2.consecutive, 0);
});

test('extractHttpStatus parses statusCode property', () => {
  assert.equal(runner.extractHttpStatus({ statusCode: 402 }), 402);
  assert.equal(runner.extractHttpStatus({ statusCode: 504 }), 504);
});

test('extractHttpStatus parses from error message string', () => {
  assert.equal(runner.extractHttpStatus({ message: 'AI API HTTP 403: forbidden' }), 403);
  assert.equal(runner.extractHttpStatus({ message: 'AI API HTTP 502: bad gateway' }), 502);
});

test('extractHttpStatus returns null for non-HTTP errors', () => {
  assert.equal(runner.extractHttpStatus({ message: 'fetch failed' }), null);
  assert.equal(runner.extractHttpStatus(null), null);
  assert.equal(runner.extractHttpStatus({}), null);
});

// ============================================================
// --stream-ai CLI FLAG TEST
// ============================================================

test('parseArgs recognizes --stream-ai flag', () => {
  const args = runner.parseArgs(['node', 'script.js', '--stream-ai', '--mode', 'observe']);
  assert.equal(args.streamAi, true);
  assert.equal(args.mode, 'observe');
});

test('parseArgs defaults streamAi to false', () => {
  const args = runner.parseArgs(['node', 'script.js']);
  assert.equal(args.streamAi, false);
});



// ============================================================
// GLOBAL CONCURRENCY TESTS
// ============================================================

test('concurrency > 1 runs multiple tickers in parallel for one model', async () => {
  const dir = await tmpdir();
  const origOutput = process.env.AI_RESEARCH_OUTPUT_DIR;
  const origCache = process.env.DAYTRADE_CACHE_DIR;
  const origUrl = process.env.SHITERU_BASE_URL;
  const origKey = process.env.SHITERU_API_KEY;
  process.env.AI_RESEARCH_OUTPUT_DIR = dir;
  process.env.DAYTRADE_CACHE_DIR = dir + '/cache';
  process.env.SHITERU_BASE_URL = 'http://127.0.0.1:1/v1';
  process.env.SHITERU_API_KEY = 'sk_test';

  const candles = makeCandles(60, 5000);
  const tickers = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE'];
  for (const t of tickers) await runner.writeCacheFile(dir + '/cache', t, candles);

  try {
    const result = await runner.run({
      mode: 'observe', tickers: tickers.join(','), models: 'test-model',
      dryRun: true, all: false, limit: null, force: true,
      tickersFile: null, concurrency: 5, includeRawCandles: false,
      streamAi: false, maxOutputTokens: 100, temperature: 0.2
    });
    assert.equal(result.completed_jobs, 5);
    assert.equal(result.total_jobs, 5);
    const jsonlPath = path.join(dir, new Date().toISOString().slice(0, 10), 'results.jsonl');
    const lines = (await fs.readFile(jsonlPath, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 5);
    const processedTickers = lines.map(l => JSON.parse(l).ticker).sort();
    assert.deepEqual(processedTickers, tickers.sort());
  } finally {
    process.env.AI_RESEARCH_OUTPUT_DIR = origOutput || '';
    process.env.DAYTRADE_CACHE_DIR = origCache || '';
    process.env.SHITERU_BASE_URL = origUrl || '';
    process.env.SHITERU_API_KEY = origKey || '';
  }
});

test('checkpoint skips still work with global concurrency', async () => {
  const dir = await tmpdir();
  const outputDir = path.join(dir, 'output', new Date().toISOString().slice(0, 10));
  await fs.mkdir(outputDir, { recursive: true });

  await runner.saveCheckpoint(outputDir, {
    completed: { 'AAA::m1': true, 'BBB::m1': true }
  });

  const origOutput = process.env.AI_RESEARCH_OUTPUT_DIR;
  const origCache = process.env.DAYTRADE_CACHE_DIR;
  process.env.AI_RESEARCH_OUTPUT_DIR = path.join(dir, 'output');
  process.env.DAYTRADE_CACHE_DIR = dir + '/cache';

  const candles = makeCandles(60, 5000);
  for (const t of ['AAA', 'BBB', 'CCC']) await runner.writeCacheFile(dir + '/cache', t, candles);

  try {
    const result = await runner.run({
      mode: 'observe', tickers: 'AAA,BBB,CCC', models: 'm1',
      dryRun: true, all: false, limit: null, force: false,
      tickersFile: null, concurrency: 3, includeRawCandles: false,
      streamAi: false, maxOutputTokens: 100, temperature: 0.2
    });
    assert.equal(result.skipped_jobs, 2);
    assert.equal(result.completed_jobs, 1);
  } finally {
    process.env.AI_RESEARCH_OUTPUT_DIR = origOutput || '';
    process.env.DAYTRADE_CACHE_DIR = origCache || '';
  }
});

test('failed job does not stop queue with concurrency', async () => {
  const dir = await tmpdir();
  const origOutput = process.env.AI_RESEARCH_OUTPUT_DIR;
  const origCache = process.env.DAYTRADE_CACHE_DIR;
  const origUrl = process.env.SHITERU_BASE_URL;
  const origKey = process.env.SHITERU_API_KEY;
  process.env.AI_RESEARCH_OUTPUT_DIR = dir;
  process.env.DAYTRADE_CACHE_DIR = dir + '/cache';
  process.env.SHITERU_BASE_URL = 'http://127.0.0.1:1/v1';
  process.env.SHITERU_API_KEY = 'sk_test';

  const candles = makeCandles(60, 5000);
  // AAA has no cache (will fail), BBB and CCC have cache
  await runner.writeCacheFile(dir + '/cache', 'BBB', candles);
  await runner.writeCacheFile(dir + '/cache', 'CCC', candles);

  try {
    const result = await runner.run({
      mode: 'observe', tickers: 'AAA,BBB,CCC', models: 'test-model',
      dryRun: true, all: false, limit: null, force: true,
      tickersFile: null, concurrency: 3, includeRawCandles: false,
      streamAi: false, maxOutputTokens: 100, temperature: 0.2
    });
    assert.equal(result.failed_jobs, 1);
    assert.equal(result.completed_jobs, 2);
    assert.equal(result.total_jobs, 3);
  } finally {
    process.env.AI_RESEARCH_OUTPUT_DIR = origOutput || '';
    process.env.DAYTRADE_CACHE_DIR = origCache || '';
    process.env.SHITERU_BASE_URL = origUrl || '';
    process.env.SHITERU_API_KEY = origKey || '';
  }
});

test('fail-fast skips remaining jobs for stopped model with concurrency', async () => {
  const dir = await tmpdir();
  const origOutput = process.env.AI_RESEARCH_OUTPUT_DIR;
  const origCache = process.env.DAYTRADE_CACHE_DIR;
  const origUrl = process.env.SHITERU_BASE_URL;
  const origKey = process.env.SHITERU_API_KEY;
  process.env.AI_RESEARCH_OUTPUT_DIR = dir;
  process.env.DAYTRADE_CACHE_DIR = dir + '/cache';
  process.env.SHITERU_BASE_URL = 'http://127.0.0.1:1/v1';
  process.env.SHITERU_API_KEY = 'sk_test';

  const candles = makeCandles(60, 5000);
  const tickers = [];
  for (let i = 0; i < 10; i++) {
    const t = 'T' + String(i).padStart(2, '0');
    tickers.push(t);
    await runner.writeCacheFile(dir + '/cache', t, candles);
  }

  try {
    const result = await runner.run({
      mode: 'observe', tickers: tickers.join(','), models: 'fail-model',
      dryRun: false, all: false, limit: null, force: true,
      tickersFile: null, concurrency: 1, includeRawCandles: false,
      streamAi: false, maxOutputTokens: 100, temperature: 0.2
    });
    assert.ok(result.failed_jobs >= 10, 'Expected all jobs to fail: ' + result.failed_jobs);
    assert.equal(result.total_jobs, 10);
  } finally {
    process.env.AI_RESEARCH_OUTPUT_DIR = origOutput || '';
    process.env.DAYTRADE_CACHE_DIR = origCache || '';
    process.env.SHITERU_BASE_URL = origUrl || '';
    process.env.SHITERU_API_KEY = origKey || '';
  }
});

test('streaming mode still works through concurrent queue (dry-run)', async () => {
  const dir = await tmpdir();
  const origOutput = process.env.AI_RESEARCH_OUTPUT_DIR;
  const origCache = process.env.DAYTRADE_CACHE_DIR;
  process.env.AI_RESEARCH_OUTPUT_DIR = dir;
  process.env.DAYTRADE_CACHE_DIR = dir + '/cache';

  const candles = makeCandles(60, 5000);
  for (const t of ['XX', 'YY', 'ZZ']) await runner.writeCacheFile(dir + '/cache', t, candles);

  try {
    const result = await runner.run({
      mode: 'observe', tickers: 'XX,YY,ZZ', models: 'stream-model',
      dryRun: true, all: false, limit: null, force: true,
      tickersFile: null, concurrency: 3, includeRawCandles: false,
      streamAi: true, maxOutputTokens: 100, temperature: 0.2
    });
    assert.equal(result.completed_jobs, 3);
    assert.equal(result.total_jobs, 3);
  } finally {
    process.env.AI_RESEARCH_OUTPUT_DIR = origOutput || '';
    process.env.DAYTRADE_CACHE_DIR = origCache || '';
  }
});

test('mapLimit runs tasks concurrently up to limit', async () => {
  let maxConcurrent = 0;
  let current = 0;
  const items = [1, 2, 3, 4, 5, 6, 7, 8];
  await runner.mapLimit(items, 3, async (item) => {
    current++;
    if (current > maxConcurrent) maxConcurrent = current;
    await new Promise(r => setTimeout(r, 10));
    current--;
    return item * 2;
  });
  assert.ok(maxConcurrent <= 3, 'maxConcurrent was ' + maxConcurrent);
  assert.ok(maxConcurrent >= 2, 'should have had at least 2 concurrent, got ' + maxConcurrent);
});

test('mapLimit with limit=1 runs sequentially', async () => {
  let maxConcurrent = 0;
  let current = 0;
  const items = [1, 2, 3, 4];
  const results = await runner.mapLimit(items, 1, async (item) => {
    current++;
    if (current > maxConcurrent) maxConcurrent = current;
    await new Promise(r => setTimeout(r, 5));
    current--;
    return item * 10;
  });
  assert.equal(maxConcurrent, 1);
  assert.deepEqual(results, [10, 20, 30, 40]);
});



// ============================================================
// INDONESIAN LANGUAGE AND SUMMARY.MD TESTS
// ============================================================

test('SYSTEM_PROMPT contains Indonesian language instruction', () => {
  assert.ok(runner.SYSTEM_PROMPT.includes('Bahasa Indonesia'), 'SYSTEM_PROMPT must instruct Indonesian');
  assert.ok(runner.SYSTEM_PROMPT.includes('Kamu'), 'SYSTEM_PROMPT should be in Indonesian');
  assert.ok(runner.SYSTEM_PROMPT.includes('strict valid JSON'), 'Must still require strict JSON');
});

test('SYSTEM_PROMPT contains deep-analysis requirements', () => {
  assert.ok(runner.SYSTEM_PROMPT.toLowerCase().includes('pola candle'), 'Must require candlestick pattern analysis');
  assert.ok(runner.SYSTEM_PROMPT.includes('respect candle') || runner.SYSTEM_PROMPT.includes('Respect candle'), 'Must require respect candle analysis');
  assert.ok(runner.SYSTEM_PROMPT.includes('rejection candle') || runner.SYSTEM_PROMPT.includes('Rejection candle'), 'Must require rejection candle');
  assert.ok(runner.SYSTEM_PROMPT.includes('recovery candle') || runner.SYSTEM_PROMPT.includes('Recovery candle'), 'Must require recovery candle');
  assert.ok(runner.SYSTEM_PROMPT.includes('demand/supply') || runner.SYSTEM_PROMPT.includes('Demand/supply'), 'Must require demand/supply reaction');
  assert.ok(runner.SYSTEM_PROMPT.includes('half-candle debt'), 'Must require half-candle debt analysis');
  assert.ok(runner.SYSTEM_PROMPT.includes('volume behavior') || runner.SYSTEM_PROMPT.includes('Volume behavior') || runner.SYSTEM_PROMPT.includes('avg volume'), 'Must require volume vs avg');
  assert.ok(runner.SYSTEM_PROMPT.includes('90D') && runner.SYSTEM_PROMPT.includes('60D'), 'Must require multi-timeframe structure');
  assert.ok(runner.SYSTEM_PROMPT.includes('PoC'), 'Must require PoC context');
  assert.ok(runner.SYSTEM_PROMPT.includes('breakout') && runner.SYSTEM_PROMPT.includes('fakeout'), 'Must require breakout/fakeout');
  assert.ok(runner.SYSTEM_PROMPT.includes('invalidation') || runner.SYSTEM_PROMPT.includes('Invalidation'), 'Must require invalidation');
});

test('SYSTEM_PROMPT contains quality_score scoring basis from deterministic data only', () => {
  assert.ok(runner.SYSTEM_PROMPT.includes('quality_score'), 'Must mention quality_score');
  assert.ok(runner.SYSTEM_PROMPT.includes('bukti teknikal') || runner.SYSTEM_PROMPT.includes('data deterministik'), 'Must base on technical evidence');
  assert.ok(runner.SYSTEM_PROMPT.includes('JANGAN score berdasarkan hype'), 'Must explicitly reject hype-based scoring');
  assert.ok(runner.SYSTEM_PROMPT.includes('wick'), 'Must include wick in scoring basis');
  assert.ok(runner.SYSTEM_PROMPT.includes('respect') && runner.SYSTEM_PROMPT.includes('rejection') && runner.SYSTEM_PROMPT.includes('recovery'), 'Must include respect/rejection/recovery');
});

test('SYSTEM_PROMPT instructs wick-based respect is valid (not body-only)', () => {
  assert.ok(runner.SYSTEM_PROMPT.includes('wick rejection/recovery'), 'Must mention wick-based respect');
  assert.ok(runner.SYSTEM_PROMPT.includes('body tidak close tepat') || runner.SYSTEM_PROMPT.includes('body-only'), 'Must say body-only is not the only signal');
});

test('USER_PROMPT_TEMPLATE contains Indonesian language instruction', () => {
  assert.ok(runner.USER_PROMPT_TEMPLATE.includes('Bahasa Indonesia'), 'USER_PROMPT must instruct Indonesian');
  assert.ok(runner.USER_PROMPT_TEMPLATE.includes('strict JSON'), 'Must still require strict JSON');
  assert.ok(runner.USER_PROMPT_TEMPLATE.includes('ticker'), 'Schema must still have ticker field');
  assert.ok(runner.USER_PROMPT_TEMPLATE.includes('technical_breakdown'), 'Schema must still have technical_breakdown');
});

test('USER_PROMPT_TEMPLATE contains deep-analysis instructions', () => {
  assert.ok(runner.USER_PROMPT_TEMPLATE.includes('candle_structure_view'), 'Must have candle_structure_view field');
  assert.ok(runner.USER_PROMPT_TEMPLATE.includes('respect') && runner.USER_PROMPT_TEMPLATE.includes('rejection') && runner.USER_PROMPT_TEMPLATE.includes('recovery'), 'Must instruct respect/rejection/recovery');
  assert.ok(runner.USER_PROMPT_TEMPLATE.includes('half-candle debt') || runner.USER_PROMPT_TEMPLATE.includes('gap'), 'Must instruct gap/half-candle');
  assert.ok(runner.USER_PROMPT_TEMPLATE.includes('breakout') && runner.USER_PROMPT_TEMPLATE.includes('fakeout'), 'Must instruct breakout/fakeout');
  assert.ok(runner.USER_PROMPT_TEMPLATE.includes('PoC'), 'Must instruct PoC context');
});

test('USER_PROMPT_TEMPLATE contains quality_score deterministic-only basis', () => {
  assert.ok(runner.USER_PROMPT_TEMPLATE.includes('quality_score'), 'Must reference quality_score');
  assert.ok(runner.USER_PROMPT_TEMPLATE.includes('bukti teknikal deterministik'), 'Must specify deterministic technical evidence');
  assert.ok(runner.USER_PROMPT_TEMPLATE.includes('JANGAN score berdasarkan hype'), 'Must reject hype scoring');
});

test('USER_PROMPT_TEMPLATE schema fields are unchanged (same keys)', () => {
  const required = [
    'ticker', 'model', 'analysis_date', 'data_quality', 'bias', 'setup_type',
    'quality_score', 'risk_level', 'executive_summary', 'technical_breakdown',
    'key_levels', 'bullish_arguments', 'bearish_arguments', 'invalidations',
    'watch_conditions', 'notable_risks', 'final_verdict', 'not_financial_advice'
  ];
  for (const key of required) {
    assert.ok(runner.USER_PROMPT_TEMPLATE.includes('"' + key + '"'), 'Schema must include key: ' + key);
  }
});

test('writeSummaryMD produces detailed per-ticker output (not truncated)', async () => {
  const dir = await tmpdir();
  const results = [
    {
      ticker: 'BBCA', model: 'test-model', error: null,
      ai_result: {
        ticker: 'BBCA', model: 'test-model', bias: 'bullish',
        setup_type: 'breakout', quality_score: 85, risk_level: 'Medium',
        executive_summary: 'Saham menunjukkan momentum bullish kuat dengan volume tinggi dan break resistance.',
        technical_breakdown: {
          trend_view: 'Uptrend kuat di atas MA20 dan MA50.',
          momentum_view: 'RSI 62 menunjukkan momentum sehat tanpa overbought.',
          volume_view: 'Volume 1.8x rata-rata 20 hari, konfirmasi akumulasi.',
          candle_structure_view: 'Bullish engulfing dengan body kuat dan close near high.',
          demand_support_view: 'Demand zone 9200-9300 sudah ditest 3x dan hold.',
          supply_resistance_view: 'Supply di 9800 belum tertembus, target selanjutnya.',
          entry_view: 'Entry ideal di pullback 9400-9500 dengan volume konfirmasi.',
          risk_reward_view: 'RR 2.1:1 layak untuk day trade.'
        },
        key_levels: { entry1: 9400, entry2: 9500, stop_loss: 9200, tp1: 9800, tp2: 10000, major_demand: 9200, major_supply: 9800, poc: 9500 },
        invalidations: ['Close di bawah 9200 membatalkan setup.', 'Volume turun 50% dari rata-rata.'],
        watch_conditions: ['Tunggu volume > 1.5x saat breakout.', 'Monitor close harian di atas 9500.'],
        notable_risks: ['Gap risk jika open jauh dari close sebelumnya.'],
        final_verdict: 'Setup breakout layak dimonitor. Entry hanya jika pullback ke area demand dengan volume konfirmasi.',
        not_financial_advice: true
      }
    }
  ];
  const report = { total_tickers: 1, total_models: 1, total_jobs: 1, completed_jobs: 1, failed_jobs: 0, skipped_jobs: 0 };
  await runner.writeSummaryMD(dir, results, report);

  const md = await fs.readFile(path.join(dir, 'summary.md'), 'utf8');

  // Must be in Indonesian
  assert.ok(md.includes('Ringkasan Riset AI'), 'Title must be Indonesian');
  assert.ok(md.includes('Laporan Run'), 'Section headers must be Indonesian');

  // Must include full ticker detail, not truncated
  assert.ok(md.includes('### BBCA (test-model)'), 'Must have per-ticker heading');
  assert.ok(md.includes('Score | 85'), 'Must include score');
  assert.ok(md.includes('Bias | bullish'), 'Must include bias');
  assert.ok(md.includes('Setup | breakout'), 'Must include setup_type');
  assert.ok(md.includes('Risk Level | Medium'), 'Must include risk_level');

  // Must include full technical breakdown views (not truncated)
  assert.ok(md.includes('Entry ideal di pullback 9400-9500'), 'entry_view must not be truncated');
  assert.ok(md.includes('Demand zone 9200-9300 sudah ditest 3x'), 'demand_support_view must not be truncated');
  assert.ok(md.includes('Volume 1.8x rata-rata 20 hari'), 'volume_view must not be truncated');
  assert.ok(md.includes('Bullish engulfing dengan body kuat'), 'candle_structure_view must not be truncated');

  // Must include invalidations and watch conditions
  assert.ok(md.includes('Close di bawah 9200 membatalkan setup'), 'invalidations must appear');
  assert.ok(md.includes('Tunggu volume > 1.5x saat breakout'), 'watch_conditions must appear');
  assert.ok(md.includes('Gap risk'), 'notable_risks must appear');

  // Must include full verdict (not sliced)
  assert.ok(md.includes('Setup breakout layak dimonitor. Entry hanya jika pullback ke area demand dengan volume konfirmasi.'), 'Verdict must not be truncated');

  // Must have detailed section labels
  assert.ok(md.includes('**Candle & Pattern:**'), 'Must have Candle & Pattern section');
  assert.ok(md.includes('**Demand & Supply:**'), 'Must have Demand & Supply section');
  assert.ok(md.includes('**Volume:**'), 'Must have Volume section');
  assert.ok(md.includes('**Trend / Momentum:**'), 'Must have Trend / Momentum section');
  assert.ok(md.includes('**Potensi Setup:**'), 'Must have Potensi Setup section');
  assert.ok(md.includes('**Invalidation:**'), 'Must have Invalidation section');
  assert.ok(md.includes('**Watch Conditions:**'), 'Must have Watch Conditions section');
  assert.ok(md.includes('**Final Verdict:**'), 'Must have Final Verdict section');

  // Must include key levels
  assert.ok(md.includes('Entry 1 | 9400'), 'entry1 must appear');
  assert.ok(md.includes('Stop Loss | 9200'), 'stop_loss must appear');
  assert.ok(md.includes('TP1 | 9800'), 'tp1 must appear');

  // Must have disclaimer in Indonesian
  assert.ok(md.includes('bukan nasihat keuangan'), 'Disclaimer must be Indonesian');
});

test('writeSummaryMD does not truncate final_verdict or executive_summary', async () => {
  const dir = await tmpdir();
  const longVerdict = 'Ini adalah verdict yang sangat panjang untuk memastikan tidak ada pemotongan teks. ' +
    'Setup ini memerlukan konfirmasi volume dan candle pattern yang kuat sebelum entry. ' +
    'Jangan chase jika harga sudah naik lebih dari 5% dari area entry.';
  const results = [{
    ticker: 'GOTO', model: 'model-x', error: null,
    ai_result: {
      ticker: 'GOTO', model: 'model-x', bias: 'neutral', setup_type: 'watchlist',
      quality_score: 55, risk_level: 'High',
      executive_summary: longVerdict,
      technical_breakdown: { trend_view: 'Sideways tanpa arah jelas.', entry_view: 'Belum ada area entry yang aman.' },
      key_levels: {},
      final_verdict: longVerdict,
      not_financial_advice: true
    }
  }];
  const report = { total_tickers: 1, total_models: 1, total_jobs: 1, completed_jobs: 1, failed_jobs: 0, skipped_jobs: 0 };
  await runner.writeSummaryMD(dir, results, report);

  const md = await fs.readFile(path.join(dir, 'summary.md'), 'utf8');
  // Full verdict must appear without truncation
  assert.ok(md.includes(longVerdict), 'Long verdict must not be truncated');
  assert.ok(md.includes('Belum ada area entry yang aman'), 'entry_view must appear fully');
});



// ============================================================
// FIBONACCI CONTEXT-ONLY TESTS
// ============================================================

test('SYSTEM_PROMPT mentions Fibonacci as context-only (not dominant)', () => {
  assert.ok(runner.SYSTEM_PROMPT.includes('Fibonacci'), 'SYSTEM_PROMPT must mention Fibonacci');
  assert.ok(runner.SYSTEM_PROMPT.includes('konteks'), 'Must describe Fibonacci as context');
  assert.ok(
    runner.SYSTEM_PROMPT.includes('tidak boleh mendominasi') || runner.SYSTEM_PROMPT.includes('konteks pendukung'),
    'Must state Fibonacci should not dominate score'
  );
});

test('USER_PROMPT_TEMPLATE mentions Fibonacci as supporting context', () => {
  assert.ok(runner.USER_PROMPT_TEMPLATE.includes('Fibonacci'), 'USER_PROMPT must mention Fibonacci');
  assert.ok(runner.USER_PROMPT_TEMPLATE.includes('konteks pendukung'), 'Must describe as supporting context');
});

test('quality_score basis in prompt includes Fibonacci as supporting only', () => {
  // In the quality_score section of USER_PROMPT
  const qualitySection = runner.USER_PROMPT_TEMPLATE.slice(
    runner.USER_PROMPT_TEMPLATE.indexOf('quality_score'),
    runner.USER_PROMPT_TEMPLATE.indexOf('Skema JSON wajib')
  );
  assert.ok(qualitySection.includes('Fibonacci'), 'quality_score section must mention Fibonacci');
  assert.ok(qualitySection.includes('konteks pendukung'), 'quality_score section must say Fibonacci is supporting only');
});

test('writeSummaryMD includes Fibonacci / Retracement Context label when fib data exists', async () => {
  const dir = await tmpdir();
  const results = [{
    ticker: 'BBCA', model: 'test-model', error: null,
    deterministic_summary: {
      fib_confluence: 'Fib confluence sehat',
      fib_levels: { fib_382: 9400, fib_500: 9250, fib_618: 9100 }
    },
    ai_result: {
      ticker: 'BBCA', model: 'test-model', bias: 'bullish',
      setup_type: 'pullback', quality_score: 78, risk_level: 'Medium',
      executive_summary: 'Pullback ke area Fib sehat.',
      technical_breakdown: {
        trend_view: 'Uptrend.', momentum_view: 'RSI 55.', volume_view: 'Volume konfirmasi.',
        candle_structure_view: 'Hammer di area demand.', demand_support_view: 'Demand hold.',
        supply_resistance_view: 'Supply di 9800.', entry_view: 'Entry di area Fib 38.2-50%.',
        risk_reward_view: 'RR 2:1.'
      },
      key_levels: { entry1: 9400, stop_loss: 9100, tp1: 9800 },
      invalidations: ['Close < 9100.'], watch_conditions: ['Volume konfirmasi.'],
      final_verdict: 'Pullback sehat, entry di area Fib.',
      not_financial_advice: true
    }
  }];
  const report = { total_tickers: 1, total_models: 1, total_jobs: 1, completed_jobs: 1, failed_jobs: 0, skipped_jobs: 0 };
  await runner.writeSummaryMD(dir, results, report);

  const md = await fs.readFile(path.join(dir, 'summary.md'), 'utf8');
  assert.ok(md.includes('**Fibonacci / Retracement Context:**'), 'Must have Fibonacci section label');
  assert.ok(md.includes('Fib confluence sehat'), 'Must show fib_confluence value');
  assert.ok(md.includes('9400'), 'Must show fib_382 level');
  assert.ok(md.includes('9250'), 'Must show fib_500 level');
  assert.ok(md.includes('9100'), 'Must show fib_618 level');
});

test('writeSummaryMD omits Fibonacci label when no fib data in payload', async () => {
  const dir = await tmpdir();
  const results = [{
    ticker: 'GOTO', model: 'test-model', error: null,
    deterministic_summary: { fib_confluence: null, fib_levels: null },
    ai_result: {
      ticker: 'GOTO', model: 'test-model', bias: 'neutral',
      setup_type: 'watchlist', quality_score: 45, risk_level: 'High',
      executive_summary: 'Belum ada setup.', technical_breakdown: { entry_view: 'Tunggu.' },
      key_levels: {}, final_verdict: 'Hindari.', not_financial_advice: true
    }
  }];
  const report = { total_tickers: 1, total_models: 1, total_jobs: 1, completed_jobs: 1, failed_jobs: 0, skipped_jobs: 0 };
  await runner.writeSummaryMD(dir, results, report);

  const md = await fs.readFile(path.join(dir, 'summary.md'), 'utf8');
  assert.ok(!md.includes('**Fibonacci / Retracement Context:**'), 'Must NOT show Fibonacci label when no fib data');
});
