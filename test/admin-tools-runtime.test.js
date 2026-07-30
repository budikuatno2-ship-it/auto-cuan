'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const runtime = require('../public/admin-tools-runtime');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('security setup guide reports every missing production dependency without secrets', () => {
  const steps = runtime.securityMissingSteps([
    'MODE OFF',
    'DATABASE BELUM SIAP',
    'PEPPER BELUM ADA',
    'ALERT BELUM SIAP',
    'ADMIN FAIL-OPEN'
  ].join(' '));

  assert.deepEqual(steps.map(step => step.key), ['database', 'pepper', 'mode', 'admin', 'alert']);
  assert.match(runtime.guideHtml(steps), /security-phase-1-migration\.sql/);
  assert.match(runtime.guideHtml(steps), /SECURITY_EVENT_PEPPER/);
  assert.match(runtime.guideHtml(steps), /SECURITY_GUARD_MODE=shadow/);
  assert.doesNotMatch(runtime.guideHtml(steps), /password\s*=|token\s*=|pepper\s*=/i);
});

test('ready Security Center produces no setup warnings', () => {
  const steps = runtime.securityMissingSteps('MODE ENFORCE DATABASE SIAP PEPPER SIAP ALERT TELEGRAM SIAP ADMIN FAIL-CLOSED');
  assert.deepEqual(steps, []);
});

test('admin runtime adds a direct Foreign Data entry and stays UI-only', () => {
  const source = read('public/admin-tools-runtime.js');
  const loader = read('public/assets/fca-stocks.js');
  new vm.Script(source, { filename:'admin-tools-runtime.js' });

  assert.match(source, /data-admin-foreign-button/);
  assert.match(source, /Foreign Data/);
  assert.match(source, /location\.assign\('\/admin-foreign\.html'\)/);
  assert.match(loader, /admin-tools-runtime\.js\?v=20260731-admin-tools-v1/);
  assert.ok(loader.indexOf('/security-admin-runtime.js') < loader.indexOf('/admin-tools-runtime.js'));
  assert.doesNotMatch(source, /fetch\(|supabase|sendTelegram|createOrder|CRON_SECRET|service_role/i);
});
