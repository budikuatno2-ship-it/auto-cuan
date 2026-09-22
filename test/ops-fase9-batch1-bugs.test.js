const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const cronPath = path.resolve(__dirname, '../deploy/vps/final-schedule.cron');
const cronContent = fs.readFileSync(cronPath, 'utf8');

test('OPS & CRON FASE 9 BATCH 1: VPS Crontab Schedule & Runner Locking Integrity', async (t) => {

  await t.test('BUG-OPS-004: final-schedule.cron wajib memanggil wrapper script dengan proteksi flock, bukan bare node', () => {
    // Crontab tidak boleh memanggil bare node runner secara langsung karena mengabaikan flock & TZ guard
    const lines = cronContent.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));

    const bareNodeCalls = lines.filter(line => {
      return line.includes('/bin/node') && (
        line.includes('run-daily-afternoon-recap.js') ||
        line.includes('run-daily-broker-update.js')
      );
    });

    assert.strictEqual(
      bareNodeCalls.length === 0,
      true,
      'Semua job kritis di crontab wajib diarahkan ke .sh runner wrapper yang memiliki proteksi flock concurrency lock'
    );
  });

  await t.test('BUG-OPS-005: final-schedule.cron wajib menetapkan deklarasi CRON_TZ=Asia/Jakarta', () => {
    // Tanpa CRON_TZ, cron daemon VPS bersistem UTC akan mengeksekusi jam pasar modal secara keliru
    const hasCronTz = cronContent.includes('CRON_TZ=Asia/Jakarta') || cronContent.includes('TZ=Asia/Jakarta');
    assert.strictEqual(
      hasCronTz,
      true,
      'Crontab VPS wajib menyertakan CRON_TZ=Asia/Jakarta pada baris header file'
    );
  });

});
