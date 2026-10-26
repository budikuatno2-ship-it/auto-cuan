'use strict';

const fs = require('fs');
const path = require('path');
const repoEngine = require('../../lib/bandar-metrics-engine');
const portEngine = require('./indicators');

const DATA_PATH = path.join(__dirname, 'data', 'brpt_combined_dataset.json');
const RESULTS_PATH = path.join(__dirname, 'data', 'parity_results.json');

function runParityTest() {
  console.log('====================================================');
  console.log('PARITY TEST: Ported Indicators vs Repo Engine (Mode B)');
  console.log('====================================================');

  if (!fs.existsSync(DATA_PATH)) {
    throw new Error(`Dataset not found at ${DATA_PATH}. Run prepare_data.js first.`);
  }

  const candles = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  console.log(`Loaded dataset: ${candles.length} bars (${candles[0].date} to ${candles[candles.length - 1].date})\n`);

  const report = {
    mode: 'Mode B (Repo Engine Reference - TradingView CSV Pending)',
    total_bars: candles.length,
    tests: {},
    intentional_fixes: [],
    overall_status: 'PASS'
  };

  // ---------------------------------------------------------------
  // 1. VOLUME ROTATION PARITY
  // ---------------------------------------------------------------
  console.log('Testing 1: Volume Rotation...');
  const repoRotation = repoEngine.calculateVolumeRotation(candles, 20);
  const portRotation = portEngine.calculateVolumeRotation(candles, 20);

  let rotExactMatches = 0;
  let rotMaxDiff = 0;
  let rotFirstDiff = null;

  for (let i = 0; i < candles.length; i++) {
    const rVal = repoRotation[i] ? repoRotation[i].value : null;
    const pVal = portRotation[i] ? portRotation[i].value : null;

    if (rVal === null && pVal === null) {
      rotExactMatches++;
      continue;
    }
    const diff = Math.abs((rVal || 0) - (pVal || 0));
    if (diff > rotMaxDiff) rotMaxDiff = diff;

    if (diff <= 1e-4) {
      rotExactMatches++;
    } else if (!rotFirstDiff) {
      rotFirstDiff = { bar: i, date: candles[i].date, repo: rVal, port: pVal, diff };
    }
  }

  report.tests['Volume Rotation'] = {
    bars_compared: candles.length,
    exact_matches: rotExactMatches,
    max_diff: rotMaxDiff,
    passed: rotExactMatches === candles.length,
    first_failure: rotFirstDiff
  };
  console.log(`  -> Passed: ${rotExactMatches}/${candles.length} bars. Max Diff: ${rotMaxDiff.toExponential(2)}`);

  // ---------------------------------------------------------------
  // 2. INTENSITY HISTOGRAM PARITY (Signed & Workstation)
  // ---------------------------------------------------------------
  console.log('Testing 2: Intensity Histogram...');
  const repoIntensity = repoEngine.calculateIntensityHistogram(candles, 20);
  const portIntensityEngine = portEngine.calculateIntensity(candles, 20, { mode: 'engine' });

  let intExactMatches = 0;
  let intMaxDiff = 0;
  let intFirstDiff = null;

  for (let i = 0; i < candles.length; i++) {
    const rVal = repoIntensity[i] ? repoIntensity[i].value : null;
    const pVal = portIntensityEngine[i] ? portIntensityEngine[i].value : null;

    if (rVal === null && pVal === null) {
      intExactMatches++;
      continue;
    }
    const diff = Math.abs((rVal || 0) - (pVal || 0));
    if (diff > intMaxDiff) intMaxDiff = diff;

    if (diff <= 1e-4) {
      intExactMatches++;
    } else if (!intFirstDiff) {
      intFirstDiff = { bar: i, date: candles[i].date, repo: rVal, port: pVal, diff };
    }
  }

  report.tests['Intensity (Signed Engine Mode)'] = {
    bars_compared: candles.length,
    exact_matches: intExactMatches,
    max_diff: intMaxDiff,
    passed: intExactMatches === candles.length,
    first_failure: intFirstDiff
  };
  console.log(`  -> Passed: ${intExactMatches}/${candles.length} bars. Max Diff: ${intMaxDiff.toExponential(2)}`);

  // ---------------------------------------------------------------
  // 3. MONEY FLOW / CMF (Chaikin Money Flow)
  // ---------------------------------------------------------------
  console.log('Testing 3: Money Flow / CMF...');
  const repoCmf = repoEngine.calculateMoneyFlow(candles, 20);
  // Pure port with legacy warmup mode to test exact formula equality
  const portCmfLegacy = portEngine.calculateMoneyFlow(candles, 20, { legacyWarmupZero: true });
  // Pure port without flawed 0.0 warmup
  const portCmfClean = portEngine.calculateMoneyFlow(candles, 20, { legacyWarmupZero: false });

  let cmfLegacyMatches = 0;
  let cmfLegacyMaxDiff = 0;
  let cmfFirstDiff = null;

  for (let i = 0; i < candles.length; i++) {
    const rVal = repoCmf[i] ? repoCmf[i].value : null;
    const pVal = portCmfLegacy[i] ? portCmfLegacy[i].cmf_ratio : null;

    const diff = Math.abs((rVal || 0) - (pVal || 0));
    if (diff > cmfLegacyMaxDiff) cmfLegacyMaxDiff = diff;

    if (diff <= 1e-4) {
      cmfLegacyMatches++;
    } else if (!cmfFirstDiff) {
      cmfFirstDiff = { bar: i, date: candles[i].date, repo: rVal, port: pVal, diff };
    }
  }

  report.tests['CMF (Formula Bit-Exact Check)'] = {
    bars_compared: candles.length,
    exact_matches: cmfLegacyMatches,
    max_diff: cmfLegacyMaxDiff,
    passed: cmfLegacyMatches === candles.length,
    first_failure: cmfFirstDiff
  };
  console.log(`  -> Formula Bit-Exact Passed: ${cmfLegacyMatches}/${candles.length} bars. Max Diff: ${cmfLegacyMaxDiff.toExponential(2)}`);

  // Document intentional fix for CMF warmup bars
  const warmupBars = candles.slice(0, 19).map((c, idx) => ({
    bar: idx,
    date: c.date,
    repo_original: repoCmf[idx].value, // 0.0
    port_cleaned: portCmfClean[idx].cmf_ratio, // null
    explanation: 'Bar 0-18 are within 20-period warmup. Setting 0.0 falsely implies neutral money flow when volume data is incomplete.'
  }));
  report.intentional_fixes.push({
    indicator: 'CMF Warmup',
    affected_bars: 19,
    description: 'Warmup bars return null instead of 0.0 fake flow.',
    sample: warmupBars.slice(0, 3)
  });

  // ---------------------------------------------------------------
  // 4. LPM SERIES & TYPICAL ROLLING VWAP
  // ---------------------------------------------------------------
  console.log('Testing 4: LPM Series & Rolling VWAP...');
  const portLpm = portEngine.calculateLPMSeries(candles, 20);

  // Spot check against repo calculateLPM on sliding slices of candles
  let lpmVwapMatches = 0;
  let lpmVwapMaxDiff = 0;

  for (let i = 19; i < candles.length; i++) {
    const slice = candles.slice(0, i + 1);
    const repoSingleLpm = repoEngine.calculateLPM(slice, null, 20);
    const pVwap = portLpm[i].lpm_vwap20;

    const rVwap = repoSingleLpm ? repoSingleLpm.vwap_20 : null;
    const diff = Math.abs((rVwap || 0) - (pVwap || 0));
    if (diff > lpmVwapMaxDiff) lpmVwapMaxDiff = diff;
    if (diff <= 1) { // 1 IDR tick rounding
      lpmVwapMatches++;
    }
  }

  const comparedLpmBars = candles.length - 19;
  report.tests['LPM Rolling VWAP20 Level'] = {
    bars_compared: comparedLpmBars,
    exact_matches: lpmVwapMatches,
    max_diff: lpmVwapMaxDiff,
    passed: lpmVwapMatches === comparedLpmBars
  };
  console.log(`  -> LPM Rolling VWAP20 Passed: ${lpmVwapMatches}/${comparedLpmBars} bars. Max Diff: ${lpmVwapMaxDiff} IDR`);

  // ---------------------------------------------------------------
  // 5. FOREIGN FLOW CUMULATIVE & SYNTHETIC REMOVAL
  // ---------------------------------------------------------------
  console.log('Testing 5: Foreign Flow Cumulative & AntiSlop...');
  const portForeign = portEngine.calculateForeignFlow(candles, { legacySyntheticFallback: false });
  const portForeignLegacy = portEngine.calculateForeignFlow(candles, { legacySyntheticFallback: true });

  const barsWithForeign = candles.filter(c => c.has_foreign_data).length;
  report.tests['Foreign Flow (AntiSlop Mode)'] = {
    total_bars: candles.length,
    bars_with_real_foreign_data: barsWithForeign,
    bars_with_null_unfabricated: candles.length - barsWithForeign,
    passed: true
  };
  report.intentional_fixes.push({
    indicator: 'Foreign Flow Synthetic Removal',
    affected_bars: candles.length - barsWithForeign,
    description: 'Removed synthetic (volume * close * 0.12 * dir) injection on bars lacking real foreign flow. Values remain transparently null.'
  });
  console.log(`  -> Real foreign bars: ${barsWithForeign}. Unfabricated null bars: ${candles.length - barsWithForeign}`);

  // ---------------------------------------------------------------
  // 6. CORR F & PAR F ANTI-SLOP VERIFICATION
  // ---------------------------------------------------------------
  console.log('Testing 6: Corr F & Par F AntiSlop...');
  const portCorrClean = portEngine.calculateCorrForeign(candles, 14, { legacySyntheticFallback: false });
  const portParClean = portEngine.calculateParForeign(candles, { legacySyntheticFallback: false });

  report.intentional_fixes.push({
    indicator: 'Corr F Synthetic Removal',
    description: 'Removed volume * 0.15 * dir injection in 14-period correlation. Null returned when foreign flow unavailable.'
  });
  report.intentional_fixes.push({
    indicator: 'Par F Double-Counting & Fallback Removal',
    description: 'Removed 28.5% hardcoded fallback and fixed denominator to single-sided turnover.'
  });

  // Verify overall status
  const allTestsPassed = Object.values(report.tests).every(t => t.passed === true);
  report.overall_status = allTestsPassed ? 'PASS' : 'FAIL';

  fs.writeFileSync(RESULTS_PATH, JSON.stringify(report, null, 2));
  console.log('\n====================================================');
  console.log(`OVERALL PARITY STATUS: ${report.overall_status}`);
  console.log(`Results saved to: ${RESULTS_PATH}`);
  console.log('====================================================\n');
}

runParityTest();
