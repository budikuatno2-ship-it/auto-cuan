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
const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-cuan-d5-'));
const records = [
  { ticker: 'BBCA', free_float_pct: 20, hsc_flag: false, market_structure_guard: 'NORMAL' },
  { ticker: 'TLKM', free_float_pct: 0, hsc_flag: true, market_structure_guard: 'CAUTION' },
  { ticker: 'ASII', free_float_pct: null, hsc_flag: null, market_structure_guard: 'UNKNOWN' }
].map(row => ({ ...row, free_float_source: 'Local exchange fixture', free_float_as_of: '2026-10-05', hsc_source: 'Local HSC fixture', hsc_as_of: '2026-10-05', as_of_trade_date: '2026-10-05', regulatory_compliance_status: 'NOT_EVALUATED', market_structure_note: 'Referensi risiko, bukan putusan kepatuhan.' }));
let server, browser, page, origin, mode = 'success', detailReads = 0;
let revision=0, failure=false, delay=0;
const requests=[];
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
      const surface=action==='watchlist'?'watchlist':url.pathname==='/api/track-record'||action==='track-record'?'trackrecord':null;
      if(surface){requests.push({surface,url:req.url,revision,failure});if(delay)await pause(delay);}
      let payload = { success: true, data: [], rows: [], results: [] };
      if (action === 'watchlist') { payload = {success:true,watchlist:[{...watchlist[0],ticker:revision?'TLKM':'BBCA',notes:'Revision '+revision}]}; } else if (url.pathname === '/api/track-record' || action === 'track-record') { payload = {success:true,signals:[{...signals[0],ticker:revision?'TLKM':'BBCA'}],summary:{total_signals:[{...signals[0],ticker:revision?'TLKM':'BBCA'}].length,total_resolved:3,running_signals:1,waiting_signals:1,win_rate_tp1:50,win_rate_tp2:25,sl_rate:25},by_category:{}}; } else if (input.action === 'portfolio_access') { payload = {success:true,user_id:'d1-local-user',username:'auditfixture'}; } else if (action === 'daily-market-context-list') {
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
      if(surface&&failure)payload={success:false,error:'Local refresh failure'};
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
const config={watchlist:{route:'watchlist',button:'#wlRefreshBtn',view:'#watchlistContainer',status:'#wlRefreshStatus',load:'loadUserWatchlist',url:'/api/sector-hot?action=watchlist'},trackrecord:{route:'trackrecord',button:'#trackRecordRefreshBtn',view:'#trTableBody',status:'#trRefreshStatus',load:'loadTrackRecord',url:'/api/track-record'}};
const count=s=>requests.filter(r=>r.surface===s).length;
async function visit(s){await page.evaluate(s=>navigateTo(s),s);await page.waitForNetworkIdle({idleTime:100,timeout:10000});await pause(100);}
async function settled(s){await page.waitForFunction(selector=>!document.querySelector(selector).hasAttribute('aria-busy'),{},config[s].button);await pause(150);}
async function click(s){await page.$eval(config[s].button,e=>e.scrollIntoView({behavior:'instant',block:'center'}));await page.click(config[s].button);}
const text=s=>page.$eval(config[s].view,e=>e.innerText);
beforeEach(async context=>{
 revision=0;failure=context.name.includes('cold failure');delay=0;requests.length=0;
 await page.setViewport({width:1440,height:900});await page.goto(origin+'/dashboard',{waitUntil:'networkidle0'});
 await page.evaluate(()=>{hideOnboardingGuide(true);applyAppTheme('light');});
});
for(const surface of Object.keys(config)){
 test(`D5 ${surface} fresh cache manual action must revalidate`,async()=>{
  await visit(surface);assert.match(await text(surface),/BBCA/);const before=count(surface);revision=1;
  await click(surface);await pause(400);
  assert.equal(count(surface),before+1);assert.match(await text(surface),/TLKM/);record('MANUAL',{surface,before,after:count(surface)});
 });
 for(const width of [390,1440])for(const theme of ['light','dark'])test(`D5 ${surface} ${theme} ${width} success failure single flight and cache`,async()=>{
  await page.setViewport({width,height:900});await page.evaluate(theme=>applyAppTheme(theme),theme);await visit(surface);
  const before=count(surface);await visit('dashboard');await visit(surface);assert.equal(count(surface),before);record('AUTO_CACHE',{surface,width,theme,before,after:count(surface)});
  const original=await text(surface);const initial=await page.$eval(config[surface].button,e=>({w:e.getBoundingClientRect().width,h:e.getBoundingClientRect().height}));
  delay=450;revision=1;await page.focus(config[surface].button);await page.keyboard.press('Enter');
  await page.waitForFunction(selector=>document.querySelector(selector).getAttribute('aria-busy')==='true',{},config[surface].button);
  assert.equal(await text(surface),original);assert.equal(await page.$eval(config[surface].button,e=>e.disabled),true);
  await page.evaluate(c=>{for(let i=0;i<6;i++)window[c.load](true);},config[surface]);await settled(surface);
  assert.equal(count(surface),before+1);assert.match(await text(surface),/TLKM/);assert.equal(await page.$eval(config[surface].button,e=>e.disabled),false);
  const cached=await page.evaluate(c=>AutoCuanKeepAlive.peek(c.url),config[surface]);const saved=await text(surface);
  failure=true;const failedBefore=count(surface);await click(surface);assert.equal(await text(surface),saved);await settled(surface);
  assert.equal(await text(surface),saved);assert.match(await page.$eval(config[surface].status,e=>e.textContent),/Gagal/);
  assert.equal(await page.$eval(config[surface].button,e=>e.disabled),false);
  const kept=await page.evaluate(c=>AutoCuanKeepAlive.peek(c.url),config[surface]);assert.equal(kept.ageMs>=cached.ageMs,true);assert.deepEqual(kept.data,cached.data);
  assert.equal(count(surface),failedBefore+(surface==='trackrecord'?2:1),'one attempt with existing Track Record fallback');
  const g=await page.$eval(config[surface].button,e=>({w:e.getBoundingClientRect().width,h:e.getBoundingClientRect().height,outline:getComputedStyle(e).outlineWidth}));assert.ok(Math.abs(g.w-initial.w)<0.1);assert.ok(Math.abs(g.h-initial.h)<0.1);if(width===390)assert.ok(g.h>=43.9);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1));
  failure=false;revision=2;await click(surface);await settled(surface);assert.match(await page.$eval(config[surface].status,e=>e.textContent),/Diperbarui/);
  record('MATRIX',{surface,width,theme,manual:[before,before+1],failed:[failedBefore,count(surface)-1],rapidRequests:1,oldDataPreserved:true,cachePreserved:true,geometry:g});

 });
 test(`D5 ${surface} stale normal read still revalidates`,async()=>{
  await visit(surface);const n=count(surface);revision=1;
  await page.evaluate(c=>{const old=Date.now;Date.now=()=>old()+AutoCuanKeepAlive.TTL_MS+1;window.__d5RestoreClock=()=>{Date.now=old;};return window[c.load](false);},config[surface]);
  await pause(250);assert.equal(count(surface),n+1);await page.evaluate(()=>__d5RestoreClock());
  await page.evaluate(c=>window[c.load](false),config[surface]);assert.match(await text(surface),/TLKM/);assert.equal(count(surface),n+1);
  record('STALE',{surface,before:n,after:count(surface),updatedSnapshotOnRevisit:true});
 });
 test(`D5 ${surface} cold failure remains truthful and retryable`,async()=>{
  failure=true;await visit(surface);assert.match(await page.$eval(config[surface].status,e=>e.textContent),/Gagal/);
  assert.equal(await page.evaluate(c=>AutoCuanKeepAlive.peek(c.url),config[surface]),null);assert.equal(await page.$eval(config[surface].button,e=>e.disabled),false);
  failure=false;await click(surface);await settled(surface);assert.match(await text(surface),/BBCA/);record('COLD_FAILURE',{surface,retrySucceeded:true});
 });
}
test('D5 refresh feedback preserves layout and keyboard focus in both themes',async()=>{
 for(const surface of Object.keys(config))for(const theme of ['light','dark']){
  await page.setViewport({width:390,height:900});await page.evaluate(theme=>applyAppTheme(theme),theme);await visit(surface);
  await page.focus(config[surface].button);await page.keyboard.press('Tab');await page.focus(config[surface].button);
  const focus=await page.$eval(config[surface].button,e=>({visible:e.matches(':focus-visible'),outline:getComputedStyle(e).outlineWidth,color:getComputedStyle(e).color}));assert.ok(focus.visible&&parseFloat(focus.outline)>=2);
  const geometry=()=>page.evaluate(c=>{const r=document.querySelector(c.view).getBoundingClientRect(),s=document.querySelector(c.status).getBoundingClientRect();return {top:r.top+scrollY,height:r.height,statusHeight:s.height};},config[surface]);
  const before=await geometry();delay=350;await page.keyboard.press('Enter');await page.waitForFunction(s=>document.querySelector(s).disabled,{},config[surface].button);
  const during=await geometry();assert.ok(Math.abs(during.top-before.top)<0.1);assert.ok(Math.abs(during.height-before.height)<0.1);assert.equal(during.statusHeight,before.statusHeight);await settled(surface);
  record('FEEDBACK_ACCESSIBILITY',{surface,theme,focus,before,during});delay=0;
 }
});
