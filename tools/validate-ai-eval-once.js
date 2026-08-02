'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
function read(file) { return fs.readFileSync(path.join(ROOT, file), 'utf8'); }
function assertOk(value, message) { if (!value) throw new Error('AI eval validation failed: ' + message); }

const scripts = [
  'tools/generate-ai-eval-dataset.js',
  'tools/generate-ai-eval-quality-dataset.js',
  'tools/openagentic-response-normalizer.js',
  'tools/run-ai-eval-cloud.js',
  'tools/upload-ai-eval-shards.js',
  'tools/ai-eval-once-supervisor.js',
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
assertOk(adminApi.includes('const AI_EVAL_TOKEN_BUDGET = 50000000'), 'initial 50M token budget is missing');
assertOk(adminApi.includes('const AI_EVAL_CASE_TARGET = 1000000'), '1M case upper bound is missing');
assertOk(adminApi.includes('const AI_EVAL_RPM = 30'), '30 RPM is missing');
assertOk(adminApi.includes('const AI_EVAL_CONCURRENCY = 4'), 'concurrency 4 is missing');
assertOk(adminApi.includes('requireBudiAdmin(req)'), 'signed budi-only admin protection is missing');
assertOk(!adminApi.includes('AI_EVAL_API_KEY'), 'admin API must never read or expose provider API key');

const launcher = read('tools/run-ai-eval-once.sh');
['--stock-ratio=60', '--rpm=30', '--concurrency=4', '--judge-mode=all'].forEach((token) => {
  assertOk(launcher.includes(token), 'launcher missing ' + token);
});
assertOk(!launcher.includes('--upload'), 'workers must not upload shards concurrently');
assertOk(launcher.includes('tools/upload-ai-eval-shards.js'), 'serialized uploader is missing');
assertOk(launcher.includes('source "$ENV_FILE"'), 'VPS-only env file is not loaded');
assertOk(launcher.includes('WORKER_PID') && launcher.includes('kill "$WORKER_PID"'), 'Stop cannot terminate the worker safely');
assertOk(launcher.includes('generate-ai-eval-quality-dataset.js'), 'quality-first generator is not used');
assertOk(launcher.includes('AI_EVAL_CASE_TARGET="${AI_EVAL_CASE_TARGET:-1000000}"'), '1M upper-bound default is missing');
assertOk(launcher.includes('--count="$AI_EVAL_CASE_TARGET"'), 'case upper bound is not configurable');
assertOk(launcher.includes('AI_EVAL_TOKEN_BUDGET="${AI_EVAL_TOKEN_BUDGET:-50000000}"'), 'initial resumable token budget is missing');
assertOk(launcher.includes('--max-total-tokens="$AI_EVAL_TOKEN_BUDGET"'), 'worker does not use the configured token budget');
assertOk(launcher.includes('openagentic-response-normalizer.js'), 'OpenAgentic response normalizer is not preloaded');

const worker = read('tools/run-ai-eval-cloud.js');
assertOk(worker.includes('retry_until_pass_or_budget_stop'), 'retry-until-pass plan marker is missing');
assertOk(worker.includes("judgeMode: String(arg('judge-mode', 'sample'))"), 'judge mode configuration is missing');
assertOk(worker.includes("compressed_raw_format: 'jsonl.gz'"), 'compressed JSONL output is missing');
assertOk(worker.includes("compressed_summary_format: 'md.gz'"), 'compressed Markdown summary is missing');
assertOk(worker.includes('Gen Z yang natural'), 'Gen Z natural style instruction is missing');
assertOk(worker.includes('TokenBudget'), 'hard token budget guard is missing');
assertOk(worker.includes('StartRateLimiter'), 'RPM guard is missing');

const generator = read('tools/generate-ai-eval-dataset.js');
assertOk(generator.includes('1000000'), 'base generator cannot reach the 1M upper bound');
assertOk(generator.includes("task: 'stock_analysis_followup'"), 'stock analysis cases are missing');
assertOk(generator.includes("task: 'portfolio_chat'"), 'portfolio cases are missing');
assertOk(generator.includes('createGzip'), 'base dataset is not streamed directly to gzip');

const qualityGenerator = read('tools/generate-ai-eval-quality-dataset.js');
assertOk(qualityGenerator.includes('class BloomFilter'), 'memory-bounded duplicate detection is missing');
assertOk(qualityGenerator.includes('quality_variations_exhausted'), 'generator cannot stop when useful variations run out');
assertOk(qualityGenerator.includes('qualityCheck'), 'quality gate is missing');
assertOk(qualityGenerator.includes('createGzip'), 'quality-first dataset is not streamed directly to gzip');

const normalizer = read('tools/openagentic-response-normalizer.js');
assertOk(normalizer.includes('data:\\s*\\[DONE\\]'), 'OpenAgentic DONE trailer handling is missing');
assertOk(normalizer.includes('firstBalancedJson'), 'fallback JSON boundary parser is missing');

const migration = read('supabase/ai-eval-cloud-migration.sql');
assertOk(migration.includes('alter table public.ai_eval_runs enable row level security'), 'run table RLS is missing');
assertOk(migration.includes("values ('ai-eval-private', 'ai-eval-private', false"), 'private storage bucket is missing');
assertOk(migration.includes('ai_eval_runs_name_uidx'), 'one-time run uniqueness is missing');

const service = read('deploy/systemd/auto-cuan-ai-eval-once.service');
assertOk(service.includes('EnvironmentFile=/home/ubuntu/auto-cuan/.env.ai-eval-once'), 'systemd secret env file is missing');
assertOk(service.includes('NoNewPrivileges=true') && service.includes('UMask=0077'), 'systemd hardening is incomplete');

console.log('AI_EVAL_ONCE_VALIDATION=PASS');
