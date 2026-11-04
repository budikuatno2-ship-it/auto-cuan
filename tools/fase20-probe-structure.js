#!/usr/bin/env node
'use strict';
// FASE 20 probe: discover real DOM ids (pages, modals, tabs) from public/index.html
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HTML = path.join(ROOT, 'public', 'index.html');
const html = fs.readFileSync(HTML, 'utf8');

function uniq(a) { return Array.from(new Set(a)); }

const pageIds = uniq((html.match(/id="page-[a-z0-9_-]+"/gi) || []).map(s => s.slice(4, -1)));
const modalIds = uniq((html.match(/id="[a-zA-Z0-9_-]*[Mm]odal[a-zA-Z0-9_-]*"/g) || []).map(s => s.slice(4, -1)));
const drawerIds = uniq((html.match(/id="[a-zA-Z0-9_-]*[Dd]rawer[a-zA-Z0-9_-]*"/g) || []).map(s => s.slice(4, -1)));
const tableIds = uniq((html.match(/<table[^>]*id="[a-zA-Z0-9_-]+"/g) || []).map(s => (s.match(/id="([^"]+)"/) || [])[1]).filter(Boolean));
const detailsAdv = uniq((html.match(/id="[a-zA-Z0-9_-]*[Aa]dv[a-zA-Z0-9_-]*"/g) || []).map(s => s.slice(4, -1)));

// Extract global function names that look like switch/toggle/open for tabs
const fnNames = uniq((html.match(/function\s+((?:switch|open|toggle|show|set)[A-Za-z0-9_]+)\s*\(/g) || [])
  .map(s => s.replace(/^function\s+/, '').replace(/\s*\($/, '')));

const out = {
  generatedAt: new Date().toISOString(),
  htmlBytes: html.length,
  counts: {
    pageIds: pageIds.length,
    modalIds: modalIds.length,
    drawerIds: drawerIds.length,
    tableIds: tableIds.length,
    functions: fnNames.length
  },
  pageIds: pageIds,
  modalIds: modalIds,
  drawerIds: drawerIds,
  tableIds: tableIds,
  advToolsIds: detailsAdv,
  switchFunctions: fnNames
};

const outPath = path.join(ROOT, 'tools', 'fase20-structure-probe.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

console.log('pageIds(' + pageIds.length + '):', pageIds.join(', '));
console.log('');
console.log('modalIds(' + modalIds.length + '):', modalIds.join(', '));
console.log('');
console.log('drawerIds(' + drawerIds.length + '):', drawerIds.join(', '));
console.log('');
console.log('switchFunctions(' + fnNames.length + '):', fnNames.join(', '));
console.log('');
console.log('tableIds(' + tableIds.length + '):', tableIds.slice(0, 40).join(', '));
console.log('');
console.log('Wrote', outPath);
