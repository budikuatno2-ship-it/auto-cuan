'use strict';

const fs = require('fs');
const path = require('path');
const scheduler = require('../lib/insider-tiered-scheduler');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'bukti-verifikasi-final', 'fase08');
const OUT_FILE = path.join(OUT_DIR, 'simulasi-tiered-insider.json');

fs.mkdirSync(OUT_DIR, { recursive: true });

console.log('[Tiered Scheduler Simulation] Running 7-day deterministic simulation...');

const result = scheduler.runDeterministicSimulation(7);

console.log('--- SIMULATION RESULTS ---');
console.log(`Total Universe: ${result.universe_size} emiten`);
console.log(`Tier 1 (Likuid / Konglo): ${result.tier1_count} emiten`);
console.log(`Tier 2 (Non-Likuid / Lapis 2-3): ${result.tier2_count} emiten (Grup A: ${result.tier2_group_a_count}, Grup B: ${result.tier2_group_b_count})`);
console.log('\nDaily Breakdown:');
result.daily_breakdown.forEach(d => {
  console.log(` Day ${d.day} [${d.day_name}]: Tier 1 = ${d.tier1_req}, Tier 2 (${d.tier2_group}) = ${d.tier2_req} => Total = ${d.total_req} req`);
});

console.log('\nMetrics:');
console.log(` 5-Day Weekly Total Requests: ${result.metrics.req_5_days_total}`);
console.log(` 5-Day Average Daily Load: ${result.metrics.avg_daily_req_5_days} req/hari`);
console.log(` 7-Day Total Requests: ${result.metrics.req_7_days_total}`);
console.log(` 7-Day Average Daily Load: ${result.metrics.avg_daily_req_7_days} req/hari`);
console.log(` Active Subset Average Daily Load: ${result.metrics.active_subset_avg_daily_req} req/hari (~455 req/hari)`);
console.log(` Baseline without tiering: ${result.metrics.baseline_daily_req_without_tiering} req/hari`);
console.log(` Quota saved: ${result.metrics.quota_saved_percentage}% (ratio: ${result.metrics.quota_reduction_ratio})`);

console.log('\nAssertions:');
console.log(` (1) Every Tier 2 emiten checked exactly twice/week: ${result.verification_assertions.all_tier2_checked_exactly_twice_per_week} (Min=${result.verification_assertions.min_checks_per_week}, Max=${result.verification_assertions.max_checks_per_week})`);
console.log(` (2) Average daily req within target range (~455-505 req/hari): ${result.verification_assertions.average_daily_req_in_target_range_455_to_505}`);
console.log(` (3) Quota saved >= 45%: ${result.verification_assertions.quota_saved_gt_45_percent}`);

fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2), 'utf8');
console.log(`\n✓ Simulation proof saved to: ${OUT_FILE}`);
