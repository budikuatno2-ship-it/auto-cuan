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
const geometryFixture = require('./fixtures/final-audit-geometry/d4.json');
const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-cuan-d4-'));
const records = [
  { ticker: 'BBCA', free_float_pct: 20, hsc_flag: false, market_structure_guard: 'NORMAL' },
  { ticker: 'TLKM', free_float_pct: 0, hsc_flag: true, market_structure_guard: 'CAUTION' },
  { ticker: 'ASII', free_float_pct: null, hsc_flag: null, market_structure_guard: 'UNKNOWN' }
].map(row => ({ ...row, free_float_source: 'Local exchange fixture', free_float_as_of: '2026-10-05', hsc_source: 'Local HSC fixture', hsc_as_of: '2026-10-05', as_of_trade_date: '2026-10-05', regulatory_compliance_status: 'NOT_EVALUATED', market_structure_note: 'Referensi risiko, bukan putusan kepatuhan.' }));
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
      if (action === 'watchlist') { payload = {success:true,watchlist:watchlist}; } else if (url.pathname === '/api/track-record' || action === 'track-record') { payload = {success:true,signals:signals,summary:{total_signals:signals.length,total_resolved:3,running_signals:1,waiting_signals:1,win_rate_tp1:50,win_rate_tp2:25,sl_rate:25},by_category:{}}; } else if (input.action === 'portfolio_access') { payload = {success:true,user_id:'d1-local-user',username:'auditfixture'}; } else if (action === 'daily-market-context-list') {
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
const targets = {
 insider:'#insiderRosterSection button, #insiderRosterSection input, #insiderRosterSection select, #insiderMobileTabs button',
 portfolio:'#qualityNote', watchlist:'.wl-filter-btn', trackrecord:'.tr-status-pill',
 dashboard:'#page-dashboard .ac-section-hint, #page-dashboard .market-tile-note', intel:'#panel-tab-intel .text-gray-500, #panel-tab-intel .text-gray-400'
};
const routes = {insider:['analisis','insider'],portfolio:['portofolio'],watchlist:['watchlist'],trackrecord:['trackrecord'],dashboard:['dashboard'],intel:['analisis','intel']};
async function navigate(route) {
 await page.evaluate(route=>{hideOnboardingGuide(true);navigateTo(...route);},routes[route]);
 await page.waitForNetworkIdle({idleTime:200,timeout:15000});await pause(400);
}
async function measurements(selector) {
 // Read settled styles, not an intermediate hover/theme transition.
 await page.waitForFunction(selector => [...document.querySelectorAll(selector)]
  .filter(e => e.getClientRects().length)
  .every(e => e.getAnimations().every(a => a.playState !== 'running')),
  { timeout: 5000 }, selector);
 const result=await page.$$eval(selector, els=>{
  const rgb=c=>{const a=(c.match(/[\d.]+/g)||[]).map(Number);return [a[0]||0,a[1]||0,a[2]||0,a[3]??1];};
  const blend=(f,b)=>f.slice(0,3).map((v,i)=>v*f[3]+b[i]*(1-f[3]));
  const background=e=>{const c=rgb(getComputedStyle(e).backgroundColor);return c[3]===1?c.slice(0,3):blend(c,e.parentElement?background(e.parentElement):[255,255,255]);};
  const lum=a=>a.map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
  const ratio=(a,b)=>{const x=lum(a),y=lum(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
  return els.filter(e=>e.getClientRects().length&&!e.closest('.hidden,[hidden]')).map(e=>{
   const s=getComputedStyle(e),bg=background(e),outside=e.parentElement?background(e.parentElement):bg,r=e.getBoundingClientRect();
   const ancestors=[];for(let a=e;a;a=a.parentElement){const st=getComputedStyle(a);if(st.backgroundImage!=='none'||st.opacity!=='1')ancestors.push({element:a.id||a.className,image:st.backgroundImage,opacity:st.opacity});if(rgb(st.backgroundColor)[3]===1)break;}
   return {id:e.id,cls:e.className,text:(e.textContent||e.value||e.placeholder).trim().slice(0,100),foreground:s.color,background:s.backgroundColor,effectiveBackground:bg,ratio:ratio(blend(rgb(s.color),bg),bg),border:s.borderTopColor,boundaryRatio:ratio(blend(rgb(s.borderTopColor),outside),outside),outline:s.outlineColor,outlineWidth:s.outlineWidth,focusVisible:e.matches(':focus-visible'),focusRatio:ratio(blend(rgb(s.outlineColor),outside),outside),width:r.width,height:r.height,font:s.fontSize,ancestors};
  });
 });
 // Where gradients remain beneath translucent surfaces, sample the actual
 // browser paint with only target text temporarily transparent. Restore every
 // inline attribute; no stylesheet, layout, application data or file changes.
 const elements=await page.$$(selector);let index=0;
 for(const el of elements){
  if(!await el.evaluate(e=>e.getClientRects().length&&!e.closest('.hidden,[hidden]')))continue;
  const row=result[index++];if(!row.ancestors.length)continue;
  await el.evaluate(e=>e.scrollIntoView({behavior:'instant',block:'center',inline:'nearest'}));
  const sample=await el.evaluate(e=>{const old=e.getAttribute('style');e.style.setProperty('transition','none','important');e.style.setProperty('color','transparent','important');e.style.setProperty('text-shadow','none','important');getComputedStyle(e).color;const r=e.getBoundingClientRect();return {old,x:scrollX+Math.max(0,Math.min(innerWidth-1,Math.floor(r.left+r.width/2))),y:scrollY+Math.max(0,Math.min(innerHeight-1,Math.floor(r.top+r.height/2)))};});
  let buffer;
  // Beyond-viewport capture can change scrollbar/layout geometry in Chromium.
  // The target is scrolled into view; preserve that exact viewport for sampling.
  try{buffer=await page.screenshot({captureBeyondViewport:false,clip:{x:sample.x,y:sample.y,width:1,height:1}});}finally{await el.evaluate((e,old)=>{
   const restore=()=>old===null?e.removeAttribute('style'):e.setAttribute('style',old);
   restore();e.style.setProperty('transition','none','important');
   // Flush restored paint before re-enabling transitions: sampling must not
   // introduce a transparent-to-original text animation into the next check.
   getComputedStyle(e).color;restore();
  },sample.old);}
  const pixel=require('pngjs').PNG.sync.read(buffer).data;
  row.paintBackground=[...pixel.slice(0,3)];
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
 await page.setViewport({width:1440,height:900});
 await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:false,maxTouchPoints:1});
 await page.goto(origin+'/dashboard',{waitUntil:'networkidle0'});
 await page.evaluate(()=>{hideOnboardingGuide(true);applyAppTheme('light');});
});
for(const route of Object.keys(routes))for(const width of [390,1440])for(const theme of ['light','dark'])test(`D4 measured ${route} ${theme} ${width}`,async()=>{
 await page.setViewport({width,height:900});await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:width===390,maxTouchPoints:1});
 await page.evaluate(theme=>applyAppTheme(theme),theme);await navigate(route);
 const rows=await measurements(targets[route]);
 const geometry=await page.evaluate(()=>({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));
 const variables=await page.evaluate(()=>Object.fromEntries(['--ac-text-muted','--ac-text','--ac-accent','--ac-accent-strong','--ac-positive','--ac-negative','--ac-warning','--ac-warning-text','--ac-info','--info','--danger','--ac-bull','--ac-bear','--ac-warn','--ac-focus-color'].map(k=>[k,getComputedStyle(document.documentElement).getPropertyValue(k).trim()])));
 record('MATRIX',{route,width,theme,geometry,variables,rows});
 if(width===1440)record('OWNERSHIP',{route,theme,rules:await ownership(targets[route].split(',')[0])});
 {
  assert.ok(rows.length,route+' missing target');
  assert.ok(rows.every(r=>r.ratio>=4.5),JSON.stringify(rows.filter(r=>r.ratio<4.5)));
  assert.ok(rows.every(r=>!r.ancestors.length||r.paintBackground),'non-flat paint requires actual pixel measurement');
  assert.ok(geometry.scroll<=geometry.client+1,JSON.stringify(geometry));
  if(route==='insider')assert.ok(rows.filter(r=>r.id!=='insiderTabRoster'&&r.id!=='insiderTabGraph').every(r=>r.boundaryRatio>=3),JSON.stringify(rows.filter(r=>r.boundaryRatio<3)));
  const before=geometryFixture.find(r=>r.name==='MATRIX'&&r.value.route===route&&r.value.theme===theme&&r.value.width===width)?.value;
  assert.ok(before,'baseline matrix required');
  // Intel results load asynchronously. The fixed controls retain exact geometry;
  // dynamic loading/result copy is checked against the current visible contract.
  const stable=route==='intel'?rows.filter(r=>before.rows.some(b=>b.id===r.id&&b.text===r.text)):rows;
  assert.deepEqual(stable.map(r=>[r.id,r.text,r.width,r.height,r.font]),before.rows.map(r=>[r.id,r.text,r.width,r.height,r.font]),'color repair must preserve geometry');
  assert.ok(rows.every(r=>Number.isFinite(r.width)&&r.width>0&&Number.isFinite(r.height)&&r.height>0&&parseFloat(r.font)>0),'visible text has valid geometry');
 }

});
test('D4 portfolio breakpoints and coarse navigation remain intact',async()=>{
 await navigate('portfolio');
 for(const width of [767,768,1179,1180,1181]){
  await page.setViewport({width,height:900});await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});await pause(200);
  const g=await page.evaluate(()=>({tabs:getComputedStyle(document.getElementById('tabStrip')).display,mobile:getComputedStyle(document.getElementById('pccMobileNav')).display,columns:getComputedStyle(document.getElementById('tabStrip')).gridTemplateColumns,heights:[...document.querySelectorAll('#tabStrip .tab')].map(e=>e.getBoundingClientRect().height)}));
  assert.equal(g.tabs,width<=767?'none':width<=1180?'flex':'grid');assert.equal(g.mobile,width<=767?'block':'none');
  if(width>767)assert.ok(g.heights.every(h=>h>=44));if(width>=1181)assert.equal(g.columns.split(' ').length,7);record('PORTFOLIO_BREAKPOINT',{width,...g});
 }
});
test('D4 watchlist selected filters retain behavior and focus visibility',async()=>{
 await navigate('watchlist');
 for(const filter of ['gain','loss','alert','all']){
  await page.focus(`[data-wl-filter="${filter}"]`);await page.keyboard.press('Enter');await pause(250);
  const state=await page.evaluate(()=>({selected:[...document.querySelectorAll('.wl-filter-btn.active')].map(e=>e.dataset.wlFilter),text:document.getElementById('watchlistContainer').innerText}));
  assert.deepEqual(state.selected,[filter]);
  if(filter==='gain'){assert.match(state.text,/BBCA/);assert.doesNotMatch(state.text,/TLKM/);}if(filter==='loss'){assert.match(state.text,/TLKM/);assert.doesNotMatch(state.text,/BBCA/);}
  const m=await measurements('.wl-filter-btn.active');record('WATCHLIST_FILTER',{filter,state,measurements:m});
  {assert.ok(m[0].ratio>=4.5);assert.ok(m[0].focusVisible&&parseFloat(m[0].outlineWidth)>=2&&m[0].focusRatio>=3);assert.ok(m[0].boundaryRatio>=3);}
 }
});
test('D4 track record outcome semantics stay distinct',async()=>{
 await navigate('trackrecord');const rows=await measurements('.tr-status-pill');
 for(const [cls,label] of [['running','Berjalan'],['tp1','TP1'],['tp2','TP2'],['sl','Stop Loss'],['waiting','Menunggu'],['expired','Kedaluwarsa']])assert.ok(rows.some(r=>r.cls.includes('tr-status-'+cls)&&r.text.includes(label)),cls+JSON.stringify(rows));
 record('STATUS_MEANINGS',rows);
 {
  const foreground=cls=>rows.find(r=>r.cls.includes('tr-status-'+cls)).foreground.match(/[\d.]+/g).map(Number);
  const positive=foreground('tp1'),negative=foreground('sl'),warning=foreground('waiting'),info=foreground('running');
  assert.ok(positive[1]>positive[0]&&positive[1]>positive[2]);assert.ok(negative[0]>negative[1]&&negative[0]>negative[2]);
  assert.ok(warning[0]>warning[1]&&warning[1]>warning[2]);assert.ok(info[2]>info[0]&&info[2]>info[1]);
 }
});
test('D4 Insider keyboard focus and selected state remain distinct in both themes',async()=>{
 for(const theme of ['light','dark']){
  await page.setViewport({width:390,height:900});await page.evaluate(theme=>applyAppTheme(theme),theme);await navigate('insider');
  for(const selector of ['#insiderTabRoster','#insiderRosterTickerInput','#insiderRosterSection button:not(.bg-emerald-500)']){
   await page.focus(selector);await page.keyboard.press('Tab');await page.focus(selector);await pause(100);
   const rows=await measurements(selector);record('INSIDER_FOCUS',{theme,selector,row:rows[0]});
   {assert.ok(rows[0].focusVisible);assert.ok(parseFloat(rows[0].outlineWidth)>=2);assert.ok(rows[0].focusRatio>=3);assert.ok(rows[0].ratio>=4.5);}
  }
  const selected=await measurements('#insiderMobileTabs .ac-tab-active'),unselected=await measurements('#insiderMobileTabs .ac-tab-btn:not(.ac-tab-active)');
  assert.notEqual(selected[0].foreground,unselected[0].foreground);
 }
});
test('D4 Portfolio info/error/success family consumes semantic theme colors',async()=>{
 await navigate('portfolio');
 await page.evaluate(()=>{const host=document.createElement('div');host.id='d4-note-family';host.innerHTML='<div class="note">Informasi fixture</div><div class="error">Kesalahan fixture</div><div class="success">Berhasil fixture</div>';document.getElementById('qualityNote').parentElement.appendChild(host);});
 for(const theme of ['light','dark']){
  await page.evaluate(theme=>applyAppTheme(theme),theme);await pause(250);const rows=await measurements('#d4-note-family > div');record('PORTFOLIO_NOTE_FAMILY',{theme,rows});
  assert.ok(rows.every(r=>r.ratio>=4.5),JSON.stringify(rows));
 }
});
test('D4 component ownership and CSS parsing remain valid',async()=>{
 for(const theme of ['light','dark']){
  await page.setViewport({width:390,height:900});await page.evaluate(theme=>applyAppTheme(theme),theme);await navigate('insider');
  for(const selector of ['#insiderRosterSection button:not(.bg-emerald-500)','#insiderTabRoster','#insiderRosterTickerInput'])record('EXACT_OWNER',{theme,selector,rows:await measurements(selector),rules:await ownership(selector)});
 }
 const sheets=await page.evaluate(()=>[...document.styleSheets].filter(s=>/\/(ui-theme|portfolio-command-center|portfolio-spa-scoped)\.css/.test(s.href||'')).map(s=>({file:s.href,rules:s.cssRules.length})));
 assert.ok(sheets.some(s=>s.file.includes('ui-theme.css')&&s.rules>0));record('CSSOM_PARSE',sheets);
 {
  const source=fs.readFileSync(path.join(publicRoot,'ui-theme.css'),'utf8');
  assert.match(source,/#page-analisis #insiderRosterSection :is\(button, input, select\)/);
  assert.match(source,/#page-dashboard \.ac-section-hint\s*\{\s*color: var\(--ac-text-muted\)/);
  for(const name of ['ui-theme.css','portfolio-command-center.css','portfolio-spa-scoped.css']){
   const css=fs.readFileSync(path.join(publicRoot,name),'utf8');
   const stripped=css.replace(/\/\*[\s\S]*?\*\//g,'').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,'');
   let depth=0;for(const c of stripped){if(c==='{')depth++;if(c==='}')depth--;assert.ok(depth>=0,name+' unmatched close brace');}assert.equal(depth,0,name+' unmatched open brace');
  }
 }
});
test('D4 Watchlist keyboard focus and hover contrast hold across both themes and sizes',async()=>{
 await navigate('watchlist');
 for(const width of [390,1440])for(const theme of ['light','dark']){
  await page.setViewport({width,height:900});await page.evaluate(theme=>applyAppTheme(theme),theme);
  await page.focus('[data-wl-filter="all"]');await page.keyboard.press('Tab');await page.focus('[data-wl-filter="all"]');await pause(200);
  const focused=await measurements('.wl-filter-btn.active');record('WATCHLIST_FOCUS_MATRIX',{width,theme,rows:focused});
  {assert.ok(focused[0].focusVisible);assert.ok(parseFloat(focused[0].outlineWidth)>=2);assert.ok(focused[0].focusRatio>=3);assert.ok(focused[0].boundaryRatio>=3);}
  for(const selector of ['.wl-filter-btn.active','.wl-filter-btn:not(.active)']){
   await page.hover(selector);await pause(250);const hovered=await measurements(selector);record('WATCHLIST_HOVER',{width,theme,rows:hovered});assert.ok(hovered.every(r=>r.ratio>=4.5),JSON.stringify({width,theme,selector,failed:hovered.filter(r=>r.ratio<4.5)}));
  }
 }
});
test('D4 native pixel sampling uses document coordinates after scrolling',async()=>{
 await page.setContent('<style>html,body{margin:0}body{height:2200px;background:linear-gradient(#000 0 1200px,#fff 1200px 100%)}#sample{position:absolute;top:1500px;left:50px;width:100px;height:40px;color:#000}</style><div id="sample">Sample text</div>');
 const [row]=await measurements('#sample');
 assert.ok(await page.evaluate(()=>scrollY>0),'fixture must exercise a scrolled page');
 assert.deepEqual(row.paintBackground,[255,255,255]);
 assert.ok(row.ratio>=4.5,'actual target text meets contrast');
 // Negative control: the old viewport-based clip samples the black region.
 const wrong=await page.$eval('#sample',e=>{const r=e.getBoundingClientRect();return {x:Math.floor(r.left+r.width/2),y:Math.floor(r.top+r.height/2),width:1,height:1};});
 const pixel=require('pngjs').PNG.sync.read(await page.screenshot({captureBeyondViewport:true,clip:wrong})).data;
 assert.deepEqual([...pixel.slice(0,3)],[0,0,0]);
});
test('D4 rendered low-contrast negative fixture is rejected at 4.5:1',async()=>{
 for(const deviceScaleFactor of [1,2]){
  await page.setViewport({width:1440,height:900,deviceScaleFactor});
  await page.setContent('<style>body{margin:0;height:1600px;background:linear-gradient(#888,#888)}#sample{position:absolute;top:1100px;left:50px;color:#777;width:100px;height:40px}</style><div id="sample">Low contrast</div>');
  const rows=await measurements('#sample');assert.equal(rows.length,1);
  assert.deepEqual(rows[0].paintBackground,[136,136,136]);
  assert.throws(()=>assert.ok(rows.every(r=>r.ratio>=4.5)),assert.AssertionError);
 }
 await page.setViewport({width:1440,height:900,deviceScaleFactor:1});
});
