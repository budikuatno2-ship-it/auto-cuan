'use strict';
// Runner 31 gate berurutan (30 sebelumnya + R1). Tabel PASS/FAIL/MISSING, exit 1 bila ada yang belum PASS.
// Daftar ID sah: P0-P6, Q1, S1-S2, B1-B4, C1-C11, D1, F1-F2, G1-G2, R1 = 31 gate.
// Kontrak: docs/darurat/KONTRAK.md Bagian 3. DILARANG melonggarkan gate; runner hanya membaca JSON + exit code.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const GATES_DIR = path.join(ROOT, 'bukti-verifikasi-final', 'gates');
// 30 gate sebelumnya (P0 s.d. D1 dalam istilah subtask = seluruh gate pra-R1) + R1 = 31.
const IDS = [
  'P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6',
  'Q1',
  'S1', 'S2',
  'B1', 'B2', 'B3', 'B4',
  'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10', 'C11',
  'D1',
  'F1', 'F2',
  'G1', 'G2',
  'R1'
];

function gateFile(id) {
  return path.join(__dirname, 'gate-' + id + '.js');
}

function outFile(id) {
  return path.join(GATES_DIR, id + '.json');
}

const rows = [];
let failures = 0;
for (const id of IDS) {
  const gf = gateFile(id);
  const of = outFile(id);
  if (!fs.existsSync(gf)) {
    rows.push({ id, status: 'MISSING', detail: 'gate file belum ada' });
    failures += 1;
    continue;
  }
  const r = spawnSync(process.execPath, [gf], { encoding: 'utf8' });
  let parsed = null;
  try {
    const raw = fs.existsSync(of) ? fs.readFileSync(of, 'utf8') : (r.stdout || '');
    parsed = JSON.parse(raw);
  } catch (_) {
    parsed = null;
  }
  const ok = r.status === 0 && parsed && parsed.pass === true;
  rows.push({ id, status: ok ? 'PASS' : 'FAIL', detail: 'exit=' + r.status });
  if (!ok) failures += 1;
}

console.log('ID   STATUS   DETAIL');
for (const r of rows) console.log(r.id.padEnd(4) + ' ' + r.status.padEnd(8) + ' ' + r.detail);
console.log('----');
console.log('PASS ' + rows.filter((r) => r.status === 'PASS').length + '/' + IDS.length + ', FAIL/MISSING ' + failures + '/' + IDS.length);
process.exit(failures > 0 ? 1 : 0);
