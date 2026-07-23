'use strict';

/**
 * Intraday Collector VPS Audit tests
 * ==================================
 *
 * Verifies the pure audit rules that back the safe, idempotent VPS verification
 * tool: missing-flag detection, duplicate-cron detection, idempotent install /
 * repair, Telegram-disabled enforcement, exact 21+1 schedule counts, and
 * preservation of unrelated crontab entries.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const audit = require('../lib/intraday-collector-vps-audit');

test('15. collector audit detects missing flags', () => {
  const runner = audit.buildRunnerScript();
  // Remove one required flag line.
  const broken = runner.replace('export TELEGRAM_ENABLED=0\n', '');
  const r = audit.auditRunnerScript(broken, { exists: true, executable: true });
  assert.equal(r.ok, false);
  assert.ok(r.missing_flags.indexOf('TELEGRAM_ENABLED') >= 0);
  // A different missing flag is also caught.
  const broken2 = runner.replace('export TRADE_PLAN_V2_SHADOW_ENABLED=true\n', '');
  const r2 = audit.auditRunnerScript(broken2, { exists: true, executable: true });
  assert.ok(r2.missing_flags.indexOf('TRADE_PLAN_V2_SHADOW_ENABLED') >= 0);
});

test('15b. collector audit detects a wrong flag value', () => {
  const runner = audit.buildRunnerScript().replace(
    'export TRADE_PLAN_V2_PUBLIC_ENABLED=false',
    'export TRADE_PLAN_V2_PUBLIC_ENABLED=true');
  const r = audit.auditRunnerScript(runner, { exists: true, executable: true });
  assert.equal(r.ok, false);
  assert.ok(r.wrong_flags.some((w) => /TRADE_PLAN_V2_PUBLIC_ENABLED/.test(w)));
});

test('16. collector audit detects duplicate cron entries', () => {
  const clean = audit.computeDesiredCrontab('');
  const c1 = audit.auditCrontab(clean);
  assert.equal(c1.ok, true);
  assert.equal(c1.collection_count, 21);
  assert.equal(c1.cleanup_count, 1);
  assert.equal(c1.has_no_duplicates, true);
  // Inject a duplicate collection line.
  const dup = clean + audit.buildCollectionLine('09:15') + '\n';
  const c2 = audit.auditCrontab(dup);
  assert.equal(c2.ok, false);
  assert.equal(c2.has_no_duplicates, false);
  assert.ok(c2.duplicates.indexOf('09:15') >= 0);
  assert.equal(c2.collection_count, 22);
});

test('16b. collector audit detects a duplicated cleanup schedule', () => {
  const dup = audit.computeDesiredCrontab('') + audit.buildCleanupLine() + '\n';
  const c = audit.auditCrontab(dup);
  assert.equal(c.cleanup_count, 2);
  assert.equal(c.ok, false);
});

test('17. collector installer/repair remains idempotent and preserves unrelated entries', () => {
  const existing = '# unrelated backup job\n0 3 * * * /usr/bin/backup.sh\nSHELL=/bin/bash\n';
  const first = audit.computeDesiredCrontab(existing);
  const second = audit.computeDesiredCrontab(first);
  assert.equal(first, second, 'install must be idempotent');
  // Unrelated entries are preserved verbatim.
  assert.ok(first.indexOf('# unrelated backup job') >= 0);
  assert.ok(first.indexOf('/usr/bin/backup.sh') >= 0);
  assert.ok(first.indexOf('SHELL=/bin/bash') >= 0);
  // Exactly one managed block regardless of repeated application.
  const a = audit.auditCrontab(second);
  assert.equal(a.collection_count, 21);
  assert.equal(a.cleanup_count, 1);
  assert.equal(a.ok, true);
  // Re-running against an ALREADY-installed (and duplicated) crontab repairs it
  // back to exactly 21 + 1 with no duplicates.
  const messy = first + audit.buildCollectionLine('10:00') + '\n' + audit.buildCleanupLine() + '\n';
  const repaired = audit.computeDesiredCrontab(messy);
  const ra = audit.auditCrontab(repaired);
  assert.equal(ra.collection_count, 21);
  assert.equal(ra.cleanup_count, 1);
  assert.equal(ra.has_no_duplicates, true);
});

test('18. Telegram remains disabled in the experimental collector runner', () => {
  const runner = audit.buildRunnerScript();
  const r = audit.auditRunnerScript(runner, { exists: true, executable: true });
  assert.equal(r.telegram_disabled, true);
  assert.equal(r.flag_values.TELEGRAM_ENABLED, '0');
  // And it cannot mutate scoring / Supabase, and keeps public V2 off.
  assert.equal(r.mutation_disabled, true);
  assert.equal(r.score_disabled, true);
  assert.equal(r.public_disabled, true);
  // It genuinely uses Node 22 and self-cleans at 16:10.
  assert.equal(r.node22, true);
  assert.equal(r.has_self_cleanup, true);
  assert.equal(r.ok, true);
});

test('18b. the generated runner + fresh crontab pass a full audit together', () => {
  const runner = audit.buildRunnerScript();
  const cron = audit.computeDesiredCrontab('');
  assert.equal(audit.auditRunnerScript(runner, { exists: true, executable: true }).ok, true);
  assert.equal(audit.auditCrontab(cron).ok, true);
  // The cleanup line targets 16:10 WIB.
  assert.ok(cron.indexOf('10 16 * * *') >= 0, 'cleanup must be scheduled at 16:10');
});
