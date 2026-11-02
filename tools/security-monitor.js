#!/usr/bin/env node
'use strict';
// S2 — Mesin deteksi intrusi siber/bot real-time (jalan tiap 5 menit + real-time hook).
// 6 sumber ancaman VPS + aplikasi:
//   (1) Brute-force SSH: /var/log/auth.log + fail2ban-client status sshd.
//   (2) Brute-force login aplikasi: log gagal login/OTP (BRUTE_FORCE_AUTH).
//   (3) Bot scraper/flood/DDoS L7: log Nginx/aplikasi + counter API_FLOOD_BOT
//       (lonjakan req/menit tak wajar, sapuan endpoint sensitif /.env,/wp-admin,/phpmyadmin,.git/config).
//   (4) Akses ilegal fitur admin (403): akun/IP coba akses Admin Console/Pattern Radar tanpa hak.
//   (5) Integritas file & proses VPS: proses mencurigakan (cryptominer/CPU>95% asing),
//       login SSH baru (Accepted publickey), perubahan tak sah file sensitif.
//   (6) Sapuan endpoint sensitif: dihitung di (3) + dicatat tersendiri SENSITIVE_PROBE.
// Ringkasan + log insiden -> data/security/security-state.json.
// Alarm Darurat Telegram ke Admin: jenis serangan, IP penyerang, jumlah percobaan,
// tindakan otomatis (IP diblokir otomatis Fail2Ban/Security Shield selama X menit).
// Anti-spam cooldown 30 menit per kunci insiden.
// Bahasa Indonesia. Tanpa print secret. Tanpa hardcode kuota/token.
// Kompatibel P2: exit 0 pada run sukses (insiden via JSON + Telegram, bukan exit code).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const shield = require(path.join(ROOT, 'lib', 'security-shield'));
const stateStore = require(path.join(ROOT, 'lib', 'security-state'));

const STATE_PATH = stateStore.statePath(ROOT);
const HISTORY_PATH = stateStore.historyPath(ROOT);
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;

const SENSITIVE_PATHS = ['/.env', '/wp-admin', '/phpmyadmin', '/.git/config', '/wp-login', '/xmlrpc', '/actuator', '/server-status'];

function parseArgs(argv) {
  const o = { json: false, noAlert: false, statusPath: null, historyPath: null, rootDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--no-alert') o.noAlert = true;
    else if (a === '--status-path' && argv[i + 1] !== undefined) o.statusPath = String(argv[++i]);
    else if (a.startsWith('--status-path=')) o.statusPath = a.slice(14);
    else if (a === '--history-path' && argv[i + 1] !== undefined) o.historyPath = String(argv[++i]);
    else if (a.startsWith('--history-path=')) o.historyPath = a.slice(15);
    else if (a === '--root-dir' && argv[i + 1] !== undefined) o.rootDir = String(argv[++i]);
    else if (a.startsWith('--root-dir=')) o.rootDir = a.slice(11);
  }
  return o;
}

function safeRead(filePath, maxBytes) {
  try {
    const st = fs.statSync(filePath);
    const size = st.size;
    const cap = Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0 ? Number(maxBytes) : 512 * 1024;
    if (size <= cap) return fs.readFileSync(filePath, 'utf8');
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(cap);
    fs.readSync(fd, buf, 0, cap, Math.max(0, size - cap));
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch (_) { return ''; }
}

function tailLines(text, n) {
  const lines = String(text || '').split('\n');
  return lines.slice(Math.max(0, lines.length - (n || 200)));
}

// (1) Brute-force SSH: auth.log + fail2ban + journalctl fallback.
function scanSshAuth(opts) {
  const o = opts || {};
  const out = { failed: 0, banned: 0, newLogins: 0, bannedIps: [], detail: '' };
  try {
    const candidates = ['/var/log/auth.log', '/var/log/secure'];
    let text = '';
    for (const f of candidates) {
      const t = o.fsRead ? o.fsRead(f) : safeRead(f, 512 * 1024);
      if (t) { text += '\n' + t; break; }
    }
    if (!text && typeof o.exec === 'function') {
      try { text = String(o.exec('journalctl -u ssh --since "2 hours ago" --no-pager 2>/dev/null | tail -n 300') || ''); } catch (_) {}
    } else if (!text) {
      try { text = String(execSync('journalctl -u ssh --since "2 hours ago" --no-pager 2>/dev/null | tail -n 300', { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }) || ''); } catch (_) {}
    }
    const lines = tailLines(text, 2000);
    const failRe = /Failed (password|publickey)|authentication failure|Failed login/i;
    const acceptRe = /Accepted (password|publickey)/i;
    const ipRe = /(\d{1,3}(?:\.\d{1,3}){3})/;
    const failsByIp = new Map();
    for (const ln of lines) {
      if (failRe.test(ln)) {
        out.failed += 1;
        const m = ln.match(ipRe);
        if (m) failsByIp.set(m[1], (failsByIp.get(m[1]) || 0) + 1);
      }
      if (acceptRe.test(ln)) out.newLogins += 1;
    }
    // fail2ban: jangan duplikasi aksi blokir — hanya BACA status.
    let f2b = '';
    if (typeof o.exec === 'function') {
      try { f2b = String(o.exec('fail2ban-client status sshd') || ''); } catch (_) {}
    } else {
      try { f2b = String(execSync('fail2ban-client status sshd 2>/dev/null', { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }) || ''); } catch (_) {}
    }
    const bannedMatch = f2b.match(/Banned IP list:\s*(.*)/i);
    if (bannedMatch && bannedMatch[1].trim()) {
      out.bannedIps = bannedMatch[1].trim().split(/\s+/).filter(Boolean);
      out.banned = out.bannedIps.length;
    }
    const top = Array.from(failsByIp.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([ip, n]) => ip + ' (' + n + 'x)').join(', ');
    out.detail = 'gagal=' + out.failed + ' banned=' + out.banned + ' loginBaru=' + out.newLogins + (top ? ' top=' + top : '');
  } catch (_) {}
  return out;
}

// (2) Brute-force login aplikasi: event shield BRUTE_FORCE_AUTH + throttle lokal.
function scanAppBrute(opts) {
  const o = opts || {};
  const out = { failed: 0, blocked: 0, detail: '' };
  try {
    const events = typeof o.shieldEvents === 'function' ? o.shieldEvents() : shield.getSecurityEvents();
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const e of (events || [])) {
      if (String(e.type) !== 'BRUTE_FORCE_AUTH') continue;
      const t = Date.parse(e.at || '');
      if (!Number.isFinite(t) || t < cutoff) continue;
      out.failed += Number(e.fails || 1) || 1;
      out.blocked += 1;
    }
    out.detail = 'BRUTE_FORCE_AUTH 1 jam: gagal=' + out.failed + ' blokir=' + out.blocked;
  } catch (_) {}
  return out;
}

// (3)+(6) Bot scraper/flood/DDoS L7 + sapuan endpoint sensitif.
function scanBotFlood(opts) {
  const o = opts || {};
  const out = { blocked: 0, probes: 0, hits: 0, detail: '', probeByIp: {} };
  try {
    const events = typeof o.shieldEvents === 'function' ? o.shieldEvents() : shield.getSecurityEvents();
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const e of (events || [])) {
      const t = Date.parse(e.at || '');
      if (!Number.isFinite(t) || t < cutoff) continue;
      if (String(e.type) === 'API_FLOOD_BOT') {
        out.blocked += 1;
        out.hits += Number(e.hits || 1) || 1;
      }
      if (String(e.type) === 'SENSITIVE_PROBE') {
        out.probes += 1;
        const ip = String(e.ip || 'unknown');
        out.probeByIp[ip] = (out.probeByIp[ip] || 0) + 1;
      }
    }
    // Log Nginx/aplikasi (best-effort, baca saja).
    let text = '';
    const logCandidates = ['/var/log/nginx/access.log', path.join(ROOT, 'logs', 'cron', 'security-monitor.log')];
    for (const f of logCandidates) {
      const t = o.fsRead ? o.fsRead(f) : safeRead(f, 256 * 1024);
      if (t) { text += '\n' + t; }
    }
    if (text) {
      const lines = tailLines(text, 2000);
      for (const ln of lines) {
        const low = ln.toLowerCase();
        for (const p of SENSITIVE_PATHS) {
          if (low.includes(p)) {
            out.probes += 1;
            const m = ln.match(/(\d{1,3}(?:\.\d{1,3}){3})/);
            const ip = m ? m[1] : 'unknown';
            out.probeByIp[ip] = (out.probeByIp[ip] || 0) + 1;
            break;
          }
        }
      }
    }
    out.detail = 'flood1jam=' + out.blocked + ' hits=' + out.hits + ' probeSensitif=' + out.probes;
  } catch (_) {}
  return out;
}

// (4) Akses ilegal fitur admin (403).
function scanAdmin403(opts) {
  const o = opts || {};
  const out = { attempts: 0, detail: '' };
  try {
    const events = typeof o.shieldEvents === 'function' ? o.shieldEvents() : shield.getSecurityEvents();
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const e of (events || [])) {
      if (String(e.type) !== 'ADMIN_403') continue;
      const t = Date.parse(e.at || '');
      if (!Number.isFinite(t) || t < cutoff) continue;
      out.attempts += 1;
    }
    out.detail = 'ADMIN_403 1 jam: ' + out.attempts + ' percobaan';
  } catch (_) {}
  return out;
}

// (5) Integritas file & proses VPS.
function scanIntegrity(opts) {
  const o = opts || {};
  const out = { issues: 0, detail: '', findings: [] };
  try {
    // Proses mencurigakan: cryptominer / CPU asing tinggi.
    let ps = '';
    if (typeof o.exec === 'function') {
      try { ps = String(o.exec('ps -eo pid,pcpu,comm --sort=-pcpu | head -n 15') || ''); } catch (_) {}
    } else if (process.platform !== 'win32') {
      try { ps = String(execSync('ps -eo pid,pcpu,comm --sort=-pcpu | head -n 15', { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }) || ''); } catch (_) {}
    }
    if (ps) {
      const minerRe = /(xmrig|minerd|cpuminer|cgminer|nicehash|t-rex|ethminer|kthreaddk|cryptonight)/i;
      for (const ln of ps.split('\n').slice(1)) {
        const m = ln.trim().match(/^(\d+)\s+([\d.]+)\s+(\S+)/);
        if (!m) continue;
        const cpu = Number(m[2]);
        const comm = m[3];
        if (minerRe.test(comm)) { out.issues += 1; out.findings.push('miner:' + comm); }
        else if (Number.isFinite(cpu) && cpu > 95 && !/^(node|pm2|nginx|postgres|redis-server|systemd|sshd)$/i.test(comm)) {
          out.issues += 1; out.findings.push('cpu-tinggi:' + comm + '=' + cpu + '%');
        }
      }
    }
    // Perubahan tak sah file sensitif (mtime < 1 jam pada file kunci).
    const watchFiles = [
      path.join(ROOT, 'lib', 'admin-session.js'),
      path.join(ROOT, 'lib', 'security-shield.js'),
      path.join(ROOT, 'lib', 'security-state.js'),
      path.join(ROOT, 'api', 'admin-users.js'),
      path.join(ROOT, 'api', 'admin-logs.js')
    ];
    const now = Date.now();
    for (const f of watchFiles) {
      try {
        const st = fs.statSync(f);
        if (now - st.mtimeMs < 60 * 60 * 1000 && process.env.S2_ALLOW_RECENT_EDIT !== '1' && !o.allowRecentEdit) {
          // File berubah <1 jam: catat sebagai sinyal (bukan vonis) agar admin sadar deploy tak terjadwal.
          out.issues += 1; out.findings.push('berubah-1jam:' + path.basename(f));
        }
      } catch (_) {}
    }
    out.detail = out.issues === 0 ? 'bersih' : out.findings.slice(0, 5).join('; ');
  } catch (_) {}
  return out;
}

function readSentHistory(historyPath) {
  try {
    const raw = fs.readFileSync(historyPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch (_) {}
  return {};
}

function writeSentHistory(history, historyPath) {
  try {
    fs.mkdirSync(path.dirname(historyPath), { recursive: true });
    fs.writeFileSync(historyPath, JSON.stringify(history || {}, null, 2));
  } catch (_) {}
  return historyPath;
}

function buildAlertText(incidents) {
  const lines = [];
  lines.push('🚨 ALARM DARURAT KEAMANAN — ' + incidents.length + ' temuan');
  lines.push('');
  lines.push('Waktu: ' + new Date().toISOString());
  for (const e of incidents.slice(0, 8)) {
    const p = shield.buildTelegramAlertPayload(e);
    lines.push('• [' + String(e.type || '?') + '] IP ' + p.ip + ' ' + p.attempts + 'x — ' + p.action);
  }
  lines.push('');
  lines.push('Tindakan otomatis: IP diblokir Fail2Ban/Security Shield 30-60 mnt. Cek Admin Console > Tab Keamanan.');
  return lines.join('\n');
}

async function defaultTelegramSender(text) {
  const notifier = require(path.join(ROOT, 'lib', 'telegram-notifier'));
  return notifier.sendTelegramMessage(text, { skip_market_guard: true });
}

async function maybeSendAlerts(opts) {
  const o = opts || {};
  const incidents = Array.isArray(o.incidents) ? o.incidents : [];
  const historyP = o.historyPath || HISTORY_PATH;
  const nowMs = o.now != null ? new Date(o.now).getTime() : Date.now();
  const sender = typeof o.sender === 'function' ? o.sender : defaultTelegramSender;
  const cooldownMs = Number.isFinite(Number(o.cooldownMs)) && Number(o.cooldownMs) > 0 ? Number(o.cooldownMs) : ALERT_COOLDOWN_MS;
  const history = readSentHistory(historyP);
  const currentKeys = new Set(incidents.map((e) => String(e.key || e.type + ':' + (e.ip || ''))));
  let changed = false;
  for (const k of Object.keys(history)) {
    if (!currentKeys.has(k)) { delete history[k]; changed = true; }
  }
  if (incidents.length === 0) {
    if (changed || Object.keys(history).length > 0) writeSentHistory({}, historyP);
    return { sent: 0, skipped: 0, historyPath: historyP };
  }
  const fresh = [];
  for (const e of incidents) {
    const k = String(e.key || e.type + ':' + (e.ip || ''));
    const prev = history[k];
    if (prev && Number.isFinite(Number(prev.lastSentAt)) && (nowMs - Number(prev.lastSentAt)) < cooldownMs) continue;
    fresh.push(e);
  }
  if (fresh.length === 0) {
    if (changed) writeSentHistory(history, historyP);
    return { sent: 0, skipped: incidents.length, historyPath: historyP };
  }
  const text = buildAlertText(fresh);
  let res = null;
  try { res = await sender(text); } catch (e) { res = { sent: false, reason: 'sender_throw' }; }
  const okSend = Boolean(res && (res.sent === true || res.ok === true || res.skipped === true));
  if (okSend) {
    for (const e of fresh) {
      const k = String(e.key || e.type + ':' + (e.ip || ''));
      history[k] = { lastSentAt: nowMs, type: e.type || null, ip: e.ip || null };
    }
    writeSentHistory(history, historyP);
    return { sent: fresh.length, skipped: incidents.length - fresh.length, historyPath: historyP, result: res, payload: { text } };
  }
  if (changed) writeSentHistory(history, historyP);
  return { sent: 0, skipped: incidents.length, historyPath: historyP, result: res, sendFailed: true, payload: { text } };
}

// Evaluasi gabungan 6 sumber. Opsi injeksi memudahkan simulasi gate tanpa I/O.
function evaluateAll(opts) {
  const o = opts || {};
  const rootDir = o.rootDir || ROOT;
  const nowMs = o.now != null ? new Date(o.now).getTime() : Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const ssh = o.ssh || scanSshAuth(o);
  const app = o.app || scanAppBrute(o);
  const bot = o.bot || scanBotFlood(o);
  const a403 = o.a403 || scanAdmin403(o);
  const integ = o.integ || scanIntegrity(o);
  const incidents = [];

  if (ssh.failed > 0 || ssh.banned > 0) {
    incidents.push({ key: 'ssh:brute', type: ssh.banned > 0 ? 'SSH_BANNED' : 'SSH_BRUTE_FORCE', ip: (ssh.bannedIps[0] || 'multi'), attempts: Math.max(ssh.failed, ssh.banned), reason: 'Fail2Ban/sshd (' + ssh.detail + ')', until: new Date(nowMs + 60 * 60 * 1000).toISOString(), source: 'ssh', at: nowIso });
  }
  if (ssh.newLogins > 0 && !o.ssh) {
    incidents.push({ key: 'ssh:newlogin', type: 'SSH_NEW_LOGIN', ip: 'vps', attempts: ssh.newLogins, reason: 'login SSH baru (Accepted publickey)', source: 'ssh', at: nowIso });
  }
  if (app.blocked > 0) {
    incidents.push({ key: 'app:brute', type: 'BRUTE_FORCE_AUTH', ip: 'multi', attempts: app.failed, reason: 'login aplikasi bertubi-tubi, diblokir Security Shield 30 mnt', until: new Date(nowMs + 30 * 60 * 1000).toISOString(), source: 'app', at: nowIso });
  }
  if (bot.blocked > 0) {
    incidents.push({ key: 'bot:flood', type: 'API_FLOOD_BOT', ip: 'multi', attempts: bot.hits, reason: 'banjir bot/scraper, diblokir Security Shield 5 mnt', until: new Date(nowMs + 5 * 60 * 1000).toISOString(), source: 'bot', at: nowIso });
  }
  const probeIps = Object.keys(bot.probeByIp || {});
  if (bot.probes > 0) {
    incidents.push({ key: 'bot:probe', type: 'SENSITIVE_PROBE', ip: probeIps[0] || 'multi', attempts: bot.probes, reason: 'sapuan endpoint sensitif /.env,/wp-admin,/phpmyadmin,.git/config', source: 'bot', at: nowIso });
  }
  if (a403.attempts > 0) {
    incidents.push({ key: 'admin:403', type: 'ADMIN_403', ip: 'multi', attempts: a403.attempts, reason: 'akses ilegal fitur admin (403) tanpa hak', source: 'admin', at: nowIso });
  }
  if (integ.issues > 0) {
    incidents.push({ key: 'integ:issue', type: 'INTEGRITY_ALERT', ip: 'vps', attempts: integ.issues, reason: integ.detail, source: 'integrity', at: nowIso });
  }
  const ok = incidents.length === 0;
  return {
    ok, at: nowIso,
    checked: { ssh: 1, app: 1, bot: 1, admin403: 1, integrity: 1, probe: 1 },
    sources: { ssh, app, bot, a403, integ },
    issues: incidents,
    incidents,
    summary: ok ? 'AMAN' : ('WASPADA: ' + incidents.length + ' temuan')
  };
}

function writeSecurityState(result, opts) {
  const o = opts || {};
  const rootDir = o.rootDir || ROOT;
  const dest = o.statusPath || stateStore.statePath(rootDir);
  const prev = stateStore.readState(rootDir);
  prev.sources = {
    ssh: { rejected: result.sources.ssh.failed, banned: result.sources.ssh.banned, newLogins: result.sources.ssh.newLogins, detail: result.sources.ssh.detail },
    appBrute: { failed: result.sources.app.failed, blocked: result.sources.app.blocked, detail: result.sources.app.detail },
    botFlood: { blocked: result.sources.bot.blocked, probes: result.sources.bot.probes, detail: result.sources.bot.detail },
    admin403: { attempts: result.sources.a403.attempts, detail: result.sources.a403.detail },
    integrity: { issues: result.sources.integ.issues, detail: result.sources.integ.detail },
    sensitiveProbe: { count: result.sources.bot.probes, detail: 'sapuan /.env,/wp-admin,/phpmyadmin,.git/config' }
  };
  for (const e of (result.incidents || [])) stateStore.appendIncident(prev, e);
  stateStore.refreshDerived(prev);
  stateStore.writeState(prev, dest);
  return dest;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rootDir = opts.rootDir || ROOT;
  const result = evaluateAll({ rootDir });
  const statusPath = opts.statusPath || stateStore.statePath(rootDir);
  const historyP = opts.historyPath || stateStore.historyPath(rootDir);
  writeSecurityState(result, { rootDir, statusPath });
  const finish = (alertRes) => {
    if (opts.json) {
      process.stdout.write(JSON.stringify({ ok: result.ok, at: result.at, checked: result.checked, issues: result.issues, alerts: alertRes || null }, null, 2) + '\n');
    } else {
      console.log('[security-monitor] ' + (result.ok ? 'AMAN' : 'WASPADA=' + result.issues.length) + ' ssh=' + result.sources.ssh.failed + ' app=' + result.sources.app.blocked + ' bot=' + result.sources.bot.blocked + ' probe=' + result.sources.bot.probes + ' 403=' + result.sources.a403.attempts + ' integ=' + result.sources.integ.issues);
      for (const i of result.issues) console.log('  - [' + i.type + '] ' + (i.reason || ''));
      if (alertRes) console.log('[security-monitor] telegram sent=' + alertRes.sent + ' skipped=' + alertRes.skipped);
    }
    process.exitCode = 0;
    return result;
  };
  if (opts.noAlert) return finish(null);
  return maybeSendAlerts({ incidents: result.incidents, historyPath: historyP }).then(
    (alertRes) => finish(alertRes),
    () => finish({ sent: 0, skipped: result.incidents.length, sendFailed: true })
  );
}

if (require.main === module) main();

module.exports = {
  parseArgs,
  scanSshAuth,
  scanAppBrute,
  scanBotFlood,
  scanAdmin403,
  scanIntegrity,
  evaluateAll,
  writeSecurityState,
  buildAlertText,
  maybeSendAlerts,
  readSentHistory,
  writeSentHistory,
  SENSITIVE_PATHS,
  ALERT_COOLDOWN_MS,
  STATE_PATH,
  HISTORY_PATH,
  main
};
