'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
function read(file) { return fs.readFileSync(path.join(ROOT, file), 'utf8'); }
function assertOk(value, message) { if (!value) throw new Error('AI eval validation failed: ' + message); }

const scripts = [
  'tools/generate-ai-eval-dataset.js',
  'tools/run-ai-eval-cloud.js',
  'tools/upload-ai-eval-shards.js',
  'tools/ai-eval-once-supervisor.js',
  'tools/build-ai-eval-failed-retry-dataset.js',
  'tools/prepare-ai-eval-failed-retry.js',
  'tools/control-ai-eval-run.js',
  'lib/ai-eval-derived-facts.js',
  'api/admin-users.js',
  'public/admin-tools-runtime.js'
];
for (const file of scripts) new vm.Script(read(file), { filename: file });

const page = read('public/admin-ai-eval.html');
let inlineScripts = 0;
for (const match of page.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
  if (!match[1].trim()) continue;
  inlineScripts += 1;
  new vm.Script(match[1], { filename: 'public/admin-ai-eval.html inline script' });
}
assertOk(inlineScripts === 1, 'phone control page must have exactly one inline script');
assertOk(page.includes("fetch('/api/admin-users'"), 'phone controls must use the existing admin API');
assertOk(page.includes("action:'ai_eval_status'") && page.includes("action:'ai_eval_control'"), 'phone status/control actions are missing');
assertOk(!page.includes('AI_EVAL_API_KEY') && !page.includes('SUPABASE_SERVICE_ROLE_KEY'), 'browser page mentions a secret variable');

const adminApi = read('api/admin-users.js');
assertOk(adminApi.includes("const AI_EVAL_MODEL = 'claude-sonnet-4.6'"), 'model is not pinned');
assertOk(adminApi.includes("const AI_EVAL_BASE_URL = 'https://openagentic.id/api/v1'"), 'base URL is not pinned');
assertOk(adminApi.includes('const AI_EVAL_TOKEN_BUDGET = 50000000'), '50M token budget is missing');
assertOk(adminApi.includes('const AI_EVAL_CASE_TARGET = 1000000'), '1M case target is missing');
assertOk(adminApi.includes('const AI_EVAL_RPM = 30'), '30 RPM is missing');
assertOk(adminApi.includes('const AI_EVAL_CONCURRENCY = 4'), 'concurrency 4 is missing');
assertOk(adminApi.includes('requireBudiAdmin(req)'), 'signed budi-only admin protection is missing');
assertOk(!adminApi.includes('AI_EVAL_API_KEY'), 'admin API must never read or expose provider API key');

const launcher = read('tools/run-ai-eval-once.sh');
assertOk(launcher.includes('--count=1000000'), 'default 1M generation marker is missing');
assertOk(launcher.includes('--stock-ratio=60'), 'stock ratio 60 is missing');
assertOk(launcher.includes('AI_EVAL_RPM="${AI_EVAL_RUN_RPM:-${AI_EVAL_RPM:-30}}"'), 'default/run RPM contract is missing');
assertOk(launcher.includes('AI_EVAL_CONCURRENCY="${AI_EVAL_RUN_CONCURRENCY:-${AI_EVAL_CONCURRENCY:-4}}"'), 'default/run concurrency contract is missing');
assertOk(launcher.includes('AI_EVAL_TOKEN_BUDGET="${AI_EVAL_RUN_TOKEN_BUDGET:-${AI_EVAL_TOKEN_BUDGET:-50000000}}"'), 'default/run token budget contract is missing');
assertOk(launcher.includes('--rpm="$AI_EVAL_RPM"'), 'validated RPM is not passed to worker');
assertOk(launcher.includes('--concurrency="$AI_EVAL_CONCURRENCY"'), 'validated concurrency is not passed to worker');
assertOk(launcher.includes('--max-total-tokens="$AI_EVAL_TOKEN_BUDGET"'), 'validated token budget is not passed to worker');
assertOk(launcher.includes('--judge-mode=all'), 'judge-all mode is missing');
assertOk(!launcher.includes('--upload'), 'workers must not upload shards concurrently');
assertOk(launcher.includes('tools/upload-ai-eval-shards.js'), 'serialized uploader is missing');
assertOk(launcher.includes('source "$ENV_FILE"'), 'VPS-only env file is not loaded');
assertOk(launcher.includes('AI_EVAL_RUN_DATASET_NOT_FOUND'), 'missing retry dataset must fail closed');
assertOk(launcher.includes('WORKER_PID') && launcher.includes('kill "$WORKER_PID"'), 'Stop cannot terminate the worker safely');

const supervisor = read('tools/ai-eval-once-supervisor.js');
assertOk(supervisor.includes('AI_EVAL_RUN_DATASET_GZ'), 'supervisor does not pass retry dataset override');
assertOk(supervisor.includes('AI_EVAL_RUN_TOKEN_BUDGET'), 'supervisor does not pass per-run token budget');
assertOk(supervisor.includes("config.run_kind === 'failed_retry'"), 'failed retry guard is missing');
assertOk(supervisor.includes("status: 'BLOCKED'"), 'invalid retry must become BLOCKED');

const retryBuilder = read('tools/build-ai-eval-failed-retry-dataset.js');
assertOk(retryBuilder.includes('missing_count: 0'), 'failed-only dataset missing-ID invariant is absent');
assertOk(retryBuilder.includes('output_sha256'), 'retry dataset checksum is missing');
const retryPrepare = read('tools/prepare-ai-eval-failed-retry.js');
assertOk(retryPrepare.includes("desired_state: 'PAUSED'"), 'retry run must be prepared paused');
assertOk(retryPrepare.includes("retry_scope: 'failed_cases_only'"), 'failed-only retry scope is missing');
const retryControl = read('tools/control-ai-eval-run.js');
assertOk(retryControl.includes("action === 'start'"), 'exact retry start control is missing');
assertOk(retryControl.includes("status === 'COMPLETED'"), 'completed run restart guard is missing');

const worker = read('tools/run-ai-eval-cloud.js');
assertOk(worker.includes('retry_until_pass_or_budget_stop'), 'retry-until-pass plan marker is missing');
assertOk(worker.includes("judgeMode: String(arg('judge-mode', 'sample'))"), 'judge mode configuration is missing');
assertOk(worker.includes("compressed_raw_format: 'jsonl.gz'"), 'compressed JSONL output is missing');
assertOk(worker.includes("compressed_summary_format: 'md.gz'"), 'compressed Markdown summary is missing');
assertOk(worker.includes('Gen Z yang natural'), 'Gen Z natural style instruction is missing');
assertOk(worker.includes('TokenBudget'), 'hard token budget guard is missing');
assertOk(worker.includes('StartRateLimiter'), 'RPM guard is missing');

const generator = read('tools/generate-ai-eval-dataset.js');
assertOk(generator.includes('1000000'), 'generator cannot reach 1M cases');
assertOk(generator.includes("task: 'stock_analysis_followup'"), 'stock analysis cases are missing');
assertOk(generator.includes("task: 'portfolio_chat'"), 'portfolio cases are missing');
assertOk(generator.includes('createGzip'), 'dataset is not streamed directly to gzip');

const migration = read('supabase/ai-eval-cloud-migration.sql');
assertOk(migration.includes('alter table public.ai_eval_runs enable row level security'), 'run table RLS is missing');
assertOk(migration.includes("values ('ai-eval-private', 'ai-eval-private', false"), 'private storage bucket is missing');
assertOk(migration.includes('ai_eval_runs_name_uidx'), 'one-time run uniqueness is missing');

const service = read('deploy/systemd/auto-cuan-ai-eval-once.service');
assertOk(service.includes('EnvironmentFile=/home/ubuntu/auto-cuan/.env.ai-eval-once'), 'systemd secret env file is missing');
assertOk(service.includes('NoNewPrivileges=true') && service.includes('UMask=0077'), 'systemd hardening is incomplete');

console.log('AI_EVAL_ONCE_VALIDATION=PASS');
