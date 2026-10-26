'use strict';
const fs = require('fs');

function checkEnv(envFile) {
  if (!fs.existsSync(envFile)) return null;
  const lines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/);
  const found = [];
  for (const l of lines) {
    const trimmed = l.trim();
    if (trimmed.startsWith('ARJUM_DAILY_LIMIT=') || trimmed.startsWith('ARJUM_DAILY_QUOTA=')) {
      found.push(trimmed.split('=')[0] + '=' + trimmed.split('=')[1]);
    }
  }
  return found;
}

console.log('runner .env:', checkEnv('/home/ubuntu/auto-cuan-runner/.env'));
console.log('repo .env:', checkEnv('/home/ubuntu/auto-cuan/.env'));
console.log('repo .env.local:', checkEnv('/home/ubuntu/auto-cuan/.env.local'));
