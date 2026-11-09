#!/usr/bin/env node
'use strict';

/**
 * tools/verify-chart-state-guard.js
 * ============================================================================
 * Verifies the two entry points of the chart identity guard cannot drift.
 * ============================================================================
 *
 * WHY THIS CHECK EXISTS
 *   `public/chart-state-guard.js` is the implementation because the static
 *   asset responder (`lib/static-assets.js`) only serves `public/`, so the
 *   browser modules can only load `<script src="/chart-state-guard.js">`.
 *   `lib/chart-state-guard.js` re-exports it so server-side code and the V5
 *   tests import the SAME object the browser runs.
 *
 *   If someone "helpfully" copies the implementation into `lib/` instead of
 *   re-exporting it, the tested guard and the served guard silently diverge and
 *   BUG-V5-P0-009 can come back. This script fails loudly instead.
 *
 * USAGE
 *   node tools/verify-chart-state-guard.js
 * ============================================================================
 */

const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function main() {
  const viaLib = require(path.join(ROOT, 'lib', 'chart-state-guard.js'));
  const viaPublic = require(path.join(ROOT, 'public', 'chart-state-guard.js'));

  if (viaLib !== viaPublic) {
    process.stderr.write(
      'chart-state-guard drift: lib/chart-state-guard.js does not re-export public/chart-state-guard.js\n'
    );
    return 1;
  }

  const required = [
    'createRequestGuard',
    'createSnapshotBus',
    'identityMatches',
    'stampIdentity',
    'assertIdentityMatch'
  ];
  const missing = required.filter((name) => typeof viaLib[name] !== 'function');
  if (missing.length) {
    process.stderr.write('chart-state-guard: missing export(s): ' + missing.join(', ') + '\n');
    return 1;
  }

  process.stdout.write('chart-state-guard: lib/ and public/ resolve to the same module\n');
  return 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { main };