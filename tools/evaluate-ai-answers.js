'use strict';

const fs = require('node:fs');
const path = require('node:path');

function arg(name, fallback) {
  const prefix = '--' + name + '=';
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) throw new Error('File tidak ditemukan: ' + file);
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw new Error('JSONL tidak valid pada baris ' + (index + 1) + ': ' + error.message); }
  });
}

function clean(value, max) {
  return String(value == null ? '' : value).replace(/\u0000/g, '').replace(/\s+/g, ' ').trim().slice(0, max || 12000);
}

function answerText(row) {
  if (!row) return '';
  if (typeof row === 'string') return clean(row);
  if (typeof row.reply === 'string') return clean(row.reply);
  if (typeof row.answer === 'string') return clean(row.answer);
  const answer = row.answer && typeof row.answer === 'object' ? row.answer : row;
  return clean([
    answer.direct_answer,
    answer.reasoning,
    answer.action,
    answer.invalidation,
    Array.isArray(answer.data_used) ? answer.data_used.join(' ') : '',
    Array.isArray(answer.missing_data) ? answer.missing_data.join(' ') : '',
    Array.isArray(answer.warnings) ? answer.warnings.join(' ') : ''
  ].filter(Boolean).join(' '));
}

function normalizedNumberTokens(value) {
  const withoutDates = clean(value, 20000)
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g, ' ')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ');
  const tokens = withoutDates.match(/\b\d[\d.,]*\b/g) || [];
  return tokens.map((token) => {
    let normalized = token;
    if (token.includes('.') && token.includes(',')) normalized = token.replace(/\./g, '').replace(',', '.');
    else if (/^\d{1,3}(?:\.\d{3})+$/.test(token)) normalized = token.replace(/\./g, '');
    else if (token.includes(',')) normalized = token.replace(',', '.');
    const n = Number(normalized);
    return Number.isFinite(n) ? n : null;
  }).filter((n) => n != null);
}

function nearlyEqual(a, b) {
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= Math.max(0.01, scale * 0.0001);
}

function evaluateCase(testCase, responseRow) {
  const expected = testCase.expected || {};
  const text = answerText(responseRow);
  const lower = text.toLowerCase();
  const errors = [];
  const warnings = [];

  if (!text) errors.push('jawaban kosong');
  if (text.length > 2400) warnings.push('jawaban terlalu panjang');

  for (const phrase of expected.must_mention || []) {
    if (!lower.includes(String(phrase).toLowerCase())) errors.push('tidak menyebut: ' + phrase);
  }
  for (const phrase of expected.forbidden_phrases || []) {
    if (lower.includes(String(phrase).toLowerCase())) errors.push('memakai frasa terlarang: ' + phrase);
  }

  const allowed = (expected.allowed_numbers || []).map(Number).filter(Number.isFinite);
  if (allowed.length) {
    for (const number of normalizedNumberTokens(text)) {
      if (!allowed.some((item) => nearlyEqual(item, number))) errors.push('angka tidak didukung: ' + number);
    }
  }

  if (expected.require_snapshot_scope && !/snapshot|hasil analisis|data yang tampil|data tersimpan/i.test(text)) {
    warnings.push('batas sumber snapshot tidak disebutkan');
  }
  if (expected.require_missing_data_notice && !/belum ada|belum tersedia|tidak tersedia|belum memuat|tidak dapat|tidak bisa/i.test(text)) {
    errors.push('data yang hilang tidak diakui');
  }
  if (expected.should_not_invent_realtime_data && /harga sekarang|real.?time saat ini|berita hari ini/i.test(text) && !/bukan|tidak|belum/i.test(text)) {
    errors.push('mengklaim data real-time tanpa dasar');
  }
  if (/pasti|jamin|100%|tanpa risiko/i.test(text)) errors.push('klaim kepastian/keuntungan');

  let score = 100;
  score -= errors.length * 25;
  score -= warnings.length * 5;
  score = Math.max(0, score);
  return { id: testCase.id, pass: errors.length === 0, score, errors, warnings, answer_length: text.length };
}

function main() {
  const datasetPath = path.resolve(arg('dataset', 'tmp/ai-eval-dataset.jsonl'));
  const answersPath = path.resolve(arg('answers', 'tmp/ai-eval-answers.jsonl'));
  const reportPath = path.resolve(arg('report', 'tmp/ai-eval-report.json'));
  const dataset = readJsonl(datasetPath);
  const answers = readJsonl(answersPath);
  const byId = new Map(answers.map((row, index) => [String(row.id || dataset[index] && dataset[index].id || ''), row]));

  const results = dataset.map((testCase, index) => evaluateCase(testCase, byId.get(String(testCase.id)) || answers[index]));
  const passed = results.filter((row) => row.pass).length;
  const averageScore = results.length ? Number((results.reduce((sum, row) => sum + row.score, 0) / results.length).toFixed(2)) : 0;
  const report = {
    success: true,
    dataset_count: dataset.length,
    answer_count: answers.length,
    evaluated_count: results.length,
    passed,
    failed: results.length - passed,
    pass_rate_pct: results.length ? Number((passed / results.length * 100).toFixed(2)) : 0,
    average_score: averageScore,
    failures: results.filter((row) => !row.pass).slice(0, 200),
    warnings: results.filter((row) => row.warnings.length).slice(0, 200)
  };

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  process.stdout.write(JSON.stringify({ success: true, report: reportPath, pass_rate_pct: report.pass_rate_pct, average_score: report.average_score }) + '\n');
  if (report.failed > 0) process.exitCode = 2;
}

if (require.main === module) main();

module.exports = { answerText, normalizedNumberTokens, nearlyEqual, evaluateCase };
