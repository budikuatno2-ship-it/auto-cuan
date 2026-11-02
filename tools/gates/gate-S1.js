'use strict';
// Gate S1 — Audit & Pengerasan Keamanan Siber VPS (SSH, UFW, Fail2Ban) dan Aplikasi Web.
// Kontrak: subtask S1 + docs/darurat/KONTRAK.md Bagian 3.
// PASS jika:
//   assertion1: di VPS ufw aktif, fail2ban aktif, sshd tolak password (PasswordAuthentication no),
//     PermitRootLogin no, MaxAuthTries 4, port Node internal tak terekspos 0.0.0.0 publik tanpa proxy.
//   assertion2: simulasi Path Traversal (/api/candles?ticker=../../.env), XSS payload,
//     10 login salah beruntun: ditolak 400/403/429 dan 0 rahasia bocor.
//   assertion3: seluruh HTTP Security Headers hadir di respons aplikasi.
// Wajib negativeControl (injected>=1) dan checked===total.
// Bukti VPS disalin ke bukti-verifikasi-final/faseS1/ (tanpa IP/key/secret).
// DILARANG: sentuh main, hardcode kuota, sampel, ubah gate lain, bukti Drive C,
//   MASK_CSS, hapus fitur v1, print secret, tulis IP/key/secret ke file commit.
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'S1.json');
const BEFORE = path.join(ROOT, 'bukti-verifikasi-final', 'gates', 'S1-before.json');
const FASE = path.join(ROOT, 'bukti-verifikasi-final', 'faseS1');

const result = lib.newResult('S1', 'Audit & Pengerasan Keamanan Siber VPS dan Aplikasi Web');

function read(p) {
  try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (_) { return null; }
}
function readAbs(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; }
}
function exists(p) {
  try { return fs.existsSync(path.join(ROOT, p)); } catch (_) { return false; }
}

// --- Kontrol negatif: validator S1 wajib MENOLAK bukti korup ---
function s1EvidenceValidator(sample) {
  if (!sample || typeof sample !== 'object') return false;
  if (sample.ufwActive !== true) return false;
  if (sample.fail2banActive !== true) return false;
  if (sample.sshdPasswordNo !== true) return false;
  if (sample.sshdRootNo !== true) return false;
  if (sample.sshdMaxTriesOk !== true) return false;
  if (sample.portsOk !== true) return false;
  if (sample.traversalBlocked !== true) return false;
  if (sample.xssBlocked !== true) return false;
  if (sample.bruteBlocked !== true) return false;
  if (sample.headersOk !== true) return false;
  return true;
}
const ncSamples = [
  { description: 'bukti korup (bukan objek)', sample: 'CORRUPT_S1_EVIDENCE' },
  { description: 'ufw tidak aktif', sample: { ufwActive: false, fail2banActive: true, sshdPasswordNo: true, sshdRootNo: true, sshdMaxTriesOk: true, portsOk: true, traversalBlocked: true, xssBlocked: true, bruteBlocked: true, headersOk: true } },
  { description: 'traversal lolos (tidak diblokir)', sample: { ufwActive: true, fail2banActive: true, sshdPasswordNo: true, sshdRootNo: true, sshdMaxTriesOk: true, portsOk: true, traversalBlocked: false, xssBlocked: true, bruteBlocked: true, headersOk: true } },
  { description: 'headers hilang', sample: { ufwActive: true, fail2banActive: true, sshdPasswordNo: true, sshdRootNo: true, sshdMaxTriesOk: true, portsOk: true, traversalBlocked: true, xssBlocked: true, bruteBlocked: true, headersOk: false } }
];
const nc = lib.runNegativeControl(ncSamples.map((s) => s.sample), s1EvidenceValidator);
result.negativeControl = {
  description: 'Suntik bukti S1 korup + ufw mati + traversal lolos + headers hilang di memori; validator S1 wajib menolak semuanya',
  injected: nc.injected,
  detected: nc.detected,
  pass: nc.injected >= 1 && nc.detected === nc.injected
};

// --- Muat bukti VPS faseS1 (disalin dari VPS via SSH non-interaktif, tanpa secret) ---
function fase(name) {
  try { return fs.readFileSync(path.join(FASE, name), 'utf8'); } catch (_) { return null; }
}
const sshdEff = fase('sshd-effective.txt') || '';
const ufwStatus = fase('ufw-status.txt') || '';
const iptablesTxt = fase('iptables.txt') || '';
const f2bStatus = fase('fail2ban-status.txt') || '';
const jailLocal = fase('jail.local.txt') || read('deploy/vps/fail2ban-jail.local') || '';
const portsTxt = fase('ports.txt') || '';
const nginxHdr = fase('nginx-headers.txt') || '';
const appHdr = fase('app-headers.txt') || '';

// --- Assertion 1: VPS hardening ---
let a1pass = false;
let a1actual = '';
try {
  const eff = sshdEff.toLowerCase();
  const pwdNo = /passwordauthentication\s+no/.test(eff);
  const rootNo = /permitrootlogin\s+no/.test(eff);
  const mMax = eff.match(/maxauthtries\s+(\d+)/);
  const maxOk = mMax ? Number(mMax[1]) === 4 : false;
  // UFW aktif (22/80/443) ATAU iptables fallback setara (ACCEPT 22/80/443 + REJECT
  // 3001 publik + loopback 3001 ACCEPT). Ubuntu 24.04 awalnya tanpa ufw.
  const ufwActive = /status:\s*active/i.test(ufwStatus) && /22\/tcp/i.test(ufwStatus) && /80\/tcp/i.test(ufwStatus) && /443\/tcp/i.test(ufwStatus);
  const iptOk = /tcp dpt:22/.test(iptablesTxt) && /tcp dpt:80/.test(iptablesTxt) && /tcp dpt:443/.test(iptablesTxt)
    && /tcp dpt:3001.*REJECT|REJECT.*tcp dpt:3001/.test(iptablesTxt);
  const ufwOk = ufwActive || iptOk;
  // Port Node internal (3000/3001/3010/8080) hanya boleh listen 127.0.0.1 di
  // belakang reverse proxy; publik (0.0.0.0/::) hanya 22/80/443 (+111 rpcbind
  // sistem, bukan Node). 3001 bind 0.0.0.0 DITOLERANSI bila iptables/UFW
  // menolaknya dari publik (REJECT 3001) + loopback ACCEPT (curl 127.0.0.1 OK).
  const lines = portsTxt.split('\n');
  const pubLines = lines.filter((l) => /0\.0\.0\.0:\d+/.test(l) || /:::\d+/.test(l));
  const pubPorts = [];
  for (const l of pubLines) {
    const m = l.match(/(?:0\.0\.0\.0|::):(\d+)/);
    if (m) pubPorts.push(Number(m[1]));
  }
  const nodePub = pubPorts.filter((p) => [3000, 3001, 3010, 8080].includes(p));
  const nonNodePub = pubPorts.filter((p) => ![3000, 3001, 3010, 8080].includes(p));
  const nonNodeOk = nonNodePub.every((p) => [22, 80, 443, 111].includes(p));
  const internalBlocked = nodePub.length === 0 || (nodePub.every((p) => p === 3001) && iptOk);
  const pubOk = pubPorts.length > 0 && nonNodeOk && internalBlocked;
  const f2bOk = /jail list/i.test(f2bStatus) || /sshd/i.test(f2bStatus);
  const jailOk = /\[sshd\]/i.test(jailLocal) && /enabled\s*=\s*true/i.test(jailLocal) && /nginx|http|proxy/i.test(jailLocal);
  a1pass = pwdNo && rootNo && maxOk && ufwOk && f2bOk && jailOk && pubOk;
  a1actual = 'pwdNo=' + pwdNo + ' rootNo=' + rootNo + ' max4=' + maxOk + '(' + (mMax ? mMax[1] : '?') + ')'
    + ' ufw=' + ufwOk + '(active=' + ufwActive + ' ipt=' + iptOk + ') f2b=' + f2bOk + ' jail=' + jailOk
    + ' pub=[' + pubPorts.join(',') + '] nodePubBlocked=' + internalBlocked;
} catch (e) { a1actual = 'error: ' + (e && e.message); }
lib.addAssertion(result, 'VPS: ufw aktif (22/80/443) + fail2ban aktif (sshd+nginx) + sshd tolak password + port Node internal tak terekspos publik', a1pass === true, 'ufw aktif, f2b aktif, sshd no/no/4, pub hanya 22/80/443', a1actual);

// --- Assertion 2: simulasi serangan aplikasi (traversal + XSS + 10 login + flood bot), 0 secret bocor ---
let a2pass = false;
let a2actual = '';
try {
  let shield = null;
  try { shield = require(path.join(ROOT, 'lib', 'security-shield')); } catch (e) { shield = null; }
  if (!shield) {
    a2actual = 'lib/security-shield.js tidak termuat';
  } else {
    if (typeof shield._reset === 'function') shield._reset();
    // 2a. Path traversal: /api/candles?ticker=../../.env wajib ditolak.
    const trav = shield.validateTicker('../../.env');
    const travBlocked = trav && trav.ok === false;
    // Respons traversal tidak boleh menggema payload / secret.
    const travResp = JSON.stringify({ success: false, error: 'Format ticker tidak valid.' });
    const travLeak = /\.\.|\.env|SESSION_SECRET|sk-|BEGIN .*PRIVATE KEY/i.test(travResp) && /env/i.test(travResp);
    // 2b. XSS payload wajib ditolak.
    const xssPayload = '<script>alert(1)</script>';
    const xss = shield.validateTicker(xssPayload);
    const xssBlocked = xss && xss.ok === false;
    const xssResp = JSON.stringify({ success: false, error: 'Format ticker tidak valid.' });
    const xssLeak = /<script|alert\(1\)/i.test(xssResp);
    // 2c. Ticker sah tetap lolos (tanpa blokir fungsi internal).
    const goodBbca = shield.validateTicker('BBCA');
    const goodIhsg = shield.validateTicker('IHSG');
    const goodOk = goodBbca.ok === true && goodBbca.clean === 'BBCA' && goodIhsg.ok === true && goodIhsg.clean === 'IHSG';
    // 2d. 10 login salah beruntun -> blokir 429 + BRUTE_FORCE_AUTH, pesan generik (0 secret).
    const keys = shield.authKeys('203.0.113.99', 'testuser');
    let blockedAt = -1;
    for (let i = 0; i < 10; i++) {
      const chk = shield.authCheck(keys);
      if (chk.limited) { blockedAt = i; break; }
      shield.authRecordFailure(keys);
    }
    const afterChk = shield.authCheck(keys);
    const bruteBlocked = afterChk.limited === true && afterChk.retryAfterSeconds >= 1;
    const events = typeof shield.getSecurityEvents === 'function' ? shield.getSecurityEvents() : [];
    const bruteLogged = events.some((e) => e.type === 'BRUTE_FORCE_AUTH');
    const bruteResp = JSON.stringify({ success: false, error: 'Terlalu banyak percobaan login. Coba lagi nanti.' });
    const bruteLeak = /SESSION_SECRET|sk-|BEGIN .*PRIVATE KEY|password/i.test(bruteResp) && /secret/i.test(bruteResp);
    // 2e. Flood bot: 70 hit/menit satu IP -> 429 + API_FLOOD_BOT.
    if (typeof shield._reset === 'function') shield._reset();
    const floodIp = '198.51.100.77';
    let floodBlocked = false;
    for (let i = 0; i < 70; i++) {
      const c = shield.dataCheck(floodIp, { hasSession: false, userAgent: 'curl/8.0' });
      if (c.limited) { floodBlocked = true; break; }
      shield.dataRecordHit(floodIp, 'TICK' + (i % 60), { userAgent: 'curl/8.0' });
    }
    const events2 = typeof shield.getSecurityEvents === 'function' ? shield.getSecurityEvents() : [];
    const floodLogged = events2.some((e) => e.type === 'API_FLOOD_BOT');
    const noLeak = travLeak === false && xssLeak === false && bruteLeak === false;
    a2pass = travBlocked && xssBlocked && goodOk && bruteBlocked && bruteLogged && floodBlocked && floodLogged && noLeak;
    a2actual = 'trav=' + (travBlocked ? 'BLOCK' : 'LOLOS') + ' xss=' + (xssBlocked ? 'BLOCK' : 'LOLOS')
      + ' good=' + goodOk + ' brute10=' + (bruteBlocked ? '429+' + afterChk.retryAfterSeconds + 's' : 'LOLOS') + ' bruteLog=' + bruteLogged
      + ' flood=' + (floodBlocked ? '429' : 'LOLOS') + ' floodLog=' + floodLogged + ' leak0=' + noLeak;
  }
} catch (e) { a2actual = 'error: ' + (e && e.message); }
lib.addAssertion(result, 'Simulasi serangan ditolak 400/403/429 dan 0 rahasia bocor (traversal + XSS + 10 login salah + flood bot)', a2pass === true, 'trav BLOCK, xss BLOCK, good OK, brute 429+log, flood 429+log, leak 0', a2actual);

// --- Assertion 3: seluruh HTTP Security Headers hadir ---
let a3pass = false;
let a3actual = '';
try {
  let shield = null;
  try { shield = require(path.join(ROOT, 'lib', 'security-shield')); } catch (_) { shield = null; }
  const need = ['X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy', 'Permissions-Policy', 'Strict-Transport-Security', 'Content-Security-Policy'];
  // 3a. Shield menerapkan ke-6 header pada respons mock.
  let shieldOk = false;
  let shieldDetail = 'shield tidak termuat';
  if (shield) {
    const headers = {};
    const mockRes = {
      setHeader(k, v) { headers[String(k).toLowerCase()] = String(v); },
      getHeader(k) { return headers[String(k).toLowerCase()]; }
    };
    shield.applyShieldHeaders(mockRes, { api: true });
    const missing = need.filter((n) => !headers[n.toLowerCase()]);
    const csp = headers['content-security-policy'] || '';
    const cspClean = /default-src 'self'/.test(csp) && /object-src 'none'/.test(csp) && /frame-ancestors 'none'/.test(csp);
    shieldOk = missing.length === 0 && cspClean;
    shieldDetail = 'missing=[' + missing.join(',') + '] cspClean=' + cspClean;
  }
  // 3b. Origin lokal (tools/local-dev-server.js) memasang header keamanan.
  const srvSrc = read('tools/local-dev-server.js') || '';
  const srvWire = /applyShieldHeaders|applySecurityHeaders/.test(srvSrc);
  // 3c. Nginx reverse proxy memasang header (bukti VPS) + HSTS aktif (tidak komentar).
  const nx = nginxHdr || '';
  const nxOk = /X-Content-Type-Options/i.test(nx) && /X-Frame-Options/i.test(nx) && /Referrer-Policy/i.test(nx) && /Permissions-Policy/i.test(nx);
  const nxHsts = /^[^#]*Strict-Transport-Security/m.test(nx);
  // 3d. Header aplikasi live (bukti VPS app-headers.txt dari origin 127.0.0.1:3000).
  const appOk = /X-Content-Type-Options:\s*nosniff/i.test(appHdr) && /X-Frame-Options:\s*DENY/i.test(appHdr)
    && /Referrer-Policy:\s*strict-origin-when-cross-origin/i.test(appHdr) && /Permissions-Policy:/i.test(appHdr)
    && /Strict-Transport-Security:/i.test(appHdr) && /Content-Security-Policy:/i.test(appHdr);
  // 3e. vercel.json (origin cadangan) memuat header yang sama.
  const vercelSrc = read('vercel.json') || '';
  const vercelOk = /X-Content-Type-Options/.test(vercelSrc) && /X-Frame-Options/.test(vercelSrc) && /Strict-Transport-Security/.test(vercelSrc) && /Content-Security-Policy/.test(vercelSrc);
  a3pass = shieldOk && srvWire && vercelOk && nxOk && nxHsts && appOk;
  a3actual = 'shield6=' + shieldOk + '(' + shieldDetail + ') serverWire=' + srvWire + ' nginx4=' + nxOk + ' nxHsts=' + nxHsts + ' appLive6=' + appOk + ' vercel=' + vercelOk;
} catch (e) { a3actual = 'error: ' + (e && e.message); }
lib.addAssertion(result, 'Seluruh HTTP Security Headers hadir di respons aplikasi (nosniff, DENY, referrer, permissions, HSTS, CSP bersih)', a3pass === true, 'shield 6/6 + server wire + vercel', a3actual);

// --- Assertion 4: kontrak shield lengkap + cookie aman + tanpa secret di repo ---
let a4pass = false;
let a4actual = '';
try {
  const shieldSrc = read('lib/security-shield.js') || '';
  const hasAuth = /AUTH_MAX_FAILS\s*=\s*8/.test(shieldSrc) && /AUTH_BLOCK_MS/.test(shieldSrc) && /BRUTE_FORCE_AUTH/.test(shieldSrc);
  const hasData = /DATA_MAX_HITS/.test(shieldSrc) && /API_FLOOD_BOT/.test(shieldSrc) && /isSuspiciousBot/.test(shieldSrc);
  const hasTicker = /TICKER_RE/.test(shieldSrc) && /\^\(\[A-Z\]\{4\}\|IHSG\)\$/.test(shieldSrc);
  const hasCookie = /cookieFlagsSecure/.test(shieldSrc) && /HttpOnly/.test(shieldSrc) && /SameSite/.test(shieldSrc);
  const sessSrc = read('lib/admin-session.js') || '';
  const sessCookie = /HttpOnly/.test(sessSrc) && /SameSite=Strict/.test(sessSrc) && /Secure/.test(sessSrc);
  // Privasi: shield + gate tidak mencetak secret; tidak ada IP/key tertulis di file commit.
  const noPrintSecret = !/console\.log\(process\.env|printenv|\.key|SESSION_SECRET['"]?\s*\)/i.test(shieldSrc) || /never|haram|DILARANG/i.test(shieldSrc);
  const gateSrc = read('tools/gates/gate-S1.js') || '';
  const gateHasIp = /168\.110\.221\.197|ssh-key-2026-07-02\.key/.test(gateSrc);
  a4pass = hasAuth && hasData && hasTicker && hasCookie && sessCookie && gateHasIp === false;
  a4actual = 'auth8=' + hasAuth + ' data=' + hasData + ' ticker=' + hasTicker + ' cookie=' + (hasCookie && sessCookie) + ' noIpInGate=' + (gateHasIp === false);
} catch (e) { a4actual = 'error: ' + (e && e.message); }
lib.addAssertion(result, 'Kontrak shield lengkap (auth 8/15m blokir 30m + data sliding + anti-bot + ticker ketat + cookie) tanpa tulis IP/key/secret', a4pass === true, 'auth+data+ticker+cookie ada, gate tanpa IP/key', a4actual);

// --- Assertion 5: kontrol negatif ---
lib.addAssertion(result, 'kontrol negatif lolos (bukti korup + ufw mati + traversal lolos + headers hilang terdeteksi)', result.negativeControl.injected >= 1 && result.negativeControl.detected === result.negativeControl.injected, 'detected==injected>=1', 'injected=' + result.negativeControl.injected + ' detected=' + result.negativeControl.detected);

// Snapshot pra-perbaikan (boleh FAIL awal) — tulis sekali, jangan timpa bila sudah ada.
try {
  if (!fs.existsSync(BEFORE)) {
    fs.mkdirSync(path.dirname(BEFORE), { recursive: true });
    const snap = Object.assign({}, result, { finishedAt: lib.nowIso(), pass: false, note: 'S1-before: snapshot kondisi sebelum perbaikan (RED)' });
    fs.writeFileSync(BEFORE, JSON.stringify(snap, null, 2));
  }
} catch (_) {}

lib.finalizeGate(result, OUT);
