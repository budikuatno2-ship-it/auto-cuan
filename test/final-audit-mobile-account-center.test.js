'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const puppeteer = require('puppeteer-core');
const publicRoot = path.resolve(__dirname, '../public');
const evidence = [];
const record = (name, value) => evidence.push({name, value});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function startFixture() {
 const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
   let raw = ''; for await (const chunk of req) raw += chunk;
   let input = {}; try { input = JSON.parse(raw); } catch (_) {}
   let payload = {success:true, data:[], rows:[], results:[]};
   if (url.pathname === '/api/maintenance-settings') payload = {success:true, config:{maintenanceMode:false}};
   if (input.action === 'session-status') payload = {success:true, userId:'h11-local-user', username:'auditfixture', isAdmin:false, isApproved:true, google_link_state:'linked', google_link_required:false, email_required:false};
   if (input.action === 'account-google-status') payload = {success:true, google_link_state:'linked', google_linked:true, required:false};
   if (input.action === 'portfolio_access') payload = {success:true, user_id:'h11-local-user', username:'auditfixture'};
   if (input.action === 'account-profile') payload = {success:true, profile:{username:'auditfixture', is_approved:true, is_admin:false, subscription:{entitlement:{premium:true}}}};
   res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify(payload)); return;
  }
  const file = path.resolve(publicRoot, '.' + (path.extname(url.pathname) ? url.pathname : '/index.html'));
  if (!file.startsWith(publicRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {res.writeHead(404); res.end(); return;}
  const mime = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json','.png':'image/png','.woff2':'font/woff2'};
  res.writeHead(200, {'Content-Type':mime[path.extname(file)] || 'application/octet-stream'}); res.end(fs.readFileSync(file));
 });
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 const origin = 'http://127.0.0.1:' + server.address().port;
 let browser;
 try {
  browser = await puppeteer.launch({executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']});
  const page = await browser.newPage(); page.setDefaultTimeout(7000);
  await page.setRequestInterception(true);
  page.on('request', req => req.url().startsWith(origin + '/') ? req.continue() : req.abort());
  await page.setViewport({width:390,height:900});
  await page.goto(origin + '/dashboard', {waitUntil:'networkidle0'});
  return {server,browser,page,origin};
 } catch (error) {if(browser) await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); throw error;}
}

test('H1.1 mobile Account Center owns drawer hit testing and restores focus', async () => {
 const errors = []; const onError = error => errors.push(error.message);
 const {server, browser, page, origin} = await startFixture();
 page.on('pageerror', onError);
 const assertReachable = geometry => {
  assert.ok(geometry.hit, 'Account Center center must hit its trigger: ' + JSON.stringify(geometry));
  assert.ok(geometry.rect.left >= 0 && geometry.rect.top >= 0 && geometry.rect.bottom <= geometry.viewport.height && geometry.rect.right <= geometry.viewport.width,
   'Account Center must be reachable inside the open drawer: ' + JSON.stringify(geometry));
 };
 const geometry = () => page.evaluate(() => {
  const trigger = document.getElementById('sidebarAccountEntry');
  const rect = trigger.getBoundingClientRect(); const nav = document.getElementById('acBottomBar').getBoundingClientRect();
  const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
  const scroll = document.querySelector('#appSidebar .sidebar-nav');
  return { viewport: {width: innerWidth, height: innerHeight}, intersectionHeight: Math.max(0, Math.min(rect.bottom, nav.bottom) - Math.max(rect.top, nav.top)), rect: rect.toJSON(), nav: nav.toJSON(), hit: trigger.contains(hit), hitTarget: hit?.closest('button')?.id || hit?.closest('button')?.dataset.page,
   scroll: { overflow: getComputedStyle(scroll).overflowY, client: scroll.clientHeight, height: scroll.scrollHeight } };
 });
 const openAndClose = async (selector, keyboard) => {
  const route = await page.evaluate(() => currentPage);
  await page.focus(selector);
  if (keyboard) await page.keyboard.press('Enter'); else await page.click(selector);
  await page.waitForFunction(() => { const el = document.getElementById('acAccountCenter'); return el && !el.hidden && el.getClientRects().length; });
  await page.waitForFunction(() => document.getElementById('acAccountCenter').contains(document.activeElement));
  assert.equal(await page.evaluate(() => currentPage), route, 'Account click must not activate Screener');
  const focusables = await page.$$eval('#acAccountCenter button, #acAccountCenter input, #acAccountCenter [tabindex="0"]', els => els.filter(e => !e.disabled && e.getClientRects().length && !e.closest('[inert]')).map(e => e.id));
  assert.ok(focusables.length > 1 && focusables[0] && focusables.at(-1));
  await page.focus('#' + focusables[0]); await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
  assert.equal(await page.evaluate(() => document.activeElement.id), focusables.at(-1));
  await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement.id), focusables[0]);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('acAccountCenter').hidden);
  await page.waitForFunction(selector => document.activeElement === document.querySelector(selector), {}, selector);
  assert.ok(await page.$eval(selector, e => { const r = e.getBoundingClientRect(); return !e.closest('[inert]') && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; }));
 };
 try {
  await page.evaluate(() => { localStorage.setItem('autocuan_logged_in', 'true'); localStorage.setItem('autocuan_user', 'auditfixture'); localStorage.setItem('autocuan_user_id', 'd1-local-user'); });
  for (const [width, height] of [[360,900],[375,900],[390,900],[430,900],[390,700],[768,900],[1440,900]]) {
   await page.setViewport({ width, height });
   await page.goto(origin + '/dashboard', { waitUntil: 'networkidle0' });
   await page.evaluate(() => { hideOnboardingGuide(true); applyAppTheme('light'); });
   await page.waitForFunction(() => premiumAccessState.state === 'ready' && premiumAccessState.premium === true);
   if (width < 1024) {
    await page.click('#workspaceSidebarToggle'); await pause(350);
    const current = await geometry(); assertReachable(current);
    assert.equal(current.scroll.overflow, 'auto'); assert.ok(current.scroll.client > 0);
    if (width === 390 && height === 900) {
     // Recreate only the original owner stacking failure in memory. The
     // full-height account row overlaps the bar, whose hit target must win.
     const original = await page.$eval('#dashboardScreen', e => { const old = e.getAttribute('style'); e.style.setProperty('position', 'static', 'important'); e.style.setProperty('z-index', 'auto', 'important'); return old; });
     try {
      const negative = await geometry(); assert.equal(negative.hitTarget, 'screener');
      assert.throws(() => assertReachable(negative), assert.AssertionError);
      record('H11_NEGATIVE', negative);
     } finally { await page.$eval('#dashboardScreen', (e, old) => old === null ? e.removeAttribute('style') : e.setAttribute('style', old), original); }
    }
    await page.focus('#sidebarAccountEntry'); await page.keyboard.press('Tab'); await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'sidebarAccountEntry');
    assert.ok(await page.$eval('#sidebarAccountEntry', e => e.matches(':focus-visible') && parseFloat(getComputedStyle(e).outlineWidth) >= 2));
    await openAndClose('#sidebarAccountEntry', width === 768 || height === 700);
    await page.keyboard.press('Escape'); await pause(150);
    assert.equal(await page.$eval('#appSidebar', e => e.classList.contains('mobile-open')), false);
    record('H11_CLOSED_STATE', await page.evaluate(() => ({route:currentPage, premium:premiumAccessState, barClass:document.getElementById('acBottomBar').className, dashboard:document.getElementById('dashboardScreen').className, active:document.activeElement.id})));
    await page.click('#acBottomBar [data-page="screener"]'); await pause(200);
    assert.equal(await page.evaluate(() => currentPage), 'screener');
    await page.click('#acBottomBar [data-page="dashboard"]'); await pause(200);
    assert.equal(await page.evaluate(() => currentPage), 'dashboard');
    const hitTargets = await page.$$eval('#acBottomBar button:not(.hidden)', els => els.map(e => { const r = e.getBoundingClientRect(); return e.contains(document.elementFromPoint(r.x + r.width/2, r.y + r.height/2)); }));
    assert.ok(hitTargets.length >= 3 && hitTargets.every(Boolean), 'closed drawer must not intercept any primary bottom control');
    assert.equal(await page.$eval('#acBottomBar', e => getComputedStyle(e).position), 'fixed');
    record('H11_MOBILE', { width, height, ...current, focusRestored: true, bottomScreenerWorks: true });
   } else {
    // V2 intentionally hides the duplicate header account controls; the
    // existing desktop sidebar entry is the canonical visible trigger.
    assert.equal(await page.$eval('#headerAccountSection', e => getComputedStyle(e).display), 'none');
    assert.equal(await page.$eval('#dashboardScreen', e => getComputedStyle(e).zIndex), 'auto');
    await openAndClose('#sidebarAccountEntry', true);
    record('H11_DESKTOP', { width, height, duplicateHeaderUnchanged: true, desktopTrigger: '#sidebarAccountEntry', focusRestored: true });
   }
   assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
  }
  assert.deepEqual(errors, []);
 } finally { page.off('pageerror', onError); if (process.env.H11_EVIDENCE_PATH) fs.writeFileSync(process.env.H11_EVIDENCE_PATH, JSON.stringify(evidence, null, 2)); try { await browser.close(); } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } }
});
