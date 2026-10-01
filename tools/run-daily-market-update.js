'use strict';
const fs=require('fs'),path=require('path');
const broker=require('./run-daily-broker-update');
const candles=require('./fetch-daily-candles');
const calendar=require('../lib/idx-trading-calendar');
function stateDir(){return path.join(path.dirname(path.dirname(broker.markerPath('unused'))),'_daily-market-update');}
function writeState(date,state){
  const p=path.join(stateDir(),date+'.json');fs.mkdirSync(stateDir(),{recursive:true});
  const temp=p+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify(state,null,2));fs.renameSync(temp,p);
}
function pendingDates(now=new Date()){
  const {dateKey,hour,minute}=broker.getJakartaTimeInfo(now);
  const holidays=calendar.getSeedHolidaySet();

  // Hard guard in addition to crontab: EOD work is allowed only from 18:00 WIB
  // on an actual IDX trading day. Weekend / exchange-holiday firings are no-op.
  if(hour<18 || !calendar.isTradingDay(dateKey,holidays))return [];

  const dates=new Set();
  const known=new Set();
  const brokerDir=path.dirname(broker.markerPath('unused'));
  for(const dir of [stateDir(),brokerDir]) {
    if(!fs.existsSync(dir))continue;
    for(const name of fs.readdirSync(dir)) {
      if(!/^\d{4}-\d{2}-\d{2}\.json$/.test(name))continue;
      const date=name.slice(0,10);known.add(date);
      try {const m=JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'));if(m.complete!==true || (dir===brokerDir && m.version!==2))dates.add(date);}catch(_){dates.add(date);}
    }
  }

  // Start today's EOD batch. Older incomplete dates remain in the set and are
  // resumed now; they stay paused throughout weekends/holidays and before 18:00.
  dates.add(dateKey);

  // Recover any trading dates missed since the newest durable marker/state.
  const last=[...known].filter(d=>d<=dateKey).sort().pop();
  if(last && last<dateKey){
    const cursor=new Date(last+'T12:00:00Z');
    for(cursor.setUTCDate(cursor.getUTCDate()+1);cursor.toISOString().slice(0,10)<=dateKey;cursor.setUTCDate(cursor.getUTCDate()+1)){
      const date=cursor.toISOString().slice(0,10);
      if(!known.has(date)&&calendar.isTradingDay(date,holidays))dates.add(date);
    }
  }
  return [...dates].filter(d=>d<=dateKey).sort().reverse();
}
async function run(options={}){
  const dryRun=options.dryRun===true;
  const dates=pendingDates(options.now);
  for(const date of dates){
    if(!dryRun)writeState(date,{date,complete:false,updated_at:new Date().toISOString()});
    if(dryRun){console.log('PENDING_MARKET_DATE='+date);continue;}
    let brokerOk=false,candleOk=false;
    try{
      process.exitCode=undefined;
      const brokerArgs=['--date',date];
      if(hour===23 && minute>=30)brokerArgs.push('--final');
      const result=await broker.run(brokerArgs);
      const marker=broker.readMarker(date);
      brokerOk=Boolean(result&&result.skipped || marker&&marker.version===2&&marker.complete);
    }catch(error){console.error('BROKER_RETRY_PENDING',date,error.message);}
    try{
      const result=await candles.main({targetDate:date});
      candleOk=result.skipped===true || (result.universe>0 && !result.quota_stop && result.failed===0 && result.cached+result.fetched===result.universe);
    }catch(error){console.error('CANDLE_RETRY_PENDING',date,error.message);}
    writeState(date,{date,complete:brokerOk&&candleOk,broker_complete:brokerOk,candle_complete:candleOk,updated_at:new Date().toISOString()});
  }
  process.exitCode=undefined;
  if(!dryRun&&pendingDates(options.now).some(date=>{
    try{return JSON.parse(fs.readFileSync(path.join(stateDir(),date+'.json'),'utf8')).complete!==true;}catch(_){return true;}
  }))process.exitCode=3;
}
module.exports={run,pendingDates,stateDir};
if(require.main===module)run({dryRun:process.argv.includes('--dry-run')}).catch(error=>{console.error(error.message);process.exitCode=1;});
