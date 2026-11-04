#!/usr/bin/env node
'use strict';
// FASE 20 precheck: env keys (names only), canvas reference files, external CDN references
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// 1. env key presence only (never print values)
const envPath = path.join(ROOT, '.env');
const envKeys = [];
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) envKeys.push(t.slice(0, i).trim());
  }
}
console.log('ENV KEYS (' + envKeys.length + '):', envKeys.join(', '));

// 2. canvas DC reference files
function walk(dir, out, depth) {
  if (depth > 3) return out;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, depth + 1);
    else if (/\.dc\.html$/i.test(e.name)) out.push(p);
  }
  return out;
}
const dcFiles = walk(ROOT, [], 0);
console.log('DC CANVAS FILES (' + dcFiles.length + ')');
dcFiles.slice(0, 40).forEach(f => console.log('  ' + path.relative(ROOT, f)));

// 3. external URLs referenced from public/*.html + public/*.js
const pubDir = path.join(ROOT, 'public');
const extHits = [];
function scanFile(p) {
  const src = fs.readFileSync(p, 'utf8');
  const re = /(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)["']|(?:fetch|import)\(\s*["'](https?:\/\/[^"']+)["']/g;
  let m;
  while ((m = re.exec(src))) {
    extHits.push({ file: path.relative(ROOT, p), url: m[1] || m[2] });
  }
}
for (const entry of fs.readdirSync(pubDir)) {
  if (/\.(html|js)$/i.test(entry)) scanFile(path.join(pubDir, entry));
}
const byHost = {};
for (const h of extHits) {
  let host = 'invalid';
  try { host = new URL(h.url).host; } catch (_) {}
  byHost[host] = byHost[host] || [];
  byHost[host].push(h);
}
console.log('EXTERNAL REFS total=' + extHits.length);
for (const [host, list] of Object.entries(byHost)) {
  console.log('  ' + host + ' x' + list.length + ' e.g. ' + list[0].file);
  list.slice(0, 5).forEach(x => console.log('      ' + x.url.slice(0, 140)));
}

// 4. which pages are declared premium/admin gated
const html = fs.readFileSync(path.join(pubDir, 'index.html'), 'utf8');
const dataPremium = Array.from(new Set((html.match(/data-premium-nav="true"[^>]*/g) || []))).length;
console.log('');
console.log('data-premium-nav count:', dataPremium);
