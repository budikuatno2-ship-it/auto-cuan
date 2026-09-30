'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

test('VPS backup keeps live data intact and only prunes backup snapshots', () => {
  const script = fs.readFileSync(path.join(ROOT, 'deploy/vps/backup-auto-cuan-data.sh'), 'utf8');

  assert.match(script, /AUTO_CUAN_ROOT:-\/home\/ubuntu\/auto-cuan/);
  assert.match(script, /AUTO_CUAN_DATA_ROOT:-\/home\/ubuntu\/auto-cuan-data/);
  assert.match(script, /AUTO_CUAN_BACKUP_KEEP_SNAPSHOTS:-14/);
  assert.match(script, /rsync -aH --delete --numeric-ids/);
  assert.match(script, /--link-dest=/);
  assert.match(script, /repo-data/);
  assert.match(script, /vps-data/);
  assert.match(script, /KEEP_SNAPSHOTS \+ 1/);
  assert.doesNotMatch(script, /find .*ROOT.*data.*-delete/);
  assert.doesNotMatch(script, /rm -rf -- .*ROOT.*data/);
});

test('VPS backup covers canonical historical market-data roots', () => {
  const script = fs.readFileSync(path.join(ROOT, 'deploy/vps/backup-auto-cuan-data.sh'), 'utf8');
  for (const expected of [
    'data/daily-candles',
    'data/arjum-data/broker-summary',
    'data/market-structure',
    'data/insider-network',
    'data/reports',
    'data/screener-latest.json'
  ]) assert.equal(script.includes(expected), true, 'missing backup inventory path: ' + expected);
});

test('nightly installer schedules backup outside market hours', () => {
  const script = fs.readFileSync(path.join(ROOT, 'deploy/vps/install-data-backup-cron.sh'), 'utf8');
  assert.match(script, /CRON_TZ=Asia\/Jakarta/);
  assert.match(script, /30 1 \* \* \*/);
  assert.match(script, /backup-auto-cuan-data\.sh/);
});

test('Windows offline puller is D-drive only and keeps weekly snapshots', () => {
  const script = fs.readFileSync(path.join(ROOT, 'deploy/windows/pull-vps-backup-to-d.ps1'), 'utf8');
  assert.equal(script.includes('D:\\\\AutoCuan-Backup'), true);
  assert.match(script, /Drive D: tidak tersedia/);
  assert.match(script, /KeepWeekly = 26/);
  assert.match(script, /OFFLINE_BACKUP_OK\.txt/);
  assert.equal(script.includes('C:\\\\'), false);
});

test('backup documentation explicitly preserves 2020-to-current source history', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs/VPS_DATA_BACKUP.md'), 'utf8');
  assert.match(doc, /Candle 2020-sekarang/);
  assert.match(doc, /broker summary historis/);
  assert.match(doc, /Retensi hanya menghapus snapshot backup lama, tidak pernah menghapus data asli/);
  assert.equal(doc.includes('D:\\AutoCuan-Backup'), true);
});
