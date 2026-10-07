'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const puppeteer = require('puppeteer-core');

const root = path.resolve(__dirname, '..');
const publicRoot = path.join(root, 'public');
// Geometry-only committed contract; historical audit evidence is never a test input.
const geometryFixture = require('./fixtures/final-audit-geometry/d6.json');
const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-cuan-d6-'));
const records = [
  { ticker: 'BBCA', free_float_pct: 20, hsc_flag: false, market_structure_guard: 'NORMAL' },
  { ticker: 'TLKM', free_float_pct: 0, hsc_flag: true, market_structure_guard: 'CAUTION' },
  { ticker: 'ASII', free_float_pct: null, hsc_flag: null, market_structure_guard: 'UNKNOWN' }
].map(row => ({ ...row, free_float_source: 'Local exchange fixture', free_float_as_of: '2026-10-05', hsc_source: 'Local HSC fixture', hsc_as_of: '2026-10-05', as_of_trade_date: '2026-10-05', regulatory_compliance_status: 'NOT_EVALUATED', market_structure_note: 'Referensi risiko, bukan putusan kepatuhan.' }));
let historyMode = 'empty';
let server, browser, page, origin, mode = 'success', detailReads = 0;
const sheets = new Map();
let cdp;
const evidence = [];
const record = (name, value) => evidence.push({ name, value });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

before(async () => {
  fs.mkdirSync(evidenceRoot, { recursive: true });
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      let body = ''; for await (const chunk of req) body += chunk;
      let input = {}; try { input = JSON.parse(body); } catch (_) {}
      const action = url.searchParams.get('action');
      let payload = { success: true, data: [], rows: [], results: [] };
      if(action==='watchlist-alert-history'){await pause(1200);payload={success:true,history:historyMode==='empty'?[]:['created','updated','deleted','triggered'].map(action=>({action,ticker:'BBCA',target_price:9000,created_at:'2026-10-05T08:00:00Z'}))};} else if (action === 'watchlist') { payload = {success:true,watchlist:watchlist}; } else if (url.pathname === '/api/track-record' || action === 'track-record') { payload = {success:true,signals:signals,summary:{total_signals:signals.length,total_resolved:3,running_signals:1,waiting_signals:1,win_rate_tp1:50,win_rate_tp2:25,sl_rate:25},by_category:{}}; } else if (input.action === 'portfolio_access') { payload = {success:true,user_id:'d1-local-user',username:'auditfixture'}; } else if (action === 'daily-market-context-list') {
        if (mode === 'loading') await pause(600);
        payload = mode === 'error' ? { success: false, error: 'Daftar fixture tidak tersedia. Coba lagi.' } : { success: true, data: mode === 'empty' ? [] : records };
      } else if (action === 'daily-market-context') {
        detailReads++;
        payload = { success: true, context: { market_structure: records.find(row => row.ticker === url.searchParams.get('ticker')) } };
      } else if (action === 'financial-snapshot') {
        payload = { success: true, snapshot: { fundamental: { pbv: 3, book_value_per_share: 3000, market_cap: 9000000000, shares_outstanding: 1000000, fundamental_period: 'Q3-2026', fundamental_source: 'Local verified filing', fundamental_updated_at: '2026-10-06' }, price: { last_price_as_of: '2026-10-05', last_price_source: 'Local EOD', freshness: 'fresh' } } };
      } else if (input.action === 'session-status') {
        payload = { success: true, userId: 'd1-local-user', username: 'auditfixture', isAdmin: false, isApproved: true, google_link_state: 'linked', google_link_required: false, email_required: false };
      } else if (input.action === 'account-google-status') {
        payload = { success: true, google_link_state: 'linked', google_linked: true, required: false };
      } else if (input.action === 'account-profile') {
        payload = { success: true, profile: { username: 'auditfixture', is_approved: true, is_admin: false, subscription: { entitlement: { premium: true } } } };
      } else if (url.pathname === '/api/maintenance-settings') {
        payload = { success: true, config: { maintenanceMode: false } };
      }
      res.writeHead(mode === 'error' && action === 'daily-market-context-list' ? 503 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload)); return;
    }
    const route = url.pathname === '/analisis-saham' ? '/analisis-saham.html' : url.pathname;
    const file = path.resolve(publicRoot, '.' + (path.extname(route) ? route : '/index.html'));
    if (!file.startsWith(publicRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' };
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' }); res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  browser = await puppeteer.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, userDataDir: path.join(evidenceRoot, 'browser-profile'), args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  page = await browser.newPage(); page.setDefaultTimeout(5000);
  await page.setRequestInterception(true);
  page.on('request', request => request.url().startsWith(origin + '/') ? request.continue() : request.abort());
  cdp = await page.createCDPSession();
  cdp.on('CSS.styleSheetAdded', ({header}) => sheets.set(header.styleSheetId, header.sourceURL));
  await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
  await page.evaluateOnNewDocument(() => {
    window.__d1Listeners = { document: 0, window: 0 };
    for (const [target, key] of [[document, 'document'], [window, 'window']]) {
      const original = target.addEventListener.bind(target);
      target.addEventListener = function (...args) { window.__d1Listeners[key]++; return original(...args); };
    }
  });
});
after(async () => {
  try { if (browser) await browser.close(); } finally {
    try { if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } }
    finally { fs.rmSync(evidenceRoot, { recursive: true, force: true }); }
  }
});

const watchlist = [
 {ticker:'BBCA',notes:'Local gain fixture',alerts:[],price:9000,change_pct:1.2},
 {ticker:'TLKM',notes:'Local loss fixture',alerts:[],price:3000,change_pct:-1.2}
];
const signals = ['RUNNING','TP1_HIT','TP2_HIT','SL_HIT','WAITING','EXPIRED'].map((outcome,i)=>({ticker:['BBCA','TLKM','ASII','BBRI','BMRI','BREN'][i],category:'top5',signal_date:'2026-10-05',entry_price:9000,sl_price:8500,tp1_price:9500,tp2_price:10000,outcome,gain_pct:outcome==='SL_HIT'?-5:outcome.startsWith('TP')?5:null}));
const routes={watchlist:['watchlist'],trackrecord:['trackrecord'],structure:['analisis','market-structure'],intel:['analisis','intel'],hunter:['analisis','hunter']};
const targets={watchlist:'#page-watchlist .text-amber-400, #page-watchlist .text-amber-400\\/70, .wl-mobile-btn-alert, .wl-mobile-btn-danger, .wl-no-alert, .wl-hist-time, .wl-hist-empty, .wl-hist-loading, .wl-empty-filter-sub',trackrecord:'#trSlHitsSub, #trTp1HitsSub, #trTp2HitsSub, #trBestGainSub, .tr-stat-lbl, .tr-cat-desc, .tr-subtext-line, .tr-mobile-footer',structure:'#panel-tab-market-structure .ac-research-kicker, #panel-tab-market-structure .ac-label-muted, #panel-tab-market-structure .ac-detail-sub, #panel-tab-market-structure .ac-cell-date, #panel-tab-market-structure .ac-badge',intel:'#panel-tab-intel .grid > div > .text-\\[10px\\]',hunter:'#panel-tab-hunter .text-sky-400, #panel-tab-hunter .text-emerald-400, #panel-tab-hunter .ac-hunter-legend'};
async function navigate(route){
 await page.evaluate(r=>{hideOnboardingGuide(true);navigateTo(...r);},routes[route]);
 await page.waitForNetworkIdle({idleTime:200,timeout:15000});await pause(500);
 if(route==='hunter')await page.evaluate(()=>BandarmologiRuntime.loadBrokerHunter(document.getElementById('brokerHunterContent')));
 if(route==='intel')await page.evaluate(()=>BandarmologiRuntime.renderBandarmologiIntelUI(document.getElementById('bandarmologiIntelContent'),{success:true,ticker:'BBCA',signals:{},result:{ticker:'BBCA',signals:{}}}));
}
async function measurements(selector) {
 const result=await page.$$eval(selector, els=>{
  const rgb=c=>{const a=(c.match(/[\d.]+/g)||[]).map(Number);return [a[0]||0,a[1]||0,a[2]||0,a[3]??1];};
  const blend=(f,b)=>f.slice(0,3).map((v,i)=>v*f[3]+b[i]*(1-f[3]));
  const background=e=>{const c=rgb(getComputedStyle(e).backgroundColor);return c[3]===1?c.slice(0,3):blend(c,e.parentElement?background(e.parentElement):[255,255,255]);};
  const lum=a=>a.map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
  const ratio=(a,b)=>{const x=lum(a),y=lum(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
  return els.filter(e=>e.getClientRects().length&&!e.closest('.hidden,[hidden],svg')).map(e=>{
   const s=getComputedStyle(e),bg=background(e),outside=e.parentElement?background(e.parentElement):bg,r=e.getBoundingClientRect();
   const ancestors=[];for(let a=e;a;a=a.parentElement){const st=getComputedStyle(a);if(st.backgroundImage!=='none'||st.opacity!=='1')ancestors.push({element:a.id||a.className,image:st.backgroundImage,opacity:st.opacity});if(rgb(st.backgroundColor)[3]===1)break;}
   return {id:e.id,cls:e.className,text:(e.textContent||e.value||e.placeholder||'').trim().slice(0,100),foreground:s.color,background:s.backgroundColor,effectiveBackground:bg,ratio:ratio(blend(rgb(s.color),bg),bg),border:s.borderTopColor,boundaryRatio:ratio(blend(rgb(s.borderTopColor),outside),outside),outline:s.outlineColor,outlineWidth:s.outlineWidth,focusVisible:e.matches(':focus-visible'),focusRatio:ratio(blend(rgb(s.outlineColor),outside),outside),width:r.width,height:r.height,font:s.fontSize,ancestors};
  });
 });
 // Sample native paint beneath translucent/gradient surfaces without rewriting CSS.
 const elements=await page.$$(selector);let index=0;
 for(const el of elements){
  if(!await el.evaluate(e=>e.getClientRects().length&&!e.closest('.hidden,[hidden],svg')))continue;
  const row=result[index++];if(!row.ancestors.length)continue;
  await el.evaluate(e=>e.scrollIntoView({behavior:'instant',block:'center',inline:'nearest'}));
  const sample=await el.evaluate(e=>{const r=e.getBoundingClientRect();return {x:scrollX+Math.max(0,Math.min(innerWidth-16,Math.floor(r.left+r.width/2)-8)),y:scrollY+Math.max(0,Math.min(innerHeight-1,Math.floor(r.bottom)-1))};});
  const buffer=await page.screenshot({clip:{x:sample.x,y:sample.y,width:16,height:1}});
  const pixels=require('pngjs').PNG.sync.read(buffer).data,counts=new Map();for(let i=0;i<pixels.length;i+=4){const key=[...pixels.slice(i,i+3)].join(',');counts.set(key,(counts.get(key)||0)+1);}row.paintBackground=[...counts].sort((a,b)=>b[1]-a[1])[0][0].split(',').map(Number);
  const rgba=(row.foreground.match(/[\d.]+/g)||[]).map(Number),a=rgba[3]??1;
  const foreground=rgba.slice(0,3).map((c,i)=>c*a+row.paintBackground[i]*(1-a));
  const lum=c=>c.map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
  const l1=lum(foreground),l2=lum(row.paintBackground);row.composedRatio=row.ratio;row.ratio=(Math.max(l1,l2)+.05)/(Math.min(l1,l2)+.05);
 }
 return result;
}
async function ownership(selector) {
 const {root:doc}=await cdp.send('DOM.getDocument');
 const {nodeId}=await cdp.send('DOM.querySelector',{nodeId:doc.nodeId,selector});
 if(!nodeId)return [];
 const matched=await cdp.send('CSS.getMatchedStylesForNode',{nodeId});
 return (matched.matchedCSSRules||[]).map(({rule})=>({selector:rule.selectorList.text,file:sheets.get(rule.styleSheetId),line:rule.style.range?.startLine,media:rule.media,properties:rule.style.cssProperties.filter(p=>/^(color|background|background-color|border-color|outline|--ac-|--pw-)/.test(p.name)&&!p.disabled)})).filter(r=>r.properties.length);
}

beforeEach(async()=>{
 await page.setViewport({width:1440,height:900});await page.goto(origin+'/dashboard',{waitUntil:'networkidle0'});
 await page.evaluate(()=>{hideOnboardingGuide(true);applyAppTheme('light');});
});
for(const route of Object.keys(routes))for(const width of [390,1440])for(const theme of ['light','dark'])test(`D6 ${route} ${theme} ${width}`,async()=>{
 await page.setViewport({width,height:900});await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:width===390,maxTouchPoints:1});
 await page.evaluate(t=>applyAppTheme(t),theme);await navigate(route);
 const rows=await measurements(targets[route]);
 const geometry=await page.evaluate(()=>({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));
 const owners=[];for(const selector of targets[route].split(', '))owners.push({selector,rules:await ownership(selector)});
 record('D6_MATRIX',{route,width,theme,state:'populated/empty-alert fixtures',rows,geometry,owners});

 {assert.ok(rows.length,route+' targets absent');assert.ok(rows.every(r=>r.ratio>=4.5),JSON.stringify(rows.filter(r=>r.ratio<4.5)));assert.ok(geometry.scroll<=geometry.client+1);}
 if(route==='intel')assert.equal(rows.length,6,'all six Intel labels must be visible');
 {
  const beforeRecords=geometryFixture;
  const old=beforeRecords.find(r=>r.name==='D6_MATRIX'&&r.value.route===route&&r.value.width===width&&r.value.theme===theme)?.value;
  assert.ok(old,'baseline geometry evidence missing');
  for(const row of rows){const previous=old.rows.find(r=>r.text===row.text&&r.id===row.id);if(previous){assert.ok(Math.abs(row.width-previous.width)<1,'width changed: '+row.text);assert.ok(Math.abs(row.height-previous.height)<1,'height changed: '+row.text);assert.equal(row.font,previous.font);}}
  const numbers=r=>r.foreground.match(/[\d.]+/g).map(Number);
  if(route==='watchlist'){
   const warning=rows.find(r=>r.text==='Menunggu trigger harga');assert.ok(warning);const [red,green,blue]=numbers(warning);assert.ok(red>green&&green>blue,'warning must retain amber meaning');
   assert.ok(rows.some(r=>r.cls==='wl-no-alert'));
   if(width===390){const action=rows.find(r=>r.cls.includes('wl-mobile-btn-alert'));assert.ok(action&&action.boundaryRatio>=3);const el=await page.$('.wl-mobile-btn-alert');await el.focus();const focused=(await measurements('.wl-mobile-btn-alert')).find(r=>r.focusVisible);assert.ok(focused&&focused.focusRatio>=3&&parseFloat(focused.outlineWidth)>0);await el.hover();assert.ok((await measurements('.wl-mobile-btn-alert')).every(r=>r.ratio>=4.5));}
  }
  if(route==='trackrecord'){
   const loss=rows.find(r=>r.id==='trSlHitsSub'),gain=rows.find(r=>r.id==='trTp1HitsSub');assert.ok(loss&&gain);assert.ok(numbers(loss)[0]>numbers(loss)[1]);assert.ok(numbers(gain)[1]>numbers(gain)[0]);assert.ok(rows.some(r=>r.id==='trBestGainSub'));
  }
  if(route==='structure'){assert.ok(rows.some(r=>r.cls==='ac-research-kicker'));assert.ok(rows.some(r=>r.cls.includes('ac-label-muted')));const warning=rows.find(r=>r.text==='HSC Aktif');assert.ok(warning);const [red,green,blue]=numbers(warning);assert.ok(red>green&&green>blue);}
  if(route==='hunter'){
   assert.ok(rows.some(r=>r.text.includes('Asing / Foreign')));
   await page.evaluate(()=>BandarmologiRuntime.setHunterBroker('YP'));await page.waitForSelector('#panel-tab-hunter .ac-hunter-legend-local',{visible:true});
   await pause(300);const local=await measurements('#panel-tab-hunter .ac-hunter-legend-local');record('HUNTER_LOCAL',{theme,width,rows:local});assert.ok(local.length&&local.every(r=>r.ratio>=4.5));assert.ok(local.every(r=>numbers(r)[1]>numbers(r)[0]));
  }
 }

 if(route==='watchlist'&&width===390){const actions=rows.filter(r=>r.cls.includes('wl-mobile-btn'));assert.ok(actions.length);assert.ok(actions.every(r=>r.height>=44));}

});

for(const theme of ['light','dark'])test(`D6 Watchlist history family ${theme}`,async()=>{
 await page.evaluate(t=>applyAppTheme(t),theme);await navigate('watchlist');
 for(const state of ['empty','populated']){
  historyMode=state;await page.evaluate(()=>{openAlertHistoryModal();});await pause(350);
  const loading=await measurements('.wl-hist-loading');assert.ok(loading.length&&loading.every(r=>r.ratio>=4.5));record('HISTORY_LOADING',{theme,rows:loading});
  await page.waitForSelector(state==='empty'?'.wl-hist-empty':'.wl-hist-time',{visible:true});
  const rows=await measurements('.wl-hist-empty, .wl-hist-time, .wl-hist-triggered, .wl-hist-created, .wl-hist-updated, .wl-hist-deleted, .wl-hist-detail');record('HISTORY_FAMILY',{theme,state,rows});assert.ok(rows.length&&rows.every(r=>r.ratio>=4.5),JSON.stringify(rows.filter(r=>r.ratio<4.5)));
  if(state==='populated'){const rgb=r=>r.foreground.match(/[\d.]+/g).map(Number);for(const [cls,kind] of [['wl-hist-created','positive'],['wl-hist-updated','info'],['wl-hist-deleted','negative'],['wl-hist-triggered','warning']]){const row=rows.find(r=>r.cls.includes(cls));assert.ok(row);const [red,green,blue]=rgb(row);assert.ok(kind==='positive'?green>red:kind==='negative'?red>green:kind==='info'?blue>red:red>green&&green>blue);}}
  await page.evaluate(()=>closeAlertHistoryModal());
 }
});

for(const theme of ['light','dark'])test(`D6 shared metric-label owner ${theme}`,async()=>{
 await page.evaluate(t=>applyAppTheme(t),theme);
 for(const route of ['dashboard','bandarmologi','intel','hunter','insider']){
  if(routes[route])await navigate(route);else {await page.evaluate(r=>navigateTo(...r),route==='dashboard'?['dashboard']:['analisis',route]);await page.waitForNetworkIdle({idleTime:200,timeout:15000});}
  const rows=await measurements('.page-content .grid > div > .text-\\[9px\\], .page-content .grid > div > .text-\\[10px\\]');
  record('SHARED_METRIC_FAMILY',{route,theme,rows});assert.ok(rows.every(r=>r.ratio>=4.5),JSON.stringify(rows.filter(r=>r.ratio<4.5)));
 }
});
