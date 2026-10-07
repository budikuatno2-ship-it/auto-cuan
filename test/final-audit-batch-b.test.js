'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { makeFakeSupabase } = require('./helpers/fake-supabase');
const { buildFinancialSnapshot } = require('../lib/financial-snapshot');
const { buildContextForTicker } = require('../lib/daily-market-context-builder');
const { handleFinancialSnapshotAction } = require('../api/quote').__test;

const row = { ticker:'BBCA',book_value_per_share:3000,equity:3000000000,shares_outstanding:1000000,market_cap:9000000000,market_cap_source:'stored snapshot',market_cap_as_of:'2026-10-05',fundamental_period:'Q3-2026',source:'verified filing',updated_at:'2026-10-06T00:00:00Z' };
const history = [{ ticker:'BBCA',trade_date:'2026-10-05',close:9000,open:9000,high:9100,low:8900,volume:1000,data_source:'stored EOD',data_quality_status:'ok' }];

function dbFixture({ fundamental=row, prices=history, fail=null, foreign='healthy' }={}) {
  const db=makeFakeSupabase({stock_fundamentals:fundamental?[fundamental]:[],stock_daily_history:prices});
  const from=db.from.bind(db),calls=[];
  db.from=table=>{
    calls.push(table);
    const query=from(table),then=query.then.bind(query);
    query.then=(resolve,reject)=>{
      if(table===fail)return Promise.resolve({data:null,error:{message:'Required dependency unavailable'}}).then(resolve,reject);
      if(table==='foreign_watchlist_daily'&&foreign==='failed')return Promise.resolve({data:null,error:{message:'Foreign offline'}}).then(resolve,reject);
      if(table==='foreign_watchlist_daily'&&foreign==='delayed')return new Promise(()=>{});
      return then(resolve,reject);
    };
    query.maybeSingle=async()=>{const result=await query;return {data:result.data?result.data[0]||null:null,error:result.error};};
    return query;
  };
  return {db,calls};
}

for(const foreign of ['healthy','delayed','failed'])test('Financial snapshot does not consult '+foreign+' foreign-flow data',async()=>{
  const {db,calls}=dbFixture({foreign});
  const snapshot=await buildFinancialSnapshot(db,'BBCA');
  assert.equal(snapshot.fundamental.pbv,3);assert.equal(snapshot.fundamental.fundamental_source,'verified filing');
  assert.deepEqual(calls.sort(),['stock_daily_history','stock_fundamentals']);
  assert.equal(snapshot.price.last_price_as_of,'2026-10-05');
});
test('a pending full-context foreign read does not block the Financial snapshot',async()=>{
  const {db,calls}=dbFixture({foreign:'delayed'});let fullFinished=false;
  buildContextForTicker(db,'BBCA',{}).then(()=>{fullFinished=true;},()=>{fullFinished=true;});
  const snapshot=await buildFinancialSnapshot(db,'BBCA');
  assert.equal(snapshot.fundamental.pbv,3);assert.equal(fullFinished,false);
  assert.ok(calls.includes('foreign_watchlist_daily'));
});
test('representative snapshot values and provenance equal the full-context source',async()=>{
  for(const fundamental of [row,{...row,book_value_per_share:null,equity:2500000000},{...row,market_cap:null,shares_outstanding:null},null]){
    const {db}=dbFixture({fundamental});
    const old=await buildContextForTicker(db,'BBCA',{}),current=await buildFinancialSnapshot(db,'BBCA');
    assert.deepEqual(current.fundamental,old.fundamental);
  }
});
test('missing price yields partial truthful fundamentals, while required storage failures reject',async()=>{
  const {db}=dbFixture({prices:[]});const snapshot=await buildFinancialSnapshot(db,'BBCA');
  assert.equal(snapshot.fundamental.pbv,null);assert.equal(snapshot.fundamental.book_value_per_share,3000);assert.equal(snapshot.price.last,null);
  for(const fail of ['stock_fundamentals','stock_daily_history']){
    await assert.rejects(buildFinancialSnapshot(dbFixture({fail}).db,'BBCA'),/storage unavailable/);
  }
});
test('Financial action validates requests and returns truthful dependency failure',async()=>{
  for(const [req,options,status] of [[{method:'POST',query:{ticker:'BBCA'}},{},405],[{method:'GET',query:{ticker:'???'}},{},400],[{method:'GET',query:{ticker:'bbca.jk'}},{},200],[{method:'GET',query:{ticker:'BBCA'}},{fail:'stock_fundamentals'},503]]){
    const res={status(n){this.code=n;return this},json(body){this.body=body;return this}};
    await handleFinancialSnapshotAction(req,res,dbFixture(options).db);
    assert.equal(res.code,status);assert.equal(res.body.success,status===200);
    if(status===200)assert.equal(res.body.snapshot.fundamental.pbv,3);
  }
});

function runtime(fetch) {
  const elements=new Map();
  const document={readyState:'loading',addEventListener(){},getElementById(id){
    if(!elements.has(id))elements.set(id,{textContent:'',innerHTML:'',hidden:false,value:'',style:{setProperty(){}}});
    return elements.get(id);
  }};
  const window={document,addEventListener(){},localStorage:{getItem(){}}};
  vm.runInNewContext(fs.readFileSync('public/analisis-saham-runtime.js','utf8'),{window,document,fetch,console,setTimeout,clearTimeout,URL,Intl});
  return {window,get:id=>document.getElementById(id)};
}
const response=(fundamental,success=true)=>({ok:success,json:async()=>success?{success:true,snapshot:{fundamental,price:{last_price_as_of:'2026-10-05',last_price_source:'stored EOD',freshness:'fresh'}}}:{success:false,error:'Local refresh failure'}});
const a={pbv:3,book_value_per_share:3000,market_cap:9000000000,shares_outstanding:1000000,fundamental_period:'Q3-2026',fundamental_source:'verified BBCA',fundamental_updated_at:'2026-10-06'};
test('cached A → B → cached A survives failed refresh with metrics and provenance',async()=>{
  let fail=false,release;
  const r=runtime(async url=>{
    assert.match(url,/action=financial-snapshot/);
    if(fail)return new Promise(resolve=>{release=resolve});
    return response(url.includes('BBCA')?a:{...a,pbv:1.5,fundamental_source:'verified TLKM'});
  });
  await r.window.loadFinancialStructureTab('financial','BBCA');await r.window.loadFinancialStructureTab('financial','TLKM');fail=true;
  const pending=r.window.loadFinancialStructureTab('financial','BBCA');
  assert.equal(r.get('financialDataContent').hidden,false);assert.equal(r.get('financialPbv').textContent,'3x');assert.equal(r.get('financialSource').textContent,'verified BBCA');
  release(response(null,false));await pending;
  assert.equal(r.get('financialDataContent').hidden,false);assert.equal(r.get('financialPeriod').textContent,'Q3-2026');assert.equal(r.get('financialUpdatedAt').textContent,'2026-10-06');
  assert.match(r.get('financialPbvPrice').textContent,/2026-10-05.*stored EOD/);
  assert.equal(r.get('financialRefreshBanner').hidden,false);assert.match(r.get('financialRefreshBanner').innerHTML,/Menampilkan data tersimpan/);
});
test('same-ticker failed refresh retains snapshot; successful refresh replaces it and clears feedback',async()=>{
  let next=response(a);const r=runtime(async()=>next);
  await r.window.loadFinancialStructureTab('financial','BBCA');next=response(null,false);await r.window.loadFinancialStructureTab('financial','BBCA');
  assert.equal(r.get('financialDataContent').hidden,false);assert.equal(r.get('financialPbv').textContent,'3x');assert.equal(r.get('financialSource').textContent,'verified BBCA');
  next=response({...a,pbv:4,fundamental_period:'Q4-2026'});await r.window.loadFinancialStructureTab('financial','BBCA');
  assert.equal(r.get('financialPbv').textContent,'4x');assert.equal(r.get('financialPeriod').textContent,'Q4-2026');assert.equal(r.get('financialRefreshBanner').hidden,true);
});
test('initial failure and all-unavailable snapshot show compact truthful states',async()=>{
  const r=runtime(async()=>response(null,false));await r.window.loadFinancialStructureTab('financial','BBCA');
  assert.equal(r.get('financialDataContent').hidden,true);assert.equal(r.get('financialDataState').hidden,false);assert.match(r.get('financialDataState').textContent,/failure/);
  const empty=runtime(async()=>response({}));await empty.window.loadFinancialStructureTab('financial','BBCA');
  assert.equal(empty.get('financialMetricGrid').hidden,true);assert.equal(empty.get('financialAllUnavailableState').hidden,false);assert.equal(empty.get('financialPbv').textContent,'—');
});
test('every served Financial panel uses the same scoped snapshot structure',()=>{
  const pattern=/<section id="panel-tab-financial"[^>]*>[\s\S]*?<\/section>/;
  const canonical=fs.readFileSync('public/partials/analisis-saham.partial.html','utf8').match(pattern)[0];
  for(const file of ['public/index.html','public/analisis-saham.html','partials/analisis-saham.partial.html']){
    assert.equal(fs.readFileSync(file,'utf8').match(pattern)[0],canonical,file);
  }
  assert.match(canonical,/data-ac-ui="v2"/);assert.match(canonical,/Snapshot terverifikasi/);assert.match(canonical,/id="financialRefreshBanner"/);
  assert.doesNotMatch(canonical,/Financial Canvas|orbit|ac-financial-focus-card/);
});
