/**
 * Analysis Context Cache - Server-side utility for building/using session context
 * Note: Primary context storage is client-side (latestAnalysisContext in localStorage)
 * This module helps the API use that context efficiently
 */

/**
 * Build compact context string from client-provided context object
 * Used to inject into prompts without wasting tokens
 * @param {object} context - From req.body.context
 * @returns {string} Compact context string for prompt injection
 */
function buildCompactContext(context) {
  if (!context || typeof context !== 'object') return '';

  const parts = [];
  if (context.ticker) parts.push(`${context.ticker}`);
  if (context.currentPrice) parts.push(`Rp${context.currentPrice}`);
  if (context.finalDecision) parts.push(context.finalDecision);
  if (context.score) parts.push(`Score:${context.score}`);
  if (context.entryArea) parts.push(`Entry:${context.entryArea}`);
  if (context.stopLoss) parts.push(`SL:${context.stopLoss}`);
  if (context.takeProfits) parts.push(`TP:${context.takeProfits}`);
  if (context.chartSummary) parts.push(`Chart:${context.chartSummary}`);

  return parts.length > 0 ? parts.join(' | ') : '';
}

/**
 * Check if context has enough data for follow-up without reprocessing
 * @param {object} context
 * @returns {boolean}
 */
function hasUsableContext(context) {
  if (!context || typeof context !== 'object') return false;
  // Need at minimum: ticker + at least one analysis result
  return !!(context.ticker && (context.finalDecision || context.chartSummary || context.score));
}

/**
 * Check if chart data already exists in context (avoid re-requesting)
 * @param {object} context
 * @returns {boolean}
 */
function hasChartInContext(context) {
  if (!context) return false;
  return !!(context.chartSummary || (context.detectedTimeframes && context.detectedTimeframes.length > 0));
}

/**
 * Check if news/catalyst already provided
 * @param {object} context
 * @returns {boolean}
 */
function hasNewsInContext(context) {
  if (!context) return false;
  return !!(context.newsProvided || context.newsSummary);
}

/**
 * Check if broker summary already provided
 * @param {object} context
 * @returns {boolean}
 */
function hasBrokerInContext(context) {
  if (!context) return false;
  return !!(context.brokerSummaryProvided || context.brokerSummaryBias);
}

/**
 * Determine what evidence is missing for a complete analysis
 * @param {object} context
 * @returns {Array} List of missing evidence types
 */
function getMissingEvidence(context) {
  const missing = [];
  if (!hasChartInContext(context)) missing.push('chart');
  if (!hasNewsInContext(context)) missing.push('news');
  if (!hasBrokerInContext(context)) missing.push('broker_summary');
  return missing;
}

/**
 * Get the single most important missing evidence to ask about
 * Priority: chart > news > broker_summary > orderbook
 * @param {object} context
 * @returns {string|null} Most important missing evidence type
 */
function getNextBestQuestion(context) {
  if (!hasChartInContext(context)) return 'chart';
  if (!hasNewsInContext(context)) return 'news';
  if (!hasBrokerInContext(context)) return 'broker_summary';
  return null;
}

module.exports = {
  buildCompactContext,
  hasUsableContext,
  hasChartInContext,
  hasNewsInContext,
  hasBrokerInContext,
  getMissingEvidence,
  getNextBestQuestion
};
