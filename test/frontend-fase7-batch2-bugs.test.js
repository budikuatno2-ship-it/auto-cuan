const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const Safety = require('../public/pattern-direction-safety.js');
const Screener = require('../public/pattern-screener-extension.js');
const Visual = require('../public/pattern-visual.js');

test('FRONTEND FASE 7 BATCH 2: Pattern Recognition & Direction Safety Bugs', async (t) => {

  await t.test('BUG-F7-007: labelDirection salah mengklasifikasikan Inverted Head and Shoulders sebagai BEARISH', () => {
    // Inverse/Inverted Head & Shoulders adalah pola bullish reversal klasik
    const dir = Safety.labelDirection('Inverted Head and Shoulders');
    assert.strictEqual(dir, 'bullish', 'Inverted Head and Shoulders harus bullish, bukan bearish!');
  });

  await t.test('BUG-F7-008: directionsCompatible meloloskan arah unknown tanpa pengamanan ketat', () => {
    // Jika salah satu arah tidak diketahui atau tidak konsisten, kompatibilitas harus false
    const compatible = Safety.directionsCompatible('unknown', 'bearish');
    assert.strictEqual(compatible, false, 'Arah unknown tidak boleh dianggap kompatibel secara otomatis');
  });

  await t.test('BUG-F7-009: rowsFromPayload mengabaikan payload bertipe Array langsung', () => {
    const rawArrayPayload = [
      { ticker: 'BBCA', pattern: 'Double Bottom' },
      { ticker: 'BBRI', pattern: 'Cup and Handle' }
    ];
    const rows = Screener.rowsFromPayload(rawArrayPayload);
    assert.ok(Array.isArray(rows) && rows.length === 2, 'rowsFromPayload harus bisa mengekstrak data dari array langsung');
  });

  await t.test('BUG-F7-010: buildPatternSvg menghasilkan atribut NaN saat rentang harga flat (high == low)', () => {
    const flatPoints = [
      { x: 10, y: 100 },
      { x: 50, y: 100 },
      { x: 90, y: 100 }
    ];
    const svg = Visual.buildPatternSvg({ points: flatPoints, minPrice: 100, maxPrice: 100, width: 200, height: 100 });
    assert.ok(typeof svg === 'string', 'SVG harus berupa string');
    assert.strictEqual(svg.includes('NaN'), false, 'SVG tidak boleh mengandung nilai koordinat NaN');
  });

});
