#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildRetryDataset } = require('./build-ai-eval-failed-retry-dataset');

const DEFAULT_WORK_DIR = '/home/ubuntu/auto-cuan-ai-eval';
const DEFAULT_GLOBAL_BUDGET = 50000000;
const DEFAULT_RESERVE_TOKENS = 1000000;

function arg(name, fallback) {
  const prefix = '--' + name + '=';
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function boundedInt(value, fallback, min, max) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function safeJson(value) {
  try { return JSON.parse(value); } catch (_) { return null; }
}

function safeWorkPath(workDir, value, suffix) {
  const root = path.resolve(workDir);
  const candidate = path.resolve(String(value || ''));
  if (!candidate.startsWith(root + path.sep)) throw new Error('Path berada di luar AI eval work directory: ' + candidate);
  if (suffix && !candidate.endsWith(suffix)) throw new Error('Path harus berakhiran ' + suffix + ': ' + candidate);
  return candidate;
}

function calculateRetryBudget(globalBudget, usedTokens, reserveTokens) {
  const budget = boundedInt(globalBudget, DEFAULT_GLOBAL_BUDGET, 1000, 1000000000);
  const used = Math.max(0, Number(usedTokens) || 0);
  const reserve = Math.max(0, Number(reserveTokens) || 0);
  const available = Math.floor(budget - used - reserve);
  if (available < 1000) throw new Error('Sisa token setelah cadangan kurang dari 1.000 token.');
  return available;
}

async function request(url, key, pathname, options) {
  const response = await fetch(String(url).replace(/\/+$/, '') + pathname, {
    ...options,
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      ...(options && options.headers || {})
    }
  });
  const text = await response.text();
  if (!response.ok) throw new Error('Supabase ' + response.status + ': ' + text.slice(0, 500));
  return text ? safeJson(text) || text : null;
}

async function fetchRun(url, key, id) {
  const rows = await request(url, key,
    '/rest/v1/ai_eval_runs?id=eq.' + encodeURIComponent(id) + '&select=*',
    { method: 'GET' }
  );
  return Array.isArray(rows) && rows[0] || null;
}

async function fetchRunByName(url, key, name) {
  const rows = await request(url, key,
    '/rest/v1/ai_eval_runs?name=eq.' + encodeURIComponent(name) + '&select=*',
    { method: 'GET' }
  );
  return Array.isArray(rows) && rows[0] || null;
}

function retryRunPayload(source, report, retryDataset, reportFile, reserveTokens) {
  const globalBudget = Number(source.token_budget) || DEFAULT_GLOBAL_BUDGET;
  const retryBudget = calculateRetryBudget(globalBudget, source.tokens_used, reserveTokens);
  return {
    name: 'failed-retry-' + String(source.id) + '-v1',
    desired_state: 'PAUSED',
    status: 'CREATED',
    provider_kind: source.provider_kind || 'openai_compatible',
    model: source.model,
    dataset_manifest_path: retryDataset,
    cases_target: report.output_case_count,
    max_rpm: boundedInt(source.max_rpm, 30, 1, 600),
    concurrency: boundedInt(source.concurrency, 4, 1, 32),
    token_budget: retryBudget,
    config: {
      run_kind: 'failed_retry',
      source_run_id: String(source.id),
      source_run_name: source.name || null,
      source_tokens_used: Number(source.tokens_used) || 0,
      source_failed_cases: Number(source.cases_failed_eval) || 0,
      global_token_budget: globalBudget,
      reserve_tokens: reserveTokens,
      retry_dataset_path: retryDataset,
      retry_dataset_report_path: reportFile,
      retry_dataset_sha256: report.output_sha256,
      retry_case_count: report.output_case_count,
      derived_facts_version: 'AI_EVAL_DERIVED_FACTS_V1',
      max_attempts_per_case: 3,
      answer_evaluation: 'strict_grounding_plus_same_model_judge_every_case',
      retry_scope: 'failed_cases_only'
    }
  };
}

function publicRun(row) {
  return row ? {
    id: row.id,
    name: row.name,
    desired_state: row.desired_state,
    status: row.status,
    model: row.model,
    dataset_manifest_path: row.dataset_manifest_path,
    cases_target: Number(row.cases_target) || 0,
    token_budget: Number(row.token_budget) || 0,
    tokens_used: Number(row.tokens_used) || 0,
    max_rpm: Number(row.max_rpm) || 0,
    concurrency: Number(row.concurrency) || 0,
    created_at: row.created_at || null
  } : null;
}

async function prepare(options) {
  const config = options || {};
  const url = config.supabaseUrl;
  const key = config.supabaseKey;
  const sourceRunId = String(config.sourceRunId || '');
  const workDir = path.resolve(config.workDir || DEFAULT_WORK_DIR);
  if (!url || !key) throw new Error('SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY wajib tersedia.');
  if (!sourceRunId) throw new Error('--source-run-id wajib diisi.');

  const source = await fetchRun(url, key, sourceRunId);
  if (!source) throw new Error('Run sumber tidak ditemukan.');
  if (source.status !== 'COMPLETED') throw new Error('Run sumber harus COMPLETED, status sekarang: ' + source.status);
  if (Number(source.cases_failed_eval) < 1) throw new Error('Run sumber tidak memiliki kasus gagal evaluasi.');

  const datasetGz = safeWorkPath(workDir,
    config.datasetGz || path.join(workDir, 'dataset-complete-v2.jsonl.gz'),
    '.jsonl.gz'
  );
  const rejectionsFile = safeWorkPath(workDir,
    config.rejectionsFile || path.join(workDir, 'output', sourceRunId, 'rejections.jsonl'),
    'rejections.jsonl'
  );
  const retryDir = path.join(workDir, 'retry-datasets');
  const retryDataset = safeWorkPath(workDir,
    config.outputGz || path.join(retryDir, sourceRunId + '-failed-v1.jsonl.gz'),
    '.jsonl.gz'
  );
  const reportFile = safeWorkPath(workDir,
    config.reportFile || retryDataset + '.report.json',
    '.report.json'
  );
  if (!fs.existsSync(datasetGz)) throw new Error('Dataset sumber tidak ditemukan: ' + datasetGz);
  if (!fs.existsSync(rejectionsFile)) throw new Error('Rejections tidak ditemukan: ' + rejectionsFile);

  const report = await buildRetryDataset({ datasetGz, rejectionsFile, outputGz: retryDataset, reportFile });
  if (report.output_case_count !== Number(source.cases_failed_eval)) {
    throw new Error('Jumlah retry case ' + report.output_case_count + ' tidak sama dengan cases_failed_eval ' + source.cases_failed_eval);
  }

  const reserveTokens = boundedInt(config.reserveTokens, DEFAULT_RESERVE_TOKENS, 0, DEFAULT_GLOBAL_BUDGET - 1000);
  const payload = retryRunPayload(source, report, retryDataset, reportFile, reserveTokens);
  const existing = await fetchRunByName(url, key, payload.name);
  if (existing) {
    const sameDataset = existing.dataset_manifest_path === retryDataset;
    const sameCases = Number(existing.cases_target) === report.output_case_count;
    if (!sameDataset || !sameCases) throw new Error('Retry run dengan nama sama sudah ada tetapi konfigurasinya berbeda.');
    return { created: false, run: publicRun(existing), report };
  }

  const rows = await request(url, key, '/rest/v1/ai_eval_runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(payload)
  });
  const row = Array.isArray(rows) && rows[0] || null;
  if (!row) throw new Error('Pembuatan retry run tidak terkonfirmasi.');
  return { created: true, run: publicRun(row), report };
}

async function main() {
  const sourceRunId = arg('source-run-id', '');
  const result = await prepare({
    sourceRunId,
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    workDir: arg('work-dir', DEFAULT_WORK_DIR),
    datasetGz: arg('dataset-gz', ''),
    rejectionsFile: arg('rejections', ''),
    outputGz: arg('output-gz', ''),
    reportFile: arg('report', ''),
    reserveTokens: arg('reserve-tokens', String(DEFAULT_RESERVE_TOKENS))
  });
  process.stdout.write(JSON.stringify({
    success: true,
    provider_called: false,
    retry_started: false,
    ...result
  }, null, 2) + '\n');
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write('FATAL: ' + (error.stack || error.message) + '\n');
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_GLOBAL_BUDGET,
  DEFAULT_RESERVE_TOKENS,
  safeWorkPath,
  calculateRetryBudget,
  retryRunPayload,
  prepare
};
