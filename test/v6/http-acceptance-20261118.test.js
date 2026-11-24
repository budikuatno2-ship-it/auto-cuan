'use strict';
// OFFLINE SYNTHETIC ONLY. Run via the credential-free temporary-mirror runner.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
if(!process.env.OFFLINE_MIRROR_ROOT || path.resolve('.')!==path.resolve(process.env.OFFLINE_MIRROR_ROOT))throw new Error('TEMPORARY_MIRROR_REQUIRED');
const results=[],readbacks=[];let server;
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
function write(file,data){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(data));}
function stateHash(){const walk=d=>fs.existsSync(d)?fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(d,e.name)):[path.join(d,e.name)]):[];return sha(JSON.stringify(walk('data').filter(p=>!p.includes('daily-candles')).sort().map(p=>[p,sha(fs.readFileSync(p))])));}
const session=require('../../lib/admin-session');
const cookies={guest:'',user:'ac_sess='+session.createSessionToken({userId:'offline-user',username:'offline-user',isAdmin:false}),admin:'ac_sess='+session.createSessionToken({userId:'offline-admin',username:'offline-admin',isAdmin:true}),tampered:'ac_sess=v1.invalid.invalid'};
async function request(name,url,{role='guest',method='GET',body,raw,origin='same',expect}={}){
 const before=stateHash(),port=Number(process.env.OFFLINE_HTTP_PORT),payload=raw!==undefined?raw:body!==undefined?JSON.stringify(body):undefined;
 const headers={connection:'close'};if(cookies[role])headers.cookie=cookies[role];if(origin)headers.origin=origin==='same'?'http://127.0.0.1:'+port:origin;
 if(payload!==undefined){headers['content-type']='application/json';headers['content-length']=Buffer.byteLength(payload);}
 const response=await new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port,path:url,method,headers},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>{let data;try{data=JSON.parse(text);}catch{data={raw:text};}resolve({status:res.statusCode,body:data,text});});});req.on('error',reject);req.setTimeout(6000,()=>req.destroy(new Error('LOCAL_REQUEST_TIMEOUT')));if(payload!==undefined)req.write(payload);req.end();});
 const after=stateHash();results.push({name,url,role,method,origin,request_body_sha256:payload===undefined?null:sha(payload),status:response.status,body_sha256:sha(response.text),body:response.body,state_before:before,state_after:after});
 if(expect!==undefined)assert.equal(response.status,expect,name+': '+response.text.slice(0,600));
 if(response.status===401||response.status===403)assert.equal(after,before,'unauthorized mutation: '+name);
 return response.body;
}
test.before(async()=>{
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jakarta',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 for(let i=0;i<1105;i++){const ticker='Q'+[Math.floor(i/676),Math.floor(i/26)%26,i%26].map(n=>String.fromCharCode(65+n)).join('');write('data/daily-candles/'+ticker+'.json',{fixture:'OFFLINE SYNTHETIC',candles:[{date:today,open:100,high:101,low:99,close:100,volume:1000},{date:today,open:100,high:102,low:99,close:101,volume:1000}]});}
 write('data/fca-transition-2026-09-28.json',{fixture:'OFFLINE SYNTHETIC EMPTY DEPENDENCY ONLY',all_exit_tickers:[],active_as_of_status_date:[],suspended_as_of_status_date:[],reactivated_after_status_date:[]});
 const event=(name,extra)=>({ticker:'AAAA',name,date:'2026-11-10',shares_after:100,pct_after:'6%',...extra});
 write('data/insider-network/insiders-db.json',[event('Offline Published',{published_at:'2026-11-12T00:00:00Z'}),event('Offline Future',{published_at:'2099-01-01T00:00:00Z'}),event('Offline Unknown',{})]);
 server=require('../../tools/local-dev-server');if(!server.listening)await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
});
test.after(async()=>{
 write('http-results.json',results);write('http-state-readback.json',readbacks);write('http-guard-events.json',global.__offlineGuardEvents||[]);
 write('http-loaded-modules.json',Object.keys(require.cache).map(p=>p.includes('node_modules')?'node_modules/'+p.split('node_modules').pop().replace(/^[\\/]+/,'').replace(/\\/g,'/'):path.relative(process.cwd(),p).replace(/\\/g,'/')));
 if(server){server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}
});
test('actual production router: signed-session manual role and origin contract',async()=>{
 for(const role of ['guest','tampered'])await request('manual '+role,'/api/manual-screener',{role,method:'POST',body:{},expect:401});
 for(const role of ['user','admin']){const r=await request('manual '+role,'/api/manual-screener',{role,method:'POST',body:{},expect:200});assert.equal(r.total_universe,1105);assert.equal(r.scanned,1105);assert.equal(r.matched_count,1105);assert.equal(r.universe_truncated,false);}
 await request('manual CSRF','/api/manual-screener',{role:'user',method:'POST',origin:'https://disallowed.invalid',body:{},expect:403});
 await request('manual method','/api/manual-screener',{role:'admin',expect:405});
});
test('manual input validation, strict historical unknown and trusted-reference injection',async()=>{
 await request('manual invalid date','/api/manual-screener',{role:'user',method:'POST',body:{asOf:'2026-02-30'},expect:400});
 await request('manual invalid rule','/api/manual-screener',{role:'user',method:'POST',body:{rules:{logic:'AND',rules:[{field:'untrusted',op:'gt',value:0}]}},expect:400});
 const proof={verified:true,source:'OFFLINE SYNTHETIC',source_as_of:'2026-11-18T00:00:00Z',source_sha256:'a'.repeat(64)};
 const r=await request('manual reference injection','/api/manual-screener',{role:'user',method:'POST',body:{asOf:'2026-11-16',strictAsOf:true,eligibilityReference:{records:[{...proof,ticker:'QAAAA',security_id:'offline',state:'LISTED',effective_from:'2020-01-01'}],calendar:[{...proof,date:'2026-11-16',state:'TRADING_DAY'}]}},expect:200});
 assert.equal(r.historical_status,'NOT_VERIFIABLE');assert.equal(r.historical_denominator,null);assert.equal(r.eligibility_status,'UNKNOWN');assert.equal(r.matched_count,0);assert.ok(r.eligibility.every(e=>e.status==='UNKNOWN'));
 const u=await request('manual unknown PBV','/api/manual-screener',{role:'user',method:'POST',body:{rules:{logic:'AND',rules:[{field:'pbv',op:'lt',value:1}]}},expect:200});assert.equal(u.matched_count,0);assert.equal(u.excluded_unknown,1105);
});
test('manual malformed parsed bodies return 400 promptly',async()=>{
 for(const raw of ['null','[]','"invalid"','{'])await request('manual malformed '+raw,'/api/manual-screener',{role:'user',method:'POST',raw,expect:400});
});
test('Insider graph/search/roster are public before premium/database gate and enforce publication visibility',async()=>{
 for(const role of ['guest','user','admin']){
  const g=await request('graph historical '+role,'/api/sector-hot?action=insider-network&ticker=AAAA&as_of=2026-11-16',{role,expect:200});assert.equal(g.success,true);assert.equal(g.edges.length,1);assert.equal(g.summary.visibility.unknown,1);assert.equal(g.summary.visibility.excluded_after_cutoff,1);
  const r=await request('roster historical '+role,'/api/sector-hot?action=insider-roster&ticker=AAAA&as_of=2026-11-16',{role,expect:200});assert.equal(r.roster.length,1);assert.equal(r.publication_visibility.unknown.length,1);
 }
 const g=await request('graph current','/api/sector-hot?action=insider-network&ticker=AAAA',{expect:200});assert.equal(g.edges.length,2);assert.ok(g.edges.some(e=>e.publication_status==='UNKNOWN'));
 const s=await request('search historical future','/api/sector-hot?action=insider-network&search=1&q=Offline%20Future&as_of=2026-11-16',{expect:200});assert.equal(s.results.length,0);
 const r=await request('graph invalid asof','/api/sector-hot?action=insider-network&ticker=AAAA&as_of=bad',{expect:200});assert.equal(r.edges.length,0);assert.equal(r.summary.visibility.status,'UNKNOWN');
});
test('actual bandarmologi cached/fallback HTTP response filters missing/future publication',async()=>{
 for(let i=0;i<2;i++){
  const r=await request('bandarmologi fallback '+i,'/api/sector-hot?action=bandarmologi&ticker=AAAA&date=2026-11-16',{expect:200});
  assert.equal(r.insiders.length,1);assert.equal(r.insider_visibility.unknown.length,1);assert.equal(r.insider_visibility.excluded_after_cutoff,1);
 }
 const bandar=require('../../lib/bandarmologi-service');
 bandar.writeDiskCache('broker-summary','AAAA','2026-11-15',{fixture:'OFFLINE SYNTHETIC',date:'2026-11-15',stock_code:'AAAA',brokers:[]});
 const disk=await request('bandarmologi disk fixture','/api/sector-hot?action=bandarmologi&ticker=AAAA&date=2026-11-15',{expect:200});
 assert.equal(disk.from_disk,true);assert.equal(disk.insiders.length,1);assert.equal(disk.insider_visibility.unknown.length,1);
 const cached=await request('bandarmologi memory cache','/api/sector-hot?action=bandarmologi&ticker=AAAA&date=2026-11-15',{expect:200});
 assert.equal(cached.from_cache,true);assert.equal(cached.insiders.length,1);assert.equal(cached.insider_visibility.excluded_after_cutoff,1);assert.equal(cached.insider_visibility.unknown.length,1);
});
test('financial Admin roles/CSRF, legitimate write and direct fixture-state readback',async()=>{
 const url='/api/admin/financial-publication';
 for(const role of ['guest','tampered','user']){const status=role==='user'?403:401;await request('financial read '+role,url,{role,expect:status});await request('financial write '+role,url,{role,method:'POST',body:{action:'set_interval',retry_interval_days:7},expect:status});}
 await request('financial CSRF',url,{role:'admin',method:'POST',origin:'https://disallowed.invalid',body:{action:'set_interval',retry_interval_days:7},expect:403});
 await request('financial invalid interval',url,{role:'admin',method:'POST',body:{action:'set_interval',retry_interval_days:0},expect:400});
 await request('financial unknown action',url,{role:'admin',method:'POST',body:{action:'unsafe'},expect:400});
 await request('financial set interval',url,{role:'admin',method:'POST',body:{action:'set_interval',retry_interval_days:7},expect:200});
 const state=JSON.parse(fs.readFileSync(process.env.FINANCIAL_PUBLICATION_STATE_PATH));assert.equal(state.retryIntervalDays,7);readbacks.push({scenario:'legitimate admin interval',state,sha256:sha(fs.readFileSync(process.env.FINANCIAL_PUBLICATION_STATE_PATH))});
 await request('financial set anchor',url,{role:'admin',method:'POST',body:{action:'set_anchor',ticker:'AAAA',fiscal_year:2026,fiscal_year_end:'12-31'},expect:200});
 await request('financial retry',url,{role:'admin',method:'POST',body:{action:'retry',ticker:'AAAA',fiscal_year:2026,period:'Q1'},expect:200});
 const r=await request('financial persisted read',url,{role:'admin',expect:200});assert.equal(r.retryIntervalDays,7);assert.ok(r.records.some(x=>x.ticker==='AAAA'));
});
test('financial invalid anchor date and malformed shape cannot mutate state',async()=>{
 const url='/api/admin/financial-publication';
 for(const fiscal_year_end of ['02-30','13-01']){const before=stateHash();await request('financial invalid anchor '+fiscal_year_end,url,{role:'admin',method:'POST',body:{action:'set_anchor',ticker:'BBBB',fiscal_year:2026,fiscal_year_end},expect:400});assert.equal(stateHash(),before);}
 for(const raw of ['null','[]','{'])await request('financial malformed '+raw,url,{role:'admin',method:'POST',raw,expect:400});
});
test('offline financial receipt transitions persisted and observed through actual admin HTTP',async()=>{
 const monitor=require('../../lib/financial-publication-monitor'),adapter=require('../../lib/financial-publication-adapter');
 const rec=monitor.buildRecordsForIssuer({ticker:'ZZZZ',fiscalYear:2026,fiscalYearEnd:'12-31'})[0];
 const source=value=>adapter.createSource({id:'OFFLINE SYNTHETIC',fetchPublicationIndex:async()=>value});
 const observe=async(name,record)=>{const loaded=monitor.loadState();loaded.state.issuers.ZZZZ={'2026':[record]};monitor.saveState(loaded.state);const r=await request(name,'/api/admin/financial-publication?ticker=ZZZZ',{role:'admin',expect:200});assert.equal(r.records[0].status,record.status);readbacks.push({scenario:name,record:r.records[0]});};
 let invalidIndex=0;
 for(const receipt of [{available:true,source_url:'invalid',checksum:'x',publication_at:'2026-05-01'},{available:true,source_url:'https://offline.invalid/receipt',checksum:'a'.repeat(64)},{available:true,source_url:'https://offline.invalid/receipt',checksum:'a'.repeat(64),publication_at:'2099-01-01'},{available:false,reason:'no publication'}]){
  const r=await adapter.checkWithAdapter(rec,source(receipt),{now:'2026-11-18T00:00:00Z'});assert.notEqual(r.outcome,adapter.OUTCOME.VERIFIED);assert.ok([monitor.STATUS.PENDING,monitor.STATUS.UPSTREAM_UNAVAILABLE].includes(r.record.status));await observe('financial rejected receipt '+invalidIndex++,r.record);
 }
 const negative=await adapter.checkWithAdapter(rec,source({available:false,not_published:true}),{now:'2026-11-18T00:00:00Z'});assert.equal(negative.record.status,monitor.STATUS.MISSING_RETRY);assert.ok(negative.record.next_check_at);await observe('financial explicit no new publication',negative.record);
 await request('financial missing publication retry','/api/admin/financial-publication',{role:'admin',method:'POST',body:{action:'retry',ticker:'ZZZZ',fiscal_year:2026,period:rec.period},expect:200});
 const receipt={available:true,source_url:'https://offline.invalid/receipt',checksum:sha('OFFLINE SYNTHETIC RECEIPT BYTES'),publication_at:'2026-05-01T00:00:00Z',retrieved_at:'2026-11-18T00:00:00Z',audited_reviewed:true};
 const verified=await adapter.checkWithAdapter(negative.record,source(receipt),{now:'2026-11-18T00:00:00Z'});assert.equal(verified.outcome,adapter.OUTCOME.VERIFIED);
 const loaded=monitor.loadState();loaded.state.issuers.ZZZZ={'2026':[verified.record]};monitor.saveState(loaded.state);
 const r=await request('financial offline receipt readback','/api/admin/financial-publication?ticker=ZZZZ',{role:'admin',expect:200});assert.equal(r.records[0].status,monitor.STATUS.PUBLISHED_VERIFIED);readbacks.push({scenario:'offline adapter receipt, persisted locally then HTTP read',receipt,record:r.records[0]});
});
test('application guard rejects outbound, subprocess and outside state writes',()=>{
 assert.throws(()=>http.get('http://external.invalid'),/OFFLINE_NETWORK/);assert.throws(()=>require('node:net').connect(443,'external.invalid'),/OFFLINE_NETWORK/);assert.throws(()=>require('node:child_process').spawn('node'),/OFFLINE_NETWORK/);assert.throws(()=>fs.writeFileSync(path.resolve('..','denied'),''),/OFFLINE_WRITE/);
});
