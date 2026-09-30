'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_ROOT = process.env.AUTO_CUAN_DATA_ROOT || '/home/ubuntu/auto-cuan-data';

const LOCAL_TABLES = new Set([
  'stock_daily_features',
  'stock_boards',
  'idx_trading_calendar',
  'daytrade_screener_latest',
  'daytrade_screener_meta',
  'daytrade_screener_runs',
  'swing_screener_latest',
  'swing_screener_meta',
  'swing_screener_non_konglo_latest',
  'swing_screener_non_konglo_meta',
  'swing_screener_non_konglo_jobs',
  'swing_screener_non_konglo_staging',
  'telegram_daily_picks',
  'sector_hot_latest',
  'sector_hot_meta',
  'sector_hot_group_members',
  'sector_hot_members_latest',
  'ai_analysis_cache',
  'ai_analysis_logs',
  'ai_context_snapshots',
  'ai_eval_runs',
  'ai_usage_logs',
  'stock_news_cache'
]);

const DEFAULT_CONFLICT_KEYS = {
  stock_daily_features: ['ticker'],
  stock_boards: ['ticker'],
  idx_trading_calendar: ['trade_date'],
  daytrade_screener_latest: ['ticker'],
  daytrade_screener_meta: ['id'],
  daytrade_screener_runs: ['id'],
  swing_screener_latest: ['ticker'],
  swing_screener_meta: ['id'],
  swing_screener_non_konglo_latest: ['ticker'],
  swing_screener_non_konglo_meta: ['id'],
  swing_screener_non_konglo_jobs: ['run_date', 'batch_index'],
  swing_screener_non_konglo_staging: ['run_date', 'ticker'],
  telegram_daily_picks: ['id'],
  sector_hot_latest: ['group_code'],
  sector_hot_meta: ['id'],
  sector_hot_group_members: ['group_code', 'ticker'],
  sector_hot_members_latest: ['group_code', 'ticker']
};

function enabled() {
  return String(process.env.AUTO_CUAN_MARKET_DATA_BACKEND || '').toLowerCase() === 'vps';
}

function tablePath(table) {
  return path.join(DATA_ROOT, 'tables', String(table) + '.json');
}

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function atomicWriteJson(p, value) {
  ensureDir(p);
  const tmp = p + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);
}

function localTableReady(table) {
  return enabled() && LOCAL_TABLES.has(table) && fs.existsSync(tablePath(table));
}

function readTableRows(table) {
  try {
    const payload = JSON.parse(fs.readFileSync(tablePath(table), 'utf8'));
    return payload && Array.isArray(payload.rows) ? payload.rows.map((r) => Object.assign({}, r)) : [];
  } catch (_) {
    return [];
  }
}

function writeTableRows(table, rows, source) {
  atomicWriteJson(tablePath(table), {
    version: 1,
    table,
    updated_at: new Date().toISOString(),
    source: source || 'vps_local_table',
    rows: rows || []
  });
  return (rows || []).length;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withTableLock(table, fn) {
  const file = tablePath(table);
  ensureDir(file);
  const lock = file + '.lock';
  let fd = null;
  for (let i = 0; i < 100; i++) {
    try {
      fd = fs.openSync(lock, 'wx');
      break;
    } catch (_) {
      try {
        const stat = fs.statSync(lock);
        if (Date.now() - stat.mtimeMs > 30000) fs.unlinkSync(lock);
      } catch (_) {}
      sleepSync(20);
    }
  }
  if (fd == null) throw new Error('Local table lock timeout: ' + table);
  try {
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch (_) {}
    try { fs.unlinkSync(lock); } catch (_) {}
  }
}

function parseInList(value) {
  if (Array.isArray(value)) return value;
  const text = String(value == null ? '' : value).trim().replace(/^\(/, '').replace(/\)$/, '');
  return text ? text.split(',').map((v) => v.trim().replace(/^["']|["']$/g, '')) : [];
}

function projectRows(rows, columns) {
  const raw = String(columns || '*').trim();
  if (!raw || raw === '*') return rows.map((r) => Object.assign({}, r));
  const cols = raw.split(',').map((x) => x.trim()).filter((x) => x && !x.includes('('));
  return rows.map((row) => {
    const out = {};
    for (const token of cols) {
      const col = token.includes(':') ? token.split(':').pop().trim() : token;
      if (Object.prototype.hasOwnProperty.call(row, col)) out[col] = row[col];
    }
    return out;
  });
}

function compareValue(actual, op, expected) {
  if (op === 'eq') return String(actual) === String(expected);
  if (op === 'neq') return String(actual) !== String(expected);
  if (op === 'is') return expected == null || expected === 'null' ? actual == null : actual === expected;
  if (op === 'gt') return actual > expected;
  if (op === 'gte') return actual >= expected;
  if (op === 'lt') return actual < expected;
  if (op === 'lte') return actual <= expected;
  if (op === 'like' || op === 'ilike') {
    const escaped = String(expected).replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/%/g, '.*');
    return new RegExp('^' + escaped + '$', op === 'ilike' ? 'i' : '').test(String(actual == null ? '' : actual));
  }
  return true;
}

function conflictKey(row, cols) {
  return (cols || []).map((col) => String(row && row[col] == null ? '' : row[col])).join('\u001f');
}

class LocalTableQuery {
  constructor(table) {
    this.table = table;
    this.op = 'select';
    this.columns = '*';
    this.filters = [];
    this.orders = [];
    this.limitCount = null;
    this.rangeStart = null;
    this.rangeEnd = null;
    this.rows = null;
    this.patch = null;
    this.options = {};
    this.returning = false;
    this.head = false;
    this.wantCount = false;
  }

  select(columns, options) {
    this.columns = columns || '*';
    this.returning = true;
    this.head = !!(options && options.head);
    this.wantCount = !!(options && options.count);
    return this;
  }
  eq(c,v){ this.filters.push((r)=>compareValue(r[c],'eq',v)); return this; }
  neq(c,v){ this.filters.push((r)=>compareValue(r[c],'neq',v)); return this; }
  is(c,v){ this.filters.push((r)=>compareValue(r[c],'is',v)); return this; }
  gt(c,v){ this.filters.push((r)=>compareValue(r[c],'gt',v)); return this; }
  gte(c,v){ this.filters.push((r)=>compareValue(r[c],'gte',v)); return this; }
  lt(c,v){ this.filters.push((r)=>compareValue(r[c],'lt',v)); return this; }
  lte(c,v){ this.filters.push((r)=>compareValue(r[c],'lte',v)); return this; }
  like(c,v){ this.filters.push((r)=>compareValue(r[c],'like',v)); return this; }
  ilike(c,v){ this.filters.push((r)=>compareValue(r[c],'ilike',v)); return this; }
  in(c,values){ const s=new Set((values||[]).map(String)); this.filters.push((r)=>s.has(String(r[c]))); return this; }
  not(c,op,value){
    if(String(op).toLowerCase()==='in'){ const s=new Set(parseInList(value).map(String)); this.filters.push((r)=>!s.has(String(r[c]))); }
    else this.filters.push((r)=>!compareValue(r[c],String(op).toLowerCase(),value));
    return this;
  }
  match(obj){ Object.entries(obj||{}).forEach(([k,v])=>this.eq(k,v)); return this; }
  contains(c, expected){
    this.filters.push((r)=>{
      const actual=r[c];
      if(Array.isArray(actual)&&Array.isArray(expected)) return expected.every((x)=>actual.includes(x));
      if(actual&&typeof actual==='object'&&expected&&typeof expected==='object') return Object.keys(expected).every((k)=>JSON.stringify(actual[k])===JSON.stringify(expected[k]));
      return false;
    });
    return this;
  }
  order(c,o){ this.orders.push({col:c,ascending:!(o&&o.ascending===false)}); return this; }
  limit(n){ this.limitCount=Math.max(0,Number(n)||0); return this; }
  range(a,b){ this.rangeStart=Number(a)||0; this.rangeEnd=Number(b); return this; }
  insert(rows){ this.op='insert'; this.rows=Array.isArray(rows)?rows:[rows]; return this; }
  upsert(rows,options){ this.op='upsert'; this.rows=Array.isArray(rows)?rows:[rows]; this.options=options||{}; return this; }
  update(patch){ this.op='update'; this.patch=patch||{}; return this; }
  delete(){ this.op='delete'; return this; }
  maybeSingle(){ return this._execute().then((r)=>({data:r.data&&r.data[0]||null,error:r.error,count:r.count})); }
  single(){ return this.maybeSingle(); }
  then(resolve,reject){ return this._execute().then(resolve,reject); }

  _filter(rows) {
    let out=rows;
    if(this.filters.length) out=out.filter((r)=>this.filters.every((fn)=>fn(r)));
    if(this.orders.length){
      const orders=this.orders;
      out=out.slice().sort((a,b)=>{
        for(const o of orders){
          const av=a[o.col], bv=b[o.col];
          if(av==null&&bv==null) continue;
          if(av==null) return o.ascending?-1:1;
          if(bv==null) return o.ascending?1:-1;
          if(av<bv) return o.ascending?-1:1;
          if(av>bv) return o.ascending?1:-1;
        }
        return 0;
      });
    }
    if(this.rangeStart!=null) out=out.slice(this.rangeStart,Number.isFinite(this.rangeEnd)?this.rangeEnd+1:undefined);
    if(this.limitCount!=null) out=out.slice(0,this.limitCount);
    return out;
  }

  async _execute() {
    try {
      if(this.op==='select'){
        const rows=this._filter(readTableRows(this.table));
        if(this.head) return {data:null,error:null,count:rows.length};
        return {data:projectRows(rows,this.columns),error:null,count:this.wantCount?rows.length:null};
      }
      return withTableLock(this.table,()=>{
        let all=readTableRows(this.table);
        let affected=[];
        if(this.op==='insert'){
          affected=(this.rows||[]).map((r)=>Object.assign({id:crypto.randomUUID()},r));
          all=all.concat(affected);
        } else if(this.op==='upsert'){
          let keys=String(this.options.onConflict||'').split(',').map((x)=>x.trim()).filter(Boolean);
          if(!keys.length) keys=DEFAULT_CONFLICT_KEYS[this.table]||['id'];
          const index=new Map(all.map((r,i)=>[conflictKey(r,keys),i]));
          for(const raw of this.rows||[]){
            const row=Object.assign({},raw);
            if(row.id==null&&keys.includes('id')) row.id=crypto.randomUUID();
            const key=conflictKey(row,keys);
            if(index.has(key)){
              const i=index.get(key); all[i]=Object.assign({},all[i],row); affected.push(all[i]);
            } else {
              index.set(key,all.length); all.push(row); affected.push(row);
            }
          }
        } else if(this.op==='update'){
          const selected=new Set(this._filter(all));
          all=all.map((r)=>{ if(!selected.has(r)) return r; const n=Object.assign({},r,this.patch); affected.push(n); return n; });
        } else if(this.op==='delete'){
          const selected=new Set(this._filter(all));
          affected=all.filter((r)=>selected.has(r));
          all=all.filter((r)=>!selected.has(r));
        }
        writeTableRows(this.table,all,'vps_local_'+this.op);
        return {data:this.returning?projectRows(affected,this.columns):null,error:null,count:affected.length};
      });
    } catch(error){
      return {data:null,error:{message:error.message||String(error)},count:null};
    }
  }
}

module.exports = {
  DATA_ROOT,
  LOCAL_TABLES,
  tablePath,
  localTableReady,
  readTableRows,
  writeTableRows,
  LocalTableQuery
};
