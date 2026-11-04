// extract-dc-lib.js — shared extraction logic for DC kanvas contracts
"use strict";

function stripTags(s) {
  return String(s||'').replace(/<[^>]*>/g, '').replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>').replace(/"/g, '"').replace(/&#x27;/g, "'").replace(/&nbsp;/g, ' ').trim();
}

function dedupe(arr) { return [...new Set(arr)]; }

function extractTitle(html) {
  const m = html.match(/<title>([^<]*)<\/title>/i);
  return m ? stripTags(m[1]) : '';
}

function extractH1(html) {
  let m = html.match(/class="ph"[^>]*>[\s\S]*?<h1[^>]*>([^<]*)<\/h1>/i);
  if (m) return stripTags(m[1]);
  m = html.match(/<h1[^>]*>([^<]*)<\/h1>/i);
  return m ? stripTags(m[1]) : '';
}

function extractTabs(html) {
  const tabs = [];
  const re = /role\s*=\s*["']tab["'][^>]*>([\s\S]*?)<\/[^>]+>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const label = stripTags(m[1]);
    if (label && label.length < 60) tabs.push(label);
  }
  return dedupe(tabs);
}

function extractButtons(html) {
  const labels = [];
  const btnRe = /<button\b[^>]*>([\s\S]*?)<\/button>/gi;
  let m;
  while ((m = btnRe.exec(html)) !== null) {
    const inner = stripTags(m[1]);
    if (inner && inner.length < 120) labels.push(inner);
  }
  return dedupe(labels);
}

function extractTableHeaders(html) {
  const hdrs = [];
  const re = /<th\b[^>]*>([\s\S]*?)<\/th>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const label = stripTags(m[1]);
    if (label && label.length < 80) hdrs.push(label);
  }
  return dedupe(hdrs);
}

function countMetricCards(html) {
  let count = 0;
  const stripMatch = html.match(/class="[^"]*\bstrip\b[^"]*"[\s\S]*?(?=<div class="(?:prov|sheet|sec-h)")/i);
  if (stripMatch) {
    count += (stripMatch[0].match(/class="[^"]*\blbl\b[^"]*"/g) || []).length;
  }
  count += (html.match(/class="[^"]*(?:\bcard\b|\bmetric-card\b)[^"]*"/g) || []).length;
  count += (html.match(/class="[^"]*\bverdict\b[^"]*"/g) || []).length;
  count += (html.match(/class="[^"]*\bmini\b[^"]*"/g) || []).length;
  return count;
}

function extractAriaLabels(html) {
  const labels = [];
  const re = /aria-label\s*=\s*"([^"]*)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[1].trim()) labels.push(m[1].trim());
  }
  return dedupe(labels);
}

function detectKomponenKhusus(html) {
  const komp = [];
  if (/<canvas\b/i.test(html)) komp.push('canvas');
  if (/<svg\b/i.test(html)) komp.push('svg');
  if (/<details\b/i.test(html)) komp.push('details');
  if (/<select\b/i.test(html)) komp.push('select');
  if (/<input\b[^>]*type\s*=\s*["']date["']/i.test(html)) komp.push('input[type=date]');
  if (/<input\b[^>]*type\s*=\s*["']checkbox["']/i.test(html)) komp.push('input[type=checkbox]');
  if (/role\s*=\s*["']tablist["']/i.test(html)) komp.push('tablist');
  if (/class="[^"]*\bvbar\b[^"]*"/i.test(html)) komp.push('vbar');
  if (/class="[^"]*\bdiv\b[^"]*"[^>]*style/i.test(html)) komp.push('div-chart');
  if (/sc-for/i.test(html)) komp.push('sc-for');
  if (/sc-if/i.test(html)) komp.push('sc-if');
  if (/class="[^"]*\bana-ctx\b[^"]*"/i.test(html)) komp.push('ana-ctx');
  return komp;
}

function extractPageContract(html, filename) {
  return {
    file: filename,
    judul: extractH1(html) || extractTitle(html),
    tab: extractTabs(html),
    tombol: extractButtons(html),
    kolom_tabel: extractTableHeaders(html),
    kartu_metrik: countMetricCards(html),
    aria_labels: extractAriaLabels(html),
    komponen_khusus: detectKomponenKhusus(html)
  };
}

// export for Node.js require()
module.exports = { extractPageContract, extractTabs, extractButtons, extractTableHeaders, countMetricCards, extractAriaLabels, detectKomponenKhusus, extractH1, extractTitle };