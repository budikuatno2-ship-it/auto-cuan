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
  const dryRun=options.dryRun===true;
  const {hour,minute}=broker.getJakartaTimeInfo(options.now || new Date());
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
module.exports={run,pendingDates,stateDir,readMarketState,previousDateNeedsWork};
if(require.main===module)run({dryRun:process.argv.includes('--dry-run')}).catch(error=>{console.error(error.message);process.exitCode=1;});
