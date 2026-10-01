'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../public/money-sheet-model');
const handler = require('../lib/money-sheet-handler');
const P = require('../public/portfolio-command-center-model');
const sample = () => M.fromLegacy({ income_salary:12000000, income_side:2000000, expense_necessities:4500000, expense_wants:1500000, savings_emergency:2000000, trading_capital_allocation:1000000 });
const read = p => fs.readFileSync(path.join(__dirname,'..',p),'utf8');

test('integer rupiah parsing accepts explicit zero and Indonesian thousands', () => {
  for (const [raw,value] of [[0,0],['',0],['0012',12],['Rp 1.500.000',1500000],['1.500.000,00',1500000],['25000,00',25000]]) assert.equal(M.amount(raw),value);
});
for (const value of [null,undefined,true,false,[],{},-1,'-5','1.5','1,50','1e9','1,000,000','=1+2',NaN,Infinity,1000000000001]) test('rejects ambiguous/unsafe amount: '+String(value),()=>assert.throws(()=>M.amount(value)));
test('legacy values and totals are preserved exactly',()=>{
 const s=sample(); assert.equal(s.rows.length,7);
 assert.deepEqual(M.totals(s),{income:14000000,expense:6000000,saving:2000000,transfer:1000000,remaining:5000000});
 assert.equal(M.toLegacy(s).income_salary,12000000);
 assert.equal(M.toLegacy(s).trading_capital_allocation,1000000);
});
test('fractional or too-large legacy values are rejected, never silently rounded',()=>{
 assert.throws(()=>M.fromLegacy({income_salary:1200.5}));
 assert.throws(()=>M.fromLegacy({income_salary:'not data'}));
});
test('types remain semantic when legacy rows change kind',()=>{
 const s=sample();s.rows[0].type='expense';
 assert.equal(M.toLegacy(s).income_salary,0);
 assert.equal(M.toLegacy(s).expense_necessities,16500000);
});
test('month validation and WIB month boundary',()=>{
 assert.equal(M.currentMonth(Date.UTC(2026,8,30,17)), '2026-10');
 for (const month of ['2026-00','2026-13','2026-9','2026-09-10','../../','2200-01',null]) assert.equal(M.validMonth(month),false);
 assert.equal(M.validMonth('2026-09'),true);
});
test('invalid/duplicate/oversized rows fail validation',()=>{
 const s=sample();assert.throws(()=>M.normalize({...s,rows:[s.rows[0],s.rows[0]]}));
 assert.throws(()=>M.normalize({version:1,rows:Array(301).fill(s.rows[0])}));
 assert.throws(()=>M.normalize({version:1,rows:[{...s.rows[0],type:'credit'}]}));
 assert.throws(()=>M.normalize({version:1,rows:[{...s.rows[0],note:'a'.repeat(501)}]}));
});
test('range paste is atomic, bounded, accepts Indonesian types and appends rows',()=>{
 const s=sample(), before=JSON.stringify(s);let n=0;
 const out=M.paste(s,6,0,'Pemasukan\tBaru\tBonus\tRp 250.000\tTerverifikasi\nPengeluaran\tRumah\tAir\t100000\t',()=> 'new-'+(++n));
 assert.equal(out.rows.length,8);assert.equal(out.rows[6].amount,250000);
 assert.equal(JSON.stringify(s),before);
 assert.throws(()=>M.paste(s,0,3,'100\tnote\textra',()=> 'unused'));
 assert.throws(()=>M.paste(s,0,3,'-100',()=> 'unused'));
 assert.equal(JSON.stringify(s),before);
});
test('CSV neutralizes formulas and escapes quotes without evaluating cells',()=>{
 const s=sample();s.rows[0].label='=HYPERLINK("bad")';s.rows[0].note='\t@SUM(1)';
 const csv=M.csv(s); assert.ok(csv.startsWith('\uFEFF'));assert.ok(csv.includes('"\'=HYPERLINK(""bad"")"'));assert.ok(csv.includes("'\t@SUM"));
});
function db(result) {
 const calls=[]; const builder={};
 for(const name of ['from','select','eq','insert','update']) builder[name]=(...args)=>{calls.push([name,...args]);return builder;};
 builder.maybeSingle=builder.single=async()=>typeof result==='function'?result(calls):result;
 return {client:builder,calls};
}
async function run(action, result, options={}) {
 const store=db(result);const response={code:200,body:null,headers:{},status(n){this.code=n;return this;},json(v){this.body=v;return this;},setHeader(k,v){this.headers[k]=v;},removeHeader(k){delete this.headers[k];}};
 const req={method:action==='save-sheet'?'POST':'GET',query:{month:'2026-09'},body:{month:'2026-09',sheet:sample(),expected_revision:0,notes:''},headers:{host:'autocuan.test',origin:'https://autocuan.test'},...options.req};
 await handler.handle({req,res:response,supabase:options.noDB?null:store.client,user:options.noUser?null:{id:'verified-user'},action});
 return {response,calls:store.calls};
}
test('worksheet reads are account-scoped and preserve an empty new month',async()=>{
 const {response,calls}=await run('get-sheet',{data:null});assert.equal(response.code,200);assert.equal(response.body.data.revision,null);assert.equal(response.body.user_id,'verified-user');
 assert.ok(calls.some(c=>c[0]==='eq'&&c[1]==='user_id'&&c[2]==='verified-user'));
 assert.equal(response.headers['Cache-Control'],'private, no-store, max-age=0');
});
test('read failure/migration absence cannot pretend to be an empty successful budget',async()=>{
 for(const code of ['42703','PGRST204','network']) {const {response}=await run('get-sheet',{error:{code}});assert.equal(response.code,503);assert.equal(response.body.success,false);}
});
test('missing database fails closed instead of reporting a successful offline save',async()=>{
 const {response,calls}=await run('save-sheet',null,{noDB:true});assert.equal(response.code,503);assert.equal(calls.length,0);
});
test('unauthenticated, cross-origin, invalid month and wrong-method requests cannot write',async()=>{
 for(const options of [{noUser:true},{req:{headers:{host:'autocuan.test',origin:'https://attacker.test'}}},{req:{method:'GET'}},{req:{body:{month:'2026-13',sheet:sample(),expected_revision:0}}}]) {const {response,calls}=await run('save-sheet',null,options);assert.ok(response.code>=400);assert.ok(!calls.some(c=>['insert','update'].includes(c[0])));}
});
test('save validates entire sheet and requires an explicit revision',async()=>{
 for(const expected_revision of [undefined,-1,1.5,'0']) {const {response,calls}=await run('save-sheet',null,{req:{body:{month:'2026-09',sheet:sample(),expected_revision}}});assert.equal(response.code,400);assert.equal(calls.length,0);}
});
test('existing-sheet save uses user+month+revision compare-and-swap',async()=>{
 const {response,calls}=await run('save-sheet',{data:{sheet_revision:1,updated_at:'now'}});
 assert.equal(response.code,200);assert.ok(calls.some(c=>c[0]==='eq'&&c[1]==='sheet_revision'&&c[2]===0));
 assert.ok(calls.some(c=>c[0]==='eq'&&c[1]==='month'&&c[2]==='2026-09'));
 const update=calls.find(c=>c[0]==='update')[1];assert.equal(update.income_salary,12000000);assert.equal(update.sheet_revision,1);assert.equal(update.sheet_data.rows.length,7);
});
test('stale revision and first-write race both return conflict, never success',async()=>{
 const existing=await run('save-sheet',{data:null});assert.equal(existing.response.code,409);
 const first=await run('save-sheet',{error:{code:'23505'}},{req:{body:{month:'2026-09',sheet:sample(),expected_revision:null}}});assert.equal(first.response.code,409);
 assert.ok(first.calls.some(c=>c[0]==='insert'));
});
test('portfolio summary is read-only and uses exactly the Portfolio model',async()=>{
 const state={plans:[{ticker:'BBCA',lots:10,entryPriceIdr:9000,stopLossIdr:8800,capitalIdr:9000000}],prices:{BBCA:9100},price_updated_at:123};
 const {response,calls}=await run('portfolio-summary',{data:{state,updated_at:'now'}});
 const expected=P.summarize(state.plans,state.prices);assert.equal(response.body.data.totalExposureIdr,expected.totalExposureIdr);assert.equal(response.body.data.totalPnlIdr,expected.totalPnlIdr);
 assert.ok(!calls.some(c=>['insert','update'].includes(c[0])));
 const absent=await run('portfolio-summary',{data:null});assert.equal(absent.response.body.data,null);
});
test('Finance does not render a duplicate journal or load its legacy runtime',()=>{
 const html=read('public/index.html');assert.doesNotMatch(html,/id="mmPanelJournal"|id="mmTabBtnJournal"|src="\/money-management-runtime/);
 assert.match(html,/money-sheet-lazy-loader\.js/);assert.match(read('public/money-sheet-lazy-loader.js'),/money-sheet-runtime\.js/);assert.match(read('lib/money-management-handler.js'),/action === 'get-journal'/);
 assert.doesNotMatch(read('supabase/money-sheet-v1-migration.sql'),/DELETE\s+FROM|DROP\s+TABLE/i);
});
test('application footer is removed without hiding semantic footers by CSS',()=>{
 assert.doesNotMatch(read('public/index.html'),/Auto-Cuan &copy; 2024/);
 assert.doesNotMatch(read('public/money-sheet.css'),/^footer\s*\{/m);
});
test('analysis has nine unique sidebar destinations and no duplicate strip in partials',()=>{
 const html=read('public/index.html');const nav=html.slice(html.indexOf('<aside id="appSidebar"'),html.indexOf('</aside>',html.indexOf('<aside id="appSidebar"')));
 assert.equal((nav.match(/data-analysis-tab=/g)||[]).length,9);
 for(const tab of ['analisis-chart','bandarmologi','intel','hunter','insider','ranking','financial','market-structure','pattern']) {
  assert.equal((nav.match(new RegExp('data-analysis-tab="' + tab + '"','g'))||[]).length,1,tab);
 }
 for(const file of ['partials/analisis-saham.partial.html','public/partials/analisis-saham.partial.html']) assert.doesNotMatch(read(file),/class="analisis-tab-strip/);
 assert.equal((html.match(/id="tabBandarmologi"/g)||[]).length,1);
 assert.equal((html.match(/id="tabFinancial"/g)||[]).length,1);
 assert.equal((html.match(/id="tabMarketStructure"/g)||[]).length,1);
});
test('Portfolio handlers are scoped and bound once, without changing its financial model',()=>{
 const source=read('public/portfolio-command-center.js');assert.match(source,/portfolioRoot\(\)\.querySelectorAll\('\[data-tab\]'\)/);assert.doesNotMatch(source,/document\.querySelectorAll\('\[data-tab\]'\)/);
 assert.match(source,/if \(button\.__portfolioTabBound\) return/);assert.match(source,/autocuan:portfolio-changed/);
});
test('worksheet uses text nodes, not HTML interpolation or an eval formula engine',()=>{
 const source=read('public/money-sheet-runtime.js');assert.doesNotMatch(source,/\.innerHTML\s*=|\beval\s*\(|new Function/);
 assert.doesNotMatch(source,/setInterval\s*\(/);
});
