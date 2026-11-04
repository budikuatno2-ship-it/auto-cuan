const fs = require('fs');

const doc = fs.readFileSync('docs/redesign-handoff/HANDOFF_ANTIGRAVITY_REDESIGN_UIUX.md', 'utf8');
const lines = doc.split('\n');
lines.forEach((line, i) => {
  if (line.includes('4.3') || line.includes('19') || line.includes('Sidebar') || line.includes('Riset')) {
    console.log(`${i+1}: ${line}`);
  }
});
