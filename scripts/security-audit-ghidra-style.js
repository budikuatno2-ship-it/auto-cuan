'use strict';
// V3-F12 — Audit pertahanan VPS ala NSA Ghidra (ufw, fail2ban, proses, port, hash SHA-256).
// Host: ubuntu@168.110.221.197 via SSH BatchMode (tanpa polling/sleep, tanpa Vercel).
// Gaya Ghidra: bedah biner/proses seperti reverse-engineering —
//   .text (daftar proses), imports (port listening), strings (hash biner), xref (ufw/fail2ban).
// Output: data/security/vps-audit.json + ringkasan console (tanpa secret).
// Bahasa Indonesia.
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const shield = require('../lib/security-shield');

const VPS_HOST = shield.VPS_SSH_HOST || 'ubuntu@168.110.221.197';
const KEY_PATH = shield.VPS_SSH_KEY_HINT || 'D:/Private Key Oracle/ssh-key-2026-07-02.key';
const OUT_PATH = path.join(ROOT, 'data', 'security', 'vps-audit.json');

function sshExec(remoteCmd, timeoutMs) {
  const key = KEY_PATH;
  const cmd = 'ssh -n -o BatchMode=yes -o ConnectTimeout=15 -i "' + key + '" ' + VPS_HOST + ' "' + String(remoteCmd).replace(/"/g, "'") + '"';
  try {
    return { ok: true, out: childProcess.execSync(cmd, { encoding: 'utf8', timeout: timeoutMs || 20000, maxBuffer: 4 * 1024 * 1024 }) };
  } catch (e) {
    const out = (e && e.stdout ? String(e.stdout) : '') + (e && e.message ? '\n' + String(e.message).slice(0, 300) : '');
    return { ok: false, out, error: String((e && e.message) || e).slice(0, 300) };
  }
}

function runVpsAudit(opts) {
  const o = opts || {};
  const execFn = typeof o.execFn === 'function' ? o.execFn : sshExec;
  const ufw = execFn('sudo ufw status verbose');
  const f2b = execFn('sudo fail2ban-client status');
  const f2bSshd = execFn('sudo fail2ban-client status sshd');
  const ps = execFn('ps -eo pid,comm,args --no-headers');
  const ss = execFn('ss -tulpn');
  const hashes = execFn('sha256sum /usr/bin/node; node --version; echo OK');

  const ufwParsed = shield.parseUfwStatus(ufw.out || '');
  const f2bParsed = shield.parseFail2banStatus(f2b.out || '', f2bSshd.out || '');
  const processes = shield.parseProcessList(ps.out || '');
  const foreign = shield.detectForeignProcesses(processes);
  const ports = shield.parseListeningPorts(ss.out || '');

  // Ghidra-style: hash biner utama (integritas .text).
  const binHashes = [];
  try {
    const lines = String(hashes.out || '').split('\n');
    for (const ln of lines) {
      const m = ln.match(/^([0-9a-f]{64})\s+(\S+)/i);
      if (m) binHashes.push({ sha256: m[1], path: m[2] });
    }
  } catch (_) {}

  const report = {
    at: new Date().toISOString(),
    host: '168.110.221.197',
    ufw: { ok: ufw.ok, active: ufwParsed.active, defaultDeny: ufwParsed.defaultDeny, ruleCount: ufwParsed.ruleCount, rules: ufwParsed.rules },
    fail2ban: { ok: f2b.ok, active: f2bParsed.active, jails: f2bParsed.jails, banned: f2bParsed.banned },
    fail2banSshd: { ok: f2bSshd.ok, raw: String(f2bSshd.out || '').slice(0, 1200) },
    processes: { ok: ps.ok, total: processes.length, foreignCount: foreign.count, foreign: foreign.foreign.slice(0, 20) },
    ports: { ok: ss.ok, total: ports.length, listening: ports.slice(0, 40) },
    binaries: { ok: hashes.ok, hashes: binHashes, raw: String(hashes.out || '').slice(0, 800) },
    ghidra: {
      text_segments: processes.length,
      imports_open_ports: ports.length,
      strings_hashes: binHashes.length,
      xref_firewall: ufwParsed.active === true,
      xref_ids: f2bParsed.active === true,
      verdict: foreign.count === 0 && ufwParsed.active === true ? 'BERSIH-0-ASING' : 'PERLU-TINDAK'
    },
    pass: ufw.ok === true && ufwParsed.active === true && f2bParsed.active === true && foreign.count === 0 && binHashes.length >= 1
  };
  return report;
}

function main() {
  const report = runVpsAudit();
  try { fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true }); } catch (_) {}
  try { fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2)); } catch (_) {}
  console.log('=== AUDIT GHIDRA VPS 168.110.221.197 ===');
  console.log('ufw aktif: ' + report.ufw.active + ' (defaultDeny=' + report.ufw.defaultDeny + ' rules=' + report.ufw.ruleCount + ')');
  console.log('fail2ban aktif: ' + report.fail2ban.active + ' jails=' + (report.fail2ban.jails || []).join(',') + ' banned_sshd_total=' + report.fail2ban.banned);
  console.log('proses total: ' + report.processes.total + ' asing: ' + report.processes.foreignCount);
  console.log('port listening: ' + report.ports.total);
  console.log('hash biner: ' + report.binaries.hashes.length);
  console.log('verdict Ghidra: ' + report.ghidra.verdict);
  console.log('laporan: data/security/vps-audit.json');
  if (!report.pass) {
    console.error('AUDIT GAGAL — lihat data/security/vps-audit.json');
    process.exitCode = 1;
    return report;
  }
  console.log('AUDIT LULUS — 0 proses asing, firewall+IDS aktif, hash tercatat.');
  return report;
}

if (require.main === module) {
  main();
}

module.exports = { runVpsAudit, sshExec, OUT_PATH, VPS_HOST };
