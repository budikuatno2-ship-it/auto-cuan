/**
 * Telegram Daily Picks Outcome/Win-Rate Report Generator
 * 
 * Read-only script to analyze telegram_daily_picks from Supabase.
 * Generates weekly outcome report for analysis purposes.
 * 
 * Usage: node tools/report-telegram-outcomes.js
 * 
 * Environment variables required:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 * 
 * Optional:
 *   DAYS_BACK - number of days to look back (default: 30)
 *   OUTPUT_DIR - directory for markdown output (default: data/reports)
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const helpers = require('../lib/report-helpers');

// === Configuration ===
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DAYS_BACK = parseInt(process.env.DAYS_BACK || '30', 10);
const OUTPUT_DIR = process.env.OUTPUT_DIR || 'data/reports';

// === Validate Environment ===
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERROR: Missing required environment variables.');
  console.error('  SUPABASE_URL');
  console.error('  SUPABASE_SERVICE_ROLE_KEY');
  console.error('\nUsage:');
  console.error('  SUPABASE_URL=https://xxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=xxx node tools/report-telegram-outcomes.js');
  process.exit(1);
}

// === Initialize Supabase Client ===
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

// === Fetch Data from Supabase ===
async function fetchDailyPicks() {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - DAYS_BACK);
  const cutoffStr = cutoffDate.toISOString().split('T')[0];
  
  console.log('Fetching telegram_daily_picks from last ' + DAYS_BACK + ' days (since ' + cutoffStr + ')...');
  
  const { data, error } = await supabase
    .from('telegram_daily_picks')
    .select('*')
    .gte('date', cutoffStr)
    .order('date', { ascending: false });
  
  if (error) {
    console.error('ERROR fetching data:', error.message);
    process.exit(1);
  }
  
  console.log('Fetched ' + (data?.length || 0) + ' records\n');
  return data || [];
}

// === Generate Report ===
function generateReport(picks) {
  console.log('=== Generating Report ===\n');
  
  const total = picks.length;
  const stats = {
    total: total,
    bySource: {},
    entryCount: 0,
    tp1Count: 0,
    tp2Count: 0,
    slCount: 0,
    waitingCount: 0,
    runningCount: 0,
    expiredCount: 0,
    scoreBuckets: {},
    avgTimeToEntry: [],
    avgTimeToTp1: [],
    avgTimeToTp2: [],
    avgTimeToSl: [],
    outcomesByStatus: {},
    outcomesBySource: {}
  };
  
  // Process each pick
  for (const pick of picks) {
    // Count by source
    const source = helpers.getMonitorSource(pick) || 'unknown';
    if (!stats.bySource[source]) stats.bySource[source] = 0;
    stats.bySource[source]++;
    
    // Count outcomes
    const outcome = helpers.classifyOutcome(pick);
    if (outcome === 'ENTRY_HIT') stats.entryCount++;
    if (outcome === 'TP1_HIT') stats.tp1Count++;
    if (outcome === 'TP2_HIT') stats.tp2Count++;
    if (outcome === 'SL_HIT') stats.slCount++;
    if (outcome === 'WAITING') stats.waitingCount++;
    if (outcome === 'RUNNING') stats.runningCount++;
    if (outcome === 'EXPIRED') stats.expiredCount++;
    
    // Group by score bucket
    const scoreBucket = helpers.getScoreBucket(pick);
    if (scoreBucket) {
      if (!stats.scoreBuckets[scoreBucket]) stats.scoreBuckets[scoreBucket] = [];
      stats.scoreBuckets[scoreBucket].push(pick);
    }
    
    // Group by status
    const status = pick.status || 'UNKNOWN';
    if (!stats.outcomesByStatus[status]) stats.outcomesByStatus[status] = 0;
    stats.outcomesByStatus[status]++;
    
    // Group outcome by source
    const outcomeKey = source + ':' + outcome;
    if (!stats.outcomesBySource[outcomeKey]) stats.outcomesBySource[outcomeKey] = 0;
    stats.outcomesBySource[outcomeKey]++;
    
    // Calculate time to outcomes (if timestamps exist)
    const firstSent = pick.first_sent_at;
    if (firstSent) {
      const timeToEntry = helpers.calculateTimeDiffHours(firstSent, pick.hit_entry_at);
      const timeToTp1 = helpers.calculateTimeDiffHours(firstSent, pick.hit_tp1_at);
      const timeToTp2 = helpers.calculateTimeDiffHours(firstSent, pick.hit_tp2_at);
      const timeToSl = helpers.calculateTimeDiffHours(firstSent, pick.hit_sl_at);
      
      if (timeToEntry !== null) stats.avgTimeToEntry.push(timeToEntry);
      if (timeToTp1 !== null) stats.avgTimeToTp1.push(timeToTp1);
      if (timeToTp2 !== null) stats.avgTimeToTp2.push(timeToTp2);
      if (timeToSl !== null) stats.avgTimeToSl.push(timeToSl);
    }
  }
  
  // Calculate rates
  stats.entryRate = helpers.calculateRate(stats.entryCount, total);
  stats.tp1Rate = helpers.calculateRate(stats.tp1Count, total);
  stats.tp2Rate = helpers.calculateRate(stats.tp2Count, total);
  stats.slRate = helpers.calculateRate(stats.slCount, total);
  
  // Calculate averages
  stats.avgTimeToEntry = helpers.calculateAverage(stats.avgTimeToEntry);
  stats.avgTimeToTp1 = helpers.calculateAverage(stats.avgTimeToTp1);
  stats.avgTimeToTp2 = helpers.calculateAverage(stats.avgTimeToTp2);
  stats.avgTimeToSl = helpers.calculateAverage(stats.avgTimeToSl);
  
  // Generate observations
  stats.observations = helpers.generateObservations(stats);
  
  return stats;
}

// === Format Console Output ===
function formatConsoleReport(stats) {
  const lines = [];
  const sep = '='.repeat(60);
  const sub = '-'.repeat(40);
  
  lines.push(sep);
  lines.push('TELEGRAM DAILY PICKS - OUTCOME REPORT');
  lines.push('Generated: ' + new Date().toISOString());
  lines.push('Period: Last ' + DAYS_BACK + ' days');
  lines.push(sep);
  lines.push('');
  
  // Summary
  lines.push('## SUMMARY');
  lines.push(sub);
  lines.push('Total monitored picks: ' + stats.total);
  lines.push('');
  
  // By Source
  lines.push('## COUNTS BY SOURCE');
  lines.push(sub);
  if (Object.keys(stats.bySource).length > 0) {
    for (const [source, count] of Object.entries(stats.bySource)) {
      lines.push('  ' + source + ': ' + count);
    }
  } else {
    lines.push('  (data tidak tersedia)');
  }
  lines.push('');
  
  // Outcome counts and rates
  lines.push('## OUTCOME COUNTS & RATES');
  lines.push(sub);
  lines.push('  Entry Hit:     ' + stats.entryCount + ' (' + (stats.entryRate || 'N/A') + ')');
  lines.push('  TP1 Hit:       ' + stats.tp1Count + ' (' + (stats.tp1Rate || 'N/A') + ')');
  lines.push('  TP2 Hit:       ' + stats.tp2Count + ' (' + (stats.tp2Rate || 'N/A') + ')');
  lines.push('  SL Hit:        ' + stats.slCount + ' (' + (stats.slRate || 'N/A') + ')');
  lines.push('  Waiting:       ' + stats.waitingCount);
  lines.push('  Running:       ' + stats.runningCount);
  lines.push('  Expired:       ' + stats.expiredCount);
  lines.push('');
  
  // Outcome by status
  lines.push('## OUTCOME BY STATUS');
  lines.push(sub);
  if (Object.keys(stats.outcomesByStatus).length > 0) {
    for (const [status, count] of Object.entries(stats.outcomesByStatus)) {
      lines.push('  ' + status + ': ' + count);
    }
  } else {
    lines.push('  (data tidak tersedia)');
  }
  lines.push('');
  
  // Score buckets
  lines.push('## OUTCOME BY SCORE BUCKET');
  lines.push(sub);
  const bucketOrder = ['<50', '50-59', '60-69', '70-79', '80+'];
  let hasBuckets = false;
  for (const bucket of bucketOrder) {
    if (stats.scoreBuckets[bucket]) {
      const bucketItems = stats.scoreBuckets[bucket];
      const tp2Hits = bucketItems.filter(i => helpers.classifyOutcome(i) === 'TP2_HIT').length;
      const tp1Hits = bucketItems.filter(i => helpers.classifyOutcome(i) === 'TP1_HIT').length;
      const slHits = bucketItems.filter(i => helpers.classifyOutcome(i) === 'SL_HIT').length;
      const waiting = bucketItems.filter(i => helpers.classifyOutcome(i) === 'WAITING').length;
      const running = bucketItems.filter(i => helpers.classifyOutcome(i) === 'RUNNING').length;
      
      lines.push('  Score ' + bucket + ': ' + bucketItems.length + ' picks');
      lines.push('    TP2: ' + tp2Hits + ', TP1: ' + tp1Hits + ', SL: ' + slHits + ', Waiting: ' + waiting + ', Running: ' + running);
      hasBuckets = true;
    }
  }
  if (!hasBuckets) {
    lines.push('  (data tidak tersedia)');
  }
  lines.push('');
  
  // Time averages
  lines.push('## AVERAGE TIME TO OUTCOME (hours)');
  lines.push(sub);
  lines.push('  Entry:   ' + (stats.avgTimeToEntry !== null ? stats.avgTimeToEntry + ' jam' : 'data tidak tersedia'));
  lines.push('  TP1:     ' + (stats.avgTimeToTp1 !== null ? stats.avgTimeToTp1 + ' jam' : 'data tidak tersedia'));
  lines.push('  TP2:     ' + (stats.avgTimeToTp2 !== null ? stats.avgTimeToTp2 + ' jam' : 'data tidak tersedia'));
  lines.push('  SL:      ' + (stats.avgTimeToSl !== null ? stats.avgTimeToSl + ' jam' : 'data tidak tersedia'));
  lines.push('');
  
  // Observations
  lines.push('## OBSERVATIONS');
  lines.push(sub);
  for (const obs of stats.observations) {
    lines.push('  - ' + obs);
  }
  lines.push('');
  
  lines.push(sep);
  
  return lines.join('\n');
}

// === Format Markdown Output ===
function formatMarkdownReport(stats) {
  const date = new Date().toISOString().split('T')[0];
  const lines = [];
  
  lines.push('# Telegram Daily Picks - Outcome Report');
  lines.push('');
  lines.push('**Generated:** ' + new Date().toISOString());
  lines.push('**Period:** Last ' + DAYS_BACK + ' days');
  lines.push('');
  
  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push('| Total Picks | ' + stats.total + ' |');
  lines.push('');
  
  // By Source
  lines.push('## Counts by Source');
  lines.push('');
  lines.push('| Source | Count |');
  lines.push('|--------|-------|');
  if (Object.keys(stats.bySource).length > 0) {
    for (const [source, count] of Object.entries(stats.bySource)) {
      lines.push('| ' + source + ' | ' + count + ' |');
    }
  } else {
    lines.push('| (data tidak tersedia) | 0 |');
  }
  lines.push('');
  
  // Outcomes
  lines.push('## Outcome Counts & Rates');
  lines.push('');
  lines.push('| Outcome | Count | Rate |');
  lines.push('|---------|-------|------|');
  lines.push('| Entry Hit | ' + stats.entryCount + ' | ' + (stats.entryRate || 'N/A') + ' |');
  lines.push('| TP1 Hit | ' + stats.tp1Count + ' | ' + (stats.tp1Rate || 'N/A') + ' |');
  lines.push('| TP2 Hit | ' + stats.tp2Count + ' | ' + (stats.tp2Rate || 'N/A') + ' |');
  lines.push('| SL Hit | ' + stats.slCount + ' | ' + (stats.slRate || 'N/A') + ' |');
  lines.push('| Waiting | ' + stats.waitingCount + ' | - |');
  lines.push('| Running | ' + stats.runningCount + ' | - |');
  lines.push('| Expired | ' + stats.expiredCount + ' | - |');
  lines.push('');
  
  // Score buckets
  lines.push('## Outcome by Score Bucket');
  lines.push('');
  lines.push('| Score | Total | TP2 | TP1 | SL | Waiting | Running |');
  lines.push('|-------|-------|-----|-----|----|---------|---------|');
  const bucketOrder = ['<50', '50-59', '60-69', '70-79', '80+'];
  for (const bucket of bucketOrder) {
    if (stats.scoreBuckets[bucket]) {
      const bucketItems = stats.scoreBuckets[bucket];
      const tp2Hits = bucketItems.filter(i => helpers.classifyOutcome(i) === 'TP2_HIT').length;
      const tp1Hits = bucketItems.filter(i => helpers.classifyOutcome(i) === 'TP1_HIT').length;
      const slHits = bucketItems.filter(i => helpers.classifyOutcome(i) === 'SL_HIT').length;
      const waiting = bucketItems.filter(i => helpers.classifyOutcome(i) === 'WAITING').length;
      const running = bucketItems.filter(i => helpers.classifyOutcome(i) === 'RUNNING').length;
      lines.push('| ' + bucket + ' | ' + bucketItems.length + ' | ' + tp2Hits + ' | ' + tp1Hits + ' | ' + slHits + ' | ' + waiting + ' | ' + running + ' |');
    }
  }
  if (Object.keys(stats.scoreBuckets).length === 0) {
    lines.push('| (data tidak tersedia) | 0 | 0 | 0 | 0 | 0 | 0 |');
  }
  lines.push('');
  
  // Time averages
  lines.push('## Average Time to Outcome');
  lines.push('');
  lines.push('| Milestone | Average (hours) |');
  lines.push('|-----------|-----------------|');
  lines.push('| Entry | ' + (stats.avgTimeToEntry !== null ? stats.avgTimeToEntry : 'N/A') + ' |');
  lines.push('| TP1 | ' + (stats.avgTimeToTp1 !== null ? stats.avgTimeToTp1 : 'N/A') + ' |');
  lines.push('| TP2 | ' + (stats.avgTimeToTp2 !== null ? stats.avgTimeToTp2 : 'N/A') + ' |');
  lines.push('| SL | ' + (stats.avgTimeToSl !== null ? stats.avgTimeToSl : 'N/A') + ' |');
  lines.push('');
  
  // Observations
  lines.push('## Observations');
  lines.push('');
  for (const obs of stats.observations) {
    lines.push('- ' + obs);
  }
  lines.push('');
  
  lines.push('---');
  lines.push('*This report is generated for analysis purposes only. No production data is modified.*');
  
  return lines.join('\n');
}

// === Write Markdown File ===
function writeMarkdownReport(stats) {
  try {
    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }
    
    const date = new Date().toISOString().split('T')[0];
    const filename = path.join(OUTPUT_DIR, 'outcome-report-' + date + '.md');
    const content = formatMarkdownReport(stats);
    
    fs.writeFileSync(filename, content, 'utf8');
    console.log('Markdown report saved to: ' + filename);
    return filename;
  } catch (e) {
    console.error('Warning: Could not write markdown file:', e.message);
    return null;
  }
}

// === Main ===
async function main() {
  try {
    const picks = await fetchDailyPicks();
    
    if (picks.length === 0) {
      console.log('No data found for the specified period.');
      return;
    }
    
    const stats = generateReport(picks);
    const consoleOutput = formatConsoleReport(stats);
    
    console.log(consoleOutput);
    
    // Write markdown file
    writeMarkdownReport(stats);
    
    console.log('\nReport generation complete.');
    
  } catch (e) {
    console.error('Error generating report:', e.message);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

module.exports = { fetchDailyPicks, generateReport, formatConsoleReport, formatMarkdownReport };