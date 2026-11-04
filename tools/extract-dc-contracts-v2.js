#!/usr/bin/env node
"use strict";
const fs = require('fs');
const path = require('path');

const BASE = process.cwd();
const DC_DIR = path.join(BASE, 'handoff-redesign', 'design', 'project');
const OUT = path.join(BASE, 'bukti-verifikasi-final', 'fase02', 'selisih-struktur-kanvas.json');
const PUBLIC_INDEX = path.join(BASE, 'public', 'index.html');
const PUBLIC_DIR = path.join(BASE, 'public');

function extractContract(html) {
  const c = {};

  // .ph page headings
  const phMatches = html.match(/class="ph"[^>]*>([^<]*)</g) || [];
  c.pageHeadings = phMatches.map(m => m.replace(/.*>([^<]*)<.*/, '$1').trim());

  // tab/segment/button labels
  const tabMatches = html.match(/class="[^"]*tab[^"]*"[^>]*>([^<]*)</g) || [];
  const segMatches = html.match(/class="[^"]*seg[^"]*"[^>]*>([^<]*)</g) || [];
  const btnMatches = html.match(/<button[^>]*>([^<]*)<\/button>/g) || [];
  c.tabs = tabMatches.map(m => m.replace(/.*>([^<]*)<.*/, '$1').trim()).filter(Boolean);
  c.segments = segMatches.map(m => m.replace(/.*>([^<]*)<.*/, '$1').trim()).filter(Boolean);
  c.buttons = btnMatches.map(m => m.replace(/<button[^>]*>([^<]*)<\/button>/, '$1').trim()).filter(Boolean);

  // table headers (th)
  const thMatches = html.match(/<th[^>]*>([^<]*)<\/th>/g) || [];
  c.tableHeaders = [...new Set(thMatches.map(m => m.replace(/<th[^>]*>([^<]*)<\/th>/, '$1').trim()).filter(Boolean))];

  // metric cards (class containing card, metric, angka, ringkasan)
  const cardMatches = html.match(/class="[^"]*(?:card|metric|angka|ringkasan)[^"]*"/g) || [];
  c.metricCards = cardMatches.length;

  // aria-labels
  const ariaMatches = html.match(/aria-label="([^"]*)"/g) || [];
  c.ariaLabels = ariaMatches.map(m => m.replace(/aria-label="([^"]*)"/, '$1'));

  // panel IDs (id="panel-...")
  const panelMatches = html.match(/id="panel-[^"]*"/g) || [];
  c.panelIds = panelMatches.map(m => m.replace(/id="(panel-[^"]*)"/, '$1'));

  // special components
  c.hasCanvas = /<canvas/i.test(html);
  c.hasSVG = /<svg/i.test(html);
  c.hasDetails = /<details/i.test(html);

  return c;
}

function extractPublicDOM(html) {
  const c = {};
  const phMatches = html.match(/class="[^"]*ph[^"]*"[^>]*>([^<]*)</g) || [];
  c.pageHeadings = phMatches.map(m => m.replace(/.*>([^<]*)<.*/, '$1').trim());

  const tabMatches = html.match(/class="[^"]*tab[^"]*"[^>]*>([^<]*)</g) || [];
  c.tabs = tabMatches.map(m => m.replace(/.*>([^<]*)<.*/, '$1').trim()).filter(Boolean);

  const btnMatches = html.match(/<button[^>]*>([^<]*)<\/button>/g) || [];
  c.buttons = btnMatches.map(m => m.replace(/<button[^>]*>([^<]*)<\/button>/, '$1').trim()).filter(Boolean);

  const panelMatches = html.match(/id="panel-[^"]*"/g) || [];
  c.panelIds = panelMatches.map(m => m.replace(/id="(panel-[^"]*)"/, '$1'));

  const thMatches = html.match(/<th[^>]*>([^<]*)<\/th>/g) || [];
  c.tableHeaders = [...new Set(thMatches.map(m => m.replace(/<th[^>]*>([^<]*)<\/th>/, '$1').trim()).filter(Boolean))];

  return c;
}

// Main
const dcFiles = fs.readdirSync(DC_DIR).filter(f => f.endsWith('.dc.html'));
const result = { meta: { dcFiles: dcFiles.length, checkedAt: new Date().toISOString() }, pages: {}, publicSummary: {} };

for (const f of dcFiles) {
  const name = f.replace('.dc.html', '');
  const html = fs.readFileSync(path.join(DC_DIR, f), 'utf8');
  result.pages[name] = extractContract(html);
}

// Parse public/index.html for comparison
if (fs.existsSync(PUBLIC_INDEX)) {
  const pubHtml = fs.readFileSync(PUBLIC_INDEX, 'utf8');
  result.publicSummary = extractPublicDOM(pubHtml);
  result.publicSummary.file = 'public/index.html';
  result.publicSummary.sizeBytes = pubHtml.length;
}

// Compare: find DC pages whose expected panels/tabs don't appear in public/index.html
result.diffs = [];
const pubPanelSet = new Set(result.publicSummary.panelIds || []);
const pubTabSet = new Set(result.publicSummary.tabs || []);

for (const [name, contract] of Object.entries(result.pages)) {
  const missingPanels = (contract.panelIds || []).filter(id => !pubPanelSet.has(id));
  const missingTabs = (contract.tabs || []).filter(t => !pubTabSet.has(t));
  if (missingPanels.length > 0 || missingTabs.length > 0) {
    result.diffs.push({ page: name, missingPanels, missingTabs, note: 'Expected elements from .dc.html not found in public/index.html' });
  }
}

// Also check if public has HTML files for each DC page
const publicFiles = fs.readdirSync(PUBLIC_DIR).filter(f => f.endsWith('.html'));
result.publicHtmlFiles = publicFiles;
result.missingPublicPages = [];
for (const f of dcFiles) {
  const name = f.replace('.dc.html', '');
  const expectedHtml = name + '.html';
  const found = publicFiles.some(pf => pf.toLowerCase() === expectedHtml.toLowerCase());
  if (!found && name !== 'Mobile' && name !== 'MobileScreener') {
    result.missingPublicPages.push({ dcPage: name, expectedFile: expectedHtml });
  }
}

fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log('Written to', OUT);
console.log('DC pages:', dcFiles.length);
console.log('Public HTML files:', publicFiles.length);
console.log('Structural diffs:', result.diffs.length);
console.log('Missing public pages:', result.missingPublicPages.length);