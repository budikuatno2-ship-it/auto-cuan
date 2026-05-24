/**
 * Response Mode Controller - Determines output format based on intent
 */

const { INTENT_TYPES } = require('./intent-router');

const RESPONSE_MODES = {
  CONVERSATIONAL: 'conversational',
  COMPACT_ANALYSIS: 'compact_analysis',
  FULL_ANALYSIS: 'full_analysis',
  FOLLOW_UP: 'follow_up',
  EVIDENCE_UPDATE: 'evidence_update'
};

/**
 * Determine response mode from intent
 * @param {string} intent - From intent router
 * @param {object} context - { hasPreviousContext, evidenceLevel }
 * @returns {object} { mode, maxTokens, temperature, outputStyle }
 */
function getResponseMode(intent, context = {}) {
  switch (intent) {
    case INTENT_TYPES.FULL_ANALYSIS:
      return {
        mode: RESPONSE_MODES.FULL_ANALYSIS,
        maxTokens: 8192,
        temperature: 0.3,
        outputStyle: 'structured_report'
      };

    case INTENT_TYPES.CHART_ANALYSIS:
    case INTENT_TYPES.MULTI_TIMEFRAME_CHART:
      return {
        mode: RESPONSE_MODES.COMPACT_ANALYSIS,
        maxTokens: 4096,
        temperature: 0.35,
        outputStyle: 'conversational_with_plan'
      };

    case INTENT_TYPES.BROKER_SUMMARY:
    case INTENT_TYPES.ORDERBOOK:
    case INTENT_TYPES.MARKET_MAKER_CODE:
      return {
        mode: RESPONSE_MODES.COMPACT_ANALYSIS,
        maxTokens: 3072,
        temperature: 0.35,
        outputStyle: 'conversational_with_plan'
      };

    case INTENT_TYPES.NEWS_CATALYST:
    case INTENT_TYPES.CORPORATE_ACTION:
      return {
        mode: RESPONSE_MODES.COMPACT_ANALYSIS,
        maxTokens: 2048,
        temperature: 0.4,
        outputStyle: 'conversational_with_plan'
      };

    case INTENT_TYPES.EVIDENCE_UPDATE:
      return {
        mode: RESPONSE_MODES.EVIDENCE_UPDATE,
        maxTokens: 2048,
        temperature: 0.4,
        outputStyle: 'conversational_update'
      };

    case INTENT_TYPES.FOLLOW_UP:
      return {
        mode: RESPONSE_MODES.FOLLOW_UP,
        maxTokens: 1536,
        temperature: 0.5,
        outputStyle: 'conversational_short'
      };

    case INTENT_TYPES.TICKER_PRICE_BASIC:
      return {
        mode: RESPONSE_MODES.CONVERSATIONAL,
        maxTokens: 2048,
        temperature: 0.5,
        outputStyle: 'conversational_with_plan'
      };

    case INTENT_TYPES.TICKER_ONLY:
      return {
        mode: RESPONSE_MODES.CONVERSATIONAL,
        maxTokens: 1536,
        temperature: 0.5,
        outputStyle: 'conversational_short'
      };

    case INTENT_TYPES.NORMAL_CHAT:
    default:
      return {
        mode: RESPONSE_MODES.CONVERSATIONAL,
        maxTokens: 1536,
        temperature: 0.7,
        outputStyle: 'conversational_short'
      };
  }
}

module.exports = { getResponseMode, RESPONSE_MODES };
