const http=require('http'),fs=require('fs'),path=require('path'),assert=require('assert/strict'),puppeteer=require('puppeteer-core');
const {handleFinancialSnapshotAction}=require('../api/quote').__test;
const base=path.resolve(__dirname,'../public');
const os=require('node:os');
const auditRoot=fs.mkdtempSync(path.join(os.tmpdir(),'auto-cuan-d9-'));
const geometryFixture=require('./fixtures/final-audit-geometry/d9.json');
let guestMode=false;let fixtureMode='success',failTicker='',emptyTicker='',foreignMode='healthy';const queries=[],evidence=[],requests=[];
const record=(name,value)=>{evidence.push({name,value});const output=name==='MATRIX'?{theme:value.theme,width:value.width,scroll:value.scroll,client:value.client,metricHeights:value.metricHeights,clipping:value.clipping}:value;console.log(name,JSON.stringify(output));};
function db(){return {from(table){queries.push({table,foreignMode});let ticker;
 const result=()=>{if(ticker===failTicker)return {data:null,error:{message:'Local required dependency failure'}};
  if(table==='stock_fundamentals')return {data:ticker===emptyTicker?null:{ticker,book_value_per_share:ticker==='TLKM'?2000:3000,shares_outstanding:1000000,market_cap:9000000000,market_cap_source:'Stored EOD',market_cap_as_of:'2026-10-05',fundamental_period:'Q3-2026',source:'LOCAL '+ticker+' VERIFIED FIXTURE',updated_at:'2026-10-06T00:00:00Z'},error:null};
  if(table==='stock_daily_history')return {data:ticker===emptyTicker?[]:[{close:9000,trade_date:'2026-10-05',data_source:'stored EOD',data_quality_status:'ok'}],error:null};
  throw new Error('Financial requested unrelated table '+table);
 };return {select(){return this},eq(k,v){ticker=v;return this},order(){return this},limit(){return this},maybeSingle:async()=>result(),then(resolve,reject){return Promise.resolve().then(result).then(resolve,reject)}};
}}}
const server=http.createServer(async(req,res)=>{
 const u=new URL(req.url,'http://localhost');let body='';for await(const x of req)body+=x;let b={};try{b=JSON.parse(body)}catch{}
 if(u.pathname.startsWith('/api/')){
  requests.push(req.url);
  if(u.searchParams.get('action')==='financial-snapshot'){
   const out={status(code){this.code=code;return this},json(d){res.writeHead(this.code,{'Content-Type':'application/json'});res.end(JSON.stringify(d));return this}};
   await handleFinancialSnapshotAction({method:req.method,query:Object.fromEntries(u.searchParams)},out,db());return;
  }
  let d={success:true,data:[],rows:[],results:[]};
  const action=u.searchParams.get('action');
  if(action==='daily-market-context-list')d={success:true,data:[{ticker:'BBCA',free_float_pct:20,hsc_flag:false,market_structure_guard:'NORMAL',as_of_trade_date:'2026-10-05'},{ticker:'TLKM',free_float_pct:0,hsc_flag:true,market_structure_guard:'CAUTION',as_of_trade_date:'2026-10-05'},{ticker:'ASII',free_float_pct:null,hsc_flag:null,market_structure_guard:'UNKNOWN'}]};
  if(action==='daily-market-context')d={success:true,data:{ticker:u.searchParams.get('ticker'),market_structure:{free_float_pct:null,hsc_flag:null,market_structure_guard:'UNKNOWN'},fundamental:{}}};
  if(action==='watchlist')d={success:true,watchlist:[{ticker:'BBCA',notes:'Catatan fixture lokal',alerts:[],price:9000,price_change_pct:1.2},{ticker:'TLKM',notes:'',alerts:[],price:null}]};
  if(u.pathname==='/api/track-record'||action==='track-record')d={success:true,summary:{total_signals:1,total_resolved:0,running_signals:1,waiting_signals:0,win_rate_tp1:'—',win_rate_tp2:'—',sl_rate:'—'},signals:[{ticker:'BBCA',category:'top5',signal_date:'2026-10-05',entry_price:9000,sl_price:8500,tp1_price:9500,tp2_price:10000,outcome:'RUNNING',gain_pct:null}],by_category:{}};
  if(fixtureMode==='error' && (['screener','daily-market-context-list','watchlist','track-record'].includes(action)||u.pathname==='/api/track-record'))d={success:false,error:'Gangguan fixture lokal'};
  if(fixtureMode==='empty' && action==='daily-market-context-list')d={success:true,data:[]};
  if(fixtureMode==='empty' && action==='watchlist')d={success:true,watchlist:[]};
  if(fixtureMode==='loading')await new Promise(r=>setTimeout(r,800));

  if(u.pathname==='/api/maintenance-settings')d={success:true,config:{maintenanceMode:false}};
  else if(b.action==='session-status')d={success:true,userId:'batch-b-local-user',username:'auditfixture',isAdmin:false,isApproved:true,email_required:false,google_link_required:false,google_link_state:'linked'};
  else if(b.action==='account-google-status')d={success:true,google_link_state:'linked',google_linked:true,google_link_required:false,required:false};
  else if(b.action==='portfolio_access')d={success:true,user_id:'batch-b-local-user',username:'auditfixture'};
  else if(b.action==='account-profile')d={success:true,profile:{username:'auditfixture',is_approved:true,is_admin:false,subscription:{entitlement:{premium:true}}}};
  if(guestMode&&b.action==='session-status')d={success:false,error:'No local session'};res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(d));return;
 }
 let f=path.join(base,u.pathname);if(!path.extname(u.pathname))f=path.join(base,'index.html');
 if(!f.startsWith(base)||!fs.existsSync(f)||!fs.statSync(f).isFile()){res.writeHead(404);res.end();return;}
 const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json','.png':'image/png','.woff2':'font/woff2'};
 res.writeHead(200,{'Content-Type':mime[path.extname(f)]||'application/octet-stream'});res.end(fs.readFileSync(f));
});
const wait=ms=>new Promise(r=>setTimeout(r,ms));

require('node:test').test('D9 caption contrast and Portfolio preservation',async()=>{
 fs.mkdirSync(auditRoot,{recursive:true});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 const browser=await puppeteer.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,userDataDir:path.join(auditRoot,'profile'),args:['--no-sandbox','--disable-dev-shm-usage']});
 try{
 const p=await browser.newPage();await p.setRequestInterception(true);p.on('request',r=>r.url().startsWith(origin+'/')?r.continue():r.abort());
 const cdp=await p.createCDPSession(),sheets=new Map();cdp.on('CSS.styleSheetAdded',({header})=>sheets.set(header.styleSheetId,header.sourceURL));await cdp.send('DOM.enable');await cdp.send('CSS.enable');
 await p.setViewport({width:1440,height:900});await p.goto(origin+'/dashboard',{waitUntil:'networkidle0'});await p.evaluate(()=>hideOnboardingGuide(true));
 const nav=async r=>{await p.evaluate(r=>navigateTo(...r),r);await wait(450);};
 const ownership=async selector=>{const {root}=await cdp.send('DOM.getDocument');const {nodeId}=await cdp.send('DOM.querySelector',{nodeId:root.nodeId,selector});if(!nodeId)return [];const matched=await cdp.send('CSS.getMatchedStylesForNode',{nodeId});return matched.matchedCSSRules.map(({rule})=>({selector:rule.selectorList.text,file:sheets.get(rule.styleSheetId),line:rule.style.range?.startLine,properties:rule.style.cssProperties.filter(x=>/^(color|background|opacity)/.test(x.name))})).filter(x=>x.properties.length);};
 const measure=async selector=>p.$$eval(selector,els=>{const rgb=c=>{const a=c.match(/[\d.]+/g).map(Number);return[a[0],a[1],a[2],a[3]??1];},blend=(a,b)=>a.slice(0,3).map((c,i)=>c*a[3]+b[i]*(1-a[3])),bg=e=>{const a=rgb(getComputedStyle(e).backgroundColor);return a[3]===1?a.slice(0,3):blend(a,e.parentElement?bg(e.parentElement):[255,255,255]);},lum=a=>a.map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4}).reduce((n,x,i)=>n+x*[.2126,.7152,.0722][i],0);return els.filter(e=>e.getClientRects().length&&!e.closest('.hidden,[hidden]')).map(e=>{const s=getComputedStyle(e),b=bg(e),f=blend(rgb(s.color),b),l1=lum(f),l2=lum(b);return{id:e.id,cls:e.className,text:e.innerText,color:s.color,background:b,contrast:(Math.max(l1,l2)+.05)/(Math.min(l1,l2)+.05),font:s.fontSize,ariaHidden:!!e.closest('[aria-hidden=true]'),role:e.getAttribute('role'),width:e.getBoundingClientRect().width};});});


 const prior=geometryFixture;
 const failures=[];
 for(const theme of ['light','dark'])for(const width of [390,768,1440,1920]){
  await p.setViewport({width,height:900});await p.evaluate(t=>applyAppTheme(t),theme);await nav(['portofolio']);await p.evaluate(()=>openPortfolioTab('planner'));await wait(900);
  const rows=await measure('#portofolioPartialMount .budget-band span');assert.equal(rows.length,3);
  const geometry=await p.evaluate(()=>[...document.querySelectorAll('#portofolioPartialMount .budget-band, #portofolioPartialMount .budget-band span, #portofolioPartialMount .budget-band strong, #portofolioPartialMount #page-planner input, #portofolioPartialMount #page-planner button, #portofolioPartialMount #page-planner select')].filter(e=>e.getClientRects().length).map(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {tag:e.tagName,id:e.id,text:e.tagName==='INPUT'?e.value:e.textContent.trim(),x:r.x,y:r.y,width:r.width,height:r.height,font:s.font,color:e.matches('.budget-band span,.budget-band')?undefined:s.color,padding:s.padding};}));
  const item={theme,width,rows,geometry};record('CAPTIONS',item);
  if(prior.length)assert.deepEqual(geometry,prior.find(e=>e.name==='CAPTIONS'&&e.value.theme===theme&&e.value.width===width).value.geometry,'geometry/values/controls unchanged');
  for(const row of rows)if(row.contrast<4.5)failures.push({theme,width,text:row.text,ratio:row.contrast});
  assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1),'no whole-page overflow');

  const form=await measure('#portofolioPartialMount .field label');record('D8_FORM',{theme,width,rows:form});assert.ok(form.length&&form.every(r=>r.contrast>=4.5));
  await p.evaluate(()=>openPortfolioTab('ai'));await wait(500);const ai=await measure('#portofolioPartialMount .ai-data-card span');record('D8_AI',{theme,width,rows:ai});assert.ok(ai.length&&ai.every(r=>r.contrast>=4.5));
 }
 for(const width of [767,768,1179,1180,1181]){
  await p.setViewport({width,height:900});await p.evaluate(()=>openPortfolioTab('planner'));await wait(250);
  const layout=await p.evaluate(()=>{const tabs=document.querySelector('#portofolioPartialMount #tabStrip'),mobile=document.querySelector('#portofolioPartialMount #pccMobileSectionSelect');return {display:getComputedStyle(tabs).display,columns:getComputedStyle(tabs).gridTemplateColumns,mobileVisible:!!mobile.getClientRects().length,mobileHeight:mobile.getBoundingClientRect().height,overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth+1};});
  record('BREAKPOINT',{width,...layout});assert.equal(layout.mobileVisible,width<=767);assert.equal(layout.display,width<=767?'none':width<=1180?'flex':'grid');if(width>=1181)assert.equal(layout.columns.split(' ').length,7);assert.equal(layout.overflow,false);if(width<=767)assert.ok(layout.mobileHeight>=44);
 }
 assert.deepEqual(failures,[],'all Planner captions meet 4.5:1');
 }finally{try{await browser.close();}finally{try{server.closeAllConnections();await new Promise(r=>server.close(r));}finally{fs.rmSync(auditRoot,{recursive:true,force:true});}}}
});
