'use strict';

/**
 * AI Narration Module — Gemini API integration for Telegram channel narration.
 *
 * Phase 1: AI-assisted copywriting for channel notifications only.
 * AI is only a copywriter/narrator — it must NOT calculate, change, invent, or decide any trading data.
 *
 * Environment variables:
 *   TELEGRAM_AI_NARRATION_ENABLED — must be "true" to enable AI narration (default: disabled)
 *   GEMINI_API_KEY_PRIMARY — Primary Gemini API key
 *   GEMINI_API_KEY_BACKUP — Backup Gemini API key (used on 429/timeout/5xx)
 *   GEMINI_MODEL — Gemini model name (default: gemini-2.0-flash)
 *   GEMINI_TIMEOUT_MS — Timeout in ms (default: 8000)
 *   GEMINI_NARRATION_CACHE_TTL_MS — Cache TTL (default: 900000 = 15 min)
 *
 * Behavior:
 *   - If disabled, returns null (caller uses existing template).
 *   - Uses primary key first. On 429/timeout/5xx, tries backup key once.
 *   - If backup fails too, returns null (fallback to existing template).
 *   - Never blocks sending Telegram notification because AI failed.
 *   - Validates AI output preserves all required data.
 *   - Uses cache to avoid redundant calls.
 */

const narrationCache = require('./ai-narration-cache');
const narrationValidator = require('./ai-narration-validator');
const narrationPrompts = require('./ai-narration-prompts');

/**
 * Check if AI narration is enabled.
 * @returns {boolean}
 */
function isNarrationEnabled() {
  return process.env.TELEGRAM_AI_NARRATION_ENABLED === 'true';
}

/**
 * Check if a pick/candidate is stale, expired, or otherwise invalid.
 * AI narration should NOT beautify stale/expired data.
 *
 * Checks (any true → stale):
 * - status contains EXPIRED, STALE, INVALID, NEEDS_REVALIDATION
 * - is_stale / data_stale / freshness_is_stale flag is true
 * - setup_freshness_status is EXPIRED or NEEDS_REVALIDATION
 * - is_final is true (already completed/closed)
 * - evaluation.status is EXPIRED or NEEDS_REVALIDATION or INVALID
 *
 * @param {object} pickOrCandidate - The pick row or screener candidate
 * @param {object} [evaluation] - Optional evaluateMonitorStatus result
 * @returns {boolean}
 */
function isStaleOrExpired(pickOrCandidate, evaluation) {
  if (!pickOrCandidate) return true;

  // Check evaluation status
  if (evaluation) {
    const evStatus = String(evaluation.status || '').toUpperCase();
    if (evStatus === 'EXPIRED' || evStatus === 'NEEDS_REVALIDATION' || evStatus === 'INVALID') {
      return true;
    }
  }

  // Check pick/candidate status field
  const status = String(pickOrCandidate.status || pickOrCandidate.final_status || '').toUpperCase();
  if (status.indexOf('EXPIRED') >= 0 || status.indexOf('STALE') >= 0 ||
      status.indexOf('INVALID') >= 0 || status.indexOf('NEEDS_REVALIDATION') >= 0) {
    return true;
  }

  // Check boolean stale flags
  if (pickOrCandidate.is_stale === true || pickOrCandidate.data_stale === true ||
      pickOrCandidate.freshness_is_stale === true) {
    return true;
  }

  // Check setup_freshness_status (from raw_payload or direct field)
  const raw = pickOrCandidate.raw_payload || pickOrCandidate;
  const freshness = String(raw.setup_freshness_status || '').toUpperCase();
  if (freshness === 'EXPIRED' || freshness === 'NEEDS_REVALIDATION') {
    return true;
  }

  return false;
}

/**
 * Get the Gemini model name.
 * @returns {string}
 */
function getModel() {
  return process.env.GEMINI_MODEL || 'gemini-2.0-flash';
}

/**
 * Get the Gemini timeout in ms.
 * @returns {number}
 */
function getTimeoutMs() {
  const val = parseInt(process.env.GEMINI_TIMEOUT_MS, 10);
  return isFinite(val) && val > 0 ? val : 8000;
}

/**
 * Call Gemini API with a given API key.
 * Returns the generated text or throws on failure.
 *
 * @param {string} apiKey
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @returns {Promise<string>}
 */
async function callGemini(apiKey, systemPrompt, userPrompt) {
  const model = getModel();
  const timeoutMs = getTimeoutMs();
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + apiKey;

  const body = {
    system_instruction: {
      parts: [{ text: systemPrompt }]
    },
    contents: [{
      parts: [{ text: userPrompt }]
    }],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 600,
      topP: 0.9
    }
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
      try {
        const errBody = await response.text();
        if (errBody.length < 300) errMsg += ': ' + errBody;
      } catch (e) { /* ignore */ }
      const err = new Error(errMsg);
      err.status = status;
      err.retryable = status === 429 || status >= 500;
      throw err;
    }

    const result = await response.json();
    const candidates = result.candidates || [];
    if (candidates.length === 0 || !candidates[0].content || !candidates[0].content.parts) {
      throw new Error('empty_response');
    }

    const text = candidates[0].content.parts.map(function(p) { return p.text || ''; }).join('').trim();
    if (!text) throw new Error('empty_text');
    return text;
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === 'AbortError') {
      const err = new Error('gemini_timeout');
      err.retryable = true;
      throw err;
    }
    if (!e.retryable && e.message && !e.status) {
      e.retryable = true; // network errors are retryable
    }
    throw e;
  }
}

/**
 * Generate AI narration for a notification.
 * Returns narrated text or null if AI is disabled/fails/validation fails.
 *
 * This is the main entry point for the AI narration system.
 *
 * @param {string} type - Notification type (e.g., 'new_signal', 'tp1_hit', 'sl_hit', etc.)
 * @param {object} data - Structured notification data
 * @param {object} [options] - Options
 * @param {string[]} [options.requiredFields] - Fields that must be validated in output
 * @returns {Promise<{ text: string|null, source: string, error?: string }>}
 *   source: 'ai' | 'cache' | 'fallback'
 */
async function generateNarration(type, data, options) {
  // 1. Check if enabled
  if (!isNarrationEnabled()) {
    return { text: null, source: 'fallback', error: 'disabled' };
  }

  // 2. Check API keys
  const primaryKey = (process.env.GEMINI_API_KEY_PRIMARY || '').trim();
  if (!primaryKey) {
    return { text: null, source: 'fallback', error: 'missing_primary_key' };
  }

  // 3. Check cache
  const cacheKey = narrationCache.buildCacheKey({
    type: type,
    ticker: data.ticker,
    category: data.category || data.status,
    data: {
      entry1: data.entry1,
      entry2: data.entry2,
      sl: data.sl || data.stop_loss,
      tp1: data.tp1,
      tp2: data.tp2,
      last_price: data.last_price || data.current_price,
      status: data.status,
      profit_pct: data.profit_pct
    }
  });

  const cached = narrationCache.get(cacheKey);
  if (cached) {
    return { text: cached, source: 'cache' };
  }

  // 4. Build prompts
  const systemPrompt = narrationPrompts.getSystemInstruction();
  const userPrompt = narrationPrompts.buildUserPrompt(type, data);

  // 5. Call Gemini with primary key
  let aiText = null;
  let aiError = null;

  try {
    aiText = await callGemini(primaryKey, systemPrompt, userPrompt);
  } catch (e) {
    aiError = e;
    // 6. If retryable, try backup key
    if (e.retryable) {
      const backupKey = (process.env.GEMINI_API_KEY_BACKUP || '').trim();
      if (backupKey) {
        try {
          aiText = await callGemini(backupKey, systemPrompt, userPrompt);
          aiError = null;
        } catch (e2) {
          aiError = e2;
        }
      }
    }
  }

  // 7. If AI failed completely, fallback
  if (!aiText) {
    return { text: null, source: 'fallback', error: aiError ? (aiError.message || 'unknown_error') : 'no_output' };
  }

  // 8. Validate AI output
  const validation = narrationValidator.validate(aiText, data, options);
  if (!validation.valid) {
    return {
      text: null,
      source: 'fallback',
      error: 'validation_failed:' + validation.reason,
      validationDetails: validation
    };
  }

  // 9. Cache the valid result
  narrationCache.set(cacheKey, aiText);

  // 10. Return narrated text
  return { text: aiText, source: 'ai' };
}

/**
 * Narrate a monitor pick status update.
 * Convenience wrapper that maps monitor data to narration types.
 *
 * @param {object} pick - The pick row from telegram_daily_picks
 * @param {object} evaluation - The evaluateMonitorStatus result
 * @param {object} priceData - { last, open, high, low }
 * @returns {Promise<{ text: string|null, source: string, error?: string }>}
 */
async function narrateMonitorUpdate(pick, evaluation, priceData) {
  const status = (evaluation.status || '').toUpperCase();

  // Guard: do not narrate stale/expired data
  if (isStaleOrExpired(pick, evaluation)) {
    return { text: null, source: 'fallback', error: 'stale_or_expired' };
  }

  // Map status to narration type
  let type = 'monitor_update';
  if (status === 'TP1_HIT') type = 'tp1_hit';
  else if (status === 'TP2_HIT') type = 'tp2_hit';
  else if (status === 'SL_HIT') type = 'sl_hit';
  else if (status === 'RUNNING') type = 'running';
  else if (status === 'IN_ENTRY_ZONE') type = 'entry_hit';
  else if (status === 'WATCHLIST' || status === 'ENTRY_READY') type = 'watchlist';

  // Build data from pick + price
  const entry1 = parseFloat(pick.entry1) || 0;
  const lastPrice = priceData && priceData.last ? priceData.last : 0;
  const tp1 = parseFloat(pick.tp1) || 0;

  // Calculate profit/loss percentage if applicable
  let profitPct = null;
  let lossPct = null;
  if (entry1 > 0 && lastPrice > 0) {
    if (status === 'TP1_HIT' || status === 'TP2_HIT') {
      const targetPrice = status === 'TP2_HIT' ? (parseFloat(pick.tp2) || tp1) : tp1;
      profitPct = (((targetPrice - entry1) / entry1) * 100).toFixed(2);
    } else if (status === 'SL_HIT') {
      const sl = parseFloat(pick.sl) || 0;
      if (sl > 0) lossPct = (((sl - entry1) / entry1) * 100).toFixed(2);
    }
  }

  const data = {
    ticker: pick.ticker,
    status: evaluation.status,
    category: (pick.raw_payload && pick.raw_payload.category) || 'Day Trade',
    entry1: pick.entry1,
    entry2: pick.entry2,
    sl: pick.sl,
    stop_loss: pick.sl,
    tp1: pick.tp1,
    tp2: pick.tp2,
    last_price: lastPrice,
    current_price: lastPrice,
    risk_reward: pick.raw_payload && pick.raw_payload.risk_reward,
    note: evaluation.note,
    profit_pct: profitPct,
    loss_pct: lossPct
  };

  return generateNarration(type, data);
}

/**
 * Narrate a new signal/watchlist candidate.
 *
 * @param {object} candidate - Screener candidate data
 * @param {string} [mode] - 'daytrade', 'swing', 'swing_non_konglo'
 * @returns {Promise<{ text: string|null, source: string, error?: string }>}
 */
async function narrateNewSignal(candidate, mode) {
  // Guard: do not narrate stale/expired data
  if (isStaleOrExpired(candidate)) {
    return { text: null, source: 'fallback', error: 'stale_or_expired' };
  }

  const data = {
    ticker: candidate.ticker,
    status: candidate.status || candidate.final_status || 'Watchlist',
    category: mode === 'daytrade' ? 'Day Trade' : (mode === 'swing_non_konglo' ? 'Swing Non-Konglo' : 'Swing'),
    entry1: candidate.entry1 || candidate.entry_high,
    entry2: candidate.entry2 || candidate.entry_low,
    sl: candidate.sl || candidate.stop_loss,
    stop_loss: candidate.sl || candidate.stop_loss,
    tp1: candidate.tp1 || candidate.tp1n,
    tp2: candidate.tp2 || candidate.tp2n,
    last_price: candidate.lastn || candidate.last_price || candidate.current_price,
    current_price: candidate.lastn || candidate.last_price || candidate.current_price,
    risk_reward: candidate.risk_reward,
    score: candidate.score || candidate.daytrade_score,
    grade: candidate.quality_grade || candidate.grade
  };

  return generateNarration('new_signal', data);
}

module.exports = {
  isNarrationEnabled,
  isStaleOrExpired,
  generateNarration,
  narrateMonitorUpdate,
  narrateNewSignal,
  // Exposed for testing
  callGemini,
  getModel,
  getTimeoutMs
};
