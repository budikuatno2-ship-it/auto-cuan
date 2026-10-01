'use strict';

/**
 * Which number in a chat message is the stock's price.
 *
 * lib/analyze-legacy.js builds the deterministic Analisis Saham card from
 * `[Auto-Cuan Market Data]` that the browser appends. When the browser's quote
 * fetch fails that block is absent (public/index.html:5598 —
 * `if (quoteCtx) enrichedMsg += quoteCtx;`), and the server falls back to
 * reading a price out of the message text.
 *
 * The fallback must not treat any arbitrary number as the price. A lot count, a
 * year, or a percentage in the user's sentence is not what the stock trades at,
 * and accepting one both prints a wrong price and — because the server only
 * fetches its own authoritative quote when it still has no price — skips the
 * one source that would have produced a correct, fully-populated card.
 *
 * The browser already solves this properly in detectPrice()
 * (public/index.html:5199): it looks for a price that is LABELLED as one, or a
 * valid ticker immediately followed by a number. These tests hold the server to
 * the same standard.
 */

const test = require('node:test');
const assert = require('node:assert');

const analyze = require('../lib/analyze-legacy');
const { extractStatedPrice } = analyze.__test;

// --- The rule this replaces, applied literally, to document the defect -------

test('0. the old rule takes the first 2-6 digit number, whatever it means', () => {
  // lib/analyze-legacy.js used exactly this to decide the stock's price:
  //     var priceMatch = chatMessage.match(/\b(\d{2,6})\b/);
  const oldRule = (msg) => {
    const m = String(msg).match(/\b(\d{2,6})\b/);
    return m ? parseFloat(m[1]) : null;
  };
  assert.strictEqual(oldRule('beli 100 lot BBCA harga sekarang 9250'), 100,
    'the old rule read the lot count as BBCA price');
  assert.strictEqual(oldRule('BBCA gimana prospek 2026?'), 2026,
    'the old rule read a year as BBCA price');
  // And because a price was "found", the authoritative server quote was skipped.
  assert.notStrictEqual(oldRule('beli 100 lot BBCA harga sekarang 9250'), 9250);
});

// --- Numbers that are NOT the price -----------------------------------------

test('1. a lot count is not the price', () => {
  assert.strictEqual(
    extractStatedPrice('beli 100 lot BBCA harga sekarang 9250', 'BBCA'), 9250,
    'the labelled price must win over the lot count that appears earlier'
  );
});

test('2. a year is not the price', () => {
  assert.strictEqual(
    extractStatedPrice('BBCA gimana prospek 2026?', 'BBCA'), null,
    'a bare year must not be accepted as a price'
  );
});

test('3. a percentage is not the price', () => {
  assert.strictEqual(
    extractStatedPrice('BBCA sudah turun 12 persen, gimana?', 'BBCA'), null
  );
});

test('4. a lot count alone yields no price', () => {
  assert.strictEqual(
    extractStatedPrice('kalau saya masuk 200 lot gimana?', 'BBCA'), null,
    'without a labelled price the server must report none, so the authoritative quote is fetched'
  );
});

test('5. a timeframe is not the price', () => {
  assert.strictEqual(extractStatedPrice('BBCA di chart 15 menit gimana?', 'BBCA'), null);
});

// --- Numbers that ARE the price ---------------------------------------------

test('6. ticker immediately followed by a number', () => {
  assert.strictEqual(extractStatedPrice('BBCA 9250', 'BBCA'), 9250);
});

test('7. "harga sekarang" label', () => {
  assert.strictEqual(extractStatedPrice('BBCA harga sekarang 9250', 'BBCA'), 9250);
});

test('8. "harganya" label', () => {
  assert.strictEqual(extractStatedPrice('BBCA harganya 9250 ya', 'BBCA'), 9250);
});

test('9. "di harga" label', () => {
  assert.strictEqual(extractStatedPrice('saya masuk BBCA di harga 9250', 'BBCA'), 9250);
});

test('10. "Rp" prefix is tolerated', () => {
  assert.strictEqual(extractStatedPrice('BBCA harga sekarang Rp 9.250', 'BBCA'), 9250);
});

test('11. a message whose only number is the price', () => {
  assert.strictEqual(extractStatedPrice('BBCA 9250', 'BBCA'), 9250);
  assert.strictEqual(extractStatedPrice('9250', 'BBCA'), 9250);
});

test('12. a sole number alongside a lot count is NOT taken', () => {
  assert.strictEqual(
    extractStatedPrice('beli 100 lot', 'BBCA'), null,
    'two candidate readings and no label: the server must not guess'
  );
});

// --- Enrichment blocks must never be mined for a price -----------------------

test('13. the [Info: ...] block is not a price source', () => {
  assert.strictEqual(
    extractStatedPrice('BBCA gimana?\n[Info: BBCA = Bank Central Asia Tbk 1957]', 'BBCA'), null,
    'a number inside an appended enrichment block is not a stated price'
  );
});

test('14. an appended Auto-Cuan block is not a price source', () => {
  assert.strictEqual(
    extractStatedPrice('BBCA gimana?\n[Auto-Cuan Volume Intelligence]\nVolume Terakhir: 45123', 'BBCA'), null
  );
});

// --- Guard rails -------------------------------------------------------------

test('15. out-of-range and malformed values are rejected', () => {
  assert.strictEqual(extractStatedPrice('BBCA harga sekarang 0', 'BBCA'), null);
  assert.strictEqual(extractStatedPrice('BBCA harga sekarang 9999999', 'BBCA'), null);
  assert.strictEqual(extractStatedPrice('', 'BBCA'), null);
  assert.strictEqual(extractStatedPrice(null, null), null);
});

test('16. IHSG index levels are accepted on the same rules', () => {
  assert.strictEqual(extractStatedPrice('IHSG 7850', 'IHSG'), 7850);
  assert.strictEqual(
    extractStatedPrice('IHSG proyeksi 2026 gimana?', 'IHSG'), null,
    'a year in an IHSG question must not become the index level'
  );
});

test('17. thousands separators and decimals are told apart', () => {
  const { cleanStatedPrice } = analyze.__test;
  assert.strictEqual(cleanStatedPrice('9.250'), 9250, 'dot + exactly 3 digits is a thousands group');
  assert.strictEqual(cleanStatedPrice('9,250'), 9250, 'comma + exactly 3 digits is a thousands group');
  assert.strictEqual(cleanStatedPrice('7850.25'), 7850.25, 'dot + 2 digits is a decimal part');
  assert.strictEqual(cleanStatedPrice('7.850,25'), 7850.25, 'Indonesian format: dot thousands, comma decimal');
  assert.strictEqual(cleanStatedPrice('1.234.567'), null, 'above the accepted range');
  assert.strictEqual(cleanStatedPrice('58'), 58);
});

test('18. an IHSG level with decimals survives extraction', () => {
  assert.strictEqual(extractStatedPrice('IHSG 7.850,25', 'IHSG'), 7850.25);
  assert.strictEqual(extractStatedPrice('IHSG harga sekarang 7850.25', 'IHSG'), 7850.25);
});
