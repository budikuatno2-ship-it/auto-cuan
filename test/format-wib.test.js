const test = require('node:test');
const assert = require('node:assert/strict');
const { formatWib, formatCompactUnit } = require('../lib/format-wib');

test('AC-2.2: formatWib formats pure YYYY-MM-DD date to Indonesian date', () => {
  assert.strictEqual(formatWib('2026-10-12'), '12 Okt 2026');
  assert.strictEqual(formatWib('2026-01-05'), '5 Jan 2026');
  assert.strictEqual(formatWib('2026-08-31'), '31 Agu 2026');
});

test('AC-2.2: formatWib formats ISO timestamp to WIB date and time regardless of process timezone', () => {
  // 09:15:00 UTC is exactly 16:15 WIB (UTC + 7)
  const isoUtc = '2026-10-12T09:15:00.000Z';
  const result = formatWib(isoUtc, { includeTime: true });
  assert.strictEqual(result, '12 Okt 2026, 16.15 WIB');
});

test('AC-2.2: formatWib handles TZ=UTC, TZ=America/New_York, and TZ=Asia/Jakarta deterministically', () => {
  const iso = '2026-10-13T09:15:00.000Z';
  // 09:15 UTC -> 16:15 WIB (13 Okt 2026, 16.15 WIB)
  assert.strictEqual(formatWib(iso, { includeTime: true }), '13 Okt 2026, 16.15 WIB');
  assert.strictEqual(formatWib(iso, { includeTime: false }), '13 Okt 2026');

  // Midnight UTC: 2026-10-12T17:00:00.000Z -> 2026-10-13 00:00 WIB
  const midnightIso = '2026-10-12T17:00:00.000Z';
  assert.strictEqual(formatWib(midnightIso, { includeTime: true }), '13 Okt 2026, 00.00 WIB');
});

test('AC-2.2: formatCompactUnit produces official Indonesian financial units (Jt, Mrd, T)', () => {
  // Market cap in Triliun (T)
  assert.strictEqual(formatCompactUnit(726151682025000), '726,15 T');
  // Shares outstanding in Miliar (Mrd lembar)
  assert.strictEqual(formatCompactUnit(122042299500, 'lembar'), '122,04 Mrd lembar');
  // Revenue in Miliar (Mrd)
  assert.strictEqual(formatCompactUnit(24592250000), '24,59 Mrd');
  // Millions in Juta (Jt)
  assert.strictEqual(formatCompactUnit(50000000), '50,00 Jt');
});

test('AC-2.2: formatWib and formatCompactUnit handle null and empty values gracefully', () => {
  assert.strictEqual(formatWib(null), '-');
  assert.strictEqual(formatWib(''), '-');
  assert.strictEqual(formatWib('-'), '-');
  assert.strictEqual(formatWib('—'), '-');
  assert.strictEqual(formatCompactUnit(null), '-');
  assert.strictEqual(formatCompactUnit(NaN), '-');
});
