'use strict';
// Mesin Gate inti P0 — kontrak finalize ketat (lihat docs/darurat/KONTRAK.md Bagian 3).
const fs = require('fs');
const path = require('path');

function nowIso() {
  return new Date().toISOString();
}

function newResult(id, title) {
  return {
    id,
    title,
    startedAt: nowIso(),
    finishedAt: null,
    total: 0,
    checked: 0,
    negativeControl: { description: '', injected: 0, detected: 0, pass: false },
    assertions: [],
    pass: false
  };
}

function addAssertion(result, name, pass, expected, actual) {
  result.total += 1;
  if (pass) result.checked += 1;
  result.assertions.push({ name, pass: Boolean(pass), expected: expected, actual: actual });
  return pass;
}

// Kontrol negatif generik: suntik objek korup ke validator memori, pastikan terdeteksi.
// Mengembalikan { injected, detected }.
function runNegativeControl(corruptSamples, validator) {
  let injected = 0;
  let detected = 0;
  for (const sample of corruptSamples) {
    injected += 1;
    try {
      const ok = validator(sample);
      if (ok === false) detected += 1;
    } catch (_) {
      detected += 1; // validator menolak via throw = terdeteksi
    }
  }
  return { injected, detected };
}

function finalizeGate(result, outPath) {
  result.finishedAt = nowIso();
  const nc = result.negativeControl || { injected: 0, detected: 0 };
  const allPass = result.assertions.length > 0 && result.assertions.every((a) => a.pass === true);
  const gatePass = result.total > 0
    && result.checked === result.total
    && (nc.injected || 0) >= 1
    && (nc.detected || 0) === (nc.injected || 0)
    && allPass === true;
  result.negativeControl = {
    description: nc.description || '',
    injected: nc.injected || 0,
    detected: nc.detected || 0,
    pass: (nc.injected || 0) >= 1 && (nc.detected || 0) === (nc.injected || 0)
  };
  result.pass = gatePass;
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  } else {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }
  if (gatePass) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

module.exports = { nowIso, newResult, addAssertion, runNegativeControl, finalizeGate };
