'use strict';

// Reorder configured model pools once per serverless instance.
// The provider exposes a validated /models directory, but that probe can fail
// transiently. In that case stale Vercel env model lists used to stay in front
// of the known-good defaults and could consume the whole bounded attempt budget
// before a healthy route was ever tried. Keep a small, vendor-diverse set of
// recently validated routes at the front while preserving configured extras as
// fallback candidates.

const VERIFIED_BALANCED = Object.freeze([
  'wz/gemini-2.5-flash',
  'wz/claude-sonnet-4.6',
  'wz/gpt-5.6-luna',
  'wz/deepseek-v4-pro',
  'wz/claude-fable-5',
  'wz/gpt-5.6-terra',
  'wz/gpt-5.6-sol'
]);

const VERIFIED_FAST = Object.freeze([
  'wz/gemini-2.5-flash',
  'wz/claude-haiku-4.5',
  'wz/gpt-5.4-mini',
  'wz/gpt-5.6-luna',
  'wz/claude-sonnet-4.6'
]);

const VERIFIED_EMPATHY = Object.freeze([
  'wz/claude-sonnet-4.6',
  'wz/gemini-2.5-flash',
  'wz/claude-fable-5',
  'wz/gpt-5.6-luna',
  'wz/claude-haiku-4.5'
]);

function split(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function dedupe(rows) {
  const seen = new Set();
  return rows.filter((item) => item && !seen.has(item) && seen.add(item));
}

function prioritize(name, preferred) {
  const configured = split(process.env[name]);
  // Always put the validated routes first. Existing env configuration is kept
  // afterwards so an operator's custom route is still available as a fallback.
  process.env[name] = dedupe(preferred.concat(configured)).join(',');
}

// Stock analysis gets a quality-oriented but vendor-diverse order. Portfolio
// heavy analysis uses the same pool. Fast chat starts with Gemini Flash for low
// latency/cost, while empathy keeps Sonnet first for response quality.
prioritize('STOCK_ANALYSIS_AI_MODELS', VERIFIED_BALANCED);
prioritize('PORTFOLIO_AI_HEAVY_MODELS', VERIFIED_BALANCED);
prioritize('PORTFOLIO_AI_EMPATHY_MODELS', VERIFIED_EMPATHY);
prioritize('PORTFOLIO_AI_FAST_MODELS', VERIFIED_FAST);

module.exports = require('./context-ai-router-v4');
