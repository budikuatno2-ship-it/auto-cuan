'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const foreignFlowService = require('../lib/foreign-flow-recap');
const runner = require('../tools/run-foreign-top10-recap');

test('isForeignBroker identifies Indonesian foreign institutional brokers', () => {
  assert.equal(foreignFlowService.isForeignBroker('AK'), true, 'AK UBS is foreign');
  assert.equal(foreignFlowService.isForeignBroker('BK'), true, 'BK JP Morgan is foreign');
  assert.equal(foreignFlowService.isForeignBroker('RX'), true, 'RX Macquarie is foreign');
  assert.equal(foreignFlowService.isForeignBroker('CS'), true, 'CS Credit Suisse is foreign');
  assert.equal(foreignFlowService.isForeignBroker('KZ'), true, 'KZ CLSA is foreign');
  assert.equal(foreignFlowService.isForeignBroker('ZP'), true, 'ZP Maybank is foreign');
  assert.equal(foreignFlowService.isForeignBroker('YU'), true, 'YU CGS is foreign');

  // Domestic brokers
  assert.equal(foreignFlowService.isForeignBroker('CC'), false, 'CC Mandiri is domestic');
  assert.equal(foreignFlowService.isForeignBroker('NI'), false, 'NI BNI is domestic');
  assert.equal(foreignFlowService.isForeignBroker('PD'), false, 'PD Indo Premier is domestic');
  assert.equal(foreignFlowService.isForeignBroker('XC'), false, 'XC Ajaib is domestic');
  assert.equal(foreignFlowService.isForeignBroker('MG'), false, 'MG Semesta is domestic');
  assert.equal(foreignFlowService.isForeignBroker(''), false);
  assert.equal(foreignFlowService.isForeignBroker(null), false);
});

test('formatForeignFlowRecapMessage generates clean valid HTML for Telegram', () => {
  const sampleData = {
    date: '2026-09-04',
    total_net_foreign: 125400000000,
    stocks_scanned: 957,
    top_accumulated: [
      { ticker: 'BBCA', net_val: 85000000000, top_foreign_brokers: ['AK', 'BK', 'RX'] },
      { ticker: 'BBRI', net_val: 55000000000, top_foreign_brokers: ['KZ', 'ZP'] }
    ],
    top_distributed: [
      { ticker: 'ASII', net_val: -32000000000, top_foreign_brokers: ['CS', 'AK'] },
      { ticker: 'TLKM', net_val: -18000000000, top_foreign_brokers: ['BK'] }
    ]
  };

  const msg = foreignFlowService.formatForeignFlowRecapMessage(sampleData);
  assert.ok(msg.includes('REKAP TOP 10 FOREIGN FLOW HARIAN'));
  assert.ok(msg.includes('BBCA'));
  assert.ok(msg.includes('+Rp 85.00 M'));
  assert.ok(msg.includes('AK, BK, RX'));
  assert.ok(msg.includes('ASII'));
  assert.ok(msg.includes('-Rp 32.00 M'));
  assert.ok(msg.includes('Total Net Foreign IDX:'));
  assert.ok(msg.includes('NET BUY'));
});

test('runner parseArgs parses dry-run, send, date, and chat-id flags correctly', () => {
  const args1 = runner.parseArgs(['--send', '--date=2026-09-04', '--chat-id=-10012345']);
  assert.equal(args1.send, true);
  assert.equal(args1.dryRun, false);
  assert.equal(args1.date, '2026-09-04');
  assert.equal(args1.chatId, '-10012345');

  const args2 = runner.parseArgs(['--dry-run']);
  assert.equal(args2.send, false);
  assert.equal(args2.dryRun, true);
});

test('computeForeignFlowRecap handles empty/missing disk data gracefully', () => {
  const recap = foreignFlowService.computeForeignFlowRecap({
    date: '1990-01-01', // Non-existent date
    tickers: ['DUMMY1', 'DUMMY2']
  });
  assert.equal(recap.total_net_foreign, 0);
  assert.equal(recap.top_accumulated.length, 0);
  assert.equal(recap.top_distributed.length, 0);
  assert.equal(recap.stocks_scanned, 0);
});
