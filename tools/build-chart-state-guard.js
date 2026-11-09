#!/usr/bin/env node
'use strict';

/**
 * tools/build-chart-state-guard.js
 * ============================================================================
 * DEPRECATED — kept only so an old CI invocation fails loudly instead of
 * overwriting the canonical guard.
 * ============================================================================
 *
 * HISTORY
 *   The first version of this script copied `lib/chart-state-guard.js` over
 *   `public/chart-state-guard.js`. That layout was replaced by the inverse:
 *   `public/chart-state-guard.js` is now the single implementation (the static
 *   asset responder only serves `public/`), and `lib/chart-state-guard.js` is a
 *   one-line re-export of it.
 *
 *   Running the old copy step now would overwrite the canonical implementation
 *   with a re-export, silently disabling the guard. This file therefore only
 *   delegates to `tools/verify-chart-state-guard.js`.
 *
 * USAGE
 *   node tools/verify-chart-state-guard.js
 * ============================================================================
 */

const { main } = require('./verify-chart-state-guard.js');

process.stderr.write(
  'note: tools/build-chart-state-guard.js is deprecated; the guard needs no build step.\n' +
  '      public/chart-state-guard.js is canonical and lib/chart-state-guard.js re-exports it.\n'
);

process.exit(main());