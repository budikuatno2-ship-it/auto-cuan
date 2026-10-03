'use strict';

/**
 * Wave 2 — Provenance scanner classification + quarantine round-trip (W2-01).
 * All destructive-path tests use TEMP directories only.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const scanner = require('../tools/scan-aux-provenance');
const quarantine = require('../tools/quarantine-aux-provenance');

// quarantine.main() sets process.exitCode on failures/refusals; reset it after
// every test so it cannot leak into the test runner's own exit code.
test.afterEach(() => { process.exitCode = undefined; });

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function makeFixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-fixture-'));
  const accDir = path.join(root, 'broker-accumulation', 'BBCA');
  const insDir = path.join(root, 'insiders', 'BBCA');
  fs.mkdirSync(accDir, { recursive: true });
  fs.mkdirSync(insDir, { recursive: true });

  // Current snapshot content (identical bytes across the contaminated dates).
  const currentSnapshot = JSON.stringify({
    code: 'BBCA', start_date: '2026-06-09', end_date: '2026-10-01',
    series: [{ broker_code: 'AK', points: [{ date: '2026-10-01', nval: 1 }] }]
  }, null, 2);
  const insiderSnapshot = JSON.stringify({ stock_code: 'BBCA', count: 15, page: 1, items: [] }, null, 2);

  // Historical dates carrying CURRENT content (contaminated). The Oct 1
  // evening mtime emulates the pre-#835 worker sweep that produced these
  // files (verified in production logs).
  const sweepMtime = new Date('2026-10-01T12:00:00Z'); // 19:00 WIB Oct 1
  for (const date of ['2026-09-28', '2026-09-29', '2026-09-30']) {
    const ap = path.join(accDir, `${date}.json`);
    const ip = path.join(insDir, `${date}.json`);
    fs.writeFileSync(ap, currentSnapshot);
    fs.writeFileSync(ip, insiderSnapshot);
    fs.utimesSync(ap, sweepMtime, sweepMtime);
    fs.utimesSync(ip, sweepMtime, sweepMtime);
  }
  // A later date carrying the same bytes (duplicate evidence).
  const laterMtime = new Date('2026-10-01T12:05:00Z');
  for (const [p, content] of [[path.join(accDir, '2026-10-01.json'), currentSnapshot], [path.join(insDir, '2026-10-01.json'), insiderSnapshot]]) {
    fs.writeFileSync(p, content);
    fs.utimesSync(p, laterMtime, laterMtime);
  }

  // A clean historical file: payload end_date equals its logical date AND its
  // mtime is that same session's evening (a legitimately dated capture).
  const cleanPath = path.join(accDir, '2026-09-25.json');
  fs.writeFileSync(cleanPath, JSON.stringify({
    code: 'BBCA', start_date: '2026-06-01', end_date: '2026-09-25',
    series: [{ broker_code: 'AK', points: [{ date: '2026-09-25', nval: 5 }] }]
  }, null, 2));
  const cleanMtime = new Date('2026-09-25T12:00:00Z'); // 19:00 WIB Sep 25
  fs.utimesSync(cleanPath, cleanMtime, cleanMtime);

  // An undated current artifact that must NEVER be selected.
  fs.writeFileSync(path.join(accDir, 'series.json'), currentSnapshot);

  return { root, accDir, insDir, currentSnapshot };
}

test('W2-01 scanner: payload end_date after logical date + duplicate hash -> VERIFIED_INVALID_PROVENANCE', () => {
  const fx = makeFixtureRoot();
  try {
    const manifest = scanner.scan({ root: fx.root });
    assert.equal(manifest.totals.scanned, 9, 'scans dated accumulation+insiders files (6 contaminated + 2 later + 1 clean)');
    assert.ok(manifest.totals.verified_invalid >= 6, `expected >=6 verified invalid, got ${manifest.totals.verified_invalid}`);
    const verified = manifest.files.filter(f => f.classification === 'VERIFIED_INVALID_PROVENANCE');
    const dates = verified.filter(f => f.dataset === 'broker-accumulation').map(f => f.logical_date).sort();
    assert.deepEqual(dates, ['2026-09-28', '2026-09-29', '2026-09-30']);
    assert.ok(verified.every(f => f.sha256 && f.endpoint_semantics === 'current_snapshot_only'));
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('W2-01 review: a --log-path flag alone cannot manufacture evidence — only a real matching log does', () => {
  const fx = makeFixtureRoot();
  const logPath = path.join(os.tmpdir(), `prov-log-${Date.now()}.txt`);
  try {
    // Log that does NOT mention the fixture dates -> no promotion from log.
    fs.writeFileSync(logPath, 'Target Date (WIB): 2026-10-02\n');
    const withoutLog = scanner.scan({ root: fx.root });
    const withUnrelatedLog = scanner.scan({ root: fx.root, logPath });
    assert.equal(
      withUnrelatedLog.totals.verified_invalid,
      withoutLog.totals.verified_invalid,
      'an unrelated log must not change any classification'
    );

    // Real sweep lines for the fixture dates.
    fs.writeFileSync(logPath, [
      '[HISTORICAL] BBCA 2026-09-28 disimpan sebagai dated cache; latest.json yang lebih baru dipertahankan.',
      '[HISTORICAL] BBCA 2026-09-29 disimpan sebagai dated cache; latest.json yang lebih baru dipertahankan.',
      '[HISTORICAL] BBCA 2026-09-30 disimpan sebagai dated cache; latest.json yang lebih baru dipertahankan.'
    ].join('\n'));
    const dates = scanner.extractSweepDatesFromLog(logPath);
    assert.deepEqual([...dates].sort(), ['2026-09-28', '2026-09-29', '2026-09-30']);
    const withLog = scanner.scan({ root: fx.root, logPath });
    assert.ok(withLog.totals.verified_invalid >= 6);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
    fs.rmSync(logPath, { force: true });
  }
});

test('W2-01 scanner: clean historical file stays VALID and is never quarantine-eligible', () => {
  const fx = makeFixtureRoot();
  try {
    const manifest = scanner.scan({ root: fx.root });
    const clean = manifest.files.find(f => f.path.endsWith(path.join('broker-accumulation', 'BBCA', '2026-09-25.json')));
    assert.ok(clean);
    assert.equal(clean.classification, 'VALID');
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('W2-01 scanner: a later mtime alone (no payload/duplicate evidence) is not VERIFIED_INVALID', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-weak-'));
  try {
    const dir = path.join(root, 'broker-accumulation', 'WEAK');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, '2026-09-25.json');
    fs.writeFileSync(p, JSON.stringify({ code: 'WEAK', end_date: '2026-09-25', series: [] }, null, 2));
    // Force a future mtime — this is the ONLY signal.
    const future = new Date(Date.now() + 86400000);
    fs.utimesSync(p, future, future);
    const manifest = scanner.scan({ root });
    const record = manifest.files.find(f => f.path === p);
    assert.notEqual(record.classification, 'VERIFIED_INVALID_PROVENANCE', 'mtime alone must never verify invalidity');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('W2-01 quarantine: dry-run leaves the filesystem byte-for-byte unchanged', () => {
  const fx = makeFixtureRoot();
  try {
    const manifest = scanner.scan({ root: fx.root });
    const manifestPath = path.join(fx.root, '..', `prov-manifest-${Date.now()}.json`);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const before = {};
    for (const f of manifest.files) before[f.path] = sha256(fs.readFileSync(f.path));

    const quarantineRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-q-'));
    try {
      const result = quarantine.main(['--manifest', manifestPath, '--quarantine-root', quarantineRoot, '--dry-run']);
      assert.ok(result);
      assert.equal(result.moved.length, 0, 'dry-run must not move files');
      for (const f of manifest.files) {
        assert.equal(fs.existsSync(f.path), true, `dry-run must leave ${f.path} in place`);
        assert.equal(sha256(fs.readFileSync(f.path)), before[f.path]);
      }
      assert.equal(fs.readdirSync(quarantineRoot).length, 0, 'dry-run must not create quarantine artifacts');
    } finally {
      fs.rmSync(quarantineRoot, { recursive: true, force: true });
      fs.rmSync(manifestPath, { force: true });
    }
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('W2-01 quarantine: execute moves ONLY verified-invalid files, preserves paths, then restore round-trips', () => {
  const fx = makeFixtureRoot();
  const quarantineRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-q-exec-'));
  const manifestPath = path.join(os.tmpdir(), `prov-manifest-exec-${Date.now()}.json`);
  try {
    const manifest = scanner.scan({ root: fx.root });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const verified = manifest.files.filter(f => f.classification === 'VERIFIED_INVALID_PROVENANCE');
    const untouched = manifest.files.filter(f => f.classification !== 'VERIFIED_INVALID_PROVENANCE');
    const beforeHashes = {};
    for (const f of verified) beforeHashes[f.path] = sha256(fs.readFileSync(f.path));

    const restoreManifestPath = path.join(quarantineRoot, 'restore.json');
    const result = quarantine.main(['--manifest', manifestPath, '--quarantine-root', quarantineRoot, '--execute', '--restore-manifest', restoreManifestPath]);

    assert.equal(result.moved.length, verified.length, 'exactly the verified set must move');
    assert.equal(result.failures.length, 0);
    for (const f of verified) {
      assert.equal(fs.existsSync(f.path), false, `${f.path} must be moved out of the active path`);
    }
    for (const f of untouched) {
      assert.equal(fs.existsSync(f.path), true, `${f.path} must be untouched`);
    }
    // Relative path + original filename preserved.
    for (const m of result.moved) {
      assert.ok(m.quarantine_path.endsWith(path.basename(m.original_path)), 'original filename preserved');
      assert.ok(m.quarantine_path.includes(path.join('broker-accumulation', 'BBCA')) || m.quarantine_path.includes(path.join('insiders', 'BBCA')), 'relative path preserved');
      assert.equal(sha256(fs.readFileSync(m.quarantine_path)), beforeHashes[m.original_path], 'quarantine hash matches original');
    }

    // Restore round-trip.
    const restored = quarantine.main(['--restore', restoreManifestPath]);
    assert.equal(restored.restored.length, verified.length);
    assert.equal(restored.failures.length, 0);
    for (const f of verified) {
      assert.equal(fs.existsSync(f.path), true, `${f.path} must be restored`);
      assert.equal(sha256(fs.readFileSync(f.path)), beforeHashes[f.path], 'restored content is byte-identical');
    }
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
    fs.rmSync(quarantineRoot, { recursive: true, force: true });
    fs.rmSync(manifestPath, { force: true });
  }
});

test('W2-01 review: a source updated after scanning is skipped, not quarantined under a stale hash', () => {
  const fx = makeFixtureRoot();
  const quarantineRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-q-stale-'));
  const manifestPath = path.join(os.tmpdir(), `prov-manifest-stale-${Date.now()}.json`);
  try {
    const manifest = scanner.scan({ root: fx.root });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    // Simulate a corrected rewrite of one verified file AFTER the scan.
    const verified = manifest.files.filter(f => f.classification === 'VERIFIED_INVALID_PROVENANCE');
    const corrected = verified[0];
    fs.writeFileSync(corrected.path, JSON.stringify({ corrected: true, end_date: corrected.logical_date }));

    const result = quarantine.main(['--manifest', manifestPath, '--quarantine-root', quarantineRoot, '--execute']);
    process.exitCode = undefined; // main() sets exit code on failures — do not leak it
    assert.ok(result.failures.some(f => f.source === corrected.path && f.reason === 'source_changed_since_scan'), 'changed source must be skipped');
    assert.equal(fs.existsSync(corrected.path), true, 'changed source must remain in place');
    assert.equal(result.moved.some(m => m.original_path === corrected.path), false, 'changed source must not be moved');
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
    fs.rmSync(quarantineRoot, { recursive: true, force: true });
    fs.rmSync(manifestPath, { force: true });
  }
});

test('W2-01 quarantine: refuses to move anything whose classification is not VERIFIED_INVALID_PROVENANCE', () => {
  const manifest = {
    root: path.join(os.tmpdir(), 'prov-gate-root'),
    files: [
      { path: path.join(os.tmpdir(), 'prov-gate-root', 'broker-accumulation', 'X', '2026-09-25.json'), classification: 'STRONGLY_SUSPECT' },
      { path: path.join(os.tmpdir(), 'prov-gate-root', 'broker-accumulation', 'X', '2026-09-26.json'), classification: 'AMBIGUOUS' },
      { path: path.join(os.tmpdir(), 'prov-gate-root', 'broker-accumulation', 'X', '2026-09-27.json'), classification: 'VALID' }
    ]
  };
  const { plan, skipped } = quarantine.buildPlan(manifest.files, manifest.root);
  assert.equal(plan.length, 0, 'no non-verified file may enter the plan');
  assert.equal(skipped.length, 3);
});

test('W2-01 quarantine: current/latest artifacts are refused even if mislabeled VERIFIED', () => {
  const root = path.join(os.tmpdir(), 'prov-latest-root');
  const files = [
    { path: path.join(root, 'broker-accumulation', 'X', 'latest.json'), classification: 'VERIFIED_INVALID_PROVENANCE' },
    { path: path.join(root, 'insiders', 'X', 'p1.json'), classification: 'VERIFIED_INVALID_PROVENANCE' }
  ];
  const { plan } = quarantine.buildPlan(files, root);
  // buildPlan itself keeps them (classification is verified), but main()
  // refuses the whole plan. Verify main()'s refusal by running it dry against
  // a temp manifest.
  const manifestPath = path.join(os.tmpdir(), `prov-latest-${Date.now()}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify({ root, files }));
  try {
    const prevExit = process.exitCode;
    process.exitCode = undefined;
    const result = quarantine.main(['--manifest', manifestPath, '--quarantine-root', path.join(os.tmpdir(), 'prov-latest-q'), '--execute']);
    assert.equal(result, null, 'main must refuse a plan containing latest/undated artifacts');
    assert.equal(process.exitCode, 2);
    process.exitCode = prevExit;
  } finally {
    fs.rmSync(manifestPath, { force: true });
  }
});
