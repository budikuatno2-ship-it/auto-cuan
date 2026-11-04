'use strict';
// Ekstraktor kontrak 28 kanvas G2 — murni regex Node.js, tanpa dep eksternal.
// Output: bukti-verifikasi-final/faseG2/kontrak-28-kanvas.json
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DC_DIR = path.join(ROOT, 'handoff-redesign', 'design', 'project');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'faseG2', 'kontrak-28-kanvas.json');

function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>')
    .replace(/"/g, '"').replace(/&#x27;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function dedupe(arr) {
  const out = [];
  const seen = new Set();
  for (const v of arr) {
    const k = String(v);
    if (!seen.has(k) && k) { seen.add(k); out.push(v); }
  }
  return out;
}
function allMatches(re, s) {
  const out = [];
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(s)) !== null) out.push(m);
  return out;
}

function extractJudul(html) {
  const t = allMatches(/<title>([^<]*)<\/title>/gi, html).map((m) => stripTags(m[1]));
  const h1All = allMatches(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, html).map((m) => stripTags(m[1]));
  const phBlocks = allMatches(/class="[^"]*\bph\b[^"]*"[^>]*>([\s\S]{0,2000}?)(?=<\/div>|<\/header>)/gi, html)
    .map((m) => stripTags(m[1]).slice(0, 160)).filter(Boolean);
  return { title: t[0] || '', h1: h1All, ph: dedupe(phBlocks).slice(0, 6) };
}

function extractTabs(html) {
  const tabs = allMatches(/role\s*=\s*["']tab["'][^>]*>([\s\S]*?)<\/\s*(button|a|span|div)\s*>/gi, html)
    .map((m) => stripTags(m[1])).filter((s) => s && s.length <= 60);
  const segmen = allMatches(/role\s*=\s*["']tablist["'][^>]*aria-label\s*=\s*"([^"]*)"/gi, html).map((m) => m[1].trim());
  const segCls = allMatches(/class="([^"]*\bseg\b[^"]*)"/gi, html).map((m) => m[1].trim()).slice(0, 4);
  return { tabs: dedupe(tabs), segmen, segCls };
}

function extractTombol(html) {
  const btns = allMatches(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi, html).map((m) => {
    const attrs = m[1] || '';
    const label = stripTags(m[2]).slice(0, 80);
    const aria = (attrs.match(/aria-label\s*=\s*"([^"]*)"/i) || [])[1] || '';
    return { label, aria: aria.trim() };
  }).filter((b) => b.label || b.aria);
  const links = allMatches(/<a\b[^>]*class="[^"]*\bbtn\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi, html)
    .map((m) => stripTags(m[1]).slice(0, 80)).filter(Boolean);
  return { tombol: dedupe(btns.map((b) => b.label || ('[aria] ' + b.aria))).slice(0, 40), tombolAria: dedupe(btns.map((b) => b.aria).filter(Boolean)), linkBtn: dedupe(links).slice(0, 10) };
}

function extractTabel(html) {
  const th = allMatches(/<th\b[^>]*>([\s\S]*?)<\/th>/gi, html).map((m) => stripTags(m[1])).filter((s) => s && s.length <= 80);
  const tables = (html.match(/<table\b/gi) || []).length;
  return { headerKolom: dedupe(th), jumlahTabel: tables };
}

function extractMetrik(html) {
  let count = 0;
  const strip = html.match(/class="[^"]*\bstrip\b[^"]*"[\s\S]*?(?=<div class="(?:prov|sheet|sec-h)")/i);
  let stripLbl = [];
  if (strip) {
    stripLbl = allMatches(/class="[^"]*\blbl\b[^"]*"[^>]*>([\s\S]*?)</gi, strip[0]).map((m) => stripTags(m[1])).filter(Boolean);
    count += (strip[0].match(/class="[^"]*\blbl\b[^"]*"/g) || []).length;
  }
  count += (html.match(/class="[^"]*(?:\bmetric-card\b|\bcard\b)[^"]*"/g) || []).length;
  count += (html.match(/class="[^"]*\bverdict\b[^"]*"/g) || []).length;
  count += (html.match(/class="[^"]*\bmini\b[^"]*"/g) || []).length;
  const kpi = allMatches(/class="[^"]*\b(kpi|stat|metric)\b[^"]*"[^>]*>([\s\S]{0,300}?)(?=<\/div>)/gi, html)
    .map((m) => stripTags(m[2]).slice(0, 100)).filter(Boolean).slice(0, 12);
  return { kartuMetrik: count, kartuLabel: dedupe(stripLbl).slice(0, 20), kpi: dedupe(kpi).slice(0, 12) };
}

function extractAria(html) {
  const labels = allMatches(/aria-label\s*=\s*"([^"]*)"/gi, html).map((m) => m[1].trim()).filter(Boolean);
  const roles = allMatches(/role\s*=\s*"([^"]*)"/gi, html).map((m) => m[1].trim()).filter(Boolean);
  return { ariaLabels: dedupe(labels), roles: dedupe(roles) };
}

function extractCss(html) {
  const cls = new Set();
  let m;
  const re = /class="([^"]*)"/g;
  while ((m = re.exec(html)) !== null) {
    for (const c of m[1].split(/\s+/)) {
      const t = c.trim();
      if (t && !/^\{\{/.test(t) && t.length <= 40) cls.add(t);
    }
  }
  const utama = [...cls].filter((c) => /^(app|main|page|ph|sheet|side|nav|top|tape|tbl|seg|btn|chip|card|strip|pane|mata|win|hero|sec|wrap|rk|ca|hrow|plan|ses|kv|gate|ladder|feat|mini|rule|cta|foot|lnav|prow|ptab|num|mut|pos|neg|mono|tk|th-s|on|sel|hd|r|x|d0|d1|rise)$/.test(c)
    || ['app', 'main', 'page', 'ph', 'sheet', 'side', 'nav', 'top', 'tape', 'tbl', 'seg', 'btn', 'chip', 'card', 'strip', 'pane', 'mata', 'win', 'hero', 'sec', 'wrap'].includes(c));
  return { cssUtama: dedupe(utama).sort().slice(0, 40), cssCount: cls.size };
}

function extractKhusus(html) {
  const k = [];
  if (/<canvas\b/i.test(html)) k.push('canvas');
  if (/<svg\b/i.test(html)) k.push('svg');
  if (/<details\b/i.test(html)) k.push('details');
  if (/<select\b/i.test(html)) k.push('select');
  if (/<input\b[^>]*type\s*=\s*["']date["']/i.test(html)) k.push('input[type=date]');
  if (/<input\b[^>]*type\s*=\s*["']checkbox["']/i.test(html)) k.push('input[type=checkbox]');
  if (/role\s*=\s*["']tablist["']/i.test(html)) k.push('tablist');
  if (/role\s*=\s*["']tab["']/i.test(html)) k.push('tab');
  if (/class="[^"]*\bvbar\b[^"]*"/i.test(html)) k.push('vbar');
  if (/sc-for/i.test(html)) k.push('sc-for');
  if (/sc-if/i.test(html)) k.push('sc-if');
  if (/class="[^"]*\bmata\b[^"]*"/i.test(html)) k.push('maskot-si-mata');
  if (/class="[^"]*\btilt\b[^"]*"/i.test(html)) k.push('tilt-3d');
  if (/class="[^"]*\bglare\b[^"]*"/i.test(html)) k.push('glare');
  if (/<table\b/i.test(html)) k.push('table');
  if (/data-mag/i.test(html)) k.push('data-mag');
  if (/IntersectionObserver/i.test(html)) k.push('intersection-observer');
  if (/requestAnimationFrame/i.test(html)) k.push('request-animation-frame');
  return dedupe(k);
}

function main() {
  const files = fs.readdirSync(DC_DIR).filter((f) => f.endsWith('.dc.html')).sort();
  const kanvas = files.map((f) => {
    const html = fs.readFileSync(path.join(DC_DIR, f), 'utf8');
    const j = extractJudul(html);
    const t = extractTabs(html);
    const b = extractTombol(html);
    const tb = extractTabel(html);
    const mk = extractMetrik(html);
    const ar = extractAria(html);
    const css = extractCss(html);
    const kh = extractKhusus(html);
    return {
      file: f,
      judulTitle: j.title,
      judulH1: j.h1,
      judulPh: j.ph,
      tabs: t.tabs,
      segmen: t.segmen,
      tombolAksi: b.tombol,
      tombolAria: b.tombolAria,
      linkBtn: b.linkBtn,
      headerKolom: tb.headerKolom,
      jumlahTabel: tb.jumlahTabel,
      kartuMetrik: mk.kartuMetrik,
      kartuLabel: mk.kartuLabel,
      kpi: mk.kpi,
      ariaLabels: ar.ariaLabels,
      roles: ar.roles,
      cssUtama: css.cssUtama,
      cssCount: css.cssCount,
      komponenKhusus: kh,
      bytes: html.length,
    };
  });
  const out = {
    generatedAt: new Date().toISOString(),
    branch: 'feat/daytrade-screener-v1',
    sumber: 'handoff-redesign/design/project/*.dc.html',
    total: kanvas.length,
    kanvas,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  let tt = 0, tb2 = 0, tc = 0, tm = 0, ta = 0;
  for (const k of kanvas) { tt += k.tabs.length; tb2 += k.tombolAksi.length; tc += k.headerKolom.length; tm += k.kartuMetrik; ta += k.ariaLabels.length; }
  console.log('kanvas=' + kanvas.length + ' tabs=' + tt + ' tombol=' + tb2 + ' kolom=' + tc + ' metrik=' + tm + ' aria=' + ta);
  console.log('written: ' + OUT);
}

if (require.main === module) main();
module.exports = { main, OUT, DC_DIR };
