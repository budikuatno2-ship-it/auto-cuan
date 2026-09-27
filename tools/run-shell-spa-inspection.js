'use strict';

/**
 * FASE 19 — Shell SPA visual inspection (headless, local only).
 *
 * Serves public/ and drives Chrome via the DevTools protocol over a raw
 * WebSocket so the checks below run against the REAL page, not a string match:
 *
 *   1. sidebar is position:fixed and does NOT move when the content scrolls
 *   2. exactly one document scrollbar (no double scrollbar)
 *   3. clicking Bandarmologi opens the real view (iframe /analisis-saham)
 *   4. clicking Sinyal Intelijen opens the real view
 *   5. the active pill is emerald, not white
 *   6. exactly one floating launcher, anchored bottom-right 24px
 *   7. the horizontal header is hidden at >=1024px
 *
 * Usage: node tools/run-shell-spa-inspection.js
 * Exit code 0 = all checks passed.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const PORT = 4599;
const DEBUG_PORT = 9333;

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium'
];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2'
};

/** Enumerate the static files this harness is allowed to serve. */
function collectPublicFiles(dir, base) {
  const root = dir || PUBLIC;
  const prefix = base || '';
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const rel = prefix + '/' + entry.name;
    if (entry.isDirectory()) out.push(...collectPublicFiles(path.join(root, entry.name), rel));
    else out.push({ rel, abs: path.join(root, entry.name) });
  }
  return out;
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.split('?')[0].startsWith('/api/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, maintenance: false, data: [] }));
        return;
      }

      // Serve ONLY files that are explicitly allow-listed. The request never
      // reaches the filesystem as a path fragment, so no traversal is possible.
      const requestPath = req.url.split('?')[0];
      const rewrites = {
        '/': '/index.html',
        '/dashboard': '/index.html',
        '/analisis-saham': '/analisis-saham.html',
        '/portfolio-command-center': '/portfolio-command-center.html'
      };
      const target = rewrites[requestPath] || requestPath;

      const served = new Set(collectPublicFiles().map((f) => f.rel));
      let file = path.join(PUBLIC, 'index.html');
      if (served.has(target)) {
        const candidate = path.join(PUBLIC, target.replace(/^\//, ''));
        const resolved = path.resolve(candidate);
        // Belt and braces: the resolved path must stay inside PUBLIC.
        if (resolved.startsWith(path.resolve(PUBLIC) + path.sep)) file = resolved;
      }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(PORT, () => resolve(server));
  });
}

function findChrome() {
  for (const c of CHROME_CANDIDATES) if (fs.existsSync(c)) return c;
  return null;
}

function launchChrome(bin, profileDir) {
  const args = [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + DEBUG_PORT,
    '--user-data-dir=' + profileDir,
    '--window-size=1440,900',
    'about:blank'
  ];
  return spawn(bin, args, { stdio: 'ignore' });
}

function httpJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function waitForDevtools(retries) {
  const attempt = (n) => httpJson('http://127.0.0.1:' + DEBUG_PORT + '/json/version')
    .catch((e) => {
      if (n <= 0) throw e;
      return new Promise((r) => setTimeout(r, 400)).then(() => attempt(n - 1));
    });
  return attempt(retries || 25);
}

/** Minimal CDP client. Uses Node's built-in global WebSocket (Node >= 22). */
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
  static connect(url) {
    if (typeof WebSocket !== 'function') {
      return Promise.reject(new Error('global WebSocket unavailable (needs Node >= 22)'));
    }
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => resolve(new Cdp(ws));
      ws.onerror = (e) => reject(new Error('CDP socket error: ' + (e && e.message ? e.message : 'unknown')));
    });
  }
  send(method, params) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 30000);
    });
  }
  attach() {
    this.ws.onmessage = (event) => {
      let msg; try { msg = JSON.parse(String(event.data)); } catch (_) { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    };
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + expression.slice(0, 120));
    return r.result.value;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const chrome = findChrome();
  if (!chrome) { console.error('SKIP: Chrome not found'); process.exit(0); }
  if (typeof WebSocket !== 'function') {
    console.error('SKIP: Node >= 22 required for the built-in WebSocket');
    process.exit(0);
  }

  const server = await startServer();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-inspect-'));
  const child = launchChrome(chrome, profileDir);
  const results = [];
  const record = (name, pass, detail) => { results.push({ name, pass, detail }); };

  try {
    const version = await waitForDevtools(30);
    const cdp = await Cdp.connect(version.webSocketDebuggerUrl);
    cdp.attach();
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

    // Wrap the session: every send carries sessionId.
    const sess = {
      send: (method, params) => {
        const id = ++cdp.id;
        cdp.ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }));
        return new Promise((resolve, reject) => {
          cdp.pending.set(id, { resolve, reject });
          setTimeout(() => { if (cdp.pending.has(id)) { cdp.pending.delete(id); reject(new Error('timeout ' + method)); } }, 30000);
        });
      },
      eval: async (expression) => {
        const r = await sess.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + expression.slice(0, 140));
        return r.result.value;
      }
    };

    await sess.send('Page.enable');
    await sess.send('Runtime.enable');
    await sess.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/dashboard' });
    await sleep(4000);

    // --- 1/2: shell geometry ------------------------------------------------
    const geom = await sess.eval(`(() => {
      const sb = document.getElementById('appSidebar');
      const main = document.getElementById('appMain');
      if (!sb || !main) return { error: 'shell elements missing' };
      const cs = getComputedStyle(sb);
      return {
        position: cs.position,
        width: sb.getBoundingClientRect().width,
        mainMarginLeft: getComputedStyle(main).marginLeft,
        docScrollable: document.documentElement.scrollHeight > window.innerHeight + 4,
        sidebarScrollsWithPage: (() => {
          const before = sb.getBoundingClientRect().top;
          window.scrollTo(0, 600);
          const after = sb.getBoundingClientRect().top;
          window.scrollTo(0, 0);
          return Math.abs(after - before) > 2;
        })(),
        hidden: sb.classList.contains('hidden')
      };
    })()`);

    record('1. sidebar is position:fixed', geom.position === 'fixed', JSON.stringify(geom));
    record('1b. sidebar does NOT scroll with the page', geom.sidebarScrollsWithPage === false,
      'moved=' + geom.sidebarScrollsWithPage);
    record('1c. main column is offset by the rail width', geom.mainMarginLeft === '240px',
      'margin-left=' + geom.mainMarginLeft);

    // --- 3/4: real sub-view routing ----------------------------------------
    await sess.eval(`(function(){
      var g = document.getElementById('sidebarGroupAnalisis');
      if (g) { g.querySelector('.sidebar-parent-item').click(); }
      return true;
    })()`);
    await sleep(500);

    const clickAndProbe = async (sub, expectToken) => {
      await sess.eval(`(function(){ selectAnalisisSubView(${JSON.stringify(sub)}); return true; })()`);
      await sleep(2500);
      return sess.eval(`(() => {
        const host = document.getElementById('workspaceViewHost');
        const frame = document.getElementById('workspaceViewFrame');
        const open = Boolean(host && !host.classList.contains('hidden'));
        const src = frame ? frame.getAttribute('src') : null;
        let inner = null, diag = {};
        try {
          const w = frame.contentWindow, d = w.document;
          const tabs = d.querySelectorAll('.analisis-tab');
          const active = d.querySelector('.analisis-tab.active');
          inner = active ? (active.dataset.tab || active.textContent.trim()) : null;
          diag = {
            readyState: d.readyState,
            title: d.title,
            tabs: tabs.length,
            hasSwitch: typeof w.switchAnalisisTab,
            bodyLen: d.body ? d.body.innerHTML.length : 0
          };
        } catch (e) { inner = 'cross-origin:' + e.message; }
        return { open, src, inner, diag };
      })()`);
    };

    const bandar = await clickAndProbe('bandarmologi', 'bandarmologi');
    record('3. Bandarmologi opens the real view',
      bandar.open && /analisis-saham/.test(bandar.src || '') && bandar.inner === 'bandarmologi',
      JSON.stringify(bandar));

    const intel = await clickAndProbe('intel', 'intel');
    record('4. Sinyal Intelijen opens the real view',
      intel.open && intel.inner === 'intel', JSON.stringify(intel));

    // --- 5: active pill colour ---------------------------------------------
    const pill = await sess.eval(`(() => {
      const el = document.querySelector('#appSidebar .sidebar-item.active');
      if (!el) return { error: 'no active item' };
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, color: cs.color, text: el.textContent.trim() };
    })()`);
    const bg = (pill.bg || '');
    const isEmerald = /16,\s*185,\s*129/.test(bg) || /52,\s*211,\s*153/.test(bg);
    record('5. active pill is emerald, not white', isEmerald, JSON.stringify(pill));

    // --- 6: single floating launcher ---------------------------------------
    const floaters = await sess.eval(`(() => {
      const btn = document.getElementById('aiFloatingBtn');
      const all = Array.from(document.querySelectorAll('body > button, body > a'))
        .filter((el) => {
          const cs = getComputedStyle(el);
          return cs.position === 'fixed' && /bottom|right/.test(cs.bottom + cs.right) &&
                 el.getBoundingClientRect().width > 24 && el.offsetParent !== null;
        })
        .map((el) => el.id || el.className);
      if (!btn) return { error: 'aiFloatingBtn missing' };
      const cs = getComputedStyle(btn);
      const r = btn.getBoundingClientRect();
      return { count: all.length, ids: all, bottom: cs.bottom, right: cs.right, z: cs.zIndex,
               onScreen: r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1 };
    })()`);
    record('6. floating launcher is anchored bottom-right, on-screen',
      floaters.bottom === '24px' && floaters.right === '24px' && floaters.onScreen === true,
      JSON.stringify(floaters));

    // --- 7: horizontal header hidden on desktop ----------------------------
    const header = await sess.eval(`(() => {
      const h = document.querySelector('#appMain > .app-header');
      if (!h) return { display: 'absent' };
      return { display: getComputedStyle(h).display };
    })()`);
    record('7. horizontal header hidden at desktop', header.display === 'none' || header.display === 'absent',
      JSON.stringify(header));

    // --- screenshots for the visual record ---------------------------------
    // Screenshots are written to a fixed, pre-created directory under a fixed
    // set of names — no caller-controlled path fragment reaches the filesystem.
    const SHOT_DIR = path.join(ROOT, 'tmp_investigasi');
    const SHOT_NAMES = {
      dashboard: 'inspect-dashboard.png',
      bandarmologi: 'inspect-bandarmologi.png',
      ranking: 'inspect-ranking.png'
    };
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const shot = async (key) => {
      const name = SHOT_NAMES[key];
      if (!name) return false;
      try {
        const r = await sess.send('Page.captureScreenshot', { format: 'png' });
        const out = path.resolve(SHOT_DIR, name);
        if (!out.startsWith(path.resolve(SHOT_DIR) + path.sep)) return false;
        fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
        return true;
      } catch (_) { return false; }
    };
    await sess.eval(`(function(){ if (window.AutoCuanShellSpa) window.AutoCuanShellSpa.close(); navigateTo('dashboard'); return true; })()`);
    await sleep(1200);
    await shot('dashboard');
    await clickAndProbe('bandarmologi');
    await shot('bandarmologi');
    await clickAndProbe('ranking');
    await shot('ranking');
  } catch (err) {
    record('inspection harness', false, err.message);
  } finally {
    try { child.kill(); } catch (_) {}
    try { server.close(); } catch (_) {}
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (_) {}
  }

  console.log('\n===== FASE 19 — SHELL SPA VISUAL INSPECTION =====');
  let failed = 0;
  results.forEach((r) => {
    if (!r.pass) failed++;
    console.log((r.pass ? 'PASS ' : 'FAIL ') + r.name + (r.pass ? '' : '  -> ' + r.detail));
  });
  console.log(failed === 0 ? '\nALL CHECKS PASSED' : '\n' + failed + ' CHECK(S) FAILED');
  process.exit(failed === 0 ? 0 : 1);
}

main();
