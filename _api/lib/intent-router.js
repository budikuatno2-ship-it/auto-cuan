/**
 * Intent Router - Classifies user intent for Auto-Cuan
 * Determines what kind of response the user needs
 */

const INTENT_TYPES = {
  NORMAL_CHAT: 'normal_chat',
  TICKER_ONLY: 'ticker_only',
  TICKER_PRICE_BASIC: 'ticker_price_basic',
  CHART_ANALYSIS: 'chart_analysis',
  MULTI_TIMEFRAME_CHART: 'multi_timeframe_chart_analysis',
  BROKER_SUMMARY: 'broker_summary_analysis',
  ORDERBOOK: 'orderbook_analysis',
  MARKET_MAKER_CODE: 'market_maker_code_analysis',
  NEWS_CATALYST: 'news_catalyst_analysis',
  CORPORATE_ACTION: 'corporate_action_analysis',
  FOLLOW_UP: 'follow_up_question',
  FULL_ANALYSIS: 'full_analysis_request',
  EVIDENCE_UPDATE: 'evidence_update',
  UNKNOWN: 'unknown'
};

// Follow-up question patterns (user asking about existing context)
const FOLLOW_UP_PATTERNS = [
  /^(bagus|aman|mantap|oke|ok)\s*(gak|ga|nggak|tidak|kah|dong|deh|sih)?\s*\??$/i,
  /^(gimana|gmn|gmana)\s*(nih|ini|tuh|dong|deh)?\s*\??$/i,
  /^(entry|masuk|beli|buy)\s*(di\s*)?mana\s*\??$/i,
  /^(tp|take\s*profit|target)\s*(berapa|mana|di\s*mana)?\s*\??$/i,
  /^(sl|stop\s*loss|cut\s*loss)\s*(berapa|mana|di\s*mana)?\s*\??$/i,
  /^(tp|sl|tp\s*sl|sl\s*tp)\s*\??$/i,
  /^(hold|tahan|pegang)\s*(atau|apa)\s*(cut|jual|lepas)?\s*\??$/i,
  /^(nambah|tambah|averaging)\s*(gak|ga|nggak|tidak|boleh|bisa)?\s*\??$/i,
  /^(lanjut|terus|next)\s*(gak|ga|gimana)?\s*\??$/i,
  /^(menurutmu|menurut\s*kamu|pendapatmu)\s*(gimana|gmn)?\s*\??$/i,
  /^(kapan|waktu)\s*(entry|masuk|beli|buy|keluar|jual)?\s*\??$/i,
  /^(ini|saham\s*ini)\s*(bagus|aman|worth|layak)\s*(gak|ga|nggak|tidak|kah)?\s*\??$/i,
  /^(cut|jual|lepas|keluar)\s*(gak|ga|aja|saja|sekarang)?\s*\??$/i,
  /^(risky|risiko|bahaya)\s*(gak|ga|nggak|tidak|kah|tinggi)?\s*\??$/i,
  /^(worth|layak)\s*(beli|buy|entry|masuk)?\s*(gak|ga|nggak|tidak|kah)?\s*\??$/i,
  /^r\s*:?\s*r\s*(berapa|nya)?\s*\??$/i,
  /^(bandar|mm|market\s*maker)\s*(akum|akumulasi|distribusi|jualan)?\s*(gak|ga|nggak|tidak|kah)?\s*\??$/i,
];

// Full analysis request patterns
const FULL_ANALYSIS_PATTERNS = [
  /analisis\s*(lengkap|penuh|detail|full|mendalam|deep)/i,
  /full\s*analysis/i,
  /deep\s*analysis/i,
  /bahas\s*(semua|lengkap|detail)/i,
  /buat\s*(laporan|report)\s*(lengkap|penuh|detail)/i,
  /detail\s*(banget|lengkap|semua)/i,
  /analisa\s*(lengkap|full|detail|mendalam)/i,
];

// Broker summary keywords
const BROKER_KEYWORDS = [
  'broker summary', 'net buy', 'net sell', 'akumulasi broker', 'distribusi broker',
  'bandarmology', 'top buyer', 'top seller', 'broker code', 'bandar akum',
  'broker akumulasi', 'broker distribusi', 'data broker'
];

// News/catalyst keywords
const NEWS_KEYWORDS = [
  'news', 'berita', 'katalis', 'catalyst', 'rumor', 'isu',
  'laporan keuangan', 'financial report', 'earnings', 'laba', 'rugi'
];

// Corporate action keywords
const CORPORATE_ACTION_KEYWORDS = [
  'corporate action', 'right issue', 'rights issue', 'stock split', 'reverse split',
  'dividen', 'dividend', 'buyback', 'inbreng', 'private placement', 'ipo',
  'tender offer', 'merger', 'akuisisi', 'acquisition', 'delisting', 'relisting',
  'rups', 'rupslb', 'warrant', 'konversi'
];

// Orderbook / MM code keywords
const ORDERBOOK_KEYWORDS = [
  'orderbook', 'order book', 'bid offer', 'bid-offer', 'running trade',
  'tape reading', 'fast tape', 'slow tape'
];

const MM_CODE_KEYWORDS = [
  'market maker', 'mm code', 'kode bandar', 'kode mm', 'kode market maker',
  'bandar code', 'code bandar'
];

/**
 * Route user intent based on message content and context
 * @param {string} message - User message
 * @param {object} options - { hasImages, imageCount, hasDocuments, hasPreviousContext, ticker, currentPrice }
 * @returns {object} { intent, confidence, metadata }
 */
function routeIntent(message, options = {}) {
  const { hasImages, imageCount, hasDocuments, hasPreviousContext, ticker, currentPrice } = options;
  const msg = String(message || '').trim();
  const msgLower = msg.toLowerCase();

  // 1. Chart analysis (images uploaded)
  if (hasImages && imageCount > 0) {
    if (imageCount >= 2) {
      return { intent: INTENT_TYPES.MULTI_TIMEFRAME_CHART, confidence: 0.95, metadata: { imageCount } };
    }
    // Check if it's broker summary screenshot or orderbook screenshot
    if (hasBrokerKeywords(msgLower)) {
      return { intent: INTENT_TYPES.BROKER_SUMMARY, confidence: 0.85, metadata: { imageCount } };
    }
    if (hasOrderbookKeywords(msgLower)) {
      return { intent: INTENT_TYPES.ORDERBOOK, confidence: 0.85, metadata: { imageCount } };
    }
    if (hasMMCodeKeywords(msgLower)) {
      return { intent: INTENT_TYPES.MARKET_MAKER_CODE, confidence: 0.85, metadata: { imageCount } };
    }
    return { intent: INTENT_TYPES.CHART_ANALYSIS, confidence: 0.9, metadata: { imageCount } };
  }

  // 2. Document-based evidence update
  if (hasDocuments && hasPreviousContext) {
    if (hasBrokerKeywords(msgLower)) {
      return { intent: INTENT_TYPES.BROKER_SUMMARY, confidence: 0.85, metadata: {} };
    }
    if (hasNewsKeywords(msgLower) || hasCorporateActionKeywords(msgLower)) {
      return { intent: INTENT_TYPES.EVIDENCE_UPDATE, confidence: 0.8, metadata: {} };
    }
    return { intent: INTENT_TYPES.EVIDENCE_UPDATE, confidence: 0.7, metadata: {} };
  }

  // 3. Full analysis request
  if (isFullAnalysisRequest(msgLower)) {
    return { intent: INTENT_TYPES.FULL_ANALYSIS, confidence: 0.95, metadata: {} };
  }

  // 4. Follow-up question (has previous context + short/conversational message)
  if (hasPreviousContext && isFollowUpQuestion(msg, msgLower)) {
    return { intent: INTENT_TYPES.FOLLOW_UP, confidence: 0.85, metadata: {} };
  }

  // 5. News/catalyst
  if (hasNewsKeywords(msgLower)) {
    if (hasPreviousContext) {
      return { intent: INTENT_TYPES.EVIDENCE_UPDATE, confidence: 0.8, metadata: { evidenceType: 'news' } };
    }
    return { intent: INTENT_TYPES.NEWS_CATALYST, confidence: 0.8, metadata: {} };
  }

  // 6. Corporate action
  if (hasCorporateActionKeywords(msgLower)) {
    if (hasPreviousContext) {
      return { intent: INTENT_TYPES.EVIDENCE_UPDATE, confidence: 0.8, metadata: { evidenceType: 'corporate_action' } };
    }
    return { intent: INTENT_TYPES.CORPORATE_ACTION, confidence: 0.8, metadata: {} };
  }

  // 7. Broker summary text question
  if (hasBrokerKeywords(msgLower)) {
    return { intent: INTENT_TYPES.BROKER_SUMMARY, confidence: 0.75, metadata: {} };
  }

  // 8. Orderbook / MM code question
  if (hasOrderbookKeywords(msgLower)) {
    return { intent: INTENT_TYPES.ORDERBOOK, confidence: 0.75, metadata: {} };
  }
  if (hasMMCodeKeywords(msgLower)) {
    return { intent: INTENT_TYPES.MARKET_MAKER_CODE, confidence: 0.75, metadata: {} };
  }

  // 9. Ticker + price (e.g. "WMUU harga 58 gimana?")
  if (ticker && currentPrice) {
    return { intent: INTENT_TYPES.TICKER_PRICE_BASIC, confidence: 0.9, metadata: { ticker, currentPrice } };
  }

  // 10. Ticker only (e.g. "WMUU")
  if (ticker && !currentPrice) {
    return { intent: INTENT_TYPES.TICKER_ONLY, confidence: 0.85, metadata: { ticker } };
  }

  // 11. Follow-up without explicit context check (short messages that look conversational)
  if (hasPreviousContext && msg.length < 60) {
    return { intent: INTENT_TYPES.FOLLOW_UP, confidence: 0.6, metadata: {} };
  }

  // 12. Normal chat
  if (msg.length > 0) {
    return { intent: INTENT_TYPES.NORMAL_CHAT, confidence: 0.7, metadata: {} };
  }

  return { intent: INTENT_TYPES.UNKNOWN, confidence: 0, metadata: {} };
}

function isFollowUpQuestion(msg, msgLower) {
  // Check against follow-up patterns
  for (const pattern of FOLLOW_UP_PATTERNS) {
    if (pattern.test(msg.trim())) return true;
  }
  // Short message with question mark or conversational tone
  if (msg.length < 40 && (msg.includes('?') || /\b(gimana|bagus|aman|entry|tp|sl|hold|cut|nambah|lanjut)\b/i.test(msgLower))) {
    return true;
  }
  return false;
}

function isFullAnalysisRequest(msgLower) {
  for (const pattern of FULL_ANALYSIS_PATTERNS) {
    if (pattern.test(msgLower)) return true;
  }
  return false;
}

function hasBrokerKeywords(msgLower) {
  return BROKER_KEYWORDS.some(kw => msgLower.includes(kw));
}

function hasNewsKeywords(msgLower) {
  return NEWS_KEYWORDS.some(kw => msgLower.includes(kw));
}

function hasCorporateActionKeywords(msgLower) {
  return CORPORATE_ACTION_KEYWORDS.some(kw => msgLower.includes(kw));
}

function hasOrderbookKeywords(msgLower) {
  return ORDERBOOK_KEYWORDS.some(kw => msgLower.includes(kw));
}

function hasMMCodeKeywords(msgLower) {
  return MM_CODE_KEYWORDS.some(kw => msgLower.includes(kw));
}

module.exports = { routeIntent, INTENT_TYPES };
