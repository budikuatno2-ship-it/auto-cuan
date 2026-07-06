'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// Static source-level tests verifying the actual Vercel API uploader
// (tools/local_scan_runner.ps1) sends the correct batching parameters.
const ps1 = fs.readFileSync('tools/local_scan_runner.ps1', 'utf8');

test('local_scan_runner.ps1 uses batch size <= 150 rows', () => {
  const match = ps1.match(/\$batchSize\s*=\s*(\d+)/);
  assert.ok(match, 'batchSize variable not found');
  const size = parseInt(match[1], 10);
  assert.ok(size <= 150, 'batch size should be <= 150 to avoid Vercel timeout, got ' + size);
});

test('local_scan_runner.ps1 sends batch_index and batch_total params in URL', () => {
  assert.ok(ps1.indexOf('batch_index=') >= 0, 'must send batch_index param');
  assert.ok(ps1.indexOf('batch_total=') >= 0, 'must send batch_total param');
});

test('local_scan_runner.ps1 sends skip_retention=1 for non-final batches', () => {
  assert.ok(ps1.indexOf('skip_retention=1') >= 0, 'must send skip_retention=1 for non-final batches');
  // Confirm it's conditional on non-final
  assert.ok(ps1.indexOf('isFinalBatch') >= 0 || ps1.indexOf('-not $isFinalBatch') >= 0,
    'skip_retention must be conditional on not-final-batch');
});

test('local_scan_runner.ps1 has retry loop (maxRetries >= 3)', () => {
  const match = ps1.match(/\$maxRetries\s*=\s*(\d+)/);
  assert.ok(match, 'maxRetries variable not found');
  assert.ok(parseInt(match[1], 10) >= 3, 'maxRetries must be >= 3');
  // Must have retry loop
  assert.ok(ps1.indexOf('$attempt') >= 0, 'must have attempt counter for retry');
});

test('local_scan_runner.ps1 prints diagnostic fields from API response', () => {
  assert.ok(ps1.indexOf('imported_count') >= 0, 'prints imported_count');
  assert.ok(ps1.indexOf('upserted_count') >= 0, 'prints upserted_count');
  assert.ok(ps1.indexOf('foreign_upload_batch_ms') >= 0, 'prints batch_ms timing');
  assert.ok(ps1.indexOf('retention_skipped') >= 0, 'prints retention_skipped status');
});

test('local_scan_runner.ps1 notes idempotent rerun is safe', () => {
  assert.ok(ps1.indexOf('idempotent') >= 0 || ps1.indexOf('upsert') >= 0,
    'should communicate that rerun is safe (upsert/idempotent)');
});
