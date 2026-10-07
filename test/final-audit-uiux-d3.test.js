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
const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-cuan-d3-'));
const records = [
  { ticker: 'BBCA', free_float_pct: 20, hsc_flag: false, market_structure_guard: 'NORMAL' },
  { ticker: 'TLKM', free_float_pct: 0, hsc_flag: true, market_structure_guard: 'CAUTION' },
  { ticker: 'ASII', free_float_pct: null, hsc_flag: null, market_structure_guard: 'UNKNOWN' }
].map(row => ({ ...row, free_float_source: 'Local exchange fixture', free_float_as_of: '2026-10-05', hsc_source: 'Local HSC fixture', hsc_as_of: '2026-10-05', as_of_trade_date: '2026-10-05', regulatory_compliance_status: 'NOT_EVALUATED', market_structure_note: 'Referensi risiko, bukan putusan kepatuhan.' }));
let server, browser, page, origin, mode = 'success', detailReads = 0;
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
      if (action === 'screener') { payload = {success:true,results:fixtures}; } else if (action === 'daily-market-context-list') {
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

const fixtures = [
 {ticker:'BBCA',pattern_personality:'FX_STRONG_BUY'},
 {ticker:'TLKM',pattern_personality:'COMBO_FX_TECH_MA5'},
 {ticker:'ASII',pattern_personality:'TECH_ABOVE_MA20'}
].map((r,i)=>({...r, rank:i+1, score:80-i, last_price:1000, risk_reward:2, confidence:'A', swing_tier:'SWING_READY', final_status:'Swing Ready', risk_label:'Low Risk', entry_low:990,entry_high:1010,stop_loss:950,tp1:1100,tp2:1200, change_pct:1,volume_ratio_avg20:1.3,rsi14:60}));
beforeEach(async () => {
 await page.setViewport({width:1440,height:900,isMobile:false,hasTouch:false});
 await page.goto(origin+'/dashboard?page=screener',{waitUntil:'networkidle0'});
 await page.evaluate(fixtures => { hideOnboardingGuide(true); applyAppTheme('light'); navigateTo('screener'); stopScreenerPolling(); if(typeof stopNkPolling==='function')stopNkPolling(); _currentScreenerType='konglo'; _screenerFilter='all'; _screenerCache={results:fixtures}; document.getElementById('filter-pattern-personality').value='all'; document.getElementById('filter-high-wr').checked=false; renderScreenerTable(fixtures); kgToggleView('table'); },fixtures);
 await page.waitForNetworkIdle({idleTime:200,timeout:15000});
 await page.evaluate(fixtures => { stopScreenerPolling(); _screenerCache={results:fixtures}; renderScreenerTable(fixtures); kgToggleView('table'); }, fixtures);
 await pause(100);
});
const action = '#screenerTableBody [data-ticker="BBCA"] .ac-screener-result-action';
const visibleRows = () => page.$$eval('#screenerTableBody tr[data-ticker]', els=>els.map(el=>el.dataset.ticker));
test('D3 390 coarse controls reach touch height and mobile form typography',async()=>{
 await page.setViewport({width:390,height:900}); await (await page.createCDPSession()).send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1}); await pause(350);
 const g=await page.evaluate(()=>({coarse:matchMedia('(pointer:coarse)').matches,modes:[...document.querySelectorAll('#scrTypeKonglo,#scrTypeNonKonglo,#scrTypeDayTrade')].map(el=>el.getBoundingClientRect().height),forms:[...document.querySelectorAll('#page-screener select,#page-screener input:not([type=checkbox])')].filter(el=>el.getClientRects().length).map(el=>({id:el.id,height:el.getBoundingClientRect().height,font:getComputedStyle(el).fontSize}))}));
 record('MOBILE_CONTROLS',g);assert.ok(g.coarse);assert.ok(g.modes.every(h=>h>=43.9));assert.ok(g.forms.every(el=>el.height>=43.9&&parseFloat(el.font)>=16));
});
test('D3 result detail action is reachable with Tab and Enter restores focus',async()=>{
 await page.focus('#kgTickerSearch');let reached=false;for(let i=0;i<35;i++){await page.keyboard.press('Tab');if(await page.evaluate(()=>document.activeElement.matches('.ac-screener-result-action'))){reached=true;break;}}
 assert.ok(reached);assert.equal(await page.evaluate(()=>document.activeElement.innerText),'BBCA');
 assert.ok(parseFloat(await page.evaluate(()=>getComputedStyle(document.activeElement).outlineWidth))>=2);
 await page.keyboard.press('Enter');assert.match(await page.$eval('#screenerDetailPaneContent',el=>el.innerText),/BBCA/);
 await page.click('#screenerDetailPane button');assert.equal(await page.evaluate(()=>document.activeElement.matches('.ac-screener-result-action')),true);
 record('KEYBOARD_DESKTOP','Tab → BBCA button → Enter → same detail → originating button');
});
test('D3 every enum option has human presentation and original filter values',async()=>{
 const options=await page.$$eval('#filter-pattern-personality option', els=>els.map(el=>({value:el.value,label:el.textContent})));
 assert.equal(options.length,11);assert.ok(options.every(o=>!/[A-Z]+_[A-Z0-9_]+/.test(o.label)));
 const expected=['all','COMBO_FX_TECH_MA5','FX_STRONG_BUY','TECH_ABOVE_MA20','TECH_ABOVE_MA5','VOL_WARM_1P2_1P5','RSI_OVERBOUGHT_65P','COMBO_BROKER_FX','COMBO_BROKER_TECH','TRAP_CHG5_VOL3_CLIMAX','BROKER_TOP3_CONCENTRATION'];assert.deepEqual(options.map(o=>o.value),expected);
 for(const value of expected.slice(1)) {await page.select('#filter-pattern-personality',value);const result=await page.evaluate(fixtures=>({value:document.getElementById('filter-pattern-personality').value,keys:applyScreenerUiFilters('konglo',fixtures).map(r=>r.pattern_personality)}),fixtures);assert.equal(result.value,value);assert.ok(result.keys.every(k=>k===value));assert.deepEqual(await visibleRows(),fixtures.filter(r=>r.pattern_personality===value).map(r=>r.ticker));}
 record('ENUM_OPTIONS',options);
});
for(const [theme,width,touch] of [['light',320,true],['light',390,true],['dark',390,true],['light',768,true],['light',1024,true],['light',1440,false],['dark',1440,false],['light',1920,false]])test(`D3 matrix ${theme} ${width}`,async()=>{
 await page.setViewport({width,height:900}); await (await page.createCDPSession()).send('Emulation.setTouchEmulationEnabled',{enabled:touch,maxTouchPoints:1}); await page.evaluate(theme=>applyAppTheme(theme),theme);await pause(350);
 const g=await page.evaluate(()=>({width:innerWidth,overflow:document.documentElement.scrollWidth,modes:[...document.querySelectorAll('#scrTypeKonglo,#scrTypeNonKonglo,#scrTypeDayTrade')].map(el=>({height:el.getBoundingClientRect().height,left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right,pressed:el.getAttribute('aria-pressed')})),forms:[...document.querySelectorAll('#page-screener select,#page-screener input:not([type=checkbox])')].filter(el=>el.getClientRects().length).map(el=>({id:el.id,height:el.getBoundingClientRect().height,font:parseFloat(getComputedStyle(el).fontSize),left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right,label:el.getAttribute('aria-label')||document.querySelector('label[for="'+el.id+'"]')?.innerText}))}));
 assert.ok(g.overflow<=width+1,JSON.stringify(g));assert.ok(g.forms.every(el=>el.left>=0&&el.right<=width+1&&el.label));assert.deepEqual(g.modes.map(el=>el.pressed),['true','false','false']);
 if(touch){assert.ok(g.modes.every(el=>el.height>=43.9));assert.ok(g.forms.every(el=>el.height>=43.9&&el.font>=16));}else assert.ok(g.modes.every(el=>el.height<=40));
 assert.ok(g.modes.every((el,i)=>!i||el.left>=g.modes[i-1].right));assert.deepEqual(await visibleRows(),['BBCA','TLKM','ASII']);
 await page.focus(action);await page.keyboard.press('Space');await pause(100);
 const detail=width>=1280?'#screenerDetailPaneContent':'#scrDetailContent';assert.match(await page.$eval(detail,el=>el.innerText),/BBCA/);
 if(width<1280){await page.keyboard.press('Escape');}else await page.click('#screenerDetailPane button');
 assert.equal(await page.evaluate(()=>document.activeElement.matches('.ac-screener-result-action')),true);
 await pause(150); await page.$eval('#screenerTableBody [data-ticker="TLKM"] .ac-screener-result-action',el=>el.scrollIntoView({behavior:'instant',block:'center',inline:'nearest'})); await page.click('#screenerTableBody [data-ticker="TLKM"] .ac-screener-result-action');assert.match(await page.$eval(detail,el=>el.innerText),/TLKM/);
 if(width<1280)await page.keyboard.press('Escape');else await page.click('#screenerDetailPane button');
 record('MATRIX', {theme,...g});
 if(theme==='light'&&[390,1440].includes(width)){await page.mouse.move(0,0);await pause(250);}
});
test('D3 rerender preserves useful keyboard focus and activation runs once',async()=>{
 await page.focus(action);await page.evaluate(fixtures=>renderScreenerTable(fixtures),fixtures);assert.equal(await page.evaluate(()=>document.activeElement.matches('.ac-screener-result-action')),true);
 await page.evaluate(()=>{window.__d3Calls=0;const original=window.selectScreenerRow;window.selectScreenerRow=function(...args){window.__d3Calls++;return original(...args);};});
 for(let i=0;i<3;i++){await page.evaluate(fixtures=>renderScreenerTable(fixtures),fixtures);await page.focus(action);await page.keyboard.press('Enter');await page.click('#screenerDetailPane button');}
 assert.equal(await page.evaluate(()=>window.__d3Calls),3);
 await page.focus(action);await page.evaluate(fixtures=>renderScreenerTable(fixtures.slice(1)),fixtures);assert.equal(await page.evaluate(()=>document.activeElement.innerText),'TLKM');
});

test('D3 all three modes retain one semantic action per ticker and mobile toolbar sizing',async()=>{
 await page.setViewport({width:390,height:900});await (await page.createCDPSession()).send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
 for(const [type,body,render] of [['konglo','screenerTableBody','renderScreenerTable'],['nonkonglo','nkScreenerTableBody','renderNkScreenerTable'],['daytrade','dtScreenerTableBody','renderDtTable']]){
  await page.evaluate(type=>switchScreenerType(type),type);
  await page.waitForFunction(render=>typeof window[render]==='function',{},render);await page.waitForNetworkIdle({idleTime:200,timeout:15000});
  await page.evaluate(({type,render,fixtures})=>{
   stopScreenerPolling();stopNkPolling();if(typeof stopDtPolling==='function')stopDtPolling();
   if(type==='konglo')_screenerCache={results:fixtures};else if(type==='nonkonglo'){_nkScreenerCache={results:fixtures};_nkScreenerFilter='all';}else{_dtScreenerCache={results:fixtures};_dtScreenerFilter='all';}
   window[render](fixtures);if(type==='konglo')kgToggleView('table');else if(type==='nonkonglo')nkToggleView('table');else dtToggleView('table');
  },{type,render,fixtures});await pause(250);
  assert.equal(await page.$$eval('#'+body+' .ac-screener-result-action',els=>els.length),3);
  const geometry=await page.$$eval('#page-screener select',els=>els.filter(el=>el.getClientRects().length).map(el=>({height:el.getBoundingClientRect().height,font:parseFloat(getComputedStyle(el).fontSize)})));assert.ok(geometry.every(el=>el.height>=43.9&&el.font>=16));
  await page.focus('#'+body+' .ac-screener-result-action');await page.keyboard.press('Enter');assert.match(await page.$eval('#scrDetailContent',el=>el.innerText),/BBCA/);await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(()=>document.activeElement.matches('.ac-screener-result-action')),true);record('MODE_PROOF',{type,geometry});
 }
});

test('D3 mouse row cell preserves the existing authoritative detail handler',async()=>{
 await page.evaluate(()=>{window.__d3RowCalls=0;const original=window.selectScreenerRow;window.selectScreenerRow=function(...args){window.__d3RowCalls++;return original(...args);};});
 const cell='#screenerTableBody [data-ticker="TLKM"] td:last-child';
 await page.$eval(cell,el=>el.scrollIntoView({behavior:'instant',block:'center',inline:'center'}));await page.click(cell);
 assert.match(await page.$eval('#screenerDetailPaneContent',el=>el.innerText),/TLKM/);assert.equal(await page.evaluate(()=>window.__d3RowCalls),1);
 await page.click('#screenerDetailPane button');assert.equal(await page.evaluate(()=>document.activeElement.closest('tr').dataset.ticker),'TLKM');record('MOUSE_ROW_ONLY','Row-cell click → TLKM detail exactly once → TLKM action focus');
});
