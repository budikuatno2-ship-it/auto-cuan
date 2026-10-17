'use strict';

/**
 * FIX-23: DESIGN.md must become the authoritative written contract for
 *  (a) the dedicated Chart Workstation navigation destination,
 *  (b) indicator mathematics purity (Wilder RSI, CMF warmup, FCA tick ladder,
 *      closed-bar trading plan, no unsafe-RR bypass),
 *  (c) V3_004 historical similarity + V3_015 volatility cone fail-closed
 *      behaviour,
 *  (d) the AntiSlop standard (null / '—' / insufficientData over fabricated
 *      numbers).
 *
 * Before this fix DESIGN.md §19 only said "Analisis AI and Chart & AI Vision are
 * internal modes of one conceptual research destination" and there was no
 * indicator-mathematics contract at all.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DESIGN = fs.readFileSync(path.join(ROOT, 'DESIGN.md'), 'utf8');

test('FIX-23: DESIGN.md documents the dedicated Chart Workstation destination', () => {
  assert.match(DESIGN, /Chart Workstation/, 'DESIGN.md must name "Chart Workstation"');

  // Sidebar IA must list the chart destination as first-class.
  assert.match(
    DESIGN,
    /tabChartWorkstation/,
    'DESIGN.md must reference the concrete #tabChartWorkstation sidebar id'
  );
  assert.match(
    DESIGN,
    /data-sidebar-page="chart"|sidebar-page="chart"/,
    'DESIGN.md must show the sidebar-page contract for the chart destination'
  );

  // The two backward-compatible entries must be kept.
  assert.match(DESIGN, /tabAnalisisChart/, 'the legacy Analisis & Chart entry must remain documented');
  assert.match(DESIGN, /tabAnalisisVision/, 'the in-shell chart lens must remain documented');
});

test('FIX-23: DESIGN.md freezes the indicator mathematics contract', () => {
  // RSI must be pinned to Wilder RMA with the exact alpha = 1/period rule.
  assert.match(DESIGN, /Wilder/, 'DESIGN.md must name Wilder smoothing');
  assert.match(DESIGN, /RMA/, 'DESIGN.md must name RMA');
  assert.match(
    DESIGN,
    /1\s*\/\s*period|\u03b1\s*=\s*1\s*\/\s*n|alpha\s*=\s*1\s*\/\s*period/i,
    'DESIGN.md must state the Wilder alpha = 1/period rule'
  );
  assert.match(DESIGN, /lib\/daily-rsi\.js/, 'DESIGN.md must name the parity reference module');

  // CMF must not fabricate warmup values.
  assert.match(DESIGN, /CMF/, 'DESIGN.md must name CMF');
  assert.match(
    DESIGN,
    /warmup/i,
    'DESIGN.md must be explicit about CMF warmup handling'
  );

  // FCA board tick ladder.
  assert.match(DESIGN, /FCA/, 'DESIGN.md must name the FCA / Akselerasi board');
  assert.match(DESIGN, /tick size/i, 'DESIGN.md must define tick size behaviour');

  // Trading plan must only read closed bars.
  assert.match(
    DESIGN,
    /closed[- ]bar|closed candle|live candle/i,
    'DESIGN.md must distinguish closed bars from the live bar for trading plans'
  );

  // The unsafe RR bypass must be documented as test-only.
  assert.match(DESIGN, /forceUnsafeRR/, 'DESIGN.md must document the forceUnsafeRR test-only gate');
  assert.match(DESIGN, /1\.5/, 'DESIGN.md must keep the R/R >= 1.5 gate');
});

test('FIX-23: DESIGN.md freezes the V3_004 / V3_015 fail-closed contract', () => {
  assert.match(DESIGN, /V3_004/, 'DESIGN.md must name V3_004');
  assert.match(DESIGN, /V3_015/, 'DESIGN.md must name V3_015');

  assert.match(DESIGN, /Pearson|NCC|normalized cross-correlation/i, 'V3_004 similarity metric must be named');
  assert.match(DESIGN, /z-score|zscore/i, 'V3_004 normalization must be named');
  assert.match(DESIGN, /insufficientData/, 'fail-closed sentinel must be named');

  assert.match(DESIGN, /Volatility Cone/, 'V3_015 must be named');
  assert.match(DESIGN, /sqrt|√/i, 'V3_015 sqrt-of-time scaling must be stated');
  assert.match(DESIGN, /1\.645|1\.96/, 'V3_015 confidence z-values must be stated');
});

test('FIX-23: DESIGN.md freezes the AntiSlop numeric-integrity standard', () => {
  assert.match(DESIGN, /AntiSlop/, 'DESIGN.md must contain an AntiSlop section');
  assert.match(
    DESIGN,
    /null/,
    'AntiSlop must prefer null over a fabricated number'
  );
  assert.match(
    DESIGN,
    /—|--/,
    'AntiSlop must define the em-dash/placeholder rendering rule'
  );
  assert.match(
    DESIGN,
    /never invent|do not invent|no fabricated|tidak mengarang/i,
    'AntiSlop must state the "never invent numbers" rule'
  );

  // Trading-plan price lines must be documented as a surface.
  assert.match(DESIGN, /createPriceLine|price line/i, 'DESIGN.md must document the plan price lines');
  assert.match(DESIGN, /axisLabelVisible/, 'DESIGN.md must state the axis label requirement');
});
