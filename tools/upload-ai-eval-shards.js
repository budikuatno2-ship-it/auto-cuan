'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

function arg(name, fallback) {
  const prefix = '--' + name + '=';
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}
function has(name) { return process.argv.includes('--' + name); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function safeJson(value) { try { return JSON.parse(value); } catch (_) { return null; } }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

async function request(pathname, options) {
  const response = await fetch(SUPABASE_URL + pathname, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      ...(options && options.headers || {})
    }
  });
  const text = await response.text();
  if (!response.ok) throw new Error('Supabase ' + response.status + ': ' + text.slice(0, 500));
  return text ? safeJson(text) || text : null;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map(safeJson).filter(Boolean);
}

function readShardRows(file) {
  const raw = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
  return raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map(safeJson).filter(Boolean);
}

async function existingShards(runId) {
  const rows = await request('/rest/v1/ai_eval_chunks?run_id=eq.' + encodeURIComponent(runId) + '&select=shard_index,sha256', { method: 'GET' });
  return new Map((Array.isArray(rows) ? rows : []).map((row) => [Number(row.shard_index), String(row.sha256)]));
}

async function runStatus(runId) {
  const rows = await request('/rest/v1/ai_eval_runs?id=eq.' + encodeURIComponent(runId) + '&select=status,desired_state', { method: 'GET' });
  return Array.isArray(rows) && rows[0] || null;
}

async function uploadOne(config, manifest) {
  const file = path.join(config.outputDir, manifest.file);
  if (!fs.existsSync(file)) return false;
  const body = fs.readFileSync(file);
  const digest = sha256(body);
  if (digest !== manifest.sha256) throw new Error('SHA256 shard tidak cocok: ' + manifest.file);

  const objectPath = config.runId + '/' + manifest.file;
  await request('/storage/v1/object/' + encodeURIComponent(config.bucket) + '/' + objectPath.split('/').map(encodeURIComponent).join('/'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/gzip', 'x-upsert': 'true' },
    body
  });

  await request('/rest/v1/ai_eval_chunks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      run_id: config.runId,
      shard_index: manifest.shard_index,
      chunk_index: 0,
      object_path: objectPath,
      sha256: manifest.sha256,
      compression: 'gzip',
      row_count: manifest.rows,
      bytes_compressed: manifest.bytes_compressed,
      prompt_tokens: manifest.prompt_tokens,
      completion_tokens: manifest.completion_tokens,
      passed_count: manifest.passed,
      failed_count: manifest.failed
    })
  });

  const rows = readShardRows(file);
  const indexRows = rows.filter((row, index) => !row.eval_pass || index % config.sampleEvery === 0).map((row, index) => ({
    run_id: config.runId,
    case_id: row.id,
    task: row.task,
    intent: row.intent,
    question_hash: row.question_hash,
    object_path: objectPath,
    row_number: index,
    provider_attempts: row.attempts,
    prompt_tokens: row.prompt_tokens,
    completion_tokens: row.completion_tokens,
    eval_pass: Boolean(row.eval_pass),
    eval_score: Number(row.eval_score) || 0,
    error_codes: Array.isArray(row.errors) ? row.errors.slice(0, 12) : [],
    model: row.model,
    completed_at: row.completed_at
  }));
  if (indexRows.length) {
    await request('/rest/v1/ai_eval_case_index', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(indexRows)
    });
  }
  return true;
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY wajib tersedia.');
  const config = {
    runId: String(arg('run-id', process.env.AI_EVAL_RUN_ID || '')).trim(),
    outputDir: path.resolve(arg('output-dir', 'tmp/ai-eval-cloud')),
    bucket: String(arg('storage-bucket', process.env.AI_EVAL_STORAGE_BUCKET || 'ai-eval-private')).trim(),
    sampleEvery: Math.max(1, Math.min(100000, Number(arg('index-sample-every', '100')) || 100)),
    watch: has('watch'),
    doneFile: path.resolve(arg('done-file', 'tmp/ai-eval-cloud/WORKER_DONE'))
  };
  if (!config.runId) throw new Error('--run-id wajib diisi.');

  let idleRounds = 0;
  while (true) {
    const manifests = readJsonl(path.join(config.outputDir, 'manifest.jsonl'));
    const existing = await existingShards(config.runId);
    let uploaded = 0;
    for (const manifest of manifests.sort((a, b) => Number(a.shard_index) - Number(b.shard_index))) {
      const known = existing.get(Number(manifest.shard_index));
      if (known === manifest.sha256) continue;
      await uploadOne(config, manifest);
      existing.set(Number(manifest.shard_index), manifest.sha256);
      uploaded += 1;
      process.stdout.write(JSON.stringify({ uploaded_shard: manifest.shard_index, file: manifest.file }) + '\n');
    }

    if (!config.watch) break;
    idleRounds = uploaded ? 0 : idleRounds + 1;
    const status = await runStatus(config.runId).catch(() => null);
    const workerDone = fs.existsSync(config.doneFile);
    const terminal = status && ['COMPLETED','STOPPED','FAILED','BLOCKED'].includes(status.status);
    if ((workerDone || terminal) && idleRounds >= 2) break;
    await sleep(5000);
  }
  process.stdout.write(JSON.stringify({ success: true, run_id: config.runId }) + '\n');
}

if (require.main === module) {
  main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
}

module.exports = { readJsonl, readShardRows, uploadOne };
