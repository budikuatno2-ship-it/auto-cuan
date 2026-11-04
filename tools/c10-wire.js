'use strict';
// C10 wiring: sambungkan c10-hardening.css + c10-fetch-guard.js ke public/index.html (idempoten).
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'public', 'index.html');
let s = fs.readFileSync(p, 'utf8');
let changed = false;
if (!s.includes('c10-hardening.css')) {
  const anchor = '<link rel="stylesheet" href="/account-hardening.css';
  if (s.includes(anchor)) {
    s = s.replace(anchor, '<link rel="stylesheet" href="/c10-hardening.css?v=20261101-v1">\n' + anchor);
    changed = true;
  }
}
if (!s.includes('c10-fetch-guard.js')) {
  const anchor2 = '<script src="/lifecycle-polling-guard.js';
  if (s.includes(anchor2)) {
    s = s.replace(anchor2, '<script src="/c10-fetch-guard.js?v=20261101-v1" defer></script>\n' + anchor2);
    changed = true;
  }
}
if (changed) fs.writeFileSync(p, s);
console.log('wired css:', s.includes('c10-hardening.css'), 'guard:', s.includes('c10-fetch-guard.js'), 'changed:', changed);
