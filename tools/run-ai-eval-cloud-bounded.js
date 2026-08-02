'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(__dirname, 'run-ai-eval-cloud.js');
const NORMALIZER = path.join(__dirname, 'openagentic-response-normalizer.js');
const TEMP = path.join(__dirname, '.run-ai-eval-cloud-bounded-' + process.pid + '.js');

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error('Patch guard gagal untuk ' + label + ': ditemukan ' + count);
  return source.replace(needle, replacement);
}

function buildPatchedSource() {
  let source = fs.readFileSync(SOURCE, 'utf8');

  source = replaceOnce(
    source,
    "  while (config.budget.remaining() > config.maxOutputTokens + 100) {",
    "  let lastFailure = null;\n  while (config.budget.remaining() > config.maxOutputTokens + 100 && attempts < config.maxAttemptsPerCase) {",
    'bounded answer loop'
  );

  source = replaceOnce(
    source,
    "      feedback = 'Request sebelumnya gagal: ' + response.error + '. Coba lagi dan tetap keluarkan JSON valid.';",
    "      lastFailure = { stage: 'provider', errors: [String(response.error || 'provider gagal')], feedback: String(response.error || '') };\n      feedback = 'Request sebelumnya gagal: ' + response.error + '. Coba lagi dan tetap keluarkan JSON valid.';",
    'provider rejection capture'
  );

  source = replaceOnce(
    source,
    "      feedback = 'Jawaban sebelumnya bukan JSON valid. Keluarkan hanya satu objek JSON sesuai kontrak.';",
    "      lastFailure = { stage: 'answer_json', errors: ['jawaban bukan JSON valid'], feedback: String(response.reply || '').slice(0, 1200) };\n      feedback = 'Jawaban sebelumnya bukan JSON valid. Keluarkan hanya satu objek JSON sesuai kontrak.';",
    'JSON rejection capture'
  );

  source = replaceOnce(
    source,
    "      feedback = 'Evaluator menolak jawaban sebelumnya. Perbaiki tanpa mengarang data. Masalah: ' + deterministic.errors.join('; ');",
    "      lastFailure = { stage: 'deterministic', errors: deterministic.errors.slice(0, 12), warnings: deterministic.warnings.slice(0, 12), answer: deterministic.normalized };\n      feedback = 'Evaluator menolak jawaban sebelumnya. Perbaiki tanpa mengarang data. Masalah: ' + deterministic.errors.join('; ');",
    'deterministic rejection capture'
  );

  source = replaceOnce(
    source,
    "        feedback = 'Judge menolak jawaban sebelumnya. Perbaiki isi dan gaya. Feedback: ' + (judge.feedback || judge.errors.join('; '));",
    "        lastFailure = { stage: 'judge', errors: judge.errors.slice(0, 12), score: judge.score, style_score: judge.style_score, feedback: judge.feedback, answer: deterministic.normalized };\n        feedback = 'Judge menolak jawaban sebelumnya. Perbaiki isi dan gaya. Feedback: ' + (judge.feedback || judge.errors.join('; '));",
    'judge rejection capture'
  );

  source = replaceOnce(
    source,
    "  return { budgetStop: true };\n}\n\nfunction makeSummary",
    "  if (attempts >= config.maxAttemptsPerCase) {\n    return { exhausted: true, attempts, promptTokens, completionTokens, failure: lastFailure || { stage: 'unknown', errors: ['batas percobaan tercapai'] } };\n  }\n  return { budgetStop: true };\n}\n\nfunction makeSummary",
    'bounded loop result'
  );

  source = replaceOnce(
    source,
    "    maxOutputTokens: boundedInt(arg('max-output-tokens', '380'), 380, 80, 2000),",
    "    maxOutputTokens: boundedInt(arg('max-output-tokens', '380'), 380, 80, 2000),\n    maxAttemptsPerCase: boundedInt(arg('max-attempts-per-case', '3'), 3, 1, 10),",
    'max attempts config'
  );

  source = replaceOnce(
    source,
    "    retry_until_pass_or_budget_stop: true,",
    "    retry_until_pass_or_budget_stop: false,\n    max_attempts_per_case: config.maxAttemptsPerCase,\n    rejected_cases_file: path.join(config.outputDir, 'rejections.jsonl'),",
    'plan metadata'
  );

  source = replaceOnce(
    source,
    "      if (result.budgetStop) { stopped = true; break; }\n      const errors =",
    "      if (result.budgetStop) { stopped = true; break; }\n      if (result.exhausted) {\n        const rejection = {\n          id: testCase.id,\n          task: testCase.task,\n          intent: testCase.intent,\n          question: testCase.question,\n          attempts: result.attempts,\n          prompt_tokens: result.promptTokens,\n          completion_tokens: result.completionTokens,\n          failure: result.failure,\n          completed_at: new Date().toISOString()\n        };\n        fs.appendFileSync(path.join(config.outputDir, 'rejections.jsonl'), JSON.stringify(rejection) + '\\n', 'utf8');\n        completed.add(String(testCase.id));\n        fs.appendFileSync(config.completedFile, String(testCase.id) + '\\n', 'utf8');\n        state.casesCompleted += 1;\n        state.casesFailedEval += 1;\n        process.stdout.write(JSON.stringify({ rejected_case: testCase.id, attempts: result.attempts, failure: result.failure }) + '\\n');\n        continue;\n      }\n      const errors =",
    'failed case persistence'
  );

  return source;
}

async function main() {
  fs.writeFileSync(TEMP, buildPatchedSource(), { mode: 0o600 });
  const args = ['--require', NORMALIZER, TEMP].concat(process.argv.slice(2));
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit'
  });

  const forward = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.once('SIGINT', () => forward('SIGINT'));
  process.once('SIGTERM', () => forward('SIGTERM'));

  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => resolve(signal ? 1 : (exitCode || 0)));
  });
  process.exitCode = code;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(() => {
  try { fs.unlinkSync(TEMP); } catch (_) {}
});
