#!/usr/bin/env node
'use strict';
// FASE 20 probe: extract tab-group contracts so the capture script drives real UI
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

function grab(re, label) {
  const m = html.match(re);
  console.log('--- ' + label + ' ---');
  if (m) console.log(m[0].slice(0, 2200));
  else console.log('(not found)');
  console.log('');
}

grab(/const PROMOTED_ANALISIS_MAP\s*=\s*\{[\s\S]{0,900}?\};/, 'PROMOTED_ANALISIS_MAP');
grab(/var PROMOTED_ANALISIS_MAP\s*=\s*\{[\s\S]{0,900}?\};/, 'PROMOTED_ANALISIS_MAP (var)');

// portfolio tabs
grab(/function openPortfolioTab[\s\S]{0,1600}?\n\}/, 'openPortfolioTab');

// analisis tabs
grab(/function switchAnalisisTab[\s\S]{0,1600}?\n\}/, 'switchAnalisisTab');

// admin console tabs
grab(/function (switchAdminTab|showAdminTab|openAdminTab)[\s\S]{0,1600}?\n\}/, 'adminTabFn');

// find all data-tab attributes
const dataTabs = Array.from(new Set((html.match(/data-[a-z-]*tab="[a-z0-9_-]+"/gi) || [])));
console.log('--- data-*tab attributes (' + dataTabs.length + ') ---');
console.log(dataTabs.join('\n'));
console.log('');

// admin console tab ids
const adminTabIds = Array.from(new Set((html.match(/id="(?:admin|adm)[A-Za-z0-9_-]*[Tt]ab[A-Za-z0-9_-]*"/g) || [])));
console.log('--- admin tab ids (' + adminTabIds.length + ') ---');
console.log(adminTabIds.join('\n'));
console.log('');

// portfolio tab ids
const portTabIds = Array.from(new Set((html.match(/id="(?:port|portfolio)[A-Za-z0-9_-]*"/g) || [])));
console.log('--- portfolio ids (' + portTabIds.length + ') ---');
console.log(portTabIds.slice(0, 120).join('\n'));
console.log('');

// analisis tab ids
const anaTabIds = Array.from(new Set((html.match(/id="(?:ana|analisis)[A-Za-z0-9_-]*"/g) || [])));
console.log('--- analisis ids (' + anaTabIds.length + ') ---');
console.log(anaTabIds.slice(0, 120).join('\n'));
console.log('');

// bandarmologi tab ids
const bandTabs = Array.from(new Set((html.match(/id="(?:band|bandar)[A-Za-z0-9_-]*"/g) || [])));
console.log('--- bandarmologi ids (' + bandTabs.length + ') ---');
console.log(bandTabs.slice(0, 80).join('\n'));
