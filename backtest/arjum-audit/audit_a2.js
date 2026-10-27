'use strict';
const fs = require('fs');
const path = require('path');

const logPath = '/home/ubuntu/auto-cuan/data/arjum-data/_backfill/backfill-foreign.log';
if (fs.existsSync(logPath)) {
  const content = fs.readFileSync(logPath, 'utf8');
  const lines = content.split('\n');
  console.log('Total lines in backfill-foreign.log:', lines.length);
  
  // Find lines with timestamps or start/stop
  const headLines = lines.slice(0, 30);
  console.log('Head:');
  console.log(headLines.join('\n'));

  // Find when circuit breaker tripped
  const cbIndex = lines.findIndex(l => l.includes('CIRCUIT BREAKER'));
  console.log('Circuit breaker line index:', cbIndex);
  if (cbIndex >= 0) {
    console.log(lines.slice(Math.max(0, cbIndex - 5), cbIndex + 10).join('\n'));
  }
}
