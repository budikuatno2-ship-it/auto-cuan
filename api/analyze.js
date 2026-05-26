/**
 * Auto-Cuan Analyze API — Main serverless function
 * Handles: chat, ticker analysis, chart upload, evidence-based multi-type analysis
 * Deployment-safe: all lib requires wrapped in try/catch with fallbacks
 */

// === SAFE MODULE LOADING ===
let routeIntent, INTENT_TYPES, getResponseMode, RESPONSE_MODES;
let sanitizeOutput, generateNewsFollowUp;
let buildConversationalPrompt, buildChartConversationalPrompt, buildFollowUpPrompt;
let hasUsableContext, hasChartInContext, hasNewsInContext;
let classifyEvidence, EVIDENCE_TYPES, buildClassificationPrompt, buildAnalyzerPrompt;
let LIB_LOAD_ERROR = null;

try {
  ({ routeIntent, INTENT_TYPES } = require('./lib/intent-router'));
  ({ getResponseMode, RESPONSE_MODES } = require('./lib/response-mode'));
  ({ sanitizeOutput, generateNewsFollowUp } = require('./lib/output-sanitizer'));
  ({ buildConversationalPrompt, buildChartConversationalPrompt, buildFollowUpPrompt } = require('./lib/prompt-builder'));
  ({ hasUsableContext, hasChartInContext, hasNewsInContext } = require('./lib/analysis-context-cache'));
  ({ classifyEvidence, EVIDENCE_TYPES, buildClassificationPrompt, buildAnalyzerPrompt } = require('./lib/evidence-classifier'));
} catch (e) {
  LIB_LOAD_ERROR = e;
  routeIntent = () => ({ intent: 'unknown', confidence: 0, metadata: {} });
  INTENT_TYPES = { NORMAL_CHAT: 'normal_chat', FULL_ANALYSIS: 'full_analysis_request', CHART_ANALYSIS: 'chart_analysis', MULTI_TIMEFRAME_CHART: 'multi_timeframe_chart_analysis', FOLLOW_UP: 'follow_up_question', TICKER_PRICE_BASIC: 'ticker_price_basic', TICKER_ONLY: 'ticker_only', UNKNOWN: 'unknown' };
  getResponseMode = () => ({ mode: 'conversational', maxTokens: 2048, temperature: 0.5, outputStyle: 'conversational_short' });
  RESPONSE_MODES = { CONVERSATIONAL: 'conversational', FULL_ANALYSIS: 'full_analysis' };
  sanitizeOutput = (html) => html || '';
  generateNewsFollowUp = () => null;
  buildConversationalPrompt = () => '';
  buildChartConversationalPrompt = () => '';
  buildFollowUpPrompt = () => '';
  hasUsableContext = () => false;
  hasChartInContext = () => false;
  hasNewsInContext = () => false;
  classifyEvidence = () => ({ primaryType: 'chart', confidence: 'low', needsGeminiClassification: true });
  EVIDENCE_TYPES = { CHART: 'chart', ORDERBOOK_BID_OFFER: 'orderbook_bid_offer', RUNNING_TRADE: 'running_trade', BROKER_SUMMARY: 'broker_summary', MARKET_MAKER_CODE_REFERENCE: 'market_maker_code_reference', NEWS_OR_CORPORATE_ACTION: 'news_or_corporate_action', DOCUMENT_FILE: 'document_file', UNKNOWN: 'unknown' };
  buildClassificationPrompt = () => '';
  buildAnalyzerPrompt = () => '';
}

// === HELPERS ===
var VALID_FCA_STATUSES = ['confirmed_by_mapping', 'confirmed_by_user', 'confirmed_by_uploaded_evidence', 'unconfirmed', 'not_detected'];
function validateFcaStatus(status) { return VALID_FCA_STATUSES.indexOf(status) !== -1 ? status : 'not_detected'; }

function calculateEvidenceLevel(req) {
  const { images, documents, image } = req.body || {};
  const hasImages = (images && images.length > 0) || !!image;
  const imageCount = images ? images.length : (image ? 1 : 0);
  const hasDocuments = documents && documents.length > 0 && documents.some(d => d.text && d.text.length > 0);
  if (!hasImages && !hasDocuments) return 1;
  if (imageCount === 1 && !hasDocuments) return 2;
  if (imageCount >= 2) return hasDocuments ? 4 : 3;
  if (hasDocuments) return 2;
  return 1;
}

function sanitizeDocumentText(text) {
  if (!text) return '';
  return text.split('\n').map(line => {
    if (/^={3,}/.test(line.trim()) && /instruksi|instruction|system|prompt|ignore|override/i.test(line)) return '[removed]';
    if (/^-{3,}/.test(line.trim()) && /(AKHIR DOKUMEN|KONTEN DOKUMEN|END|SYSTEM)/i.test(line)) return '[removed]';
    if (/^(IGNORE ALL|FORGET ALL|OVERRIDE|NEW INSTRUCTIONS|SYSTEM PROMPT|YOU ARE NOW)/i.test(line.trim())) return '[removed]';
    return line;
  }).join('\n');
}

function sanitizeFilename(name) { return name ? String(name).replace(/[^a-zA-Z0-9._\-\s]/g, '').slice(0, 50) : 'unknown'; }

function buildDocumentContext(documents) {
  if (!documents || documents.length === 0) return '';
  const validDocs = documents.filter(d => d.text && d.text.trim().length > 0);
  if (validDocs.length === 0) return '';
  let ctx = '\n\n=== DOKUMEN USER ===\n';
  validDocs.forEach((doc, i) => {
    const text = doc.text.length > 5000 ? doc.text.slice(0, 5000) + '\n[...dipotong]' : doc.text;
    ctx += `\nDokumen ${i + 1}: ${sanitizeFilename(doc.filename)} (${doc.type || 'unknown'})\n${sanitizeDocumentText(text)}\n`;
  });
  return ctx;
}

function buildFCAContextBlock(fcaStatus) {
  if (fcaStatus === 'not_detected') {
    return '\n\n=== FCA STATUS: not_detected ===\nDILARANG menyebut FCA / Full Call Auction di manapun. Chart illiquid/volatile/penny stock BUKAN bukti FCA.\n';
  }
  if (fcaStatus === 'unconfirmed') {
    return '\n\nFCA Status: unconfirmed. Jawab hypothetical jika ditanya, tapi JANGAN konfirmasi FCA.\n';
  }
  const labels = { confirmed_by_mapping: 'Local mapping', confirmed_by_user: 'User input', confirmed_by_uploaded_evidence: 'Uploaded evidence' };
  return `\n\n=== FCA CONFIRMED: ${labels[fcaStatus] || fcaStatus} ===\nSaham FCA: skor dikurangi, confidence rendah, posisi kecil, warn risiko FCA.\n`;
}

// === GEMINI CALL HELPER ===
async function callGemini(systemPrompt, userMessage, images, config) {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) return null;

  const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

  const parts = [{ text: systemPrompt }];
  if (userMessage) parts.push({ text: userMessage });

  if (images && images.length > 0) {
    images.forEach(img => {
      let base64 = img.data || img.base64Data || '';
      if (base64.includes(',')) base64 = base64.split(',')[1];
      if (base64) parts.push({ inline_data: { mime_type: img.mimeType || 'image/png', data: base64 } });
    });
  }

  const payload = {
    contents: [{ parts }],
    generationConfig: config || { temperature: 0.4, topP: 0.9, topK: 40, maxOutputTokens: 4096 }
  };

  const response = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) return null;
  const result = await response.json();
  const candidates = result.candidates || [];
  if (candidates.length > 0) {
    const cparts = candidates[0].content?.parts || [];
    if (cparts.length > 0 && cparts[0].text) {
      let html = cparts[0].text;
      html = html.replace(/^```html\s*/i, '').replace(/```\s*$/i, '');
      return html;
    }
  }
  return null;
}

// === FALLBACK ===
function generateFallback(ticker, price) {
  const p = price || 0;
  const score = p > 500 ? 48 : p > 200 ? 45 : p > 100 ? 42 : p > 50 ? 40 : 38;
  return `<div class="space-y-3"><div class="bg-[#151a23] rounded-xl p-4 border border-[#1c2333]"><div class="flex items-center gap-3 mb-2"><span class="text-lg font-bold text-white">${ticker || 'UNKNOWN'}</span><span class="text-sm text-gray-400">Rp ${p}</span><span class="px-2 py-0.5 rounded text-xs font-bold bg-yellow-500/20 text-yellow-400 border border-yellow-500/30">NEED CHART CONFIRMATION</span></div><p class="text-sm text-gray-300">Data terlalu minim (hanya ticker + harga). Upload chart 1W/1D/4H untuk analisis lengkap.</p><p class="text-xs text-gray-500 mt-1">Score: ${score}/55 (max Level 1) | Risk: Medium-High</p></div><p class="text-xs text-gray-500">Bukan rekomendasi jual/beli; tetap pakai risk management.</p></div>`;
}

// === MAIN HANDLER ===
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (LIB_LOAD_ERROR) {
    console.error('analyze.js lib load error:', LIB_LOAD_ERROR.message);
    return res.status(500).json({ error: 'Server initialization error.' });
  }

  try {
    const { ticker, currentPrice, image, mimeType, source, chatMessage, images, documents, fcaStatus } = req.body || {};

    if (documents && documents.length > 10) return res.status(400).json({ error: 'Terlalu banyak dokumen.' });
    if (images && images.length > 10) return res.status(400).json({ error: 'Terlalu banyak gambar.' });

    const fca = validateFcaStatus(fcaStatus);

    // === CHAT MODE ===
    if (source === 'chat_mode' && chatMessage) {
      return await handleChatMode(req, res, chatMessage, fca);
    }

    // === IMAGE/FILE UPLOAD MODE ===
    if (source === 'chart_upload' && (image || (images && images.length > 0))) {
      return await handleImageUpload(req, res, fca);
    }

    // === TICKER MODE ===
    if (!ticker || !currentPrice) {
      return res.status(400).json({ error: 'Ticker dan harga sekarang wajib diisi.' });
    }

    return await handleTickerMode(req, res, fca);

  } catch (error) {
    console.error('analyze error:', error.message);
    try {
      const { ticker, currentPrice } = req.body || {};
      return res.status(200).json({ html: generateFallback((ticker || 'UNKNOWN').toUpperCase(), parseFloat(currentPrice) || 0) });
    } catch (e) {
      return res.status(500).json({ error: 'Server error' });
    }
  }
};

// === CHAT MODE HANDLER ===
async function handleChatMode(req, res, message, fca) {
  const context = req.body.context || null;
  const hasPrevCtx = hasUsableContext(context);

  const intentResult = routeIntent(message, {
    hasImages: false, imageCount: 0, hasDocuments: false,
    hasPreviousContext: hasPrevCtx,
    ticker: context && context.ticker, currentPrice: context && context.currentPrice
  });

  // Full analysis redirect
  if (intentResult.intent === INTENT_TYPES.FULL_ANALYSIS && hasPrevCtx && context.ticker) {
    req.body.ticker = context.ticker;
    req.body.currentPrice = context.currentPrice || 0;
    req.body.fullAnalysisRequested = true;
    return await handleTickerMode(req, res, fca);
  }

  const responseMode = getResponseMode(intentResult.intent, { hasPreviousContext: hasPrevCtx });
  const fcaStatus = (context && context.fcaStatus) || fca;

  let systemPrompt;
  if (intentResult.intent === INTENT_TYPES.FOLLOW_UP) {
    systemPrompt = buildFollowUpPrompt({ message, context, fcaStatus });
  } else {
    systemPrompt = buildConversationalPrompt({
      intent: intentResult.intent, responseMode: responseMode.mode,
      ticker: context && context.ticker, currentPrice: context && context.currentPrice,
      fcaStatus, context, evidenceLevel: 1
    });
  }

  const html = await callGemini(systemPrompt, message, null, {
    temperature: responseMode.temperature, topP: 0.9, topK: 40, maxOutputTokens: responseMode.maxTokens
  });

  if (!html) {
    return res.status(200).json({ html: '<p class="text-sm text-red-400">AI sedang tidak tersedia. Coba lagi nanti.</p>' });
  }

  let output = sanitizeOutput(html, { fcaStatus, responseMode: responseMode.mode, hasChart: hasChartInContext(context), hasNews: hasNewsInContext(context) });

  // Append news follow-up if needed
  if (intentResult.intent !== INTENT_TYPES.NORMAL_CHAT) {
    const followUp = generateNewsFollowUp({ hasNews: hasNewsInContext(context), hasCorporateAction: context && context.corporateActionSummary, hasChart: hasChartInContext(context), hasTicker: context && context.ticker });
    if (followUp && !output.includes('news') && !output.includes('corporate action')) output += followUp;
  }

  return res.status(200).json({ html: output, intent: intentResult.intent, responseMode: responseMode.mode });
}

// === IMAGE UPLOAD HANDLER (with Evidence Type Classifier) ===
async function handleImageUpload(req, res, fca) {
  const { image, mimeType, images, documents, ticker, currentPrice, chatMessage } = req.body || {};
  const context = req.body.context || null;

  // Build image array
  const imageArray = [];
  if (images && images.length > 0) {
    images.forEach(img => imageArray.push(img));
  } else if (image) {
    imageArray.push({ data: image, mimeType: mimeType || 'image/png', filename: 'upload' });
  }

  // === EVIDENCE TYPE CLASSIFICATION ===
  const classification = classifyEvidence({
    message: chatMessage || '',
    images: imageArray,
    documents: documents,
    userHint: req.body.evidenceTypeHint || null
  });

  const evidenceType = classification.primaryType;
  const imageCount = imageArray.length;
  const hasDocuments = documents && documents.length > 0 && documents.some(d => d.text && d.text.length > 0);
  const level = imageCount >= 2 ? (hasDocuments ? 4 : 3) : (hasDocuments ? 2 : 2);

  // Determine if full analysis requested
  const isFullAnalysis = req.body.fullAnalysisRequested === true ||
    (chatMessage && /analisis\s*(lengkap|full|detail|mendalam)|full\s*analysis|bahas\s*semua/i.test(chatMessage));

  // === ROUTE TO CORRECT ANALYZER ===
  let systemPrompt;

  if (evidenceType === EVIDENCE_TYPES.CHART || evidenceType === EVIDENCE_TYPES.UNKNOWN) {
    // Chart analysis (default for images) — includes classification prompt for ambiguous
    systemPrompt = buildChartPrompt({ ticker, currentPrice, fca, imageCount, level, isFullAnalysis, context, hasDocuments, documents, classification });
  } else {
    // Non-chart evidence: orderbook, running trade, broker summary, mm code, news
    systemPrompt = buildNonChartPrompt(evidenceType, { ticker, currentPrice, fca, context, documents });
  }

  const html = await callGemini(systemPrompt, chatMessage || '', imageArray, {
    temperature: isFullAnalysis ? 0.35 : 0.4, topP: 0.95, topK: 40,
    maxOutputTokens: isFullAnalysis ? 8192 : 4096
  });

  if (!html || html.trim().length < 50) {
    return res.status(200).json({ html: '<div class="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4 text-center"><p class="text-yellow-400 font-semibold">AI belum berhasil menganalisis gambar ini.</p><p class="text-sm text-gray-400 mt-2">Coba lagi atau pastikan gambar cukup jelas.</p></div>' });
  }

  const output = sanitizeOutput(html, { fcaStatus: fca, responseMode: isFullAnalysis ? 'full_analysis' : 'compact_analysis', hasChart: evidenceType === EVIDENCE_TYPES.CHART, hasNews: hasNewsInContext(context) });

  return res.status(200).json({ html: output, intent: evidenceType, responseMode: isFullAnalysis ? 'full_analysis' : 'compact_analysis', evidenceType });
}

// === TICKER MODE HANDLER ===
async function handleTickerMode(req, res, fca) {
  const { ticker, currentPrice, documents } = req.body || {};
  const tickerUpper = ticker.toUpperCase();
  const price = parseFloat(currentPrice);
  const level = calculateEvidenceLevel(req);
  const isFullAnalysis = req.body.fullAnalysisRequested === true;
  const docContext = buildDocumentContext(documents);

  let systemPrompt;
  if (isFullAnalysis) {
    systemPrompt = buildFullTickerPrompt(tickerUpper, price, fca, level, docContext, req.body.context);
  } else {
    systemPrompt = buildConversationalPrompt({
      intent: INTENT_TYPES.TICKER_PRICE_BASIC, responseMode: RESPONSE_MODES.CONVERSATIONAL,
      ticker: tickerUpper, currentPrice: price, fcaStatus: fca,
      context: req.body.context || null, evidenceLevel: level
    });
    if (docContext) systemPrompt += docContext;
  }

  const html = await callGemini(systemPrompt, '', null, {
    temperature: isFullAnalysis ? 0.3 : 0.5, topP: 0.9, topK: 40,
    maxOutputTokens: isFullAnalysis ? 8192 : 2048
  });

  if (!html || html.trim().length < 50) {
    return res.status(200).json({ html: generateFallback(tickerUpper, price) });
  }

  const output = sanitizeOutput(html, { fcaStatus: fca, responseMode: isFullAnalysis ? 'full_analysis' : 'conversational', hasChart: false, hasNews: hasNewsInContext(req.body.context) });
  return res.status(200).json({ html: output, intent: 'ticker_price_basic', responseMode: isFullAnalysis ? 'full_analysis' : 'conversational' });
}

// === CHART PROMPT BUILDER ===
function buildChartPrompt(params) {
  const { ticker, currentPrice, fca, imageCount, level, isFullAnalysis, context, hasDocuments, documents, classification } = params;
  const safeTicker = ticker ? String(ticker).replace(/[^A-Za-z]/g, '').slice(0, 10).toUpperCase() : null;
  const safePrice = currentPrice ? String(currentPrice).replace(/[^0-9.]/g, '').slice(0, 15) : null;

  let prompt;
  if (!isFullAnalysis) {
    prompt = buildChartConversationalPrompt({
      ticker: safeTicker, currentPrice: safePrice, fcaStatus: fca,
      imageCount, timeframes: [], context, evidenceLevel: level, hasDocuments
    });
  } else {
    prompt = buildFullChartPrompt(safeTicker, safePrice, fca, level);
  }

  // Add classification prompt if confidence is low (let Gemini classify)
  if (classification && classification.needsGeminiClassification) {
    prompt = buildClassificationPrompt() + '\n' + prompt;
  }

  // Add evidence level
  const scoreCap = imageCount >= 2 ? (hasDocuments ? 90 : 80) : 70;
  prompt += `\n\n=== EVIDENCE LEVEL ${level} | SKOR MAKS: ${scoreCap} ===\n`;

  // Multi-image context
  if (imageCount > 1) {
    prompt += `\nUser mengirim ${imageCount} gambar. Analisis SETIAP gambar. Identifikasi timeframe masing-masing.\n`;
  }

  // Ticker/price context
  if (safeTicker || safePrice) {
    prompt += '\n';
    if (safeTicker) prompt += `Ticker: ${safeTicker}\n`;
    if (safePrice) prompt += `Harga: Rp ${safePrice}\n`;
  }

  // FCA
  prompt += buildFCAContextBlock(fca);

  // Document context
  if (hasDocuments) prompt += buildDocumentContext(documents);

  // Session context
  if (context && typeof context === 'object' && context.ticker) {
    prompt += '\n=== KONTEKS SESI ===\n';
    if (context.finalDecision) prompt += `Keputusan: ${context.finalDecision}\n`;
    if (context.chartSummary) prompt += `Chart: ${context.chartSummary}\n`;
    if (context.brokerSummaryBias) prompt += `Broker: ${context.brokerSummaryBias}\n`;
    if (context.newsProvided) prompt += `News: sudah ada\n`;
  }

  return prompt;
}

// === NON-CHART PROMPT BUILDER ===
function buildNonChartPrompt(evidenceType, params) {
  const { ticker, currentPrice, fca, context, documents } = params;

  let prompt = `Kamu adalah Auto-Cuan AI, teman trading yang pintar dan santai.\n\n`;
  prompt += `=== GAYA JAWABAN ===\n- Jawab conversational, BUKAN report.\n- Bahasa Indonesia natural.\n- Sertakan kesimpulan + rekomendasi di akhir.\n\n`;
  prompt += `=== FORMAT OUTPUT ===\nHTML sederhana Tailwind dark theme. Wrap dalam <div class="space-y-3">.\n\n`;

  // Add specific analyzer prompt
  prompt += buildAnalyzerPrompt(evidenceType);

  // FCA
  prompt += buildFCAContextBlock(fca);

  // Context
  if (ticker) prompt += `\nTicker: ${String(ticker).toUpperCase()}\n`;
  if (currentPrice) prompt += `Harga: Rp ${currentPrice}\n`;

  if (context && context.ticker) {
    prompt += '\n=== KONTEKS SESI ===\n';
    if (context.finalDecision) prompt += `Keputusan: ${context.finalDecision}\n`;
    if (context.score) prompt += `Score: ${context.score}\n`;
    if (context.chartSummary) prompt += `Chart: ${context.chartSummary}\n`;
  }

  // Document context
  if (documents) prompt += buildDocumentContext(documents);

  return prompt;
}

// === FULL CHART PROMPT (structured 7-section) ===
function buildFullChartPrompt(ticker, price, fca, level) {
  return `Kamu adalah AI Analis Teknikal Saham PROFESIONAL. Analisis chart berikut dengan standar EVIDENCE-BASED.

=== EVIDENCE LOCK ===
HANYA gunakan data yang TERLIHAT di chart. Jangan mengarang angka.

=== CHART VALIDATION ===
Chart valid jika ada: candlestick/price structure + skala harga. Jangan tolak chart yang sedikit kurang jelas.
Deteksi timeframe dari header TradingView atau toolbar.

=== ATURAN FCA ===
${fca === 'not_detected' ? 'DILARANG menyebut FCA.' : 'FCA: ' + fca}

=== OUTPUT 7-SECTION (HTML Tailwind dark) ===
1. Kesimpulan Cepat (label + score + risk)
2. Data Terbaca (ticker, harga, timeframe, evidence)
3. Bias 1W/1D/4H
4. Level Penting (support, resistance, invalidation, entry, SL, TP)
5. Entry/SL/TP (3 skenario: Agresif, Moderat, Konservatif)
6. Risiko Utama (2-4 poin)
7. Action Plan

Score max: ${level === 2 ? 70 : level === 3 ? 80 : level >= 4 ? 90 : 55}
${ticker ? 'Ticker: ' + ticker : ''}${price ? ' | Harga: Rp ' + price : ''}

Labels: AVOID|WAIT|WATCHLIST|NEED CHART CONFIRMATION|SPECULATIVE BUY|BUY ON CONFIRMATION|BUY ON PULLBACK|SCALP ONLY|SWING VALID|HOLD|TAKE PROFIT PARTIAL|CUT LOSS/EXIT

Disclaimer cukup 1 kalimat di akhir.`;
}

// === FULL TICKER PROMPT (structured) ===
function buildFullTickerPrompt(ticker, price, fca, level, docContext, context) {
  let prompt = `Kamu adalah AI Analis Teknikal Saham PROFESIONAL.

=== EVIDENCE LOCK ===
Data: Ticker ${ticker}, Harga Rp ${price}. TIDAK ada chart/news/volume/orderbook.
Level 1: Skor max 55. Label valid: WAIT, WATCHLIST, NEED CHART CONFIRMATION, AVOID.

=== ANTI-HALLUCINATION ===
DILARANG klaim: volume spike, demand zone, order block, BOS, CHoCH, candle pattern TANPA chart.

=== FCA ===
${fca === 'not_detected' ? 'DILARANG menyebut FCA.' : 'FCA: ' + fca}

=== OUTPUT 7-SECTION HTML Tailwind dark ===
1. Kesimpulan Cepat 2. Data Terbaca 3. Bias (tidak tersedia) 4. Level Penting (estimasi) 5. Entry/SL/TP (belum valid) 6. Risiko 7. Action Plan

Disclaimer 1 kalimat.`;

  if (context && typeof context === 'object' && context.ticker) {
    prompt += '\n\n=== KONTEKS SESI ===\n';
    if (context.finalDecision) prompt += `Keputusan: ${context.finalDecision}\n`;
    if (context.score) prompt += `Score: ${context.score}\n`;
    if (context.chartSummary) prompt += `Chart: ${context.chartSummary}\n`;
  }

  prompt += buildFCAContextBlock(fca);
  if (docContext) prompt += docContext;

  return prompt;
}
