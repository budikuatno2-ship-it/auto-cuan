'use strict';

/**
 * test/v5/run-exit-code.test.js
 * ============================================================================
 * V5 FIX 2 — Release-gate exit-code contract for test/v5/run.js.
 * ============================================================================
 * The defect: `main()` only set a nonzero exit code for BROKEN_CONTROL. A run in
 * which a control reported DETECTED / PENDING_IMPLEMENTATION / SKIP (a live
 * defect, a missing seam, or a control that genuinely could not run) still
 * exited 0, so a release gate treated a FAILING tree as PASSING.
 *
 * Required contract (release-gate mode, the default):
 *   exit 0  ==  every mandatory control ran AND returned PASSED
 *              (zero DETECTED, zero BROKEN_CONTROL, zero SKIP/BLOCKED/PENDING)
 *   exit 1  ==  gate failed (>=1 DETECTED / BROKEN_CONTROL / SKIP / PENDING)
 *   exit 2  ==  runner/infrastructure failure (exception, unknown --only id)
 *
 * Diagnostic mode (--diagnostic): returns 0 for a healthy framework when only
 * DETECTED / SKIP / PENDING are present (labelled), but still fails (1) when a
 * BROKEN_CONTROL is present (the framework itself is defective), and still
 * returns 2 on an infra failure.
 *
 * This file covers the 7 mandatory cases:
 *   1. 25 PASS / 0 DETECTED                 -> exit 0 (unit + real subprocess)
 *   2. 1 DETECTED                           -> exit nonzero
 *   3. 1 BROKEN_CONTROL                     -> exit nonzero
 *   4. runner exception / unknown --only id -> exit 2
 *   5. mandatory control did not run (SKIP/PENDING) -> exit nonzero
 *   6. N24 negative-control fault injection -> DETECTED AND release gate fails
 *   7. --diagnostic with DETECTED/SKIP      -> exit 0 (labelled), mode split works
 * ============================================================================
 * Run:  node test/v5/run-exit-code.test.js
 * ============================================================================
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const H = require('./harness');
const runner = require('./run');

const REPO = H.ROOT;
const RUN_JS = path.join(REPO, 'test', 'v5', 'run.js');
const MANIFEST = path.join(REPO, 'MANIFEST_AUDIT_V4_LENGKAP.md');

const S = H.STATUS;

let pass = 0;
let fail = 0;
const failures = [];

function rec(id, status, detail) {
  return { id, name: id, status, detail: detail || 'reason-' + id };
}

function check(name, cond, detail) {
  if (cond) {
    pass += 1;
    process.stdout.write('PASS  ' + name + (detail ? '  (' + detail + ')' : '') + '\n');
  } else {
    fail += 1;
    failures.push({ name, detail });
    process.stdout.write('FAIL  ' + name + (detail ? '  (' + detail + ')' : '') + '\n');
  }
}

function statuses() {
  const counts = {};
  for (const k of Object.values(S)) counts[k] = 0;
  return counts;
}

/* -------------------------------------------------------------------------- */
/* Case 1 — 25 PASSED, 0 anything else -> exit 0                               */
/* -------------------------------------------------------------------------- */
(function case1_unit() {
  const records = [];
  for (let i = 1; i <= 25; i += 1) records.push(rec('N' + i, S.PASSED, 'invariant held'));
  const v = runner.computeExitCode(records, {});
  check('case1(unit): 25 PASSED -> exit 0', v.code === runner.EXIT_CODES.OK && v.mode === 'release-gate' && v.failures.length === 0,
    'code=' + v.code + ' mode=' + v.mode);
})();

/* -------------------------------------------------------------------------- */
/* Case 2 — 1 DETECTED -> nonzero (gate fail)                                  */
/* -------------------------------------------------------------------------- */
(function case2_unit() {
  const records = [rec('N1', S.PASSED, 'ok'), rec('N2', S.DETECTED, 'live defect present'), rec('N3', S.PASSED, 'ok')];
  const v = runner.computeExitCode(records, {});
  check('case2(unit): 1 DETECTED -> exit nonzero', v.code === runner.EXIT_CODES.GATE_FAIL && v.mode === 'release-gate',
    'code=' + v.code + ' failures=' + v.failures.length);
  check('case2(unit): failure names the DETECTED control + reason',
    v.failures.length === 1 && /N2/.test(v.failures[0]) && /DETECTED/.test(v.failures[0]) && /live defect present/.test(v.failures[0]),
    v.failures.join(' | '));
})();

/* -------------------------------------------------------------------------- */
/* Case 3 — 1 BROKEN_CONTROL -> nonzero                                        */
/* -------------------------------------------------------------------------- */
(function case3_unit() {
  const records = [rec('N1', S.PASSED, 'ok'), rec('N2', S.BROKEN, 'control passed while bug is live')];
  const v = runner.computeExitCode(records, {});
  check('case3(unit): 1 BROKEN_CONTROL -> exit nonzero', v.code === runner.EXIT_CODES.GATE_FAIL,
    'code=' + v.code);
  check('case3(unit): BROKEN_CONTROL reported with reason',
    /BROKEN_CONTROL/.test(v.failures[0]) && /bug is live/.test(v.failures[0]),
    v.failures.join(' | '));
})();

/* -------------------------------------------------------------------------- */
/* Case 5 — mandatory control did not run (SKIP / PENDING) -> nonzero          */
/* -------------------------------------------------------------------------- */
(function case5_unit() {
  const records = [
    rec('N1', S.PASSED, 'ok'),
    rec('N2', S.SKIP, 'offline precondition absent'),
    rec('N3', S.PENDING, 'required module lib/x.js does not exist')
  ];
  const v = runner.computeExitCode(records, {});
  check('case5(unit): SKIP + PENDING on mandatory controls -> exit nonzero', v.code === runner.EXIT_CODES.GATE_FAIL,
    'code=' + v.code + ' failures=' + v.failures.length);
  check('case5(unit): both SKIP and PENDING are named with reasons',
    v.failures.length === 2 && v.failures.some((f) => /SKIP/.test(f) && /offline precondition absent/.test(f)) &&
    v.failures.some((f) => /PENDING_IMPLEMENTATION/.test(f) && /lib\/x\.js/.test(f)),
    v.failures.join(' | '));
})();

/* -------------------------------------------------------------------------- */
/* Case 7 — diagnostic mode: DETECTED/SKIP/PENDING are healthy (0);            */
/*          BROKEN_CONTROL still fails                                         */
/* -------------------------------------------------------------------------- */
(function case7_unit() {
  const healthy = [rec('N1', S.PASSED, 'ok'), rec('N2', S.DETECTED, 'live defect'), rec('N3', S.SKIP, 'offline'), rec('N4', S.PENDING, 'seam missing')];
  const vh = runner.computeExitCode(healthy, { diagnostic: true });
  check('case7(unit): --diagnostic with DETECTED/SKIP/PENDING -> exit 0', vh.code === runner.EXIT_CODES.OK && vh.mode === 'diagnostic',
    'code=' + vh.code + ' mode=' + vh.mode);
  check('case7(unit): diagnostic labels non-fatal statuses',
    vh.diagnostic && vh.diagnostic.detected === 1 && vh.diagnostic.skipped === 1 && vh.diagnostic.pending === 1,
    JSON.stringify(vh.diagnostic));

  const broken = [rec('N1', S.PASSED, 'ok'), rec('N2', S.DETECTED, 'live defect'), rec('N3', S.BROKEN, 'control passed while bug live')];
  const vb = runner.computeExitCode(broken, { diagnostic: true });
  check('case7(unit): --diagnostic STILL fails on BROKEN_CONTROL', vb.code === runner.EXIT_CODES.GATE_FAIL,
    'code=' + vb.code);
})();

/* -------------------------------------------------------------------------- */
/* parseArgs: --diagnostic / --diag flag wiring                                 */
/* -------------------------------------------------------------------------- */
(function parseArgs() {
  const a = runner.parseArgs(['--diagnostic', '--no-write']);
  const b = runner.parseArgs(['--diag']);
  const c = runner.parseArgs([]);
  check('parseArgs: --diagnostic sets diagnostic=true', a.diagnostic === true && a.write === false);
  check('parseArgs: --diag alias sets diagnostic=true', b.diagnostic === true);
  check('parseArgs: default is release-gate (diagnostic=false)', c.diagnostic === false);
})();

/* -------------------------------------------------------------------------- */
/* Subprocess integration (real exit codes)                                    */
/* -------------------------------------------------------------------------- */

function runNode(args) {
  return spawnSync(process.execPath, [RUN_JS].concat(args), {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 64 * 1024 * 1024
  });
}

/* Case 1 (real) — the 16 source/fixture-independent controls run as the
 * required release gate and must exit 0. The 9 external-evidence controls
 * (N4,N5,N6,N7,N10,N11,N23,N24,N25) depend on artifacts that live outside
 * Git and are exercised separately with `--diagnostic`, so a full 25-control
 * run is NOT expected to exit 0 on a fresh checkout. */
(function case1_real() {
  const PORTABLE = 'N1,N2,N3,N8,N9,N12,N13,N14,N15,N16,N17,N18,N19,N20,N21,N22';
  const r = runNode(['--no-write', '--only', PORTABLE]);
  const ok = r.status === 0 && /GATE PASSED/.test(r.stderr || '');
  check('case1(real): 16 portable controls release-gate run exits 0', ok,
    'status=' + r.status);
  if (!ok) {
    process.stderr.write((r.stdout || '') + '\n' + (r.stderr || '') + '\n');
  }
})();

/* Case 4 — unknown --only id -> exit 2 (infra). */
(function case4_unknown() {
  const r = runNode(['--only', 'NOPE', '--no-write']);
  check('case4(unknown): unknown --only id exits 2', r.status === 2,
    'status=' + r.status + ' stderr=' + String(r.stderr || '').trim());
})();

/* Case 4 — runner exception (infra failure) -> exit 2. */
(function case4_exception() {
  // Inject an infra failure into the evidence-write path via a preload that
  // makes fs.writeFileSync throw. main() rejects, the .catch sets exit code 2.
  const preload = path.join(os.tmpdir(), 'ac-v5-infra-throw-' + process.pid + '.js');
  fs.writeFileSync(preload, [
    "'use strict';",
    "const fs = require('node:fs');",
    "const orig = fs.writeFileSync;",
    "fs.writeFileSync = function () { throw new Error('injected infra failure'); };",
    "void orig;"
  ].join('\n'), 'utf8');

  let r = null;
  try {
    r = spawnSync(process.execPath, ['--require', preload, RUN_JS], {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 64 * 1024 * 1024
    });
  } finally {
    fs.unlinkSync(preload);
  }
  check('case4(exception): runner exception exits 2 (infra)',
    r !== null && r.status === 2 && /runner failure/.test(r.stderr || ''),
    'status=' + (r ? r.status : 'null') +
      ' stderr=' + String(r ? (r.stderr || '').split(/\r?\n/)[0] : '').trim());
})();

/* Case 7 (real) — diagnostic mode -> exit 0 in the healthy baseline. */
(function case7_real() {
  const r = runNode(['--diagnostic', '--no-write']);
  check('case7(real): --diagnostic full run exits 0 (baseline healthy)',
    r.status === 0 && /DIAGNOSTIC MODE/.test(r.stdout || ''),
    'status=' + r.status);
})();

/* Case 6 (real) — N24 negative-control fault injection -> DETECTED -> gate fail.
 * The injection fixture is the external MANIFEST_AUDIT_V4_LENGKAP.md artifact
 * (owned outside Git). When it is absent, the case reports SKIP instead of a
 * release defect: N24 itself already reports SKIP for exactly this reason. */
(function case6_inject() {
  if (!fs.existsSync(MANIFEST)) {
    check('case6(inject): skipped (MANIFEST_AUDIT_V4_LENGKAP.md external artifact absent)',
      true, 'external artifact absent -> SKIP, not a release defect');
    return;
  }

  const original = fs.readFileSync(MANIFEST, 'utf8');
  const injectLine = '| **V4-F99** | Injected anti-fake probe (untracked gate, fault injection) | **PASS** | test/v5/run-exit-code.test.js |';
  const baseline = runNode(['--only', 'N24', '--no-write']);
  check('case6(baseline): N24 without injection exits 0 (tree clean)',
    baseline.status === 0, 'status=' + baseline.status);

  let injected = null;
  try {
    fs.writeFileSync(MANIFEST, original.replace(/\n?$/, '\n') + injectLine + '\n', 'utf8');
    injected = runNode(['--only', 'N24', '--no-write']);
  } finally {
    fs.writeFileSync(MANIFEST, original, 'utf8');
  }

  check('case6(inject): N24 fault injection exits nonzero in release-gate mode',
    injected !== null && injected.status !== 0 && injected.status === runner.EXIT_CODES.GATE_FAIL,
    'status=' + (injected ? injected.status : 'null'));
  check('case6(inject): the injected N24 was reported DETECTED',
    injected !== null && /N24/.test(injected.stdout || '') && /\| DETECTED \|/.test(injected.stdout || '') ||
    injected !== null && /DETECTED/.test(injected.stderr || ''),
    'stderr=' + String(injected ? injected.stderr : '').trim().slice(0, 240));

  // Restore guard: the manifest must be byte-identical to the original.
  const restored = fs.readFileSync(MANIFEST, 'utf8');
  check('case6(inject): manifest restored byte-identical after injection', restored === original);
})();

/* -------------------------------------------------------------------------- */
/* Summary                                                                     */
/* -------------------------------------------------------------------------- */
process.stdout.write('\n========================================\n');
process.stdout.write('exit-code test summary: ' + pass + ' passed, ' + fail + ' failed\n');
if (failures.length > 0) {
  process.stdout.write('failures:\n');
  for (const f of failures) process.stdout.write('  - ' + f.name + ': ' + (f.detail || '') + '\n');
}
process.stdout.write('========================================\n');
process.exitCode = fail === 0 ? 0 : 1;