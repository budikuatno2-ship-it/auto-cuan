'use strict';
// Bounded recovery engine. Offline callers inject transport; no environment loading or automatic execution.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync, backup } = require('node:sqlite');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const TABLE = 'broker_summary_daily_raw_v6';
const LEDGER = 'broker_recovery_f3_v6';
const wibDate = time => new Date(time + 7 * 3600000).toISOString().slice(0, 10);
function requireThat(condition, reason) { if (!condition) throw new Error(reason); }
function identity(key) {
  requireThat(/^[A-Z]{4}$/.test(key.ticker), 'INVALID_TICKER');
  requireThat(/^2026-\d{2}-\d{2}$/.test(key.trade_date) && new Date(key.trade_date).toISOString().slice(0,10) === key.trade_date, 'INVALID_DATE');
  requireThat(['ALL','F'].includes(key.flow), 'INVALID_FLOW');
  return [key.ticker,key.trade_date,key.flow].join('\u001f');
}
function endpoint(key) {
  identity(key);
  const params = new URLSearchParams({ start_date:key.trade_date,end_date:key.trade_date,date:key.trade_date,all_data:'true' });
  if (key.flow === 'F') params.set('flow','F');
  return '/api/broker-summary/' + key.ticker + '?' + params;
}
function atomic(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive:true, mode:0o700 });
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  const fd = fs.openSync(temp,'wx',0o600);
  try { fs.writeFileSync(fd,bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp,file);
}
function validatePayload(key, body) {
  requireThat(body && !body.error && body.stock_code === key.ticker, 'SCHEMA_TICKER');
  requireThat(String(body.flow).toUpperCase() === key.flow, 'SCHEMA_FLOW');
  requireThat(body.broker_start_date === key.trade_date && body.broker_end_date === key.trade_date, 'DATE_RANGE_MISMATCH');
  for (const name of ['broker_date_min','broker_date_max']) {
    requireThat(body[name] == null || body[name] === key.trade_date,'DATE_RANGE_MISMATCH');
  }
  requireThat(body.date == null || body.date === key.trade_date, 'DATE_RANGE_MISMATCH');
  requireThat(body.source == null || body.source === 'stock.arjum.com', 'SCHEMA_SOURCE');
  requireThat(Array.isArray(body.brokers), 'SCHEMA_BROKERS');
  const codes = new Set();
  for (const row of body.brokers) {
    requireThat(row && /^[A-Z0-9]{2,4}$/.test(row.broker_code), 'SCHEMA_BROKER_CODE');
    requireThat(!codes.has(row.broker_code), 'DUPLICATE_BROKER_CODE');
    codes.add(row.broker_code);
    for (const field of ['bval','sval','nval','bvol','svol','nvol']) {
      requireThat(typeof row[field] === 'number' && Number.isFinite(row[field]) && Math.abs(row[field]) <= Number.MAX_SAFE_INTEGER,'SCHEMA_NUMERIC');
    }
    for (const field of ['bval','sval','bvol','svol']) requireThat(row[field] >= 0, 'NEGATIVE_GROSS');
    // docs/v6/V6_LOCAL_VS_UPSTREAM_ACCUM_ANALYSIS.md:94,137-138:
    // values are IDR, volumes are shares (not lots), nets are signed buy minus sell.
    // Allow independent rounding of three measures to their native whole unit:
    // at most 3 * 0.5 IDR/share plus bounded IEEE-754 subtraction error. No relative % waiver.
    for (const [buy,sell,net] of [['bval','sval','nval'],['bvol','svol','nvol']]) {
      const error = 2 * Number.EPSILON * (Math.abs(row[buy]) + Math.abs(row[sell]) + Math.abs(row[net]));
      requireThat(Math.abs((row[buy] - row[sell]) - row[net]) <= 1.5 + error, 'NET_RECONCILIATION');
    }
  }
  return body.brokers.length ? 'VALIDATED_RAW' : key.flow === 'F' ? 'FOREIGN_EMPTY_UNCONFIRMED' : 'EMPTY_UNVERIFIED';
}
function gate(key, witness, policy, eligibility, now, maxCost) {
  identity(key);
  requireThat(key.trade_date < wibDate(now), 'PREPUBLICATION');
  requireThat(eligibility?.ticker === key.ticker && eligibility?.trade_date === key.trade_date && eligibility.eligible === true && eligibility.proof_sha256?.match(/^[a-f0-9]{64}$/) && eligibility.source, 'ELIGIBILITY_UNKNOWN');
  requireThat(witness?.authenticated === true && witness.source === 'provider' && witness.evidence_sha256?.match(/^[a-f0-9]{64}$/), 'AUTH_QUOTA_UNKNOWN');
  const age = now - Date.parse(witness.observed_at);
  requireThat(Number.isFinite(age) && age >= 0 && age <= 300000 && wibDate(Date.parse(witness.observed_at)) === wibDate(now), 'QUOTA_STALE');
  requireThat(Number.isFinite(Date.parse(witness.expires_at)) && Date.parse(witness.expires_at) > now, 'EXPIRY_UNKNOWN_OR_EXPIRED');
  for (const v of [witness.limit,witness.remaining,policy?.reserve,policy?.mandatory_remaining,policy?.cap_remaining,maxCost]) requireThat(Number.isFinite(v) && v >= 0, 'BUDGET_UNKNOWN');
  requireThat(witness.remaining <= witness.limit && maxCost > 0 && policy.enabled === true && policy.kill_switch === false && policy.obligations_verified === true, 'POLICY_BLOCK');
  const hhmm = new Date(now + 7*3600000).toISOString().slice(11,16);
  requireThat(hhmm >= '00:10' && hhmm < '23:50', 'FORBIDDEN_WINDOW');
  requireThat(Math.min(witness.remaining - policy.reserve - policy.mandatory_remaining,policy.cap_remaining) >= maxCost, 'BUDGET_BLOCK');
}
function receipt(key, response, runId, requestedAt, receivedAt, rawPath) {
  const h = Object.fromEntries(Object.entries(response.headers || {}).map(([k,v])=>[k.toLowerCase(),String(v)]));
  const numeric = name => h[name] != null && /^\d+$/.test(h[name]) && Number.isSafeInteger(Number(h[name])) ? Number(h[name]) : null;
  const cost = numeric('x-quota-cost');
  let status = response.status === 401 ? 'ERROR_401' : response.status === 429 ? 'ERROR_429' : response.status === 403 ? 'ERROR_403' : 'PROVIDER_ERROR';
  let body = null;
  if (response.status === 200) {
    try { body = JSON.parse(response.bytes.toString('utf8')); status = validatePayload(key,body); }
    catch (e) { status = 'SCHEMA_ERROR'; }
  }
  return { ...key,eligible_as_of:key.trade_date,source:'stock.arjum.com',endpoint:endpoint(key),requested_at:requestedAt,source_published_at:null,received_at:receivedAt,provider_status:response.status,source_sha256:sha(response.bytes),raw_sha256:sha(response.bytes),broker_start_date:body?.broker_start_date ?? null,broker_end_date:body?.broker_end_date ?? null,source_as_of:body?.broker_end_date ?? null,request_id:null,quota_units:cost,provider_quota_cost_units:cost,provider_timestamp:h.date ?? null,provider_limit:numeric('x-ratelimit-limit'),provider_remaining:numeric('x-ratelimit-remaining'),http_count:1,status,reason:status === 'VALIDATED_RAW' ? null : status,raw_cache_path:rawPath,sqlite_table_key:[TABLE,identity(key)].join(':'),db_readback_sha:null,consumer_as_of:null,run_id:runId,category:'MANUAL_CATCHUP_20261116' };
}
function checkSchema(db) {
  const cols = db.prepare('PRAGMA table_info(market_rows)').all().map(c=>c.name);
  requireThat(['table_name','row_key','row_json','updated_at'].every(c=>cols.includes(c)), 'CANONICAL_SCHEMA_MISMATCH');
  requireThat(db.prepare('PRAGMA integrity_check').get().integrity_check === 'ok','DB_INTEGRITY');
}
async function ingest(dbPath, backupPath, r, bytes) {
  requireThat(['VALIDATED_RAW','FOREIGN_EMPTY_UNCONFIRMED','EMPTY_UNVERIFIED'].includes(r.status), 'UNINGESTIBLE_RECEIPT');
  requireThat(r.provider_status === 200 && r.source === 'stock.arjum.com' && r.endpoint === endpoint(r) && r.authenticated === true && /^[a-f0-9]{64}$/.test(r.quota_witness_sha256 || '') && /^[a-f0-9]{64}$/.test(r.eligibility_proof_sha256 || '') && /^[a-f0-9]{64}$/.test(r.accounting_binding_sha256 || ''), 'RECEIPT_PROVENANCE_UNKNOWN');
  requireThat(sha(bytes) === r.raw_sha256, 'RAW_HASH_MISMATCH');
  const accounting = new DatabaseSync(fs.realpathSync(dbPath)+'.broker-recovery.sqlite',{readOnly:true});
  try {
    const journal = loadJournal(accounting), entry = journal?.requests[identity(r)];
    requireThat(journal && !journal.stop_reason && entry && ['validated','completed'].includes(entry.phase) && entry.receipt_sha256 === digest(r) && entry.cost === r.quota_units && entry.cost <= entry.max_cost && r.accounting_binding_sha256 === digest(journal.binding),'RECEIPT_ACCOUNTING_UNVALIDATED');
  } finally {accounting.close();}
  const body = JSON.parse(bytes.toString('utf8'));
  requireThat(validatePayload(r,body) === r.status,'RECEIPT_STATUS_MISMATCH');
  const db = new DatabaseSync(dbPath);
  try {
    checkSchema(db);
    const key = identity(r);
    const old = db.prepare('SELECT row_json FROM market_rows WHERE table_name=? AND row_key=?').get(TABLE,key);
    if (old) {
      const stored = JSON.parse(old.row_json);
      requireThat(stored.raw_sha256 === r.raw_sha256 && JSON.stringify(stored.receipt) === JSON.stringify(r) && JSON.stringify(stored.payload) === JSON.stringify(body),'EXISTING_RAW_CONFLICT');
      const prior = db.prepare('SELECT row_json FROM market_rows WHERE table_name=? AND row_key=?').get(LEDGER,key);
      const ledger = prior && JSON.parse(prior.row_json);
      requireThat(ledger && ledger.db_readback_sha === sha(old.row_json) && Object.entries(r).every(([k,v]) => ['status','db_readback_sha'].includes(k) || ledger[k] === v) && ledger.status === (r.status === 'VALIDATED_RAW' ? 'REAL_PROVIDER_VERIFIED' : r.status),'EXISTING_LEDGER_MISMATCH');
      return { ...ledger,duplicate_suppressed:true };
    }
    requireThat(!fs.existsSync(backupPath), 'BACKUP_ALREADY_EXISTS');
    fs.mkdirSync(path.dirname(backupPath), {recursive:true,mode:0o700});
    await backup(db,backupPath);
    fs.chmodSync(backupPath,0o600);
    const check = new DatabaseSync(backupPath,{readOnly:true});
    try { checkSchema(check); } finally { check.close(); }
    const row = JSON.stringify({ticker:r.ticker,trade_date:r.trade_date,flow:r.flow,source_as_of:r.source_as_of,ingested_at:new Date().toISOString(),raw_sha256:r.raw_sha256,receipt:r,payload:body});
    const ledger = {...r,db_readback_sha:sha(row),status:r.status === 'VALIDATED_RAW' && r.quota_units != null ? 'REAL_PROVIDER_VERIFIED' : r.status,backup_path:backupPath};
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO market_rows(table_name,row_key,row_json,updated_at) VALUES(?,?,?,?)').run(TABLE,key,row,new Date().toISOString());
      db.prepare('INSERT INTO market_rows(table_name,row_key,row_json,updated_at) VALUES(?,?,?,?)').run(LEDGER,key,JSON.stringify(ledger),new Date().toISOString());
      const read = db.prepare('SELECT row_json FROM market_rows WHERE table_name=? AND row_key=?').get(TABLE,key);
      requireThat(read.row_json === row && sha(read.row_json) === ledger.db_readback_sha,'SQLITE_READBACK_MISMATCH');
      db.exec('COMMIT');
    } catch(e) { db.exec('ROLLBACK'); throw e; }
    checkSchema(db);
    return ledger;
  } finally { db.close(); }
}
// The sidecar is anchored to the canonical DB, not a disposable run directory.
// SQLite FULL synchronous commits make reservation + HTTP count one durable transition.
// Both exclusive locks deliberately survive hard process death; never guess that a PID is stale.
const canonical = value => JSON.stringify(value, function(k,v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(key=>[key,v[key]])) : v;
});
const digest = value => sha(canonical(value));
function bounds(o) {
  requireThat(/^[A-Za-z0-9_-]{1,90}$/.test(o.runId),'INVALID_RUN_ID');
  requireThat(Number.isInteger(o.maxRequests) && o.maxRequests > 0 && o.maxRequests <= 2 && Number.isSafeInteger(o.maxUnits) && o.maxUnits > 0 && Number.isSafeInteger(o.maxCost) && o.maxCost > 0,'INVALID_BOUNDS');
  requireThat(Array.isArray(o.keys) && o.keys.length > 0 && o.keys.length <= 2 && new Set(o.keys.map(identity)).size === o.keys.length,'INVALID_KEYS');
}
function binding(o) {
  return {version:2,root:fs.realpathSync(o.root),db:fs.realpathSync(o.dbPath),witness:o.witness,policy:o.policy,eligibility:o.eligibility,maxRequests:o.maxRequests,maxUnits:o.maxUnits,maxCost:o.maxCost};
}
function totals(j) {
  const entries = Object.values(j.requests);
  const unknown = entries.some(e=>e.cost == null);
  return {cumulative_http_count:entries.length,cumulative_billed_units:unknown ? null : entries.reduce((s,e)=>s+e.cost,0),known_billed_units:entries.reduce((s,e)=>s+(e.cost ?? 0),0),reserved_units:entries.reduce((s,e)=>s+(e.cost == null ? e.max_cost : 0),0),billing_complete:!unknown};
}
function budget(o,j,key) {
  const t = totals(j);
  requireThat(t.billing_complete,'UNRESOLVED_REQUEST_INTENT');
  const witness = {...o.witness,remaining:Math.min(o.witness.remaining-t.known_billed_units,...Object.values(j.requests).map(e=>e.provider_remaining ?? Infinity))};
  const policy = {...o.policy,cap_remaining:o.policy.cap_remaining-t.known_billed_units};
  gate(key,witness,policy,o.eligibility?.find(e=>e.ticker===key.ticker && e.trade_date===key.trade_date),Date.now(),o.maxCost);
  requireThat(t.cumulative_http_count < o.maxRequests && t.known_billed_units + t.reserved_units + o.maxCost <= o.maxUnits,'REQUEST_BOUND');
}
function stopped(j) {
  if (['ERROR_401','ERROR_403','ERROR_429','AUTH_QUOTA_LATCHED'].includes(j.stop_reason)) throw Error('AUTH_QUOTA_LATCHED');
  requireThat(!Object.values(j.requests).some(e=>e.phase === 'reserved'),'UNRESOLVED_REQUEST_INTENT');
  requireThat(!j.stop_reason,j.stop_reason);
  requireThat(Object.values(j.requests).every(e=>['validated','completed'].includes(e.phase)),'UNVALIDATED_RECEIPT');
}
function files(o,key) {
  const stem = [key.ticker,key.trade_date,key.flow].join('_');
  return {stem,raw:path.join(o.root,stem+'.raw.json'),meta:path.join(o.root,stem+'.receipt.json'),intent:path.join(o.root,stem+'.intent.json')};
}
function cached(o,j,key,e) {
  const f = files(o,key);
  requireThat(fs.existsSync(f.raw) && fs.existsSync(f.meta),'CACHE_RECEIPT_MISMATCH');
  const bytes = fs.readFileSync(f.raw), r = JSON.parse(fs.readFileSync(f.meta,'utf8'));
  requireThat(identity(r) === identity(key) && r.endpoint === endpoint(key) && r.source === 'stock.arjum.com' && r.raw_sha256 === sha(bytes) && r.source_sha256 === sha(bytes) && digest(r) === e.receipt_sha256 && r.run_id === e.run_id && r.accounting_binding_sha256 === digest(j.binding),'CACHE_RECEIPT_MISMATCH');
  requireThat(r.quota_witness_sha256 === o.witness.evidence_sha256 && r.eligibility_proof_sha256 === o.eligibility.find(x=>x.ticker===key.ticker && x.trade_date===key.trade_date)?.proof_sha256,'CACHE_RECEIPT_MISMATCH');
  requireThat(r.provider_status === 200 && r.quota_units === e.cost && e.cost <= e.max_cost && r.provider_limit === o.witness.limit && r.provider_remaining === e.provider_remaining && r.provider_remaining != null && r.provider_remaining >= 0 && r.provider_remaining <= r.provider_limit,'CACHE_RECEIPT_MISMATCH');
  requireThat(validatePayload(key,JSON.parse(bytes.toString('utf8'))) === r.status,'RECEIPT_STATUS_MISMATCH');
  return {r,bytes};
}
function completed(o,e,r,bytes) {
  const db = new DatabaseSync(o.dbPath,{readOnly:true});
  try {
    checkSchema(db);
    const raw = db.prepare('SELECT row_json FROM market_rows WHERE table_name=? AND row_key=?').get(TABLE,identity(r));
    const ledger = db.prepare('SELECT row_json FROM market_rows WHERE table_name=? AND row_key=?').get(LEDGER,identity(r));
    requireThat(raw && ledger && sha(raw.row_json) === e.db_readback_sha && sha(ledger.row_json) === e.ledger_sha256,'EXISTING_LEDGER_MISMATCH');
    const row = JSON.parse(raw.row_json), result = JSON.parse(ledger.row_json);
    requireThat(digest(row.receipt) === digest(r) && digest(row.payload) === digest(JSON.parse(bytes)) && result.db_readback_sha === sha(raw.row_json),'EXISTING_RAW_CONFLICT');
    return {...result,duplicate_suppressed:true};
  } finally { db.close(); }
}
function loadJournal(db) {
  const row = db.prepare('SELECT state FROM recovery_accounting WHERE id=1').get();
  return row ? JSON.parse(row.state) : null;
}
function preflight(o) {
  bounds(o);
  o = {...o,dbPath:fs.realpathSync(o.dbPath),root:path.resolve(o.root)};
  const state = {http_count:0,billed_units:0,stop_reason:null,cumulative_http_count:0,cumulative_billed_units:0,reserved_units:0};
  let db;
  try {
    requireThat(!fs.existsSync(path.join(o.root,'recovery.lock')) && !fs.existsSync(o.dbPath+'.broker-recovery.lock'),'RECOVERY_LOCK_BUSY');
    let j;
    if (fs.existsSync(o.dbPath+'.broker-recovery.sqlite')) {
      db = new DatabaseSync(o.dbPath+'.broker-recovery.sqlite',{readOnly:true}); j=loadJournal(db);
      requireThat(j && digest(j.binding) === digest(binding(o)),'ACCOUNTING_BINDING_MISMATCH');
      Object.assign(state,totals(j));stopped(j);
    } else {
      requireThat(!fs.existsSync(path.join(o.root,'checkpoint.json')),'LEGACY_CHECKPOINT_REVIEW_REQUIRED');
      j={requests:{}};
    }
    for (const key of o.keys) {
      const e=j.requests[identity(key)];
      if (e) {const {r,bytes}=cached(o,j,key,e);requireThat(e.phase === 'completed','RECOVERY_REQUIRED');completed(o,e,r,bytes);}
      else {
        const f=files(o,key);requireThat(![f.raw,f.meta,f.intent].some(fs.existsSync),'ORPHAN_CACHE_REVIEW_REQUIRED');budget(o,j,key);
        // Worst-case projection is in memory only; preflight must cover the whole pending plan.
        j.requests[identity(key)]={phase:'projected',cost:o.maxCost,max_cost:o.maxCost};
      }
    }
  } catch(e) {state.stop_reason=/^[A-Z0-9_]+$/.test(e.message)?e.message:'PREFLIGHT_FAILED';}
  finally {db?.close();}
  return state;
}
async function run(o) {
  bounds(o);
  o = {...o,dbPath:fs.realpathSync(o.dbPath),root:path.resolve(o.root)};
  fs.mkdirSync(o.root,{recursive:true,mode:0o700});
  o.root=fs.realpathSync(o.root);
  const lock = path.join(o.root,'recovery.lock');
  const fd = fs.openSync(lock,'wx',0o600);
  let dbLock, account, j, invocationBilled=0;
  const state = {run_id:o.runId,category:'MANUAL_CATCHUP_20261116',http_count:0,billed_units:0,billing_complete:true,results:[],remaining:o.keys,stop_reason:null};
  const save = () => atomic(path.join(o.root,'checkpoint.json'),JSON.stringify(state,null,2));
  const sync = () => {if(j)Object.assign(state,totals(j));save();};
  const persist = () => {
    account.exec('BEGIN IMMEDIATE');
    try {account.prepare('INSERT INTO recovery_accounting(id,state) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state').run(JSON.stringify(j));account.exec('COMMIT');}
    catch(e) {account.exec('ROLLBACK');throw e;}
    sync();
  };
  try {
    dbLock = fs.openSync(o.dbPath+'.broker-recovery.lock','wx',0o600);
    const existed = fs.existsSync(o.dbPath+'.broker-recovery.sqlite');
    account = new DatabaseSync(o.dbPath+'.broker-recovery.sqlite');
    fs.chmodSync(o.dbPath+'.broker-recovery.sqlite',0o600);
    account.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS recovery_accounting(id INTEGER PRIMARY KEY CHECK(id=1),state TEXT NOT NULL)');
    j = loadJournal(account);
    if (!j) {
      requireThat(!existed && !fs.existsSync(path.join(o.root,'checkpoint.json')),'LEGACY_CHECKPOINT_REVIEW_REQUIRED');
      requireThat(!fs.readdirSync(o.root).some(n=>/\.(intent|receipt|raw)\.json$/.test(n)),'ORPHAN_CACHE_REVIEW_REQUIRED');
      j = {binding:binding(o),origin_run_id:o.runId,requests:{},stop_reason:null};persist();
    }
    Object.assign(state,totals(j));
    requireThat(digest(j.binding) === digest(binding(o)),'ACCOUNTING_BINDING_MISMATCH');
    stopped(j);
    for (const key of o.keys) {
      const id=identity(key), f=files(o,key);
      let e=j.requests[id], r, bytes;
      if (e) {
        ({r,bytes}=cached(o,j,key,e));
        if(e.phase === 'completed') {
          state.results.push(completed(o,e,r,bytes));state.remaining=state.remaining.filter(k=>identity(k)!==id);sync();continue;
        }
      } else {
        budget(o,j,key);
        requireThat(![f.raw,f.meta,f.intent].some(fs.existsSync),'ORPHAN_CACHE_REVIEW_REQUIRED');
        const preDb = new DatabaseSync(o.dbPath,{readOnly:true});
        const preBackup=path.join(o.root,'backups',o.runId+'_'+f.stem+'_pre_request.sqlite');
        try {
          checkSchema(preDb);requireThat(!fs.existsSync(preBackup),'BACKUP_ALREADY_EXISTS');
          fs.mkdirSync(path.dirname(preBackup),{recursive:true,mode:0o700});await backup(preDb,preBackup);fs.chmodSync(preBackup,0o600);
          const verify=new DatabaseSync(preBackup,{readOnly:true});try{checkSchema(verify);}finally{verify.close();}
        } finally {preDb.close();}
        // Backup is asynchronous: recheck freshness and policy before making the reservation.
        budget(o,j,key);
        e={key,run_id:o.runId,phase:'reserved',max_cost:o.maxCost,cost:null,requested_at:new Date().toISOString()};
        j.requests[id]=e;state.http_count++;persist();
        atomic(f.intent,JSON.stringify({...e,accounting_binding_sha256:digest(j.binding)}));
        let response;
        try {response=await o.transport(endpoint(key));} catch(_){state.billed_units=null;throw Error('TRANSPORT_UNKNOWN_COST');}
        state.billed_units=null;
        requireThat(Buffer.isBuffer(response.bytes),'TRANSPORT_BYTES_REQUIRED');
        requireThat(!o.secret || !response.bytes.includes(Buffer.from(o.secret)),'SECRET_ECHO_BLOCKED');
        r=receipt(key,response,e.run_id,e.requested_at,new Date().toISOString(),f.raw);bytes=response.bytes;
        r.authenticated=o.witness.authenticated;r.quota_witness_sha256=o.witness.evidence_sha256;
        r.eligibility_proof_sha256=o.eligibility.find(x=>x.ticker===key.ticker && x.trade_date===key.trade_date).proof_sha256;
        r.accounting_binding_sha256=digest(j.binding);
        atomic(f.raw,bytes);atomic(f.meta,JSON.stringify(r,null,2));
        e.phase='received';e.cost=r.quota_units;e.provider_remaining=r.provider_remaining;e.receipt_sha256=digest(r);
        invocationBilled += e.cost ?? 0;
        state.results.push(r);state.billed_units=e.cost == null ? null : invocationBilled;persist();
        requireThat(!['ERROR_401','ERROR_403','ERROR_429'].includes(r.status),r.status);
        requireThat(e.cost != null,'BILLING_UNKNOWN');
        requireThat(e.cost <= e.max_cost,'COST_BOUND_EXCEEDED');
        requireThat(r.provider_remaining != null && r.provider_limit === o.witness.limit && r.provider_remaining >= 0 && r.provider_remaining <= r.provider_limit,'QUOTA_WITNESS_MISSING_OR_CHANGED');
        requireThat(['VALIDATED_RAW','FOREIGN_EMPTY_UNCONFIRMED','EMPTY_UNVERIFIED'].includes(r.status),'UNINGESTIBLE_RECEIPT');
        e.phase='validated';persist();
      }
      // Identical receipt checks apply after restart; no cache replay waiver.
      ({r,bytes}=cached(o,j,key,e));
      const result=await ingest(o.dbPath,path.join(o.root,'backups',e.run_id+'_'+f.stem+'.sqlite'),r,bytes);
      const readDb=new DatabaseSync(o.dbPath,{readOnly:true});
      try {e.ledger_sha256=sha(readDb.prepare('SELECT row_json FROM market_rows WHERE table_name=? AND row_key=?').get(LEDGER,id).row_json);} finally {readDb.close();}
      e.db_readback_sha=result.db_readback_sha;e.phase='completed';persist();
      if(fs.existsSync(f.intent))fs.unlinkSync(f.intent);
      const index=state.results.findIndex(v=>identity(v)===id);if(index<0)state.results.push(result);else state.results[index]=result;
      state.remaining=state.remaining.filter(k=>identity(k)!==id);sync();
    }
  } catch(e) {
    state.stop_reason=/^[A-Z0-9_]+$/.test(e.message)?e.message:'RECOVERY_FAILED';
    if(j && account && digest(j.binding) === digest(binding(o))) {j.stop_reason ||= state.stop_reason;persist();} else sync();
  } finally {
    account?.close();
    if(dbLock !== undefined){fs.closeSync(dbLock);fs.unlinkSync(o.dbPath+'.broker-recovery.lock');}
    fs.closeSync(fd);fs.unlinkSync(lock);
  }
  return state;
}
function httpTransport(secret) {
  requireThat(typeof secret === 'string' && secret.length > 0,'KEY_MISSING');
  return async ep => {
    requireThat(ep.startsWith('/api/broker-summary/') && !ep.includes('://'),'ENDPOINT_BLOCKED');
    const res = await fetch('https://stock.arjum.com'+ep,{headers:{'X-API-Key':secret,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(15000)});
    const bytes = Buffer.from(await res.arrayBuffer());
    requireThat(bytes.length <= 16*1024*1024,'RESPONSE_TOO_LARGE');
    return {status:res.status,headers:Object.fromEntries(['date','x-quota-cost','x-ratelimit-limit','x-ratelimit-remaining'].map(k=>[k,res.headers.get(k)]).filter(([,v])=>v!=null)),bytes};
  };
}
module.exports = {sha,identity,endpoint,atomic,validatePayload,gate,receipt,ingest,run,preflight,httpTransport,TABLE,LEDGER};
