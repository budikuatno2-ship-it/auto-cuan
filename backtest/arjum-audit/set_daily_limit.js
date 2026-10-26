'use strict';
const fs = require('fs');

function setDailyLimit(envPath, limit) {
  if (!fs.existsSync(envPath)) return false;
  let content = fs.readFileSync(envPath, 'utf8');
  if (content.includes('ARJUM_DAILY_LIMIT=')) {
    content = content.replace(/ARJUM_DAILY_LIMIT=\d+/g, `ARJUM_DAILY_LIMIT=${limit}`);
  } else {
    content = content.trimEnd() + `\nARJUM_DAILY_LIMIT=${limit}\n`;
  }
  fs.writeFileSync(envPath, content, 'utf8');
  return true;
}

const r1 = setDailyLimit('/home/ubuntu/auto-cuan-runner/.env', 18080);
const r2 = setDailyLimit('/home/ubuntu/auto-cuan/.env', 18080);
console.log({ runnerUpdated: r1, repoUpdated: r2 });
