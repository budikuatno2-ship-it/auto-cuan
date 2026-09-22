const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sectorScriptPath = path.resolve(__dirname, '../scripts/refresh-sector-hot.js');
const sectorScriptContent = fs.readFileSync(sectorScriptPath, 'utf8');

test('OPS & AUTOMATION FASE 9 BATCH 3: Sector Hot Refresher & Data Pipeline Exit Guarantees', async (t) => {

  await t.test('BUG-OPS-008: refresh-sector-hot tidak boleh menelan kegagalan upsert dan menandai status ok', () => {
    // Skrip tidak boleh mencetak error di console lalu tetap memanggil updateMeta(..., 'ok')
    const swallowsUpsertError = /if\s*\(\s*upsertMErr\s*\)\s*\{\s*console\.error\([^)]+\);\s*\}/i.test(sectorScriptContent);
    assert.strictEqual(
      swallowsUpsertError,
      false,
      'Kegagalan upsert member pada refresh-sector-hot wajib menggagalkan proses (throw/exit non-zero), bukan ditelan secara silent'
    );
  });

  await t.test('BUG-OPS-009: updateMeta tidak boleh menerima status "ok" tanpa verifikasi kegagalan parsial', () => {
    // Jika terdapat failedCount > 0 atau error upsert, updateMeta tidak boleh di-hardcode ke 'ok'
    const hardcodedOk = /updateMeta\([^)]*['"]ok['"]\s*,\s*['"]Refresh completed/i.test(sectorScriptContent);
    assert.strictEqual(
      hardcodedOk,
      false,
      'Metadata refresh sektor tidak boleh di-hardcode status ok ketika terdapat mutasi atau ticker yang gagal'
    );
  });

});
