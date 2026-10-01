'use strict';
const BEGIN='# BEGIN AUTO-CUAN FINAL SCHEDULE', END='# END AUTO-CUAN FINAL SCHEDULE';
function reconcile(current,canonical) {
  if(!canonical.includes(BEGIN)||!canonical.includes(END)||!canonical.includes('CRON_TZ=Asia/Jakarta')) throw new Error('Invalid canonical cron schedule');
  const owned=new Set(['run-daily-broker-update.sh','run-daily-candles.sh','fetch-daily-candles.js','run-daily-broker-update.js','run-webhook-failover.sh']);
  for(const line of canonical.split(/\r?\n/)) {
    for(const match of line.matchAll(/\/home\/ubuntu\/auto-cuan\/((?:deploy\/vps|tools)\/[\w.-]+)/g)) owned.add(match[1].split('/').pop());
  }
  let inside=false;
  const kept=[];
  for(const line of current.split(/\r?\n/)) {
    if(line.startsWith(BEGIN)){inside=true;continue;}
    if(line.startsWith(END)){inside=false;continue;}
    if(inside)continue;
    const command=line.trim();
    if(!command.startsWith('#') && /\/home\/ubuntu\/auto-cuan\//.test(line) &&
      [...owned].some(name => line.includes('/'+name+' ') || line.endsWith('/'+name))) continue;
    kept.push(line);
  }
  if(inside)throw new Error('Unclosed managed cron block');
  return kept.join('\n').trimEnd()+'\n\n'+canonical.replace(/\r\n/g,'\n').trim()+'\n';
}
module.exports={reconcile};
if(require.main===module){const fs=require('fs');process.stdout.write(reconcile(fs.readFileSync(process.argv[2],'utf8'),fs.readFileSync(process.argv[3],'utf8')));}
