'use strict';

/**
 * AI Narration Module — Gemini API integration for Telegram channel narration.
 *
 * Note-only mode: AI generates a short contextual note (1-3 sentences) that is
 * appended to the deterministic system template. AI does NOT rewrite the full message.
 *
 * Environment variables:
 *   TELEGRAM_AI_NARRATION_ENABLED — must be "true" to enable AI narration (default: disabled)
 *   GEMINI_API_KEY_PRIMARY — Primary Gemini API key
 *   GEMINI_API_KEY_BACKUP — Backup Gemini API key (used on 429/timeout/5xx)
 *   GEMINI_MODEL — Gemini model name (default: gemini-3-flash)
 *   GEMINI_TIMEOUT_MS — Timeout in ms (default: 8000)
 *   GEMINI_NARRATION_CACHE_TTL_MS — Cache TTL (default: 900000 = 15 min)
 *
 * Behavior:
 *   - If disabled, returns { note: null } (caller uses existing template as-is).
 *   - Uses primary key first. On 429/timeout/5xx, tries backup key once.
 *   - If backup fails too, returns { note: null } (fallback to existing template).
 *   - Never blocks sending Telegram notification because AI failed.
 *   - Validates AI note: no fabricated numbers, no hype, short length.
 *   - Uses cache to avoid redundant calls.
 *   - Caller appends note to deterministic template if note is non-null.
 */

const narrationCache = require('./ai-narration-cache');
const narrationValidator = require('./ai-narration-validator');
const narrationPrompts = require('./ai-narration-prompts');

function isNarrationEnabled() {
  return process.env.TELEGRAM_AI_NARRATION_ENABLED === 'true';
}

function isStaleOrExpired(pickOrCandidate, evaluation) {
  if (!pickOrCandidate) return true;
  if (evaluation) {
    const evStatus = String(evaluation.status || '').toUpperCase();
    if (evStatus === 'EXPIRED' || evStatus === 'NEEDS_REVALIDATION' || evStatus === 'INVALID') return true;
  }
  const status = String(pickOrCandidate.status || pickOrCandidate.final_status || '').toUpperCase();
  if (status.indexOf('EXPIRED') >= 0 || status.indexOf('STALE') >= 0 ||
      status.indexOf('INVALID') >= 0 || status.indexOf('NEEDS_REVALIDATION') >= 0) return true;
  if (pickOrCandidate.is_stale === true || pickOrCandidate.data_stale === true ||
      pickOrCandidate.freshness_is_stale === true) return true;
  const raw = pickOrCandidate.raw_payload || pickOrCandidate;
  const freshness = String(raw.setup_freshness_status || '').toUpperCase();
  if (freshness === 'EXPIRED' || freshness === 'NEEDS_REVALIDATION') return true;
  return false;
}

function getModel() {
  return process.env.GEMINI_MODEL || 'gemini-3-flash';
}

function getTimeoutMs() {
  const val = parseInt(process.env.GEMINI_TIMEOUT_MS, 10);
  return isFinite(val) && val > 0 ? val : 8000;
}

async function callGemini(apiKey, systemPrompt, userPrompt) {
  const model = getModel();
  const timeoutMs = getTimeoutMs();
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + apiKey;
  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ parts: [{ text: userPrompt }] }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 150, topP: 0.9 }
  };
  const controller = new AbortController();
  const timer = setTimeout(function() { controller.abort(); }, timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!response.ok) {
      const status = response.status;
      let errMsg = 'HTTP ' + status;
      try { const errBody = await response.text(); if (errBody.length < 300) errMsg += ': ' + errBody; } catch (e) {}
      const err = new Error(errMsg);
      err.status = status;
      err.retryable = status === 429 || status >= 500;
      throw err;
    }
    const result = await response.json();
    const candidates = result.candidates || [];
    if (candidates.length === 0 || !candidates[0].content || !candidates[0].content.parts) throw new Error('empty_response');
    const text = candidates[0].content.parts.map(function(p) { return p.text || ''; }).join('').trim();
    if (!text) throw new Error('empty_text');
    return text;
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === 'AbortError') { const err = new Error('gemini_timeout'); err.retryable = true; throw err; }
    if (!e.retryable && e.message && !e.status) e.retryable = true;
    throw e;
  }
}

/**
 * Generate an AI note for a notification (note-only mode).
 * @param {string} type
 * @param {object} data
 * @param {object} [options]
 * @returns {Promise<{ note: string|null, source: string, error?: string }>}
 */
async function generateNote(type, data, options) {
  if (!isNarrationEnabled()) return { note: null, source: 'fallback', error: 'disabled' };
  const primaryKey = (process.env.GEMINI_API_KEY_PRIMARY || '').trim();
  if (!primaryKey) return { note: null, source: 'fallback', error: 'missing_primary_key' };

  const cacheKey = narrationCache.buildCacheKey({
    type: type, ticker: data.ticker, category: data.category || data.status,
    data: { entry1: data.entry1, entry2: data.entry2, sl: data.sl || data.stop_loss, tp1: data.tp1, tp2: data.tp2, last_price: data.last_price || data.current_price, status: data.status, profit_pct: data.profit_pct }
  });
  const cached = narrationCache.get(cacheKey);
  if (cached) return { note: cached, source: 'cache' };

  const systemPrompt = narrationPrompts.getSystemInstruction();
  const userPrompt = narrationPrompts.buildNotePrompt(type, data);
  let aiText = null, aiError = null;

  try { aiText = await callGemini(primaryKey, systemPrompt, userPrompt); }
  catch (e) {
    aiError = e;
    if (e.retryable) {
      const backupKey = (process.env.GEMINI_API_KEY_BACKUP || '').trim();
      if (backupKey) { try { aiText = await callGemini(backupKey, systemPrompt, userPrompt); aiError = null; } catch (e2) { aiError = e2; } }
    }
  }

  if (!aiText) return { note: null, source: 'fallback', error: aiError ? (aiError.message || 'unknown_error') : 'no_output' };

  const validation = narrationValidator.validateNote(aiText, data, options);
  if (!validation.valid) return { note: null, source: 'fallback', error: 'validation_failed:' + validation.reason, validationDetails: validation };

  narrationCache.set(cacheKey, aiText);
  return { note: aiText, source: 'ai' };
}

async function narrateNewSignal(candidate, mode) {
  if (isStaleOrExpired(candidate)) return { note: null, source: 'fallback', error: 'stale_or_expired' };
  const data = {
    ticker: candidate.ticker,
    status: candidate.status || candidate.final_status || 'Watchlist',
    category: mode === 'daytrade' ? 'Day Trade' : (mode === 'swing_non_konglo' ? 'Swing Non-Konglo' : 'Swing'),
    entry1: candidate.entry1 || candidate.entry_high,
    entry2: candidate.entry2 || candidate.entry_low,
    sl: candidate.sl || candidate.stop_loss, stop_loss: candidate.sl || candidate.stop_loss,
    tp1: candidate.tp1 || candidate.tp1n, tp2: candidate.tp2 || candidate.tp2n,
    last_price: candidate.lastn || candidate.last_price || candidate.current_price,
    current_price: candidate.lastn || candidate.last_price || candidate.current_price,
    risk_reward: candidate.risk_reward,
    score: candidate.score || candidate.daytrade_score,
    grade: candidate.quality_grade || candidate.grade
  };
  return generateNote('new_signal', data);
}

async function narrateMonitorUpdate(pick, evaluation, priceData) {
  const status = (evaluation.status || '').toUpperCase();
  if (isStaleOrExpired(pick, evaluation)) return { note: null, source: 'fallback', error: 'stale_or_expired' };
  let type = 'monitor_update';
  if (status === 'TP1_HIT') type = 'tp1_hit';
  else if (status === 'TP2_HIT') type = 'tp2_hit';
  else if (status === 'SL_HIT') type = 'sl_hit';
  else if (status === 'RUNNING') type = 'running';
  else if (status === 'IN_ENTRY_ZONE') type = 'entry_hit';
  else if (status === 'WATCHLIST' || status === 'ENTRY_READY') type = 'watchlist';

  const entry1 = parseFloat(pick.entry1) || 0;
  const lastPrice = priceData && priceData.last ? priceData.last : 0;
  const tp1 = parseFloat(pick.tp1) || 0;
  let profitPct = null, lossPct = null;
  if (entry1 > 0 && lastPrice > 0) {
    if (status === 'TP1_HIT' || status === 'TP2_HIT') { const tp = status === 'TP2_HIT' ? (parseFloat(pick.tp2) || tp1) : tp1; profitPct = (((tp - entry1) / entry1) * 100).toFixed(2); }
    else if (status === 'SL_HIT') { const sl = parseFloat(pick.sl) || 0; if (sl > 0) lossPct = (((sl - entry1) / entry1) * 100).toFixed(2); }
  }
  const data = {
    ticker: pick.ticker, status: evaluation.status,
    category: (pick.raw_payload && pick.raw_payload.category) || 'Day Trade',
    entry1: pick.entry1, entry2: pick.entry2, sl: pick.sl, stop_loss: pick.sl,
    tp1: pick.tp1, tp2: pick.tp2, last_price: lastPrice, current_price: lastPrice,
    risk_reward: pick.raw_payload && pick.raw_payload.risk_reward,
    note: evaluation.note, profit_pct: profitPct, loss_pct: lossPct
  };
  return generateNote(type, data);
}

/** Legacy wrapper — maps note → text for backward compat */
async function generateNarration(type, data, options) {
  var result = await generateNote(type, data, options);
  return { text: result.note, source: result.source, error: result.error, validationDetails: result.validationDetails };
}

function getNarrationConfigStatus() {
  const primaryKey = (process.env.GEMINI_API_KEY_PRIMARY || '').trim();
  const backupKey = (process.env.GEMINI_API_KEY_BACKUP || '').trim();
  return { enabled: isNarrationEnabled(), has_primary_key: !!primaryKey, has_backup_key: !!backupKey, model: getModel(), timeout_ms: getTimeoutMs(), cache_ttl_ms: narrationCache.getCacheTtlMs(), cache_size: narrationCache.size(), mode: 'note_only' };
}

module.exports = {
  isNarrationEnabled, isStaleOrExpired, generateNote, generateNarration,
  narrateMonitorUpdate, narrateNewSignal, getNarrationConfigStatus,
  callGemini, getModel, getTimeoutMs
};
