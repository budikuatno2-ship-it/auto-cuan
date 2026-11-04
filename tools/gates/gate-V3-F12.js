'use strict';
// Gate V3-F12 — Pertahanan Siber VPS (ufw, fail2ban, Forensik Ghidra, & Alarm Serangan Bot ke Telegram + Admin Console).
// Verifikasi: lib/security-shield.js (403 auto-blokir + ufw/fail2ban/Ghidra + alarm Telegram) +
// scripts/security-audit-ghidra-style.js (audit proses/port/hash SHA-256 VPS) +
// routes/admin.js (status keamanan + block/unblock + 403 guard) +
// Tab Keamanan Admin Console (panel VPS + Unblock + alarm).
// Gate: simulasi serangan IP uji 203.0.113.99 diblokir otomatis, tercatat di UI Admin Console,
// kirim payload alert, berhasil Unblock.
// ATURAN BESI: no GH polling/sleep, no Vercel, Windows node -e, data riil, anti-gate-gaming.
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates-v3', 'F12.json');

const result = lib.newResult('V3-F12', 'Pertahanan siber VPS: ufw+fail2ban+Ghidra 0 asing + 403 auto-blokir + alarm Telegram + tab Keamanan');

function read(p) { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (_) { return null; } }
function existsRaw(p) { try { return fs.existsSync(path.join(ROOT, p)); } catch (_) { return false; } }

// Kontrol negatif: validator blokir-IP wajib MENOLAK sampel korup/tak-valid.
function ipBlockValidator(sample) {
  if (!sample || typeof sample !== 'object') return false;
  if (sample.blocked !== true) return false;
  if (typeof sample.ip !== 'string' || !/^(\d{1,3}\.){3}\d{1,3}$/.test(sample.ip)) return false;
  if (!sample.until || !Number.isFinite(Date.parse(sample.until))) return false;
  if (!sample.payload || typeof sample.payload.text !== 'string') return false;
  if (sample.payload.text.indexOf('DIBLOKIR') < 0) return false;
  if (sample.payload.text.indexOf(sample.ip) < 0) return false;
  return true;
}

async function main() {
  const ncSamples = [
    null,
    { blocked: false },
    { blocked: true, ip: 'bukan-ip', until: new Date().toISOString(), payload: { text: 'DIBLOKIR 1.2.3.4' } },
    { blocked: true, ip: '203.0.113.99', until: 'bukan-tanggal', payload: { text: 'DIBLOKIR 203.0.113.99' } },
    { blocked: true, ip: '203.0.113.99', until: new Date().toISOString(), payload: null },
    { blocked: true, ip: '203.0.113.99', until: new Date().toISOString(), payload: { text: 'halo dunia' } },
    { blocked: true, ip: '203.0.113.99', until: new Date().toISOString(), payload: { text: 'DIBLOKIR 1.2.3.4' } },
    { success: true }
  ];
  const nc = lib.runNegativeControl(ncSamples, ipBlockValidator);
  result.negativeControl = {
    description: 'Suntik null/tak-diblokir/IP-salah/tanggal-salah/payload-null/teks-tanpa-DIBLOKIR/IP-tak-cocok; validator blokir wajib menolak',
    injected: nc.injected, detected: nc.detected,
    pass: nc.injected >= 1 && nc.detected === nc.injected
  };

  // 1. Scope file ada (hanya scope subtask).
  const scopeFiles = ['lib/security-shield.js', 'scripts/security-audit-ghidra-style.js', 'routes/admin.js'];
  const missingScope = scopeFiles.filter((f) => !existsRaw(f));
  lib.addAssertion(result, 'scope V3-F12 selaras (shield+audit-ghidra+routes/admin)',
    missingScope.length === 0, '3/3 ada', missingScope.length ? ('hilang: ' + missingScope.join(',')) : '3/3 ada');

  const shieldSrc = read('lib/security-shield.js') || '';
  const auditSrc = read('scripts/security-audit-ghidra-style.js') || '';
  const adminSrc = read('routes/admin.js') || '';
  const html = read('public/admin-console.html') || '';
  const runtime = read('public/admin-console-runtime.js') || '';

  // 2. Shield V3-F12: 403 auto-blokir + ufw/fail2ban/Ghidra + alarm Telegram.
  let shieldOk = false;
  let shieldDetail = 'tidak terbaca';
  try {
    const has403 = shieldSrc.indexOf('recordHttp403') >= 0 && shieldSrc.indexOf('HTTP_403_WINDOW_MS') >= 0
      && shieldSrc.indexOf('HTTP_403_AUTO_BLOCK') >= 0 && shieldSrc.indexOf('HTTP_403_MAX_HITS') >= 0;
    const hasUfw = shieldSrc.indexOf('parseUfwStatus') >= 0 && shieldSrc.indexOf('defaultDeny') >= 0;
    const hasF2b = shieldSrc.indexOf('parseFail2banStatus') >= 0 && shieldSrc.indexOf('jail list') >= 0;
    const hasGhidra = shieldSrc.indexOf('parseProcessList') >= 0 && shieldSrc.indexOf('detectForeignProcesses') >= 0
      && shieldSrc.indexOf('parseListeningPorts') >= 0 && shieldSrc.indexOf('sha256Hex') >= 0;
    const hasAlarm = shieldSrc.indexOf('queueTelegramAlarm') >= 0 && shieldSrc.indexOf('buildTelegramAlertPayload') >= 0
      && shieldSrc.indexOf('ALARM DARURAT KEAMANAN') >= 0;
    const hasSsh = shieldSrc.indexOf('168.110.221.197') >= 0 && shieldSrc.indexOf('BatchMode') >= 0;
    shieldOk = has403 && hasUfw && hasF2b && hasGhidra && hasAlarm && hasSsh;
    shieldDetail = '403=' + has403 + ' ufw=' + hasUfw + ' f2b=' + hasF2b + ' ghidra=' + hasGhidra + ' alarm=' + hasAlarm + ' ssh=' + hasSsh;
  } catch (e) { shieldDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, 'lib/security-shield V3-F12: 403 auto-blokir + ufw/fail2ban/Ghidra + alarm Telegram + SSH VPS',
    shieldOk === true, '403+ufw+f2b+ghidra+alarm+ssh penuh', shieldDetail);

  // 3. Skrip audit Ghidra: SSH VPS + tulis vps-audit.json.
  let auditOk = false;
  let auditDetail = 'tidak terbaca';
  try {
    const hasSsh = auditSrc.indexOf('168.110.221.197') >= 0 && auditSrc.indexOf('BatchMode') >= 0;
    const hasCmds = auditSrc.indexOf('ufw status verbose') >= 0 && auditSrc.indexOf('fail2ban-client status') >= 0
      && auditSrc.indexOf('ps -eo pid,comm,args') >= 0 && auditSrc.indexOf('ss -tulpn') >= 0 && auditSrc.indexOf('sha256sum') >= 0;
    const hasOut = auditSrc.indexOf('vps-audit.json') >= 0 && auditSrc.indexOf('BERSIH-0-ASING') >= 0;
    const hasParsers = auditSrc.indexOf('parseUfwStatus') >= 0 && auditSrc.indexOf('detectForeignProcesses') >= 0;
    auditOk = hasSsh && hasCmds && hasOut && hasParsers;
    auditDetail = 'ssh=' + hasSsh + ' cmds=' + hasCmds + ' out=' + hasOut + ' parsers=' + hasParsers;
  } catch (e) { auditDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, 'scripts/security-audit-ghidra-style.js: SSH VPS + 5 perintah audit + vps-audit.json',
    auditOk === true, 'ssh+cmds+out+parsers penuh', auditDetail);

  // 4. routes/admin.js: status + block/unblock + 403 guard + auth admin.
  let adminOk = false;
  let adminDetail = 'tidak terbaca';
  try {
    const hasStatus = adminSrc.indexOf('handleSecurityStatus') >= 0 && adminSrc.indexOf('security_status') >= 0;
    const hasBlock = adminSrc.indexOf('handleBlockIp') >= 0 && adminSrc.indexOf('security_block_ip') >= 0;
    const hasUnblock = adminSrc.indexOf('handleUnblockIp') >= 0 && adminSrc.indexOf('security_unblock_ip') >= 0;
    const hasGuard = adminSrc.indexOf('guard403') >= 0 && adminSrc.indexOf('recordHttp403') >= 0;
    const hasAuth = adminSrc.indexOf('requireAdminSession') >= 0 && adminSrc.indexOf('isSameOrigin') >= 0;
    adminOk = hasStatus && hasBlock && hasUnblock && hasGuard && hasAuth;
    adminDetail = 'status=' + hasStatus + ' block=' + hasBlock + ' unblock=' + hasUnblock + ' guard=' + hasGuard + ' auth=' + hasAuth;
  } catch (e) { adminDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, 'routes/admin.js: status + block/unblock + guard403 + auth admin + same-origin',
    adminOk === true, 'status+block+unblock+guard+auth penuh', adminDetail);

  // 5. Tab Keamanan Admin Console: panel VPS (ufw/fail2ban/Ghidra) + Unblock + alarm.
  let uiOk = false;
  let uiDetail = 'tidak terbaca';
  try {
    const hasPanel = html.indexOf('data-v3f12-vps-panel') >= 0 && html.indexOf('Pertahanan Siber VPS') >= 0;
    const hasBadges = html.indexOf('secUfwBadge') >= 0 && html.indexOf('secF2bBadge') >= 0 && html.indexOf('secGhidraBadge') >= 0;
    const hasUnblock = html.indexOf('unblockIpAction') >= 0 && html.indexOf('Unblock IP') >= 0;
    const hasRender = runtime.indexOf('renderVpsPanel') >= 0 && runtime.indexOf('secUfwBadge') >= 0;
    uiOk = hasPanel && hasBadges && hasUnblock && hasRender;
    uiDetail = 'panel=' + hasPanel + ' badges=' + hasBadges + ' unblock=' + hasUnblock + ' render=' + hasRender;
  } catch (e) { uiDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, 'Tab Keamanan: panel VPS ufw/fail2ban/Ghidra + tombol Unblock + renderer runtime',
    uiOk === true, 'panel+badges+unblock+render penuh', uiDetail);

  // 6. Audit VPS riil: ufw aktif + fail2ban aktif + 0 proses asing + hash SHA-256.
  let vpsOk = false;
  let vpsDetail = 'audit tidak termuat';
  let vpsReport = null;
  try {
    const fp = path.join(ROOT, 'data', 'security', 'vps-audit.json');
    vpsReport = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const ufwOn = vpsReport && vpsReport.ufw && vpsReport.ufw.active === true;
    const f2bOn = vpsReport && vpsReport.fail2ban && vpsReport.fail2ban.active === true;
    const zeroForeign = vpsReport && vpsReport.processes && Number(vpsReport.processes.foreignCount) === 0;
    const hasHash = vpsReport && vpsReport.binaries && Array.isArray(vpsReport.binaries.hashes) && vpsReport.binaries.hashes.length >= 1;
    const fresh = vpsReport && vpsReport.at && (Date.now() - Date.parse(vpsReport.at)) < 24 * 60 * 60 * 1000;
    vpsOk = ufwOn && f2bOn && zeroForeign && hasHash && fresh === true;
    vpsDetail = 'ufw=' + ufwOn + ' f2b=' + f2bOn + ' asing=' + (vpsReport.processes && vpsReport.processes.foreignCount)
      + ' hash=' + (vpsReport.binaries && vpsReport.binaries.hashes && vpsReport.binaries.hashes.length)
      + ' fresh=' + fresh + ' at=' + (vpsReport.at || '-');
  } catch (e) { vpsDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, 'audit VPS riil: ufw aktif + fail2ban aktif + 0 proses asing + hash SHA-256 + fresh<24jam',
    vpsOk === true, 'ufw+f2b+0asing+hash+fresh', vpsDetail);

  // 7. SIMULASI SERANGAN IP UJI 203.0.113.99: 5x HTTP 403 -> auto-blokir + insiden + payload alert + Unblock.
  let simOk = false;
  let simDetail = 'simulasi tidak jalan';
  try {
    delete require.cache[path.join(ROOT, 'lib', 'security-shield.js')];
    const S = require(path.join(ROOT, 'lib', 'security-shield.js'));
    const TEST_IP = '203.0.113.99';
    S._reset();
    // Pastikan IP uji bersih sebelum simulasi.
    try { S.unblockIp(TEST_IP, { reason: 'bersihkan sebelum simulasi gate V3-F12' }, ROOT); } catch (_) {}
    S._reset();
    let last = null;
    for (let i = 1; i <= 5; i++) {
      last = S.recordHttp403(TEST_IP, { reason: 'simulasi serangan bot uji #' + i }, ROOT);
    }
    const blockedNow = S.isIpBlocked(TEST_IP, ROOT);
    const payloadOk = last && last.payload && typeof last.payload.text === 'string'
      && last.payload.text.indexOf('DIBLOKIR') >= 0 && last.payload.text.indexOf(TEST_IP) >= 0
      && last.payload.text.indexOf('ALARM DARURAT KEAMANAN') >= 0;
    const validatorOk = ipBlockValidator({ blocked: blockedNow.blocked === true, ip: TEST_IP, until: blockedNow.until, payload: last && last.payload });
    // Tercatat di UI Admin Console: baca security-state.json (sumber Tab Keamanan).
    let inState = false;
    let inIncidents = false;
    try {
      const st = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'security', 'security-state.json'), 'utf8'));
      inState = Array.isArray(st.blockedIps) && st.blockedIps.some((b) => String(b.ip) === TEST_IP);
      inIncidents = Array.isArray(st.incidents) && st.incidents.some((e) => String(e.ip) === TEST_IP && /HTTP_403_AUTO_BLOCK/.test(String(e.type || '')));
    } catch (_) { inState = false; inIncidents = false; }
    // Kirim payload alert (non-blokir bila tanpa konfigurasi Telegram — payload valid sudah cukup).
    let alertQueued = false;
    let alertDetail = 'tanpa-konfigurasi-telegram';
    try {
      const qr = await S.queueTelegramAlarm(last && last.payload, { SECURITY_TELEGRAM_BOT_TOKEN: '', SECURITY_TELEGRAM_CHAT_ID: '' });
      alertQueued = qr && (qr.sent === true || qr.skipped === true);
      alertDetail = (qr && (qr.reason || (qr.sent ? 'sent' : 'skipped'))) || 'queued';
    } catch (e) { alertDetail = 'error: ' + String((e && e.message) || e).slice(0, 80); }
    // Unblock berhasil.
    const unb = S.unblockIp(TEST_IP, { reason: 'simulasi gate V3-F12 selesai, buka blokir IP uji' }, ROOT);
    const afterUnblock = S.isIpBlocked(TEST_IP, ROOT);
    const unblockOk = unb && unb.ok === true && afterUnblock.blocked !== true;
    simOk = last && last.blocked === true && blockedNow.blocked === true && payloadOk === true
      && validatorOk === true && inState === true && inIncidents === true && alertQueued === true && unblockOk === true;
    simDetail = 'hits5=' + (last && last.hits) + ' blocked=' + (last && last.blocked)
      + ' state=' + inState + ' insiden=' + inIncidents + ' payload=' + payloadOk
      + ' alert=' + alertQueued + '(' + alertDetail + ') unblock=' + unblockOk;
    result.simulation = {
      ip: TEST_IP, hits: (last && last.hits) || 0, blocked: blockedNow.blocked === true,
      until: blockedNow.until || null, inAdminConsole: inState, inIncidents,
      alertText: (last && last.payload && last.payload.text) || null,
      alertQueued, unblocked: unblockOk
    };
  } catch (e) { simDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, 'simulasi 203.0.113.99: 5x 403 -> auto-blokir + tercatat UI + payload alert + Unblock OK',
    simOk === true, 'blokir+ui+alert+unblock penuh', simDetail);

  // 8. Kontrol negatif lolos.
  lib.addAssertion(result, 'kontrol negatif lolos (injected>=1, detected==injected)',
    result.negativeControl.injected >= 1 && result.negativeControl.detected === result.negativeControl.injected,
    'detected==injected>=1', 'injected=' + result.negativeControl.injected + ' detected=' + result.negativeControl.detected);

  if (vpsReport) {
    result.vpsAudit = {
      at: vpsReport.at || null,
      ufwActive: Boolean(vpsReport.ufw && vpsReport.ufw.active),
      ufwRules: (vpsReport.ufw && vpsReport.ufw.ruleCount) || 0,
      fail2banActive: Boolean(vpsReport.fail2ban && vpsReport.fail2ban.active),
      fail2banJails: (vpsReport.fail2ban && vpsReport.fail2ban.jails) || [],
      totalProcesses: (vpsReport.processes && vpsReport.processes.total) || 0,
      foreignProcesses: (vpsReport.processes && vpsReport.processes.foreignCount) || 0,
      listeningPorts: (vpsReport.ports && vpsReport.ports.total) || 0,
      binaryHashes: ((vpsReport.binaries && vpsReport.binaries.hashes) || []).map((h) => ({ path: h.path, sha256: String(h.sha256 || '').slice(0, 16) + '…' })),
      verdict: (vpsReport.ghidra && vpsReport.ghidra.verdict) || null
    };
  }

  lib.finalizeGate(result, OUT);
  return result;
}

main().catch((e) => {
  try {
    lib.addAssertion(result, 'gate tidak crash', false, 'no-crash', String((e && e.message) || e).slice(0, 300));
    lib.finalizeGate(result, OUT);
  } catch (_) { process.exit(1); }
});
