'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {reconcile}=require('../lib/cron-reconcile');
test('canonical schedule replaces stale owned entries and preserves unrelated jobs',()=>{
 const current='MAILTO=ops@example.com\n0 2 * * * /opt/backup.sh\n0 20 * * * /home/ubuntu/auto-cuan/deploy/vps/run-daily-broker-update.sh --final\n*/10 * * * * /home/ubuntu/auto-cuan/deploy/vps/run-webhook-failover.sh\n';
 const canonical='# BEGIN AUTO-CUAN FINAL SCHEDULE\nCRON_TZ=Asia/Jakarta\n0,30 * * * * bash /home/ubuntu/auto-cuan/deploy/vps/run-daily-market-update.sh\n# END AUTO-CUAN FINAL SCHEDULE\n';
 const result=reconcile(current,canonical);
 assert.match(result,/\/opt\/backup.sh/);assert.match(result,/MAILTO/);
 assert.doesNotMatch(result,/run-daily-broker-update|run-webhook-failover/);
 assert.equal(result.split('run-daily-market-update').length,2);
 assert.equal(reconcile(result,canonical),result);
});
