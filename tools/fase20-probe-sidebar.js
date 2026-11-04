#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

const re = /<button[^>]*id="nav-[a-z0-9_-]+"[^>]*>/gi;
const matches = html.match(re) || [];
console.log('SIDEBAR NAV BUTTONS (' + matches.length + ')');
for (const m of matches) {
  const id = (m.match(/id="([^"]+)"/) || [])[1];
  const page = (m.match(/data-sidebar-page="([^"]+)"/) || m.match(/data-page="([^"]+)"/) || [])[1];
  const label = (m.match(/data-label="([^"]+)"/) || [])[1];
  console.log('  ' + id + '  page=' + page + '  label=' + (label || ''));
}

// Simple text labels within nav buttons
const navBlock = html.match(/<nav[\s\S]{0,40000}?<\/nav>/i);
if (navBlock) {
  const texts = Array.from(navBlock[0].matchAll(/id="nav-([a-z0-9_-]+)"[\s\S]{0,400}?<\/button>/gi))
    .map(m => {
      const t = m[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      return m[1] + ' -> ' + t.slice(0, 70);
    });
  console.log('');
  console.log('NAV LABELS (' + texts.length + ')');
  texts.forEach(t => console.log('  ' + t));
}

// page-* containers and premium flags
const pageDivs = Array.from(html.matchAll(/<div[^>]*id="(page-[a-z0-9_-]+)"[^>]*>/gi))
  .map(m => ({ id: m[1], attrs: m[0] }));
console.log('');
console.log('PAGE CONTAINERS (' + pageDivs.length + ')');
for (const p of pageDivs) {
  const premium = /data-premium-page="true"/.test(p.attrs);
  console.log('  ' + p.id + (premium ? '  [PREMIUM]' : ''));
}
