'use strict';
// OFFLINE ONLY. Synthetic payloads remain in OS temporary directories, never production caches.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {DatabaseSync} = require('node:sqlite');
const r = require('../lib/v6-p0-broker-recovery.cjs');
const date='2026-11-16';
const key=flow=>({ticker:'BBCA',trade_date:date,flow});
function payload(flow='ALL',empty=false) { return {stock_code:'BBCA',flow:flow.toLowerCase(),broker_start_date:date,broker_end_date:date,brokers:empty?[]:[{broker_code:'YU',bval:100,sval:40,nval:60,bvol:10,svol:4,nvol:6}]}; }
function response(flow='ALL',status=200,cost='1',empty=false) { return {status,headers:{'x-quota-cost':cost,'x-ratelimit-limit':'100','x-ratelimit-remaining':'90',date:new Date().toUTCString()},bytes:Buffer.from(JSON.stringify(payload(flow,empty)))}; }
function setup(t,transport) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'OFFLINE-v6-p0-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const dbPath=path.join(root,'fixture.sqlite');
 const db=new DatabaseSync(dbPath); db.exec('CREATE TABLE market_rows(table_name TEXT NOT NULL,row_key TEXT NOT NULL,row_json TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(table_name,row_key))'); db.close();
 const options={root:path.join(root,'private'),dbPath,keys:[key('ALL'),key('F')],transport,runId:'offline_test',maxRequests:2,maxUnits:2,maxCost:1,witness:{authenticated:true,source:'provider',evidence_sha256:'a'.repeat(64),observed_at:new Date().toISOString(),expires_at:new Date(Date.now()+3600000).toISOString(),limit:100,remaining:92},policy:{enabled:true,kill_switch:false,obligations_verified:true,reserve:10,mandatory_remaining:5,cap_remaining:2},eligibility:[{ticker:'BBCA',trade_date:date,eligible:true,proof_sha256:'b'.repeat(64),source:'OFFLINE_FIXTURE'}]};
 return options;
}
test('separate ALL/F, native backup, exact SQLite hash readback and zero-call replay',async t=>{
 let calls=0; const o=setup(t,async ep=>{calls++; return response(ep.includes('flow=F')?'F':'ALL');});
 const state=await r.run(o); assert.equal(state.stop_reason,null); assert.equal(state.http_count,2); assert.equal(state.billed_units,2); assert.equal(state.remaining.length,0); assert.equal(calls,2);
 const db=new DatabaseSync(o.dbPath,{readOnly:true}); const rows=db.prepare('SELECT row_key,row_json FROM market_rows WHERE table_name=?').all(r.TABLE); assert.equal(rows.length,2);
 for(const result of state.results) { const row=rows.find(v=>v.row_key===r.identity(result)); assert.equal(r.sha(row.row_json),result.db_readback_sha); assert.ok(fs.existsSync(result.backup_path)); assert.equal(result.status,'REAL_PROVIDER_VERIFIED'); } db.close();
 const replay=await r.run({...o,runId:'offline_replay',transport:async()=>{throw Error('NETWORK_FORBIDDEN');}}); assert.equal(replay.http_count,0); assert.equal(replay.stop_reason,null); assert.equal(replay.results.length,2);
});
test('range, wrong flow, malformed numeric and empty Foreign semantics',()=>{
 const p=payload(); p.broker_start_date='2026-11-13'; assert.throws(()=>r.validatePayload(key('ALL'),p),/DATE_RANGE/);
 assert.throws(()=>r.validatePayload(key('F'),payload()),/FLOW/);
 const n=payload(); n.brokers[0].bval=null; assert.throws(()=>r.validatePayload(key('ALL'),n),/NUMERIC/);
 assert.equal(r.validatePayload(key('F'),payload('F',true)),'FOREIGN_EMPTY_UNCONFIRMED');
});
for(const status of [401,403,429]) test('HTTP '+status+' stops after one attempt and blocks replay',async t=>{
 let calls=0; const o=setup(t,async()=>{calls++;return response('ALL',status);});
 const s=await r.run(o); assert.equal(s.http_count,1); assert.equal(s.stop_reason,'ERROR_'+status); assert.equal(calls,1); assert.equal(s.billed_units,1);
 const repeat=await r.run(o); assert.equal(repeat.http_count,0); assert.equal(calls,1); assert.equal(repeat.stop_reason,'AUTH_QUOTA_LATCHED');
});
test('unknown billing, schema drift and transport uncertainty do not continue',async t=>{
 for(const mode of ['billing','schema','transport']) {
  let calls=0; const o=setup(t,async()=>{calls++; if(mode==='transport') throw Error('secret should not escape'); const v=response(); if(mode==='billing') delete v.headers['x-quota-cost']; if(mode==='schema') v.bytes=Buffer.from('{}'); return v;});
  const s=await r.run(o); assert.equal(calls,1); assert.equal(s.http_count,1); assert.ok(s.stop_reason); if(mode!=='schema') assert.equal(s.billed_units,null);
  if(mode==='transport') {const repeat=await r.run(o); assert.equal(repeat.stop_reason,'UNRESOLVED_REQUEST_INTENT'); assert.equal(calls,1);}
 }
});
test('unknown/stale/expired quota, eligibility, obligations and insufficient headroom send no calls',async t=>{
 const changes=[o=>o.witness.remaining=null,o=>o.witness.observed_at='2026-11-13T00:00:00Z',o=>o.witness.expires_at=null,o=>o.eligibility=[],o=>o.policy.obligations_verified=false,o=>o.policy.reserve=100,o=>o.policy.kill_switch=true];
 for(const change of changes) { let calls=0; const o=setup(t,async()=>{calls++;return response();}); change(o); const s=await r.run(o); assert.ok(s.stop_reason); assert.equal(calls,0); }
});
test('request bound enforced before second request',async t=>{let calls=0;const o=setup(t,async()=>{calls++;return response();});o.maxRequests=1;const s=await r.run(o);assert.equal(s.stop_reason,'REQUEST_BOUND');assert.equal(calls,1);});
test('empty F persisted but never no-flow or provider-verified',async t=>{const o=setup(t,async()=>response('F',200,'1',true));o.keys=[key('F')];const s=await r.run(o);assert.equal(s.stop_reason,null);assert.equal(s.results[0].status,'FOREIGN_EMPTY_UNCONFIRMED');});
test('tampered cache stops without provider or DB writes',async t=>{const o=setup(t,async()=>response());o.keys=[key('ALL')];await r.run(o);fs.appendFileSync(path.join(o.root,'BBCA_'+date+'_ALL.raw.json'),' ');const s=await r.run(o);assert.equal(s.stop_reason,'CACHE_RECEIPT_MISMATCH');assert.equal(s.http_count,0);});
test('lock exclusion and secret echo leave no response payload',async t=>{const o=setup(t,async()=>response());fs.mkdirSync(o.root);fs.writeFileSync(path.join(o.root,'recovery.lock'),'');await assert.rejects(r.run(o),/EEXIST/);fs.unlinkSync(path.join(o.root,'recovery.lock'));o.secret='OFFLINE_SECRET';o.transport=async()=>({...response(),bytes:Buffer.from('OFFLINE_SECRET')});const s=await r.run(o);assert.equal(s.stop_reason,'SECRET_ECHO_BLOCKED');assert.equal(s.billed_units,null);assert.equal(fs.existsSync(path.join(o.root,'BBCA_'+date+'_ALL.raw.json')),false);});
test('401 without billing headers retains auth classification and latches other keys',async t=>{let calls=0;const o=setup(t,async()=>{calls++;const v=response('ALL',401);delete v.headers['x-quota-cost'];return v;});const s=await r.run(o);assert.equal(s.stop_reason,'ERROR_401');assert.equal(s.billed_units,null);o.keys=[key('F')];const again=await r.run(o);assert.equal(again.stop_reason,'AUTH_QUOTA_LATCHED');assert.equal(calls,1);});
test('native backup exists before transport and unreadable schema blocks all calls',async t=>{let calls=0;const o=setup(t,async()=>{calls++;const names=fs.readdirSync(path.join(o.root,'backups'));assert.ok(names.some(n=>n.endsWith('_pre_request.sqlite')));return response();});o.keys=[key('ALL')];assert.equal((await r.run(o)).stop_reason,null);assert.equal(calls,1);const bad=setup(t,async()=>{throw Error('MUST_NOT_CALL');});const db=new DatabaseSync(bad.dbPath);db.exec('DROP TABLE market_rows');db.close();const blocked=await r.run(bad);assert.equal(blocked.stop_reason,'CANONICAL_SCHEMA_MISMATCH');assert.equal(blocked.http_count,0);});
