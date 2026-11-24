'use strict';
// OFFLINE SYNTHETIC fixtures only. Executed in the temporary source mirror.
const test = require('node:test');
const assert = require('node:assert/strict');
const graph = require('../../lib/insider-network-service');
const bandar = require('../../lib/bandarmologi-service');
const screen = require('../../lib/manual-screener');
const event = (extra = {}) => ({ ticker:'AAAA', name:'Offline Holder', date:'2026-11-10', shares_after:100, pct_after:'6%', ...extra });
const cutoff = '2026-11-16T16:00:00+07:00';
test('existing graph must not leak trade-before but publication-after cutoff', () => {
  const g = graph.buildInsiderNetworkGraph({records:[event({published_at:'2026-11-17T09:00:00+07:00'})], asOf:cutoff});
  assert.equal(g.edges.length,0);
});
test('normalization preserves full publication and separate ingestion timestamps', () => {
  const r = bandar.normalizeInsiders([event({published_at:'2026-11-16T15:30:00+07:00', received_at:'2026-11-18T12:00:00+07:00'})])[0];
  assert.equal(r.source_published_at,'2026-11-16T15:30:00+07:00');
  assert.equal(r.received_at,'2026-11-18T12:00:00+07:00');
});
test('unknown publication is explicit graph UNKNOWN, not historical false/verified', () => {
  const g = graph.buildInsiderNetworkGraph({records:[event()], asOf:cutoff});
  assert.equal(g.edges.length,0);
  assert.equal(g.summary.visibility.unknown,1);
  assert.equal(g.summary.visibility.status,'UNKNOWN');
});
test('strict historical screen must not screen current rows as historical eligible', () => {
  const r = screen.runScreen({strictAsOf:true, asOf:'2026-11-16', rows:[{ticker:'AAAA',_as_of:'2026-11-16',price:100}], nowMs:Date.parse(cutoff)});
  assert.equal(r.matched_count,0);
  assert.equal(r.eligibility[0].status,'UNKNOWN');
  assert.equal(r.historical_status,'NOT_VERIFIABLE');
});
function visibility(records, asOf=cutoff, extra={}) { return require('../../lib/insider-source-visibility').selectVisibleInsiders(records,{asOf,...extra}); }
test('later ingestion never blocks historically published evidence', () => {
  assert.equal(visibility([event({source_published_at:'2026-11-16T08:00:00Z',received_at:'2026-11-18T08:00:00Z'})]).records.length,1);
});
test('WIB boundary and equal instant are inclusive; next millisecond excluded', () => {
  assert.equal(visibility([event({published_at:'2026-11-16T09:00:00Z'})]).records.length,1);
  assert.equal(visibility([event({published_at:'2026-11-16T09:00:00.001Z'})]).records.length,0);
  assert.equal(visibility([event({published_at:'2026-11-16T16:59:59.999Z'})],'2026-11-16').records.length,1);
  assert.equal(visibility([event({published_at:'2026-11-16T17:00:00Z'})],'2026-11-16').records.length,0);
});
for (const value of [null,'2026-02-30T10:00:00Z','2026-11-16','2026-11-16T10:00:00','garbage']) test('publication unknown/invalid remains UNKNOWN: '+value, () => {
  const r=visibility([event({published_at:value,filing_date:'2026-11-10',received_at:'2026-11-11T00:00:00Z'})]);
  assert.equal(r.records.length,0); assert.equal(r.unknown.length,1);
});
test('conflicting publication aliases are UNKNOWN', () => { assert.equal(visibility([event({source_published_at:'2026-11-10T00:00:00Z',published_at:'2026-11-17T00:00:00Z'})]).unknown.length,1); });
test('filing date is never normalized into source publication timestamp',()=>{
 const r=bandar.normalizeInsiders([event({filing_date:'2026-11-10',published_at:null,source_published_at:null})])[0];
 assert.equal(r.filing_date,'2026-11-10'); assert.equal(r.signal_available_date,'2026-11-10');
 assert.equal(r.source_published_at,null); assert.equal(r.publication_status,'UNKNOWN');
});
test('empty events, not due and unknown never imply no disclosure or no flow', () => {
  assert.equal(visibility([]).status,'UNKNOWN');
  assert.equal(visibility([],cutoff,{dueStatus:'NOT_DUE'}).status,'NOT_DUE');
  assert.equal(visibility([event({published_at:'2026-11-17T00:00:00Z'})]).status,'NO_VISIBLE_EVENTS');
});
test('current graph retains unverified roster and original event date explicitly', () => {
  const g=graph.buildInsiderNetworkGraph({records:[event()]});
  assert.equal(g.edges.length,1); assert.equal(g.edges[0].as_of,'2026-11-10');
  assert.equal(g.edges[0].publication_status,'UNKNOWN');
});
const proof={verified:true,source:'OFFLINE SYNTHETIC IDX REFERENCE',source_as_of:'2026-11-18T00:00:00Z',source_sha256:'a'.repeat(64)};
const reference=(extra={})=>({...proof,ticker:'AAAA',security_id:'offline-1',effective_from:'2026-11-10',effective_to:'2026-11-20',state:'LISTED',...extra});
const calendar=(date='2026-11-16',state='TRADING_DAY')=>({...proof,date,state});
function eligible(date='2026-11-16',records=[reference()],cal=[calendar(date)]) { return require('../../lib/historical-ticker-eligibility').resolveEligibility('AAAA',date,{records,calendar:cal}); }
test('listing inclusive; before listing UNKNOWN absent explicit not-listed evidence; delisting exclusive',()=>{
 assert.equal(eligible('2026-11-10').status,'ELIGIBLE');
 assert.equal(eligible('2026-11-09').status,'UNKNOWN');
 assert.equal(eligible('2026-11-20').status,'INELIGIBLE');
 assert.equal(eligible('2026-11-20').reason,'NOT_LISTED_ON_DATE');
 assert.equal(eligible('2026-11-20',[reference({effective_from:'2026-11-20',effective_to:null,state:'NOT_LISTED'})]).reason,'NOT_LISTED_ON_DATE');
});
for(const state of ['SUSPENDED','NO_TRADE','NOT_LISTED','TICKER_CHANGED']) test('distinct eligibility reason '+state,()=>{
 const r=eligible(undefined,[reference({state})]); assert.equal(r.status,'INELIGIBLE'); assert.equal(r.reason,{SUSPENDED:'SUSPENDED_VERIFIED',NO_TRADE:'NO_TRADE_PROVEN',NOT_LISTED:'NOT_LISTED_ON_DATE',TICKER_CHANGED:'TICKER_CHANGED'}[state]); assert.equal(r.evidence[0].source_sha256,proof.source_sha256);
});
test('suspension/resume use nonoverlapping half-open boundaries',()=>{
 const records=[reference({state:'SUSPENDED',effective_to:'2026-11-16'}),reference({effective_from:'2026-11-16'})];
 assert.equal(eligible('2026-11-15',records).reason,'SUSPENDED_VERIFIED'); assert.equal(eligible('2026-11-16',records).status,'ELIGIBLE');
});
test('calendar holiday excluded; absent/unverified reference UNKNOWN including weekend',()=>{
 assert.equal(eligible(undefined,undefined,[calendar(undefined,'HOLIDAY')]).reason,'NON_TRADING_DAY');
 assert.equal(eligible(undefined,undefined,[]).status,'UNKNOWN');
 assert.equal(eligible(undefined,undefined,[{...calendar(),verified:false}]).status,'UNKNOWN');
 assert.equal(eligible('2026-11-15',undefined,[]).status,'UNKNOWN');
});
test('conflicts, duplicate records and ticker identity collisions rejected',()=>{
 for(const records of [[reference(),reference()], [reference(),reference({state:'SUSPENDED'})], [reference(),reference({ticker:'BBBB'})]]) assert.equal(eligible(undefined,records).status,'UNKNOWN');
 assert.equal(eligible(undefined,undefined,[calendar(),calendar()]).status,'UNKNOWN');
});
test('unverified, invalid interval and missing hash cannot establish eligibility',()=>{
 for(const extra of [{verified:false},{source_sha256:null},{effective_from:'2026-02-30'},{effective_to:'2026-11-01'},{state:'LIVE_UNIVERSE'}]) assert.equal(eligible(undefined,[reference(extra)]).status,'UNKNOWN');
});
test('strict preflight uses authoritative supplied records but never certifies current financial rows PIT',()=>{
 const r=screen.runScreen({strictAsOf:true,asOf:'2026-11-16',eligibilityReference:{records:[reference()],calendar:[calendar()]},rows:[{ticker:'AAAA',_as_of:'2026-11-16'}]});
 assert.equal(r.eligibility[0].status,'ELIGIBLE'); assert.equal(r.matched_count,0); assert.equal(r.historical_status,'NOT_VERIFIABLE');
});
test('ordinary current screening remains available without historical metadata',()=>{
 assert.equal(screen.runScreen({rows:[{ticker:'AAAA',_as_of:'2026-11-16'}],nowMs:Date.parse(cutoff)}).matched_count,1);
});
test('aggregation filters before latest holding selection; search/profile respect cutoff',()=>{
const records=[event({published_at:'2026-11-12T00:00:00Z',shares_after:100}),event({date:'2026-11-15',published_at:'2026-11-17T00:00:00Z',shares_after:900})];
const g=graph.buildInsiderNetworkGraph({name:'Offline Holder',records,asOf:cutoff});
assert.equal(g.edges[0].shares,100); assert.equal(g.edges[0].publication_status,'VISIBLE');
assert.equal(g.summary.visibility.excluded_after_cutoff,1);
assert.equal(graph.searchInsiders('Offline Holder',{records:[records[1]],asOf:cutoff}).length,0);
assert.equal(graph.getInsiderProfile('Offline Holder',{records:[records[1]],asOf:cutoff}),null);
});
test('invalid cutoff and future publication never visible; renormalization is stable',()=>{
assert.equal(visibility([event({published_at:'2026-11-10T00:00:00Z'})],'bad').status,'UNKNOWN');
assert.equal(require('../../lib/insider-source-visibility').selectVisibleInsiders([event({published_at:'2099-01-01T00:00:00Z'})]).records.length,0);
const rows=bandar.normalizeInsiders(bandar.normalizeInsiders([event({published_at:'2026-11-17T00:00:00Z'})]));
assert.equal(visibility(rows).records.length,0);
});
test('ticker rename boundaries do not silently alias old ticker',()=>{
const resolver=require('../../lib/historical-ticker-eligibility').resolveEligibility;
const records=[reference({effective_to:'2026-11-16'}),reference({ticker:'BBBB',effective_from:'2026-11-16'})];
assert.equal(resolver('AAAA','2026-11-16',{records,calendar:[calendar()]}).status,'INELIGIBLE');
assert.equal(resolver('AAAA','2026-11-16',{records,calendar:[calendar()]}).reason,'TICKER_CHANGED');
assert.equal(resolver('BBBB','2026-11-16',{records,calendar:[calendar()]}).status,'ELIGIBLE');
assert.equal(require('../../lib/v6-historical-reconciliation').preflightHistoricalEligibility(['AAAA'],'2026-11-16').historical_denominator,null);
});
test('roster current UNKNOWN remains displayed; historical UNKNOWN has an explicit bucket',()=>{
graph.setCustomUniverse([event()]);
try {
 const current=graph.getRosterForTicker('AAAA');
 assert.equal(current[0].publication_status,'UNKNOWN'); assert.equal(current[0].last_date,'2026-11-10');
 const historical=graph.getRosterVisibilityForTicker('AAAA',{asOf:cutoff});
 assert.equal(historical.records.length,0); assert.equal(historical.unknown.length,1);
} finally {graph.setCustomUniverse(null);}
});
test('bandarmologi historical consumer filters fallback roster after every cached response',async()=>{
graph.setCustomUniverse([event({published_at:'2026-11-17T00:00:00Z'}),event({name:'Unknown Holder'})]);
try {
 const response=await bandar.getBandarmologiData('AAAA',{date:'2026-11-16',allowLiveFetch:false});
 assert.equal(response.insiders.length,0);
 assert.equal(response.insider_visibility.status,'UNKNOWN');
 assert.equal(response.insider_visibility.unknown.length,1);
 assert.equal(response.insider_visibility.excluded_after_cutoff,1);
 const repeated=await bandar.getBandarmologiData('AAAA',{date:'2026-11-16',allowLiveFetch:false});
 assert.deepEqual(repeated.insider_visibility,response.insider_visibility);
} finally {graph.setCustomUniverse(null);}
});
test('manual handler authenticates and exposes unknown preflight without trusting client reference',async()=>{
 const auth=require('../../lib/admin-session');
 const handler=require('../../api/manual-screener');
 const old=process.env.SESSION_SECRET;
 process.env.SESSION_SECRET=require('node:crypto').randomBytes(32).toString('hex');
 const fs=require('node:fs'),path=require('node:path');
 const dir=path.resolve('data/daily-candles'); fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(dir,'AAAA.json'),JSON.stringify({candles:[]}));
 const response=()=>({setHeader(){},end(s){this.body=JSON.parse(s);}});
 try {
  const token=auth.createSessionToken({userId:'offline-only',username:'offline'});
  const headers={host:'offline.invalid',origin:'https://offline.invalid',cookie:'ac_sess='+token};
  const res=response(); await handler({method:'POST',headers,body:{asOf:'2026-11-16',strictAsOf:true,eligibilityReference:{records:[reference()],calendar:[calendar()]}}},res);
  assert.equal(res.statusCode,200); assert.equal(res.body.historical_status,'NOT_VERIFIABLE');
  assert.equal(res.body.eligibility[0].status,'UNKNOWN');
  const noAuth=response(); await handler({method:'POST',headers:{host:'offline.invalid'},body:{}},noAuth); assert.equal(noAuth.statusCode,401);
  const cross=response(); await handler({method:'POST',headers:{...headers,origin:'https://other.invalid'},body:{}},cross); assert.equal(cross.statusCode,403);
  const invalid=response(); await handler({method:'POST',headers,body:{asOf:'2026-02-30'}},invalid); assert.equal(invalid.statusCode,400);
 } finally {if(old===undefined)delete process.env.SESSION_SECRET;else process.env.SESSION_SECRET=old; fs.unlinkSync(path.join(dir,'AAAA.json'));}
});
test('actual Insider graph and roster handler bodies propagate cutoff and explicit unknowns',async()=>{
 // Execute actual handler declarations in VM to avoid loading the unrelated
 // giant endpoint's external Supabase dependency; this is handler-body, not HTTP E2E.
 const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
 const source=fs.readFileSync(path.resolve('api/sector-hot.js'),'utf8');
 const take=(name,next)=>source.slice(source.indexOf('async function '+name+'('),source.indexOf(next,source.indexOf('async function '+name+'(')));
 const context={require:(id)=> id==='../lib/insider-network-service'?graph: id==='../lib/insider-source-visibility'?require('../../lib/insider-source-visibility'):require(id),auditRosterIntegrity:()=>({}),ROSTER_SOURCE_OWNERSHIP:'OFFLINE',ROSTER_OWNERSHIP_AS_OF:'2026-09-30',ROSTER_SOURCE_TRANSACTIONS:'OFFLINE'};
 vm.createContext(context);
 vm.runInContext(take('handleInsiderNetwork','let marketStructure30SepCache')+'\n'+take('handleInsiderRoster','async function handleTelegramDailyRecap'),context);
 const response=()=>({status(c){this.statusCode=c;return this;},json(b){this.body=b;return this;}});
 graph.setCustomUniverse([event({published_at:'2026-11-17T00:00:00Z'}),event({name:'Unknown Holder'})]);
 try {
  const g=response(); await context.handleInsiderNetwork({query:{ticker:'AAAA',as_of:cutoff}},g);
  assert.equal(g.statusCode,200); assert.equal(g.body.edges.length,0); assert.equal(g.body.summary.visibility.unknown,1);
  const r=response(); await context.handleInsiderRoster({query:{ticker:'AAAA',as_of:cutoff}},r);
  assert.equal(r.statusCode,200); assert.equal(r.body.roster.length,0); assert.equal(r.body.publication_visibility.unknown.length,1);
  const c=response(); await context.handleInsiderRoster({query:{ticker:'AAAA'}},c); assert.equal(c.body.roster.length,2);
 } finally {graph.setCustomUniverse(null);}
});
test('offline guard denies network, subprocess and outside-mirror write',()=>{
assert.throws(()=>fetch('https://offline.invalid'),/OFFLINE_NETWORK/);
assert.throws(()=>require('node:net').connect(443,'offline.invalid'),/OFFLINE_NETWORK/);
assert.throws(()=>require('node:child_process').spawn('node'),/OFFLINE_NETWORK/);
assert.throws(()=>require('node:fs').writeFileSync(require('node:path').resolve('..','outside-v6-test'),''),/OFFLINE_WRITE/);
});
