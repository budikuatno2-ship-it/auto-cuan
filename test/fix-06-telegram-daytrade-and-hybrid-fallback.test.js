'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const botModule = require('../lib/telegram-interactive-bot.js');

test('FIX-06: MARKET_COMMANDS includes "daytrade" and "dt" and parses correctly', () => {
  assert.ok(botModule.MARKET_COMMANDS.has('daytrade'), 'MARKET_COMMANDS must include "daytrade"');
  assert.ok(botModule.MARKET_COMMANDS.has('dt'), 'MARKET_COMMANDS must include "dt"');

  const cmdDt1 = botModule.parseCommand('/daytrade');
  assert.equal(cmdDt1.command, 'daytrade');

  const cmdDt2 = botModule.parseCommand('/dt');
  assert.equal(cmdDt2.command, 'dt');
});

test('FIX-06: formatScanCard handles "daytrade", "konglo", and "nonkonglo" modes', () => {
  assert.equal(typeof botModule.formatScanCard, 'function', 'formatScanCard must be exported');

  const snapshot = {
    daytrade: [{ ticker: 'BBCA', unified_score: 85 }],
    swing: [{ ticker: 'ASII', unified_score: 78 }],
    swing_konglo: [{ ticker: 'ASII', unified_score: 78 }],
    swing_non_konglo: [{ ticker: 'BRIS', unified_score: 80 }],
    missing: false
  };

  const dayCard = botModule.formatScanCard(snapshot, 'daytrade');
  assert.match(dayCard, /BBCA/);
  assert.match(dayCard, /85/);

  const kongloCard = botModule.formatScanCard(snapshot, 'konglo');
  assert.match(kongloCard, /ASII/);

  const nonKongloCard = botModule.formatScanCard(snapshot, 'nonkonglo');
  assert.match(nonKongloCard, /BRIS/);
});

test('FIX-06: loadScreenerWithHybridFallback recovers from database when file is missing', async () => {
  assert.equal(typeof botModule.loadScreenerWithHybridFallback, 'function', 'loadScreenerWithHybridFallback must be exported');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-screener-fallback-'));
  const missingFilePath = path.join(tmpDir, 'screener-latest.json');

  const mockDb = {
    from: (table) => ({
      select: () => ({
        limit: async () => {
          if (table === 'daytrade_screener_latest') {
            return { data: [{ ticker: 'BBRI', unified_score: 90 }] };
          }
          if (table === 'swing_screener_latest') {
            return { data: [{ ticker: 'BMRI', unified_score: 88 }] };
          }
          if (table === 'swing_screener_non_konglo_latest') {
            return { data: [{ ticker: 'BREN', unified_score: 82 }] };
          }
          return { data: [] };
        }
      })
    })
  };

  const recovered = await botModule.loadScreenerWithHybridFallback(missingFilePath, mockDb);
  assert.equal(recovered.missing, false);
  assert.equal(recovered.daytrade.length, 1);
  assert.equal(recovered.daytrade[0].ticker, 'BBRI');
  assert.equal(recovered.swing_konglo[0].ticker, 'BMRI');
  assert.equal(recovered.swing_non_konglo[0].ticker, 'BREN');

  // Verify file was written to disk
  assert.ok(fs.existsSync(missingFilePath), 'Fallback should materialize snapshot file on disk');
  const diskData = JSON.parse(fs.readFileSync(missingFilePath, 'utf8'));
  assert.equal(diskData.daytrade[0].ticker, 'BBRI');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
