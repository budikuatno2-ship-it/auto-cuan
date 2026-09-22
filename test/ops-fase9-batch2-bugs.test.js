const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const serverPath = path.resolve(__dirname, '../tools/vps-api-server.js');
const serverContent = fs.readFileSync(serverPath, 'utf8');

test('OPS & DAEMONS FASE 9 BATCH 2: VPS API Server Security & Lifecycle Integrity', async (t) => {

  await t.test('BUG-OPS-006: vps-api-server wajib memiliki mekanisme autentikasi token / API key guard', () => {
    // Server di 0.0.0.0 dengan CORS '*' wajib memvalidasi token otentikasi
    const hasAuthCheck = /authorization|x-api-key|vps_secret|bearer/i.test(serverContent);
    assert.strictEqual(
      hasAuthCheck,
      true,
      'vps-api-server harus memverifikasi header Authorization atau API key sebelum melayani endpoint data internal'
    );
  });

  await t.test('BUG-OPS-007: vps-api-server wajib memiliki handler sinyal graceful shutdown (SIGTERM & SIGINT)', () => {
    // Daemon harus menangkap SIGTERM / SIGINT agar port dilepas bersih tanpa EADDRINUSE saat PM2 restart
    const handlesSigterm = /process\.on\(\s*['"]SIGTERM['"]/i.test(serverContent);
    const handlesSigint = /process\.on\(\s*['"]SIGINT['"]/i.test(serverContent);
    assert.strictEqual(
      handlesSigterm && handlesSigint,
      true,
      'vps-api-server wajib mengimplementasikan handler SIGTERM dan SIGINT untuk penutupan socket yang bersih'
    );
  });

});
