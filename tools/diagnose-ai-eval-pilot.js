'use strict';

require('./openagentic-response-normalizer');

const fs = require('node:fs');
const path = require('node:path');
const cloud = require('./run-ai-eval-cloud');

const ANSWER_MAX_TOKENS = 8192;
const JUDGE_MAX_TOKENS = 2048;

function arg(name, fallback) {
  const prefix = '--' + name + '=';
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(JSON.parse);
}

function extractReply(data) {
  const choice = data && data.choices && data.choices[0];
  const content = choice && choice.message && choice.message.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) return content.map((part) => part && (part.text || part.content) || '').join('').trim();
  return typeof data.output_text === 'string' ? data.output_text.trim() : '';
}

async function providerCall(baseUrl, apiKey, model, messages, maxTokens) {
  const response = await fetch(baseUrl.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + apiKey
    },
    body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: maxTokens })
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); }
  catch (error) { throw new Error('Respons provider bukan JSON: ' + text.slice(0, 500)); }
  if (!response.ok) throw new Error('Provider HTTP ' + response.status + ': ' + text.slice(0, 500));
  return { data, reply: extractReply(data) };
}

async function diagnoseCase(testCase, config) {
  const answerMessages = [
    { role: 'system', content: cloud.answerSystemPrompt(testCase.task) },
    { role: 'user', content: JSON.stringify({ question: testCase.question, context: testCase.context }) }
  ];
  const answerResponse = await providerCall(config.baseUrl, config.apiKey, config.model, answerMessages, ANSWER_MAX_TOKENS);
  const parsedAnswer = cloud.parseJsonReply(answerResponse.reply);
  const deterministic = parsedAnswer ? cloud.deterministicEvaluation(testCase, parsedAnswer) : {
    pass: false,
    score: 0,
    errors: ['answer JSON tidak valid'],
    raw_reply: answerResponse.reply.slice(0, 4000)
  };

  let judge = null;
  if (parsedAnswer && deterministic.pass) {
    const judgeMessages = [
      { role: 'system', content: cloud.judgeSystemPrompt() },
      { role: 'user', content: JSON.stringify({ question: testCase.question, context: testCase.context, expected: testCase.expected, answer: deterministic.normalized }) }
    ];
    const judgeResponse = await providerCall(config.baseUrl, config.apiKey, config.model, judgeMessages, JUDGE_MAX_TOKENS);
    judge = cloud.parseJsonReply(judgeResponse.reply) || {
      pass: false,
      score: 0,
      style_score: 0,
      errors: ['judge JSON tidak valid'],
      raw_reply: judgeResponse.reply.slice(0, 4000)
    };
  }

  return {
    id: testCase.id,
    task: testCase.task,
    intent: testCase.intent,
    question: testCase.question,
    answer_max_tokens: ANSWER_MAX_TOKENS,
    judge_max_tokens: JUDGE_MAX_TOKENS,
    provider_model_reported: answerResponse.data && answerResponse.data.model || null,
    provider_usage: answerResponse.data && answerResponse.data.usage || null,
    answer: parsedAnswer || answerResponse.reply,
    deterministic,
    judge
  };
}

async function main() {
  const dataset = path.resolve(arg('dataset', '/home/ubuntu/auto-cuan-ai-eval/final-pilot/pilot.jsonl'));
  const rows = readJsonl(dataset).slice(0, 2);
  if (!rows.length) throw new Error('Pilot dataset kosong: ' + dataset);

  const config = {
    baseUrl: process.env.AI_EVAL_BASE_URL,
    apiKey: process.env.AI_EVAL_API_KEY,
    model: process.env.AI_EVAL_MODEL || 'claude-sonnet-4.6'
  };
  if (!config.baseUrl || !config.apiKey) throw new Error('AI_EVAL_BASE_URL/API_KEY belum ada.');

  const results = [];
  for (const row of rows) results.push(await diagnoseCase(row, config));
  process.stdout.write(JSON.stringify({
    success: true,
    retry_count: 0,
    transport: 'sse-reassembled',
    answer_max_tokens: ANSWER_MAX_TOKENS,
    judge_max_tokens: JUDGE_MAX_TOKENS,
    results
  }, null, 2) + '\n');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});