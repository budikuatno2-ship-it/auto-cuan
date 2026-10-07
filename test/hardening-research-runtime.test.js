'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
test('embedded analysis template contains the Financial and market panels from the canonical partial', () => {
  const shell=fs.readFileSync('public/index.html','utf8');
  const embedded=shell.match(/<template id="tpl-analisis-saham">([\s\S]*?)<\/template>/)[1].trim();
  const canonical=fs.readFileSync('partials/analisis-saham.partial.html','utf8').trim();
  assert.equal(embedded,canonical);
  assert.match(embedded,/id="financialDataContent"/);
  assert.match(embedded,/id="marketStructureDataContent"/);
});
function runtime(fetch) {
  const elements = new Map();
  const document = { readyState: 'loading', addEventListener() {}, getElementById(id) {
    if (!elements.has(id)) elements.set(id, { textContent: '', hidden: false, value: '' });
    return elements.get(id);
  }};
  const window = { document, addEventListener() {}, localStorage: { getItem() {} } };
  vm.runInNewContext(fs.readFileSync('public/analisis-saham-runtime.js', 'utf8'), {window,document,fetch,console,setTimeout,clearTimeout,URL,Intl});
  return {window, get: id => document.getElementById(id)};
}
test('missing numeric research data stays unavailable, while real zero remains zero', async () => {
  const r = runtime(async () => ({ok:true,json:async () => ({success:true,snapshot:{fundamental:{pbv:null,market_cap:null,shares_outstanding:null,book_value_per_share:0}}})}));
  await r.window.loadFinancialStructureTab('financial','BBCA');
  assert.equal(r.get('financialMarketCap').textContent,'—');
  assert.equal(r.get('financialPbv').textContent,'—');
  assert.equal(r.get('financialShares').textContent,'—');
  assert.match(r.get('financialBvps').textContent,/0/);
});
test('older research response cannot replace newer ticker result', async () => {
  const pending=[];
  const r=runtime(() => new Promise(resolve=>pending.push(resolve)));
  const a=r.window.loadFinancialStructureTab('financial','BBCA');
  const b=r.window.loadFinancialStructureTab('financial','BBRI');
  pending[1]({ok:true,json:async()=>({success:true,snapshot:{fundamental:{pbv:2}}})}); await b;
  pending[0]({ok:true,json:async()=>({success:true,snapshot:{fundamental:{pbv:9}}})}); await a;
  assert.equal(r.get('financialPbv').textContent,'2x');
  assert.equal(r.get('financialTickerInput').value,'BBRI');
});
