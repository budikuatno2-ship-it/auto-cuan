'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { validateAnswer } = require('../lib/ai-answer-contract');

function arg(name, fallback) {
  const prefix = '--' + name + '=';
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}
function has(name) { return process.argv.includes('--' + name); }
function boundedInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
function boundedFloat(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function estimateTokens(text) { return Math.max(1, Math.ceil(String(text || '').length / 4)); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function safeJson(value) { try { return JSON.parse(value); } catch (_) { return null; } }
function parseJsonReply(reply) {
  const cleaned = String(reply || '').replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
  return safeJson(cleaned);
}
function extractReply(data) {
  const choice = data && data.choices && data.choices[0];
  const content = choice && choice.message && choice.message.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) return content.map((part) => part && (part.text || part.content) || '').join('').trim();
  if (typeof data.output_text === 'string') return data.output_text.trim();
  return '';
}
function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}
function loadCompleted(file) {
  const rows = new Set();
  if (!fs.existsSync(file)) return rows;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) if (line.trim()) rows.add(line.trim());
  return rows;
}

class StartRateLimiter {
  constructor(rpm) {
    this.intervalMs = Math.ceil(60000 / rpm);
    this.nextAt = 0;
    this.chain = Promise.resolve();
  }
  take() {
    const task = this.chain.then(async () => {
      const now = Date.now();
      const wait = Math.max(0, this.nextAt - now);
      if (wait) await sleep(wait);
      this.nextAt = Date.now() + this.intervalMs;
    });
    this.chain = task.catch(() => {});
    return task;
  }
}

class TokenBudget {
  constructor(limit, alreadyUsed) {
    this.limit = limit;
    this.used = alreadyUsed || 0;
    this.reserved = 0;
  }
  reserve(estimated) {
    if (this.used + this.reserved + estimated > this.limit) return false;
    this.reserved += estimated;
    return true;
  }
  settle(estimated, actual) {
    this.reserved = Math.max(0, this.reserved - estimated);
    this.used += Math.max(0, actual || estimated);
  }
  remaining() { return Math.max(0, this.limit - this.used - this.reserved); }
}

function answerSystemPrompt(task) {
  const role = task === 'portfolio_chat'
    ? 'Kamu adalah Asisten AI Portofolio Auto-Cuan. Fokus pada posisi, alokasi, risiko gabungan, dan rencana yang tersimpan.'
    : 'Kamu adalah AI Pendamping Analisis Saham Auto-Cuan. Fokus hanya pada ticker dan snapshot analisis yang sedang dibuka.';
  return [
    role,
    'Gaya bahasa wajib: bahasa Indonesia Gen Z yang natural, santai secukupnya, pakai kata “kamu”, kalimat pendek, langsung ke inti, tetapi tetap profesional dan presisi.',
    'Jangan terdengar seperti dokumen hukum atau robot. Jangan pakai bestie, bro, cuy, lo, lu, gue, gas full, auto cuan, emoji berlebihan, atau bahasa influencer.',
    'Jawab hanya dari snapshot/konteks yang diberikan. Jangan mengarang harga, indikator, berita, probabilitas, atau data real-time.',
    'Jangan memberi perintah BUY/SELL mutlak, menjanjikan keuntungan, atau membuat kepastian arah harga.',
    'Keluarkan tepat satu objek JSON valid tanpa markdown dengan field:',
    'direct_answer, data_used(array), reasoning, action, invalidation, confidence(TINGGI/SEDANG/RENDAH/TIDAK_DINILAI),',
    'levels{last,entry_low,entry_high,stop_loss,tp1,tp2}, missing_data(array), warnings(array), source_scope(snapshot).',
    'direct_answer maksimal 3 kalimat. reasoning maksimal 4 kalimat. Isi null untuk level yang memang tidak tersedia.'
  ].join(' ');
}

function judgeSystemPrompt() {
  return [
    'Kamu adalah evaluator ketat Auto-Cuan.',
    'Nilai jawaban terhadap pertanyaan, konteks, dan aturan sumber data.',
    'Periksa angka karangan, klaim real-time, kepastian keuntungan, ketepatan tindakan, pengakuan data yang kurang, dan gaya Gen Z natural yang tetap profesional.',
    'Gaya bagus itu ringan dan enak dibaca, bukan alay, bukan kaku, tidak memakai bestie/bro/cuy/lo/lu/gue/gas full/auto cuan.',
    'Keluarkan JSON valid tanpa markdown: {"pass":boolean,"score":0-100,"errors":string[],"style_score":0-100,"feedback":string}.'
  ].join(' ');
}

async function providerCall(config, messages, maxTokens) {
  const promptText = messages.map((row) => row.content || '').join('\n');
  const estimated = estimateTokens(promptText) + maxTokens;
  if (!config.budget.reserve(estimated)) return { ok: false, budgetStop: true, error: 'Token budget habis.' };
  await config.limiter.take();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(config.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.apiKey },
      body: JSON.stringify({ model: config.model, messages, temperature: 0.2, max_tokens: maxTokens }),
      signal: controller.signal
    });
    const raw = await response.text();
    let data = safeJson(raw);
    const usage = data && data.usage && typeof data.usage === 'object' ? data.usage : {};
    const promptTokens = Number(usage.prompt_tokens) || estimateTokens(promptText);
    const completionTokens = Number(usage.completion_tokens) || estimateTokens(data ? extractReply(data) : raw);
    const totalTokens = Number(usage.total_tokens) || promptTokens + completionTokens;
    config.budget.settle(estimated, totalTokens);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        terminal: [400, 401, 402, 403, 404, 422].includes(response.status),
        error: String(raw || 'Provider error.').slice(0, 500),
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens }
      };
    }
    const reply = extractReply(data);
    return reply
      ? { ok: true, reply, usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens } }
      : { ok: false, status: 502, terminal: false, error: 'Jawaban model kosong.', usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens } };
  } catch (error) {
    const timedOut = error && error.name === 'AbortError';
    config.budget.settle(estimated, estimateTokens(promptText));
    return { ok: false, status: timedOut ? 504 : 502, terminal: false, error: timedOut ? 'Timeout.' : String(error && error.message || 'Provider error.') };
  } finally {
    clearTimeout(timer);
  }
}

function deterministicEvaluation(testCase, answer) {
  const expected = testCase.expected || {};
  const result = validateAnswer(answer, {
    allowed_numbers: expected.allowed_numbers || [],
    require_snapshot_scope: expected.require_snapshot_scope !== false,
    require_missing_data_notice: Boolean(expected.require_missing_data_notice)
  });
  const combined = [answer && answer.direct_answer, answer && answer.reasoning, answer && answer.action, answer && answer.invalidation].filter(Boolean).join(' ').toLowerCase();
  const errors = result.errors.slice();
  for (const phrase of expected.must_mention || []) if (!combined.includes(String(phrase).toLowerCase())) errors.push('tidak menyebut: ' + phrase);
  for (const phrase of expected.forbidden_phrases || []) if (combined.includes(String(phrase).toLowerCase())) errors.push('frasa terlarang: ' + phrase);
  if (expected.should_not_invent_realtime_data && /harga (real.?time|sekarang)|berita (hari ini|terbaru)/i.test(combined) && !/tidak|belum|bukan/i.test(combined)) errors.push('mengklaim data real-time');
  const stiff = /berdasarkan pemaparan tersebut|dengan demikian|oleh karena itu dapat disimpulkan|sehubungan dengan/i.test(combined);
  const cringe = /bestie|\bbro\b|\bcuy\b|\blo\b|\blu\b|\bgue\b|gas full|auto cuan/i.test(combined);
  if (stiff) result.warnings.push('gaya terlalu kaku');
  if (cringe) errors.push('gaya Gen Z berlebihan/cringe');
  const score = Math.max(0, 100 - errors.length * 25 - result.warnings.length * 5);
  return { pass: errors.length === 0, score, errors, warnings: result.warnings, normalized: result.answer };
}

async function modelJudge(config, testCase, answer) {
  const messages = [
    { role: 'system', content: judgeSystemPrompt() },
    { role: 'user', content: JSON.stringify({ question: testCase.question, context: testCase.context, expected: testCase.expected, answer }) }
  ];
  const response = await providerCall(config, messages, config.judgeMaxTokens);
  if (!response.ok) return { pass: false, unavailable: true, score: 0, errors: [response.error || 'judge gagal'], feedback: response.error || 'Judge gagal.', usage: response.usage };
  const parsed = parseJsonReply(response.reply);
  if (!parsed || typeof parsed.pass !== 'boolean') return { pass: false, unavailable: true, score: 0, errors: ['format judge tidak valid'], feedback: 'Keluarkan JSON judge yang valid.', usage: response.usage };
  return {
    pass: parsed.pass === true && Number(parsed.score) >= config.minJudgeScore && Number(parsed.style_score) >= config.minStyleScore,
    score: Number(parsed.score) || 0,
    style_score: Number(parsed.style_score) || 0,
    errors: Array.isArray(parsed.errors) ? parsed.errors.slice(0, 8).map(String) : [],
    feedback: String(parsed.feedback || '').slice(0, 700),
    usage: response.usage
  };
}

function shouldJudge(config, testCase) {
  if (config.judgeMode === 'all') return true;
  if (config.judgeMode === 'off') return false;
  const fraction = parseInt(sha256(testCase.id).slice(0, 8), 16) / 0xffffffff;
  return fraction < config.judgeSampleRate;
}

class ShardWriter {
  constructor(config, state) {
    this.config = config;
    this.state = state;
    this.rows = [];
    this.shardIndex = state.nextShard || 0;
    fs.mkdirSync(config.outputDir, { recursive: true });
  }
  async add(row) {
    this.rows.push(row);
    if (this.rows.length >= this.config.shardRows) await this.flush();
  }
  async flush() {
    if (!this.rows.length) return;
    const lines = this.rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
    const gz = zlib.gzipSync(Buffer.from(lines), { level: 9 });
    const name = 'results-' + String(this.shardIndex).padStart(6, '0') + '.jsonl.gz';
    const file = path.join(this.config.outputDir, name);
    fs.writeFileSync(file, gz);
    const digest = sha256(gz);
    const passed = this.rows.filter((row) => row.eval_pass).length;
    const manifest = {
      shard_index: this.shardIndex,
      file: name,
      sha256: digest,
      rows: this.rows.length,
      bytes_compressed: gz.length,
      prompt_tokens: this.rows.reduce((sum, row) => sum + Number(row.prompt_tokens || 0), 0),
      completion_tokens: this.rows.reduce((sum, row) => sum + Number(row.completion_tokens || 0), 0),
      passed,
      failed: this.rows.length - passed,
      created_at: new Date().toISOString()
    };
    fs.appendFileSync(this.config.manifestFile, JSON.stringify(manifest) + '\n', 'utf8');
    if (this.config.upload) await uploadShard(this.config, file, manifest, this.rows);
    this.shardIndex += 1;
    this.state.nextShard = this.shardIndex;
    this.rows = [];
    saveState(this.config, this.state);
  }
}

async function supabaseRequest(config, pathname, options) {
  if (!config.supabaseUrl || !config.supabaseKey) return null;
  const response = await fetch(config.supabaseUrl.replace(/\/+$/, '') + pathname, {
    ...options,
    headers: {
      apikey: config.supabaseKey,
      Authorization: 'Bearer ' + config.supabaseKey,
      ...(options && options.headers || {})
    }
  });
  const text = await response.text();
  if (!response.ok) throw new Error('Supabase ' + response.status + ': ' + text.slice(0, 400));
  return text ? safeJson(text) || text : null;
}

async function uploadShard(config, file, manifest, rows) {
  if (!config.supabaseUrl || !config.supabaseKey || !config.storageBucket || !config.runId) return;
  const objectPath = config.runId + '/' + path.basename(file);
  const body = fs.readFileSync(file);
  await supabaseRequest(config, '/storage/v1/object/' + encodeURIComponent(config.storageBucket) + '/' + objectPath.split('/').map(encodeURIComponent).join('/'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/gzip', 'x-upsert': 'true' },
    body
  });
  await supabaseRequest(config, '/rest/v1/ai_eval_chunks', {
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
  const indexRows = rows.filter((row, idx) => !row.eval_pass || idx % config.indexSampleEvery === 0).map((row, idx) => ({
    run_id: config.runId,
    case_id: row.id,
    task: row.task,
    intent: row.intent,
    question_hash: row.question_hash,
    object_path: objectPath,
    row_number: idx,
    provider_attempts: row.attempts,
    prompt_tokens: row.prompt_tokens,
    completion_tokens: row.completion_tokens,
    eval_pass: row.eval_pass,
    eval_score: row.eval_score,
    error_codes: row.errors,
    model: config.model,
    completed_at: row.completed_at
  }));
  if (indexRows.length) await supabaseRequest(config, '/rest/v1/ai_eval_case_index', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(indexRows)
  });
}

function saveState(config, state) {
  state.tokensUsed = config.budget.used;
  state.updatedAt = new Date().toISOString();
  atomicWrite(config.stateFile, JSON.stringify(state, null, 2) + '\n');
}

async function updateRunStatus(config, state, status, error) {
  state.status = status;
  if (error) state.lastError = String(error).slice(0, 1000);
  saveState(config, state);
  if (!config.runId || !config.supabaseUrl || !config.supabaseKey) return;
  await supabaseRequest(config, '/rest/v1/ai_eval_runs?id=eq.' + encodeURIComponent(config.runId), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({
      status,
      tokens_used: config.budget.used,
      cases_attempted: state.casesAttempted,
      cases_completed: state.casesCompleted,
      cases_passed: state.casesPassed,
      cases_failed_eval: state.casesFailedEval,
      provider_failures: state.providerFailures,
      retries: state.retries,
      current_shard: state.nextShard,
      current_case_index: state.casesCompleted,
      last_error: error ? String(error).slice(0, 1000) : null,
      last_heartbeat_at: new Date().toISOString(),
      started_at: state.startedAt,
      finished_at: ['STOPPED','COMPLETED','FAILED','BLOCKED'].includes(status) ? new Date().toISOString() : null
    })
  });
}

async function desiredState(config) {
  if (config.stopFile && fs.existsSync(config.stopFile)) return 'STOPPED';
  if (!config.runId || !config.supabaseUrl || !config.supabaseKey) return 'RUNNING';
  try {
    const rows = await supabaseRequest(config, '/rest/v1/ai_eval_runs?id=eq.' + encodeURIComponent(config.runId) + '&select=desired_state', { method: 'GET' });
    return Array.isArray(rows) && rows[0] && rows[0].desired_state || 'RUNNING';
  } catch (_) {
    return 'RUNNING';
  }
}

async function answerUntilPass(config, state, testCase) {
  let feedback = '';
  let attempts = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  while (config.budget.remaining() > config.maxOutputTokens + 100) {
    attempts += 1;
    state.casesAttempted += 1;
    if (attempts > 1) state.retries += 1;
    const messages = [
      { role: 'system', content: answerSystemPrompt(testCase.task) },
      { role: 'user', content: JSON.stringify({ question: testCase.question, context: testCase.context, correction_feedback: feedback || undefined }) }
    ];
    const response = await providerCall(config, messages, config.maxOutputTokens);
    promptTokens += Number(response.usage && response.usage.prompt_tokens || 0);
    completionTokens += Number(response.usage && response.usage.completion_tokens || 0);
    if (response.budgetStop) return { budgetStop: true };
    if (!response.ok) {
      state.providerFailures += 1;
      if (response.terminal) return { terminal: true, error: response.error, status: response.status };
      feedback = 'Request sebelumnya gagal: ' + response.error + '. Coba lagi dan tetap keluarkan JSON valid.';
      await sleep(Math.min(60000, 1500 * Math.pow(2, Math.min(attempts - 1, 5))));
      continue;
    }
    const parsed = parseJsonReply(response.reply);
    if (!parsed) {
      feedback = 'Jawaban sebelumnya bukan JSON valid. Keluarkan hanya satu objek JSON sesuai kontrak.';
      continue;
    }
    const deterministic = deterministicEvaluation(testCase, parsed);
    if (!deterministic.pass) {
      feedback = 'Evaluator menolak jawaban sebelumnya. Perbaiki tanpa mengarang data. Masalah: ' + deterministic.errors.join('; ');
      continue;
    }
    let judge = null;
    if (shouldJudge(config, testCase)) {
      judge = await modelJudge(config, testCase, deterministic.normalized);
      promptTokens += Number(judge.usage && judge.usage.prompt_tokens || 0);
      completionTokens += Number(judge.usage && judge.usage.completion_tokens || 0);
      if (!judge.pass) {
        feedback = 'Judge menolak jawaban sebelumnya. Perbaiki isi dan gaya. Feedback: ' + (judge.feedback || judge.errors.join('; '));
        continue;
      }
    }
    return {
      ok: true,
      answer: deterministic.normalized,
      deterministic,
      judge,
      attempts,
      promptTokens,
      completionTokens
    };
  }
  return { budgetStop: true };
}

function makeSummary(config, state) {
  const rate = state.casesCompleted ? (state.casesPassed / state.casesCompleted * 100).toFixed(2) : '0.00';
  return [
    '# Auto-Cuan AI Evaluation Summary',
    '',
    '- Model: `' + config.model + '`',
    '- RPM: ' + config.rpm,
    '- Concurrency: ' + config.concurrency,
    '- Token budget: ' + config.tokenBudget.toLocaleString('en-US'),
    '- Tokens used: ' + config.budget.used.toLocaleString('en-US'),
    '- Cases completed: ' + state.casesCompleted.toLocaleString('en-US'),
    '- Cases passed: ' + state.casesPassed.toLocaleString('en-US'),
    '- Final pass rate: ' + rate + '%',
    '- Provider failures: ' + state.providerFailures.toLocaleString('en-US'),
    '- Retries: ' + state.retries.toLocaleString('en-US'),
    '- Status: ' + state.status,
    '',
    'Raw results are stored in compressed JSONL shards. This Markdown file is only the human-readable audit summary.'
  ].join('\n') + '\n';
}

async function main() {
  const outputDir = path.resolve(arg('output-dir', 'tmp/ai-eval-cloud'));
  const stateFile = path.resolve(arg('state-file', path.join(outputDir, 'state.json')));
  const previous = fs.existsSync(stateFile) ? safeJson(fs.readFileSync(stateFile, 'utf8')) || {} : {};
  const config = {
    execute: has('execute'),
    dataset: path.resolve(arg('dataset', 'tmp/ai-eval-dataset.jsonl')),
    outputDir,
    stateFile,
    manifestFile: path.join(outputDir, 'manifest.jsonl'),
    completedFile: path.join(outputDir, 'completed.ids'),
    stopFile: path.resolve(arg('stop-file', path.join(outputDir, 'STOP'))),
    baseUrl: String(arg('base-url', process.env.AI_EVAL_BASE_URL || '')).trim().replace(/\/+$/, ''),
    apiKey: process.env.AI_EVAL_API_KEY || '',
    model: String(arg('model', process.env.AI_EVAL_MODEL || '')).trim(),
    rpm: boundedInt(arg('rpm', '30'), 30, 1, 600),
    concurrency: boundedInt(arg('concurrency', '4'), 4, 1, 32),
    tokenBudget: boundedInt(arg('max-total-tokens', '50000000'), 50000000, 1000, 1000000000),
    maxOutputTokens: boundedInt(arg('max-output-tokens', '380'), 380, 80, 2000),
    judgeMaxTokens: boundedInt(arg('judge-max-tokens', '220'), 220, 80, 1000),
    timeoutMs: boundedInt(arg('timeout-ms', '90000'), 90000, 10000, 180000),
    shardRows: boundedInt(arg('shard-rows', '250'), 250, 25, 5000),
    judgeMode: String(arg('judge-mode', 'sample')).toLowerCase(),
    judgeSampleRate: boundedFloat(arg('judge-sample-rate', '0.1'), 0.1, 0, 1),
    minJudgeScore: boundedInt(arg('min-judge-score', '85'), 85, 1, 100),
    minStyleScore: boundedInt(arg('min-style-score', '80'), 80, 1, 100),
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    runId: String(arg('run-id', process.env.AI_EVAL_RUN_ID || '')).trim(),
    storageBucket: String(arg('storage-bucket', process.env.AI_EVAL_STORAGE_BUCKET || 'ai-eval-private')).trim(),
    upload: has('upload'),
    indexSampleEvery: boundedInt(arg('index-sample-every', '100'), 100, 1, 100000)
  };
  if (!['all','sample','off'].includes(config.judgeMode)) throw new Error('--judge-mode harus all, sample, atau off.');
  config.limiter = new StartRateLimiter(config.rpm);
  config.budget = new TokenBudget(config.tokenBudget, Number(previous.tokensUsed) || 0);

  const plan = {
    execute: config.execute,
    dataset: config.dataset,
    output_dir: config.outputDir,
    model: config.model || null,
    rpm: config.rpm,
    concurrency: config.concurrency,
    token_budget: config.tokenBudget,
    tokens_already_used: config.budget.used,
    retry_until_pass_or_budget_stop: true,
    judge_mode: config.judgeMode,
    judge_sample_rate: config.judgeSampleRate,
    compressed_raw_format: 'jsonl.gz',
    compressed_summary_format: 'md.gz',
    cloud_upload: config.upload
  };
  process.stdout.write(JSON.stringify({ plan }) + '\n');
  if (!config.execute) return;
  if (!config.apiKey || !config.baseUrl || !config.model) throw new Error('AI_EVAL_API_KEY, AI_EVAL_BASE_URL, dan AI_EVAL_MODEL wajib untuk --execute.');
  if (!fs.existsSync(config.dataset)) throw new Error('Dataset tidak ditemukan: ' + config.dataset);

  fs.mkdirSync(config.outputDir, { recursive: true });
  const completed = loadCompleted(config.completedFile);
  const state = {
    status: 'STARTING',
    startedAt: previous.startedAt || new Date().toISOString(),
    casesAttempted: Number(previous.casesAttempted) || 0,
    casesCompleted: Number(previous.casesCompleted) || completed.size,
    casesPassed: Number(previous.casesPassed) || completed.size,
    casesFailedEval: Number(previous.casesFailedEval) || 0,
    providerFailures: Number(previous.providerFailures) || 0,
    retries: Number(previous.retries) || 0,
    nextShard: Number(previous.nextShard) || 0,
    tokensUsed: config.budget.used
  };
  const writer = new ShardWriter(config, state);
  await updateRunStatus(config, state, 'RUNNING');

  const input = fs.createReadStream(config.dataset, 'utf8');
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const queue = [];
  const waitForWork = [];
  let feederDone = false;
  let stopped = false;
  let terminalError = null;

  function pushWork(item) {
    if (waitForWork.length) waitForWork.shift()(item);
    else queue.push(item);
  }
  async function getWork() {
    if (queue.length) return queue.shift();
    if (feederDone) return null;
    return new Promise((resolve) => waitForWork.push(resolve));
  }

  const feeder = (async () => {
    for await (const line of lines) {
      if (stopped) break;
      if (!line.trim()) continue;
      const testCase = safeJson(line);
      if (!testCase || !testCase.id || completed.has(String(testCase.id))) continue;
      while (queue.length >= config.concurrency * 3 && !stopped) await sleep(100);
      pushWork(testCase);
    }
    feederDone = true;
    while (waitForWork.length) waitForWork.shift()(null);
  })();

  let controlCheckedAt = 0;
  async function checkControl() {
    if (Date.now() - controlCheckedAt < 10000) return 'RUNNING';
    controlCheckedAt = Date.now();
    return desiredState(config);
  }

  async function worker(workerId) {
    while (!stopped) {
      const control = await checkControl();
      if (control === 'STOPPED') { stopped = true; break; }
      if (control === 'PAUSED') {
        await updateRunStatus(config, state, 'PAUSED');
        while (!stopped && await desiredState(config) === 'PAUSED') await sleep(10000);
        if (!stopped) await updateRunStatus(config, state, 'RUNNING');
      }
      const testCase = await getWork();
      if (!testCase) break;
      const result = await answerUntilPass(config, state, testCase);
      if (result.terminal) {
        terminalError = 'Provider terminal ' + result.status + ': ' + result.error;
        stopped = true;
        break;
      }
      if (result.budgetStop) { stopped = true; break; }
      const errors = (result.deterministic.errors || []).concat(result.judge && result.judge.errors || []).slice(0, 12);
      const score = result.judge ? Math.min(result.deterministic.score, result.judge.score) : result.deterministic.score;
      const row = {
        id: testCase.id,
        task: testCase.task,
        intent: testCase.intent,
        question_hash: sha256(testCase.question),
        question: testCase.question,
        context: testCase.context,
        answer: result.answer,
        eval_pass: true,
        eval_score: score,
        style_score: result.judge ? result.judge.style_score : null,
        judge_used: Boolean(result.judge),
        attempts: result.attempts,
        prompt_tokens: result.promptTokens,
        completion_tokens: result.completionTokens,
        errors,
        worker_id: workerId,
        model: config.model,
        completed_at: new Date().toISOString()
      };
      await writer.add(row);
      completed.add(String(testCase.id));
      fs.appendFileSync(config.completedFile, String(testCase.id) + '\n', 'utf8');
      state.casesCompleted += 1;
      state.casesPassed += 1;
      if (state.casesCompleted % 10 === 0) {
        saveState(config, state);
        process.stdout.write(JSON.stringify({ progress: state.casesCompleted, tokens_used: config.budget.used, retries: state.retries, queue: queue.length }) + '\n');
      }
      if (state.casesCompleted % 100 === 0) await updateRunStatus(config, state, 'RUNNING');
    }
  }

  const workers = Array.from({ length: config.concurrency }, (_, index) => worker(index + 1));
  try {
    await Promise.all([feeder, ...workers]);
    await writer.flush();
    const status = terminalError ? 'BLOCKED' : (config.budget.remaining() <= config.maxOutputTokens + 100 ? 'STOPPED' : (stopped ? 'STOPPED' : 'COMPLETED'));
    await updateRunStatus(config, state, status, terminalError);
    const summary = makeSummary(config, state);
    fs.writeFileSync(path.join(config.outputDir, 'summary.md.gz'), zlib.gzipSync(Buffer.from(summary), { level: 9 }));
    process.stdout.write(JSON.stringify({ success: !terminalError, status, cases_completed: state.casesCompleted, tokens_used: config.budget.used, output_dir: config.outputDir }) + '\n');
    if (terminalError) process.exitCode = 2;
  } catch (error) {
    await writer.flush().catch(() => {});
    await updateRunStatus(config, state, 'FAILED', error.message).catch(() => {});
    throw error;
  }
}

if (require.main === module) {
  main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
}

module.exports = {
  StartRateLimiter,
  TokenBudget,
  answerSystemPrompt,
  judgeSystemPrompt,
  deterministicEvaluation,
  parseJsonReply,
  estimateTokens,
  shouldJudge
};
