'use strict';

// Reorder configured model pools once per serverless instance.
// The goal is not "bad first", but economical-capable first for simple tasks,
// balanced models first for analysis, and premium models only as fallback.

const CHEAP_CAPABLE = Object.freeze([
  'wz/claude-haiku-4.5',
  'wz/gemini-2.5-flash-lite',
  'wz/gemini-2.5-flash',
  'wz/mimo-v2.5',
  'wz/grok-4.5-low',
  'wz/deepseek-v4-flash',
  'wz/deepseek-chat',
  'wz/gpt-5.4-mini',
  'wz/gpt-5.4-mini-review',
  'wz/kimi-k2.7-code-highspeed'
]);

const BALANCED = Object.freeze([
  'wz/claude-sonnet-4.6',
  'wz/deepseek-v4-pro',
  'wz/claude-fable-5',
  'wz/grok-4.5-medium',
  'wz/grok-4.5-high',
  'wz/gpt-5.6-terra',
  'wz/gpt-5.6-luna',
  'wz/deepseek-reasoner',
  'wz/gemini-2.5-pro',
  'wz/kimi-k3',
  'wz/mimo-v2.5-pro',
  'wz/claude-sonnet-4.5'
]);

const PREMIUM = Object.freeze([
  'wz/gpt-5.6-sol',
  'wz/claude-opus-5',
  'wz/claude-opus-4.5',
  'wz/claude-opus-4.6',
  'wz/claude-opus-4.7',
  'wz/claude-opus-4.8',
  'wz/deepseek-v4-pro-max',
  'wz/gpt-5.5',
  'wz/gpt-5.5-review',
  'wz/gpt-5.4',
  'wz/gpt-5.4-review',
  'wz/grok-4.5'
]);

function split(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function dedupe(rows) {
  const seen = new Set();
  return rows.filter((item) => item && !seen.has(item) && seen.add(item));
}

function reorder(name, preferred) {
  const configured = split(process.env[name]);
  const source = configured.length ? configured : preferred;
  const allowed = new Set(source);
  const front = preferred.filter((model) => allowed.has(model));
  const extras = source.filter((model) => !front.includes(model));
  process.env[name] = dedupe(front.concat(extras)).join(',');
}

// Stock analysis needs a quality floor, so it starts balanced rather than with the cheapest model.
reorder('STOCK_ANALYSIS_AI_MODELS', BALANCED.concat(PREMIUM, CHEAP_CAPABLE));
reorder('PORTFOLIO_AI_HEAVY_MODELS', BALANCED.concat(PREMIUM, CHEAP_CAPABLE));
reorder('PORTFOLIO_AI_EMPATHY_MODELS', [
  'wz/claude-sonnet-4.6',
  'wz/claude-fable-5',
  'wz/gpt-5.6-luna',
  'wz/claude-haiku-4.5',
  'wz/gemini-2.5-flash',
  'wz/grok-4.5-medium',
  'wz/gpt-5.6-sol',
  'wz/claude-opus-5'
].concat(BALANCED, CHEAP_CAPABLE, PREMIUM));
reorder('PORTFOLIO_AI_FAST_MODELS', CHEAP_CAPABLE.concat(BALANCED, PREMIUM));

module.exports = require('./context-ai-router-v4');
