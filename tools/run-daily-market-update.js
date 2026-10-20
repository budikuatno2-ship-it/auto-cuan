'use strict';
const fs=require('fs'),path=require('path');
const broker=require('./run-daily-broker-update');
const candles=require('./fetch-daily-candles');
const broksumValidator=require('../lib/broksum-validator');
const calendar=require('../lib/idx-trading-calendar');
const historySync=require('../lib/daily-history-sqlite-sync');
const arjumSharedLock=require('../lib/arjum-shared-lock');

const RUNNER_DIR = process.env.AUTO_CUAN_RUNNER_DIR || '/home/ubuntu/auto-cuan-runner';
const ROOT_DIR = path.resolve(__dirname, '..');

function loadEnvFile(file) {
  try {
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq <= 0) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!Object.prototype.hasOwnProperty.call(process.env, k)) process.env[k] = v;
    }
  } catch (_) {}
}

function loadEnv() {
  loadEnvFile(path.join(RUNNER_DIR, '.env'));
  loadEnvFile(path.join(ROOT_DIR, '.env.local'));
  loadEnvFile(path.join(ROOT_DIR, '.env.intraday-runtime'));
  loadEnvFile(path.join(ROOT_DIR, '.env'));

  // Canonical VPS market data routing (BUG-3C-03)
  if (process.env.AUTO_CUAN_MARKET_DATA_VPS == null &&
      (fs.existsSync(path.join(RUNNER_DIR, '.env')) || process.env.NODE_ENV === 'production')) {
    process.env.AUTO_CUAN_MARKET_DATA_VPS = '1';
  }
}

function stateDir(){return path.join(path.dirname(path.dirname(broker.markerPath('unused'))),'_daily-market-update');}
// 2c: EOD completion sentinel readable by the backfill worker. Written after
// broker-summary + foreign + insider + candle all complete for the date.
function eodDonePath(date, dataDir){
  const base = dataDir || path.dirname(path.dirname(broker.markerPath('unused')));
  return path.join(base, '_eod', date + '.done');
}
function writeEodDone(date, dataDir, payload){
  try{
    const p = eodDonePath(date, dataDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const temp = p + '.' + process.pid + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(payload, null, 2));
    fs.renameSync(temp, p);
  }catch(_){}
}
function writeState(date,state){
  const p=path.join(stateDir(),date+'.json');fs.mkdirSync(stateDir(),{recursive:true});
  const temp=p+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify(state,null,2));fs.renameSync(temp,p);
}
function readMarketState(date){
  try{
    const p=path.join(stateDir(),date+'.json');
    if(!fs.existsSync(p))return null;
    return JSON.parse(fs.readFileSync(p,'utf8'));
  }catch(_){return null;}
}
function previousDateNeedsWork(date){
  const marketState=readMarketState(date);
  const brokerMarker=broker.readMarker(date);
  const marketComplete=Boolean(marketState&&marketState.complete===true);
  const brokerComplete=Boolean(brokerMarker&&brokerMarker.version===2&&brokerMarker.complete===true);
  return !(marketComplete&&brokerComplete);
}
function pendingDates(now=new Date()){
  const {dateKey,hour}=broker.getJakartaTimeInfo(now);
  const holidays=calendar.getSeedHolidaySet();

  // Hard guard in addition to crontab: EOD work is allowed only from 18:00 WIB
  // on an actual IDX trading day. Weekend / exchange-holiday firings are no-op.
  if(hour<18 || !calendar.isTradingDay(dateKey,holidays))return [];

  // Automatic EOD work is deliberately bounded:
  //   1) today's trading date
  //   2) at most the immediately previous trading date (H-1), only if incomplete
  //
  // Never scan arbitrary historical incomplete markers here. Historical gaps
  // older than H-1 require an explicit manual --date backfill so a single bad
  // marker cannot consume the account's daily API quota.
  const dates=[dateKey];
  const previous=calendar.previousTradingDay(dateKey,holidays);
  if(previous&&previousDateNeedsWork(previous))dates.push(previous);
  return dates;
}
async function run(options={}){
  loadEnv();
  const dryRun=options.dryRun===true;
  const now=options.now || new Date();
  const env=options.env || process.env;
  const {hour,minute}=broker.getJakartaTimeInfo(now);
  const dates=pendingDates(options.now);
  // BUG-3C-03: the flat-file candle stage alone is not success. The canonical
  // SQLite stock_daily_history must also be synchronized (rolling window of
  // recent trading sessions) or lifecycle consumers keep skipping history.
  // Injectable for tests; production uses the real bounded sync.
  const syncHistory=options.syncHistory || historySync.syncRecentHistoryToSqlite;
  // Fase 5 (diperbaiki 18 Okt 2026): validasi kewajaran arsip broksum harian J1
  // SEBELUM `.done` ditulis, dengan TOLERANSI supaya satu-dua anomali tidak menahan
  // seluruh data hari itu.
  //
  // Aturan .done baru:
  //   - .done DITULIS jika  (a) jumlah anomali <= 1% dari total file, DAN
  //                          (b) tidak ada anomali di 100 saham paling likuid.
  //   - Jika salah satu dilanggar  -> .done TERTAHAN (butuh investigasi).
  //   - Daftar anomali selalu ditulis ke _eod/<tanggal>.anomali.json sebagai
  //     antrean backfill paling depan (dibaca oleh backfill-broksum.js).
  //
  // Aturan yang dihitung sebagai anomali KERAS (bukan peringatan):
  //   - empty_broksum_but_candle_has_volume
  //   - unclipped_ratio_below
  //   - unclipped_imbalance (beli != jual > 0.5%)
  //   - f_empty_but_all_has_value
  //   - f_buy_exceeds_all / f_sell_exceeds_all
  //   - parse_error / f_parse_error
  //
  // Aturan peringatan (TIDAK menghitung sebagai anomali keras):
  //   - unclipped_ratio_above (rasio > 1.25 karena transaksi pasar negosiasi)
  //   - f_broker_missing_in_all (sekarang hanya dijalankan bila all punya all_data === true;
  //     kalau tidak, di-skip karena padding null pada broker_levels)
  const ANOMALY_PCT_TOLERANCE = 1.0;

  const HARD_ALL_FLAGS = ['empty_broksum_but_candle_has_volume','unclipped_ratio_below','unclipped_imbalance','parse_error'];
  const HARD_F_FLAGS = ['f_empty_but_all_has_value','f_buy_exceeds_all','f_sell_exceeds_all','f_parse_error','foreign_buy_exceeds_all','foreign_sell_exceeds_all'];

  function loadTop100LiquidTickers(){
    try{
      const candleDir=path.join(ROOT_DIR,'data','daily-candles');
      if(!fs.existsSync(candleDir))return new Set();
      const ranking=[];
      const files=fs.readdirSync(candleDir).filter(f=>f.endsWith('.json')&&f!=='IHSG.json');
      for(const f of files){
        const tk=f.replace('.json','');
        try{
          const d=JSON.parse(fs.readFileSync(path.join(candleDir,f),'utf8'));
          const cs=(d.candles||[]).slice(-60);
          if(cs.length===0)continue;
          const sum=cs.reduce((a,c)=>a+Number(c.volume||0)*Number(c.close||0),0);
          ranking.push({ticker:tk,avgTurnover:sum/cs.length});
        }catch(_){}
      }
      ranking.sort((a,b)=>b.avgTurnover-a.avgTurnover);
      return new Set(ranking.slice(0,100).map(r=>r.ticker));
    }catch(_){return new Set();}
  }

  function validateDailyBroksumArchive(date){
    try{
      const dataRoot=process.env.ARJUM_DATA_DIR||path.resolve(__dirname,'..','data','arjum-data');
      const candleDir=path.join(ROOT_DIR,'data','daily-candles');
      const allDir=path.join(dataRoot,'broker-summary');
      const fDir=path.join(dataRoot,'broker-summary-F');
      const readCandle=(ticker)=>{
        try{
          const p=path.join(candleDir,ticker+'.json');
          if(!fs.existsSync(p))return null;
          const d=JSON.parse(fs.readFileSync(p,'utf8'));
          for(const c of (d.candles||[])){
            const dd=String(c.date||c.time||'').slice(0,10);
            if(dd===date)return{close:Number(c.close),volume:Number(c.volume),value:c.value!=null?Number(c.value):null};
          }
        }catch(_){}
        return null;
      };
      const invalidAll=[];const invalidF=[];const warnings=[];
      const allByTicker=new Map();
      if(fs.existsSync(allDir)){
        for(const tk of fs.readdirSync(allDir)){
          const f=path.join(allDir,tk,date+'.json');
          if(!fs.existsSync(f))continue;
          let payload;try{payload=JSON.parse(fs.readFileSync(f,'utf8'));}catch(e){invalidAll.push({ticker:tk,flags:['parse_error'],stream:'all'});continue;}
          allByTicker.set(tk,payload);
          const v=broksumValidator.validateBroksumAgainstCandle(payload,readCandle(tk));
          const hard=v.flags.filter(fl=>HARD_ALL_FLAGS.includes(fl));
          if(!v.valid){
            if(hard.length>0) invalidAll.push({ticker:tk,flags:v.flags,ratio:v.ratio,stream:'all'});
            else warnings.push({ticker:tk,flags:v.flags,ratio:v.ratio,stream:'all'});
          }
        }
      }
      if(fs.existsSync(fDir)){
        for(const tk of fs.readdirSync(fDir)){
          const f=path.join(fDir,tk,date+'.json');
          if(!fs.existsSync(f))continue;
          let fPayload;try{fPayload=JSON.parse(fs.readFileSync(f,'utf8'));}catch(e){invalidF.push({ticker:tk,flags:['f_parse_error'],stream:'F'});continue;}
          const aPayload=allByTicker.get(tk);
          if(!aPayload)continue;
          const v=broksumValidator.validateForeignAgainstAll(fPayload,aPayload);
          const hard=v.flags.filter(fl=>HARD_F_FLAGS.includes(fl));
          if(!v.valid){
            if(hard.length>0) invalidF.push({ticker:tk,flags:v.flags,stream:'F'});
            else warnings.push({ticker:tk,flags:v.flags,stream:'F'});
          }
        }
      }
      const totalFiles=allByTicker.size;
      const totalInvalid=invalidAll.length+invalidF.length;
      const invalidPct=totalFiles>0?(totalInvalid/totalFiles)*100:0;
      const top100=loadTop100LiquidTickers();
      const top100Invalid=[...invalidAll,...invalidF].filter(r=>top100.has(r.ticker));
      const pctOk=invalidPct<=ANOMALY_PCT_TOLERANCE;
      const top100Ok=top100Invalid.length===0;
      return{
        ok:pctOk&&top100Ok,
        invalidAll,invalidF,warnings,
        totalFiles,totalInvalid,invalidPct:Number(invalidPct.toFixed(3)),
        top100Invalid,
        rules:{pctTolerance:ANOMALY_PCT_TOLERANCE,pctOk,top100Ok}
      };
    }catch(e){
      return{ok:false,error:e.message,invalidAll:[],invalidF:[],warnings:[],totalFiles:0,totalInvalid:0,invalidPct:0,top100Invalid:[],rules:{pctTolerance:ANOMALY_PCT_TOLERANCE,pctOk:false,top100Ok:false}};
    }
  }

  function writeAnomalyFile(date,detail){
    try{
      const dataRoot=process.env.ARJUM_DATA_DIR||path.resolve(ROOT_DIR,'data','arjum-data');
      const eodDir=path.join(dataRoot,'_eod');
      fs.mkdirSync(eodDir,{recursive:true});
      const p=path.join(eodDir,date+'.anomali.json');
      const temp=p+'.'+process.pid+'.tmp';
      fs.writeFileSync(temp,JSON.stringify({
        date,
        generated_at:new Date().toISOString(),
        total_files:detail.totalFiles,
        invalid_total:detail.totalInvalid,
        invalid_pct:detail.invalidPct,
        last_count:detail.invalidTotal,
        rules:detail.rules,
        anomalies:[...detail.invalidAll,...detail.invalidF],
        warnings:detail.warnings.slice(0,200)
      },null,2));
      fs.renameSync(temp,p);
      return p;
    }catch(_){return null;}
  }
  // B3 (2026-10-20): hold the shared Arjum lock for the whole EOD Arjum phase
  // (broker summary + candles + history sync). J2 and the backfill worker use
  // the same lock file, so they wait/skip instead of running in parallel. The
  // nested broker/candle calls run in-process and are reentrant (no re-lock).
  const lockOutcome = await arjumSharedLock.withArjumLock({ job: 'J1', waitMs: 0 }, async () => {
  for(const date of dates){
    if(!dryRun)writeState(date,{date,complete:false,updated_at:new Date().toISOString()});
    if(dryRun){console.log('PENDING_MARKET_DATE='+date);continue;}
    let brokerOk=false,candleOk=false,historyOk=false,archiveOk=false,archiveDetail=null;
    try{
      process.exitCode=undefined;
      const brokerArgs=['--date',date];
      if(hour===23 && minute>=30)brokerArgs.push('--final');
      const extraArgs = options.argv || process.argv.slice(2);
      for(const a of extraArgs){
        if(typeof a === 'string' && (a.startsWith('--accum-source=') || a.startsWith('--insider-mode='))) brokerArgs.push(a);
      }
      const result=await broker.run(brokerArgs);
      const marker=broker.readMarker(date);
      brokerOk=Boolean(result&&result.skipped || marker&&marker.version===2&&marker.complete);
    }catch(error){console.error('BROKER_RETRY_PENDING',date,error.message);}
    try{
      const result=await candles.main({targetDate:date});
      candleOk=result.skipped===true || (result.universe>0 && !result.quota_stop && result.failed===0 && result.cached+result.fetched===result.universe);
    }catch(error){console.error('CANDLE_RETRY_PENDING',date,error.message);}
    if(candleOk){
      try{
        // Pass the repo-anchored candle dir explicitly: cron invokes this tool
        // by absolute path with no `cd`, so any process.cwd()-based default
        // resolves to /home/ubuntu/data/daily-candles (nonexistent) and the
        // sync silently reports no_candles_found, freezing stock_daily_history.
        const result=await syncHistory({now, env, candleDir:path.join(ROOT_DIR,'data','daily-candles')});
        historyOk=Boolean(result&&result.ok);
        if(!historyOk)console.error('HISTORY_SYNC_RETRY_PENDING',date,'reason='+(result&&result.reason||'unknown'));
      }catch(error){console.error('HISTORY_SYNC_RETRY_PENDING',date,error.message);}
    }
    // Fase 5: cek kewajaran arsip broksum harian sebelum sentinel .done.
    if(brokerOk&&candleOk){
      archiveDetail=validateDailyBroksumArchive(date);
      archiveOk=Boolean(archiveDetail&&archiveDetail.ok);
      // Selalu tulis daftar anomali (antrean backfill paling depan), walau .done ditulis.
      if(archiveDetail&&(archiveDetail.invalidTotal>0||(archiveDetail.warnings&&archiveDetail.warnings.length>0))){
        const p=writeAnomalyFile(date,archiveDetail);
        if(p)console.error('BROKSUM_ANOMALY_FILE',date,p,'invalid='+archiveDetail.invalidTotal,'pct='+archiveDetail.invalidPct,'top100='+archiveDetail.top100Invalid.length);
      }
      if(!archiveOk){
        console.error('BROKSUM_SANITY_PENDING',date,
          'invalid='+archiveDetail.invalidTotal,
          'pct='+archiveDetail.invalidPct,
          'top100_invalid='+archiveDetail.top100Invalid.length,
          'rules='+JSON.stringify(archiveDetail.rules));
      }else if(archiveDetail&&archiveDetail.invalidTotal>0){
        console.log('BROKSUM_SANITY_TOLERATED',date,'invalid='+archiveDetail.invalidTotal,'pct='+archiveDetail.invalidPct,'(di dalam toleransi, .done tetap ditulis)');
      }
    }
    writeState(date,{date,complete:brokerOk&&candleOk&&historyOk&&archiveOk,broker_complete:brokerOk,candle_complete:candleOk,history_complete:historyOk,archive_complete:archiveOk,anomaly_total:archiveDetail?archiveDetail.invalidTotal:0,anomaly_pct:archiveDetail?archiveDetail.invalidPct:0,anomaly_top100:archiveDetail?archiveDetail.top100Invalid.length:0,warnings_total:archiveDetail&&archiveDetail.warnings?archiveDetail.warnings.length:0,updated_at:new Date().toISOString()});
    if(brokerOk&&candleOk&&historyOk&&archiveOk){
      writeEodDone(date, null, {
        date,
        broker_complete: brokerOk,
        candle_complete: candleOk,
        history_complete: historyOk,
        archive_complete: archiveOk,
        completed_at: new Date().toISOString()
      });
    }
  }
  return { ok: true };
  });
  if(lockOutcome && lockOutcome.skipped){
    console.log('[ARJUM-LOCK] SKIPPED_ARJUM_BUSY: J1 tidak berjalan; job Arjum lain sedang berjalan. Akan dicoba di firing berikutnya.');
  }
  process.exitCode=undefined;
  if(!dryRun&&pendingDates(options.now).some(date=>{
    try{return JSON.parse(fs.readFileSync(path.join(stateDir(),date+'.json'),'utf8')).complete!==true;}catch(_){return true;}
  }))process.exitCode=3;
}
module.exports={run,pendingDates,stateDir,readMarketState,previousDateNeedsWork,loadEnv,eodDonePath,writeEodDone};
if(require.main===module)run({dryRun:process.argv.includes('--dry-run')}).catch(error=>{console.error(error.message);process.exitCode=1;});
