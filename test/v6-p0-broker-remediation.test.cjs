'use strict';
// Offline regression fixtures only. No application/provider imports beyond the isolated broker engine.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {DatabaseSync} = require('node:sqlite');
const r = require('../lib/v6-p0-broker-recovery.cjs');
const date = '2026-11-16';
const key = flow => ({ticker:'BBCA',trade_date:date,flow});
const body = (flow='ALL') => ({stock_code:'BBCA',flow,broker_start_date:date,broker_end_date:date,brokers:[{broker_code:'YU',bval:100,sval:40,nval:60,bvol:10,svol:4,nvol:6}]});
const response = (flow='ALL',cost='1') => ({status:200,headers:{'x-quota-cost':cost,'x-ratelimit-limit':'100','x-ratelimit-remaining':'90'},bytes:Buffer.from(JSON.stringify(body(flow)))});
function setup(t) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(),'OFFLINE-broker-remediation-'));
  t.after(()=>fs.rmSync(fixture,{recursive:true,force:true}));
  const dbPath = path.join(fixture,'fixture.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE market_rows(table_name TEXT NOT NULL,row_key TEXT NOT NULL,row_json TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(table_name,row_key))'); db.close();
  return {root:path.join(fixture,'private'),dbPath,keys:[key('ALL'),key('F')],runId:'regression',maxRequests:2,maxUnits:2,maxCost:1,witness:{authenticated:true,source:'provider',evidence_sha256:'a'.repeat(64),observed_at:new Date().toISOString(),expires_at:new Date(Date.now()+3600000).toISOString(),limit:100,remaining:92},policy:{enabled:true,kill_switch:false,obligations_verified:true,reserve:10,mandatory_remaining:5,cap_remaining:2},eligibility:[{ticker:'BBCA',trade_date:date,eligible:true,proof_sha256:'b'.repeat(64),source:'OFFLINE_FIXTURE'}]};
}
function rows(o) { const db=new DatabaseSync(o.dbPath,{readOnly:true}); try {return db.prepare('SELECT * FROM market_rows').all();} finally {db.close();} }
for (const mode of ['cost','remaining','limit','billing','schema']) test('restart cannot promote stopped cached '+mode,async t=>{
  const o=setup(t); let calls=0;
  o.transport=async()=>{calls++;const v=response('ALL',mode==='cost'?'2':'1');if(mode==='remaining')delete v.headers['x-ratelimit-remaining'];if(mode==='limit')v.headers['x-ratelimit-limit']='101';if(mode==='billing')delete v.headers['x-quota-cost'];if(mode==='schema')v.bytes=Buffer.from('{}');return v;};
  const first=await r.run(o); assert.ok(first.stop_reason);
  const again=await r.run(o); assert.ok(again.stop_reason);assert.equal(calls,1);assert.equal(rows(o).length,0);
  assert.equal(again.cumulative_http_count,1);
  assert.equal(again.cumulative_billed_units,mode==='billing'?null:mode==='cost'?2:1);
});
for (const bound of ['cap','units','http']) test('cumulative '+bound+' bound survives repeat and new run id',async t=>{
  const o=setup(t);let calls=0;o.transport=async ep=>{calls++;return response(ep.includes('flow=F')?'F':'ALL');};
  if(bound==='cap')o.policy.cap_remaining=1;if(bound==='units')o.maxUnits=1;if(bound==='http')o.maxRequests=1;
  const first=await r.run(o);assert.ok(first.stop_reason);assert.equal(calls,1);
  for(const runId of [o.runId,'different_run']) {const again=await r.run({...o,runId});assert.ok(again.stop_reason);assert.equal(calls,1);assert.equal(again.cumulative_http_count,1);assert.equal(again.cumulative_billed_units,1);}
});
test('unknown transport debit remains reserved across restart',async t=>{
  const o=setup(t);let calls=0;o.transport=async()=>{calls++;throw Error('OFFLINE_DISCONNECT');};
  const first=await r.run(o);assert.equal(first.billed_units,null);assert.equal(first.reserved_units,1);
  const again=await r.run(o);assert.equal(again.stop_reason,'UNRESOLVED_REQUEST_INTENT');assert.equal(again.reserved_units,1);assert.equal(again.cumulative_http_count,1);assert.equal(calls,1);
});
test('completed replay is exact, cumulative and cannot repair tampered SQLite',async t=>{
  const o=setup(t);o.keys=[key('ALL')];let calls=0;o.transport=async()=>{calls++;return response();};
  const first=await r.run(o);assert.equal(first.stop_reason,null);const before=rows(o);
  const replay=await r.run({...o,runId:'readback'});assert.equal(replay.stop_reason,null);assert.equal(replay.http_count,0);assert.equal(replay.cumulative_http_count,1);assert.equal(replay.cumulative_billed_units,1);assert.deepEqual(rows(o),before);assert.equal(calls,1);
  const db=new DatabaseSync(o.dbPath);const raw=JSON.parse(before.find(x=>x.table_name===r.TABLE).row_json);raw.payload.brokers[0].nval=999;db.prepare('UPDATE market_rows SET row_json=? WHERE table_name=?').run(JSON.stringify(raw),r.TABLE);db.close();
  assert.ok((await r.run(o)).stop_reason);assert.equal(calls,1);
});
for(const field of ['source','run_id','quota_units','provider_remaining','quota_witness_sha256','eligibility_proof_sha256']) test('receipt binding rejects tampered '+field,async t=>{
  const o=setup(t);o.keys=[key('ALL')];let calls=0;o.transport=async()=>{calls++;return response();};await r.run(o);
  const p=path.join(o.root,'BBCA_'+date+'_ALL.receipt.json');const v=JSON.parse(fs.readFileSync(p));v[field]=typeof v[field]==='number'?v[field]+1:'changed';fs.writeFileSync(p,JSON.stringify(v));
  assert.ok((await r.run(o)).stop_reason);assert.equal(calls,1);
});
for(const field of ['witness','policy','bounds','root','db']) test('durable plan binding rejects changed '+field,async t=>{
  const o=setup(t);o.keys=[key('ALL')];o.transport=async()=>response();await r.run(o);const changed=structuredClone({...o,transport:undefined});changed.transport=async()=>{throw Error('NO_CALL');};
  if(field==='witness')changed.witness.evidence_sha256='c'.repeat(64);if(field==='policy')changed.policy.cap_remaining=100;if(field==='bounds')changed.maxUnits=100;
  if(field==='root'){changed.root=path.join(path.dirname(o.root),'copied');fs.cpSync(o.root,changed.root,{recursive:true});}
  if(field==='db'){changed.dbPath=path.join(path.dirname(o.dbPath),'copied.sqlite');fs.copyFileSync(o.dbPath,changed.dbPath);}
  assert.ok((await r.run(changed)).stop_reason);
});
test('concurrent invocation never removes the active lock or spends twice',async t=>{
  const o=setup(t);o.keys=[key('ALL')];let enter,release;const entered=new Promise(v=>enter=v),wait=new Promise(v=>release=v);let calls=0;
  o.transport=async()=>{calls++;enter();await wait;return response();};const active=r.run(o);await entered;
  await assert.rejects(r.run(o),/EEXIST/);assert.ok(fs.existsSync(path.join(o.root,'recovery.lock')));release();assert.equal((await active).stop_reason,null);assert.equal(calls,1);
});
test('hard exit retains durable reservation and stale lock fails closed',async t=>{
  const o=setup(t);o.keys=[key('ALL')];const plan=path.join(path.dirname(o.dbPath),'plan.json');fs.writeFileSync(plan,JSON.stringify(o));
  const child=spawnSync(process.execPath,[__filename,'--crash-worker',plan],{encoding:'utf8'});assert.equal(child.status,73,child.stderr);
  const lock=path.join(o.root,'recovery.lock');assert.ok(fs.existsSync(lock));await assert.rejects(r.run({...o,transport:async()=>{throw Error('NO_CALL');}}),/EEXIST/);
  // Simulate explicit offline operator removal only; accounting must still block unknown debit.
  fs.unlinkSync(lock);if(fs.existsSync(o.dbPath+'.broker-recovery.lock'))fs.unlinkSync(o.dbPath+'.broker-recovery.lock');
  const again=await r.run({...o,transport:async()=>{throw Error('NO_CALL');}});assert.equal(again.stop_reason,'UNRESOLVED_REQUEST_INTENT');assert.equal(again.reserved_units,1);assert.equal(again.cumulative_http_count,1);
});
test('financial gross, signed nets, rounding and duplicate broker contract',()=>{
  for(const field of ['bval','sval','bvol','svol']) {const p=body();p.brokers[0][field]=-1;assert.throws(()=>r.validatePayload(key('ALL'),p),/GROSS/);}
  for(const field of ['nval','nvol']) {const p=body();p.brokers[0][field]+=5;assert.throws(()=>r.validatePayload(key('ALL'),p),/NET/);}
  const duplicate=body();duplicate.brokers.push({...duplicate.brokers[0]});assert.throws(()=>r.validatePayload(key('ALL'),duplicate),/DUPLICATE/);
  const seller=body();Object.assign(seller.brokers[0],{bval:40,sval:100,nval:-60,bvol:4,svol:10,nvol:-6});assert.equal(r.validatePayload(key('ALL'),seller),'VALIDATED_RAW');
  const rounded=body();Object.assign(rounded.brokers[0],{bval:100.4,sval:40.2,nval:60,bvol:10,svol:4,nvol:6});assert.equal(r.validatePayload(key('ALL'),rounded),'VALIDATED_RAW');
  const large=body();Object.assign(large.brokers[0],{bval:831957657500,sval:146574900000,nval:685382757500});assert.equal(r.validatePayload(key('ALL'),large),'VALIDATED_RAW');large.brokers[0].nval+=1000;assert.throws(()=>r.validatePayload(key('ALL'),large),/NET/);
});
test('exact optional provider date and source binding',()=>{
  for(const change of [p=>p.date='2026-11-13',p=>p.source='other.invalid']) {const p=body();change(p);assert.throws(()=>r.validatePayload(key('ALL'),p),/DATE|SOURCE/);}
});
test('preflight reconstructs durable spent budget without writes',async t=>{
  const o=setup(t);o.policy.cap_remaining=1;o.transport=async()=>response();await r.run(o);
  const before=fs.readFileSync(o.dbPath+'.broker-recovery.sqlite');const result=r.preflight(o);assert.ok(result.stop_reason);assert.equal(result.cumulative_billed_units,1);assert.equal(result.cumulative_http_count,1);assert.deepEqual(fs.readFileSync(o.dbPath+'.broker-recovery.sqlite'),before);
});
test('provider remaining headroom survives restart even when original witness has room',async t=>{
  const o=setup(t);let calls=0;o.transport=async()=>{calls++;const v=response();v.headers['x-ratelimit-remaining']='15';return v;};
  const first=await r.run(o);assert.equal(first.stop_reason,'BUDGET_BLOCK');assert.equal(calls,1);assert.equal(first.cumulative_billed_units,1);
  const next=await r.run({...o,runId:'restart'});assert.equal(next.stop_reason,'BUDGET_BLOCK');assert.equal(calls,1);assert.equal(next.cumulative_billed_units,1);
});
test('fresh preflight projects every pending request without creating files',t=>{
  const o=setup(t);o.policy.cap_remaining=1;assert.equal(r.preflight(o).stop_reason,'BUDGET_BLOCK');assert.equal(fs.existsSync(o.root),false);assert.equal(fs.existsSync(o.dbPath+'.broker-recovery.sqlite'),false);
  o.policy.cap_remaining=2;assert.equal(r.preflight(o).stop_reason,null);
});
test('exported ingest rejects a receipt stopped by excess cost',async t=>{
  const o=setup(t);o.keys=[key('ALL')];o.transport=async()=>response('ALL','2');assert.equal((await r.run(o)).stop_reason,'COST_BOUND_EXCEEDED');
  const f=path.join(o.root,'BBCA_'+date+'_ALL');const receipt=JSON.parse(fs.readFileSync(f+'.receipt.json'));await assert.rejects(r.ingest(o.dbPath,path.join(o.root,'must-not-create.sqlite'),receipt,fs.readFileSync(f+'.raw.json')),/ACCOUNTING/);assert.equal(rows(o).length,0);
});
test('successful partial plan resumes with cumulative debit and invocation-only billing',async t=>{
  const o=setup(t);const all=o.keys;o.keys=[key('ALL')];let calls=0;o.transport=async ep=>{calls++;return response(ep.includes('flow=F')?'F':'ALL');};
  assert.equal((await r.run(o)).billed_units,1);o.keys=all;
  const next=await r.run({...o,runId:'second'});assert.equal(next.stop_reason,null);assert.equal(next.http_count,1);assert.equal(next.billed_units,1);assert.equal(next.cumulative_http_count,2);assert.equal(next.cumulative_billed_units,2);assert.equal(calls,2);
});
for(const phase of ['raw','received','validated','postcommit','completed']) test('hard crash boundary '+phase+' reserves or resumes without another HTTP',async t=>{
  const o=setup(t);o.keys=[key('ALL')];const plan=path.join(path.dirname(o.dbPath),'plan.json');fs.writeFileSync(plan,JSON.stringify(o));
  const child=spawnSync(process.execPath,[__filename,'--phase-worker',plan,phase],{encoding:'utf8'});assert.equal(child.status,73,child.stderr);
  for(const p of [path.join(o.root,'recovery.lock'),o.dbPath+'.broker-recovery.lock'])fs.unlinkSync(p);
  let calls=0;const next=await r.run({...o,transport:async()=>{calls++;throw Error('NO_HTTP');}});assert.equal(calls,0);assert.equal(next.cumulative_http_count,1);
  if(['raw','received'].includes(phase)){assert.ok(next.stop_reason);assert.equal(rows(o).length,0);}
  else {assert.equal(next.stop_reason,null);assert.equal(next.cumulative_billed_units,1);assert.equal(rows(o).length,2);}
});
test('CLI preflight reports spent accounting and never loads provider path',async t=>{
  const o=setup(t);o.policy.cap_remaining=1;o.transport=async()=>response();await r.run(o);
  const plan=path.join(path.dirname(o.dbPath),'plan.json');fs.writeFileSync(plan,JSON.stringify(o));
  const result=spawnSync(process.execPath,['tools/v6-p0-broker-canary.cjs','--preflight',plan],{encoding:'utf8'});assert.equal(result.status,2,result.stderr);
  const out=JSON.parse(result.stdout);assert.equal(out.provider_calls,0);assert.equal(out.status,'PREFLIGHT_BLOCKED');assert.equal(out.cumulative_billed_units,1);
});
test('separate roots sharing a database cannot bypass active accounting lock',async t=>{
  const o=setup(t);o.keys=[key('ALL')];let enter,release;const entered=new Promise(v=>enter=v),wait=new Promise(v=>release=v);
  const active=r.run({...o,transport:async()=>{enter();await wait;return response();}});await entered;
  const other=await r.run({...o,root:o.root+'_other',transport:async()=>{throw Error('NO_HTTP');}});assert.ok(other.stop_reason);assert.ok(fs.existsSync(o.dbPath+'.broker-recovery.lock'));release();assert.equal((await active).stop_reason,null);
});
if(process.argv[2]==='--crash-worker') {
  const o=JSON.parse(fs.readFileSync(process.argv[3]));r.run({...o,transport:async()=>process.exit(73)}).catch(()=>process.exit(74));
}
if(process.argv[2]==='--phase-worker') {
  const o=JSON.parse(fs.readFileSync(process.argv[3])),phase=process.argv[4],rename=fs.renameSync;
  fs.renameSync=function(a,b){rename(a,b);if(phase==='raw' && b.endsWith('.raw.json'))process.exit(73);if(b.endsWith('checkpoint.json') && fs.existsSync(o.dbPath+'.broker-recovery.sqlite')){const db=new DatabaseSync(o.dbPath+'.broker-recovery.sqlite',{readOnly:true});const j=JSON.parse(db.prepare('SELECT state FROM recovery_accounting WHERE id=1').get().state);db.close();if(Object.values(j.requests).some(e=>e.phase===phase))process.exit(73);}};
  if(phase==='postcommit'){const exec=DatabaseSync.prototype.exec;DatabaseSync.prototype.exec=function(sql){const result=exec.call(this,sql);if(sql==='COMMIT'){try{if(this.prepare('SELECT 1 FROM market_rows WHERE table_name=?').get(r.TABLE))process.exit(73);}catch(_){}}return result;};}
  r.run({...o,transport:async()=>response()}).then(()=>process.exit(75)).catch(()=>process.exit(74));
}
