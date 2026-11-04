const fs = require('fs');

const f7 = fs.readFileSync('tools/fase7-verify-ui-tabs.js', 'utf8');
console.log(f7.slice(0, 1500));
