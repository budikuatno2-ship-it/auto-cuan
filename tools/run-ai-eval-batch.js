'use strict';

const fs = require('node:fs');
const path = require('node:path');

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
function readJsonl(file) {
  if (!fs.existsSync(file)) throw new Error('File tidak ditemukan: ' + file);
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map(JSON.parse);
}
function existingIds(file) {
  if (!fs.existsSync(file)) return new Set();
  const ids = new Set();
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { const row = JSON.parse(line); if (row.id) ids.add(String(row.id)); } catch (_) {}
  }
  return ids;
}
function estimateTokens(text) { return Math.max(1, Math.ceil(String(text || '').length / 4)); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function extractReply(data) {
  const choice = data && data.choices && data.choices[0];
  const content = choice && choice.message && choice.message.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) return content.map((part) => part && (part.text || part.content) || '').join('').trim();
  if (typeof data.output_text === 'string') return data.output_text.trim();
  return '';
}
function parseJsonReply(reply) {
  const cleaned = String(reply || '').replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(cleaned); } catch (_) { return null; }
}
function systemPrompt() {
  return [
    'Anda adalah AI evaluasi Auto-Cuan. Jawab hanya berdasarkan snapshot yang diberikan.',
    'Jangan mengarang harga, indikator, berita, probabilitas, atau data real-time.',
    'Jangan memberi perintah BUY/SELL mutlak dan jangan menjanjikan keuntungan.',
    'Keluarkan satu objek JSON valid tanpa markdown dengan field:',
    'direct_answer, data_used(array), reasoning, action, invalidation, confidence(TINGGI/SEDANG/RENDAH/TIDAK_DINILAI),',
    'levels{last,entry_low,entry_high,stop_loss,tp1,tp2}, missing_data(array), warnings(array), source_scope(snapshot).',
    'Jawaban ringkas, alami, profesional, dan langsung menjawab pertanyaan.'
  ].join(' ');
}
async function callProvider(config, testCase) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const userContent = JSON.stringify({ question: testCase.question, context: testCase.context });
  try {
    const response = await fetch(config.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.apiKey },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'system', content: systemPrompt() }, { role: 'user', content: userContent }],
        temperature: 0.2,
        max_tokens: config.maxOutputTokens
      }),
      signal: controller.signal
    });
    const raw = await response.text();
    if (!response.ok) {
      const retriable = response.status === 429 || response.status >= 500;
      return { ok: false, status: response.status, retriable, error: raw.slice(0, 300) };
    }
    let data;
    try { data = JSON.parse(raw); } catch (_) { return { ok: false, status: 502, retriable: true, error: 'Respons provider bukan JSON.' }; }
    const reply = extractReply(data);
    if (!reply) return { ok: false, status: 502, retriable: true, error: 'Jawaban model kosong.' };
    const usage = data.usage && typeof data.usage === 'object' ? data.usage : {};
    return {
      ok: true,
      reply,
      answer: parseJsonReply(reply),
      usage: {
        prompt_tokens: Number(usage.prompt_tokens) || estimateTokens(systemPrompt() + userContent),
        completion_tokens: Number(usage.completion_tokens) || estimateTokens(reply),
        total_tokens: Number(usage.total_tokens) || 0
      }
    };
  } catch (error) {
    return { ok: false, status: error && error.name === 'AbortError' ? 504 : 502, retriable: false, error: error && error.name === 'AbortError' ? 'Timeout.' : String(error && error.message || 'Provider error.') };
  } finally { clearTimeout(timer); }
}

async function main() {
  const datasetPath = path.resolve(arg('dataset', 'tmp/ai-eval-dataset.jsonl'));
  const outputPath = path.resolve(arg('output', 'tmp/ai-eval-answers.jsonl'));
  const limit = boundedInt(arg('limit', '20'), 20, 1, 100000);
  const maxOutputTokens = boundedInt(arg('max-output-tokens', '500'), 500, 80, 4000);
  const maxTotalTokens = boundedInt(arg('max-total-tokens', '20000'), 20000, 1000, 100000000);
  const timeoutMs = boundedInt(arg('timeout-ms', '60000'), 60000, 10000, 120000);
  const model = String(arg('model', process.env.AI_EVAL_MODEL || '')).trim();
  const baseUrl = String(arg('base-url', process.env.AI_EVAL_BASE_URL || '')).trim().replace(/\/+$/, '');
  const apiKey = process.env.AI_EVAL_API_KEY || '';
  const execute = has('execute');
  const dataset = readJsonl(datasetPath);
  const done = existingIds(outputPath);
  const queue = dataset.filter((row) => row && row.id && !done.has(String(row.id))).slice(0, limit);
  const estimatedInputTokens = queue.reduce((sum, row) => sum + estimateTokens(systemPrompt() + JSON.stringify({ question: row.question, context: row.context })), 0);
  const estimatedMaxTokens = estimatedInputTokens + queue.length * maxOutputTokens;

  const plan = { execute, dataset: datasetPath, output: outputPath, queued: queue.length, already_done: done.size, model: model || null, estimated_max_tokens: estimatedMaxTokens, hard_token_budget: maxTotalTokens };
  process.stdout.write(JSON.stringify({ plan }) + '\n');
  if (!execute) return;
  if (!apiKey) throw new Error('AI_EVAL_API_KEY wajib untuk --execute.');
  if (!baseUrl) throw new Error('AI_EVAL_BASE_URL atau --base-url wajib untuk --execute.');
  if (!model) throw new Error('AI_EVAL_MODEL atau --model wajib untuk --execute.');
  if (estimatedMaxTokens > maxTotalTokens) throw new Error('Rencana melewati --max-total-tokens. Turunkan --limit atau --max-output-tokens.');

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  let spent = 0;
  let completed = 0;
  for (const testCase of queue) {
    if (spent >= maxTotalTokens) break;
    let result = await callProvider({ apiKey, baseUrl, model, maxOutputTokens, timeoutMs }, testCase);
    if (!result.ok && result.retriable) {
      await sleep(1500);
      result = await callProvider({ apiKey, baseUrl, model, maxOutputTokens, timeoutMs }, testCase);
    }
    const usage = result.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    const used = usage.total_tokens || usage.prompt_tokens + usage.completion_tokens;
    spent += used;
    const row = {
      id: testCase.id,
      success: result.ok,
      model,
      reply: result.reply || null,
      answer: result.answer || null,
      usage,
      status: result.status || (result.ok ? 200 : 500),
      error: result.ok ? null : result.error,
      evaluated_at: new Date().toISOString()
    };
    fs.appendFileSync(outputPath, JSON.stringify(row) + '\n', 'utf8');
    completed += 1;
    process.stdout.write(JSON.stringify({ progress: completed, total: queue.length, id: testCase.id, success: result.ok, spent_tokens: spent }) + '\n');
    if (!result.ok && !result.retriable) continue;
  }
  process.stdout.write(JSON.stringify({ success: true, completed, spent_tokens: spent, output: outputPath }) + '\n');
}

if (require.main === module) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { estimateTokens, extractReply, parseJsonReply, systemPrompt };
