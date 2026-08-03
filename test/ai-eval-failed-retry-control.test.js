'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  calculateRetryBudget,
  retryRunPayload
} = require('../tools/prepare-ai-eval-failed-retry');
const {
  transition,
  publicRun
} = require('../tools/control-ai-eval-run');
const {
  safeDatasetPath,
  runtimeEnvForRun,
  desiredStateStopsWorker
} = require('../tools/ai-eval-once-supervisor');

const ROOT = path.join(__dirname, '..');

test('retry budget uses remaining global allowance minus reserve', () => {
  assert.equal(calculateRetryBudget(50000000, 11106406, 1000000), 37893594);
  assert.throws(() => calculateRetryBudget(10000, 9500, 1000), /kurang dari 1\.000/);
});

test('retry run payload is paused, failed-only, and preserves source run', () => {
  const source = {
    id: '4a734576-21a7-4cf6-8590-1cabe78e7804',
    name: 'one-time-ai-data-20260803',
    status: 'COMPLETED',
    model: 'claude-sonnet-4.6',
    provider_kind: 'openai_compatible',
    token_budget: 50000000,
    tokens_used: 11106406,
    cases_failed_eval: 241,
    max_rpm: 30,
    concurrency: 4
  };
  const report = { output_case_count: 241, output_sha256: 'a'.repeat(64) };
  const payload = retryRunPayload(
    source,
    report,
    '/home/ubuntu/auto-cuan-ai-eval/retry-datasets/source-failed-v1.jsonl.gz',
    '/home/ubuntu/auto-cuan-ai-eval/retry-datasets/source-failed-v1.jsonl.gz.report.json',
    1000000
  );
  assert.equal(payload.desired_state, 'PAUSED');
  assert.equal(payload.status, 'CREATED');
  assert.equal(payload.cases_target, 241);
  assert.equal(payload.token_budget, 37893594);
  assert.equal(payload.config.run_kind, 'failed_retry');
  assert.equal(payload.config.retry_scope, 'failed_cases_only');
  assert.equal(payload.config.source_run_id, source.id);
});

test('exact run control cannot restart completed or blocked runs', () => {
  assert.throws(
    () => transition({ status: 'COMPLETED', token_budget: 1000, tokens_used: 0 }, 'start'),
    /COMPLETED/
  );
  assert.throws(
    () => transition({ status: 'BLOCKED', token_budget: 1000, tokens_used: 0 }, 'start'),
    /BLOCKED/
  );
});

test('exact run control starts created retry and pauses running retry', () => {
  const start = transition({
    status: 'CREATED',
    desired_state: 'PAUSED',
    token_budget: 1000000,
    tokens_used: 0,
    last_error: null
  }, 'start');
  assert.equal(start.desired_state, 'RUNNING');
  assert.equal(start.status, 'CREATED');
  assert.equal(start.finished_at, null);

  assert.deepEqual(
    transition({ status: 'RUNNING', desired_state: 'RUNNING' }, 'pause'),
    { desired_state: 'PAUSED' }
  );
});

test('public run output exposes counters but not provider credentials', () => {
  const output = publicRun({
    id: 'retry-id',
    name: 'failed-retry',
    desired_state: 'PAUSED',
    status: 'CREATED',
    token_budget: 10000,
    tokens_used: 2000,
    cases_target: 241,
    config: {
      run_kind: 'failed_retry',
      source_run_id: 'source-id',
      retry_scope: 'failed_cases_only',
      derived_facts_version: 'AI_EVAL_DERIVED_FACTS_V1',
      retry_case_count: 241,
      secret: 'must-not-leak'
    }
  });
  assert.equal(output.tokens_remaining, 8000);
  assert.equal(output.config.retry_case_count, 241);
  assert.equal(Object.prototype.hasOwnProperty.call(output.config, 'secret'), false);
});

test('supervisor accepts only gzip datasets under the private work directory', () => {
  assert.equal(
    safeDatasetPath('/home/ubuntu/auto-cuan-ai-eval/retry-datasets/retry.jsonl.gz'),
    '/home/ubuntu/auto-cuan-ai-eval/retry-datasets/retry.jsonl.gz'
  );
  assert.equal(safeDatasetPath('/tmp/retry.jsonl.gz'), null);
  assert.equal(safeDatasetPath('/home/ubuntu/auto-cuan-ai-eval/retry.json'), null);
});

test('paused and stopped desired states both terminate active workers', () => {
  assert.equal(desiredStateStopsWorker('PAUSED'), true);
  assert.equal(desiredStateStopsWorker('STOPPED'), true);
  assert.equal(desiredStateStopsWorker('RUNNING'), false);
  assert.equal(desiredStateStopsWorker('CREATED'), false);
});

test('supervisor emits run-specific override variables instead of generic env names', () => {
  const env = runtimeEnvForRun({
    id: 'run-id',
    model: 'claude-sonnet-4.6',
    cases_target: 241,
    token_budget: 37893594,
    max_rpm: 30,
    concurrency: 4,
    config: { max_attempts_per_case: 3 }
  });
  assert.equal(env.AI_EVAL_RUN_ID, 'run-id');
  assert.equal(env.AI_EVAL_RUN_MODEL, 'claude-sonnet-4.6');
  assert.equal(env.AI_EVAL_RUN_CASE_TARGET, '241');
  assert.equal(env.AI_EVAL_RUN_TOKEN_BUDGET, '37893594');
  assert.equal(env.AI_EVAL_RUN_RPM, '30');
  assert.equal(env.AI_EVAL_RUN_CONCURRENCY, '4');
  assert.equal(env.AI_EVAL_RUN_MAX_ATTEMPTS_PER_CASE, '3');
  assert.equal(Object.prototype.hasOwnProperty.call(env, 'AI_EVAL_TOKEN_BUDGET'), false);
});

test('launcher prioritizes run-specific settings and refuses to generate a missing retry dataset', () => {
  const source = fs.readFileSync(path.join(ROOT, 'tools/run-ai-eval-once.sh'), 'utf8');
  assert.match(source, /AI_EVAL_RUN_DATASET_GZ:-\$\{AI_EVAL_DATASET_GZ/);
  assert.match(source, /AI_EVAL_RUN_TOKEN_BUDGET:-\$\{AI_EVAL_TOKEN_BUDGET/);
  assert.match(source, /AI_EVAL_RUN_RPM:-\$\{AI_EVAL_RPM/);
  assert.match(source, /AI_EVAL_RUN_CONCURRENCY:-\$\{AI_EVAL_CONCURRENCY/);
  assert.match(source, /AI_EVAL_RUN_DATASET_NOT_FOUND/);
});