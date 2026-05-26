/**
 * Evidence Type Classifier
 * Classifies uploaded images/files into the correct evidence type
 * so the system routes to the appropriate analyzer instead of
 * treating everything as a chart.
 */

const EVIDENCE_TYPES = {
  CHART: 'chart',
  ORDERBOOK_BID_OFFER: 'orderbook_bid_offer',
  RUNNING_TRADE: 'running_trade',
  BROKER_SUMMARY: 'broker_summary',
  MARKET_MAKER_CODE_REFERENCE: 'market_maker_code_reference',
  NEWS_OR_CORPORATE_ACTION: 'news_or_corporate_action',
  DOCUMENT_FILE: 'document_file',
  UNKNOWN: 'unknown'
};

// Keywords for each evidence type (used for user message + filename hints)
const CHART_KEYWORDS = [
  'chart', 'candlestick', 'candle', 'tradingview', 'weekly', 'daily',
  '1w', '1d', '4h', '1h', '15m', 'timeframe', 'ohlc', 'harga',
  'support', 'resistance', 'bos', 'choch', 'msb', 'order block',
  'demand', 'supply', 'fvg', 'imbalance', 'liquidity'
];

const ORDERBOOK_KEYWORDS = [
  'orderbook', 'order book', 'bid', 'offer', 'bid-offer', 'bid offer',
  'antrian', 'queue', 'lot bid', 'lot offer', 'freq', 'frekuensi',
  'buy queue', 'sell queue'
];

const RUNNING_TRADE_KEYWORDS = [
  'running trade', 'trade print', 'running', 'tape', 'fast tape',
  'transaksi', 'buyer', 'seller', 'done', 'match'
];

const BROKER_SUMMARY_KEYWORDS = [
  'broker summary', 'broker', 'net buy', 'net sell', 'top buyer',
  'top seller', 'akumulasi broker', 'distribusi broker', 'bandarmology',
  'broker code', 'bandar akum', 'broker akumulasi', 'broker distribusi',
  'data broker', 'stockbit broker', 'rti broker', 'ipot broker'
];

const MM_CODE_KEYWORDS = [
  'market maker', 'mm code', 'kode bandar', 'kode mm', 'kode market maker',
  'bandar code', 'code bandar', '777', '666', '999', '555', '888', '404', '911',
  'kode market', 'arti kode', 'meaning code'
];

const NEWS_KEYWORDS = [
  'news', 'berita', 'katalis', 'catalyst', 'rumor', 'isu',
  'laporan keuangan', 'financial report', 'earnings', 'laba', 'rugi',
  'corporate action', 'right issue', 'rights issue', 'stock split',
  'reverse split', 'dividen', 'dividend', 'buyback', 'inbreng',
  'private placement', 'ipo', 'tender offer', 'merger', 'akuisisi',
  'acquisition', 'delisting', 'relisting', 'rups', 'rupslb',
  'warrant', 'konversi', 'suspension', 'uma', 'pkpu', 'disclosure',
  'pengumuman', 'idx', 'keterbukaan informasi'
];

// File extensions for document classification
const DOCUMENT_EXTENSIONS = ['pdf', 'doc', 'docx', 'txt', 'csv', 'xls', 'xlsx'];
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];

/**
 * Classify evidence type from user message context
 * @param {string} message - User message text
 * @returns {string|null} Evidence type hint or null if no strong signal
 */
function classifyFromMessage(message) {
  if (!message) return null;
  const msg = message.toLowerCase();

  // Check each category with keyword matching
  const scores = {
    [EVIDENCE_TYPES.ORDERBOOK_BID_OFFER]: 0,
    [EVIDENCE_TYPES.RUNNING_TRADE]: 0,
    [EVIDENCE_TYPES.BROKER_SUMMARY]: 0,
    [EVIDENCE_TYPES.MARKET_MAKER_CODE_REFERENCE]: 0,
    [EVIDENCE_TYPES.NEWS_OR_CORPORATE_ACTION]: 0,
    [EVIDENCE_TYPES.CHART]: 0
  };

  ORDERBOOK_KEYWORDS.forEach(kw => { if (msg.includes(kw)) scores[EVIDENCE_TYPES.ORDERBOOK_BID_OFFER]++; });
  RUNNING_TRADE_KEYWORDS.forEach(kw => { if (msg.includes(kw)) scores[EVIDENCE_TYPES.RUNNING_TRADE]++; });
  BROKER_SUMMARY_KEYWORDS.forEach(kw => { if (msg.includes(kw)) scores[EVIDENCE_TYPES.BROKER_SUMMARY]++; });
  MM_CODE_KEYWORDS.forEach(kw => { if (msg.includes(kw)) scores[EVIDENCE_TYPES.MARKET_MAKER_CODE_REFERENCE]++; });
  NEWS_KEYWORDS.forEach(kw => { if (msg.includes(kw)) scores[EVIDENCE_TYPES.NEWS_OR_CORPORATE_ACTION]++; });
  CHART_KEYWORDS.forEach(kw => { if (msg.includes(kw)) scores[EVIDENCE_TYPES.CHART]++; });

  // Find highest score
  let maxType = null;
  let maxScore = 0;
  for (const [type, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score;
      maxType = type;
    }
  }

  return maxScore >= 1 ? maxType : null;
}

/**
 * Classify evidence type from filename
 * @param {string} filename
 * @returns {string|null} Evidence type hint or null
 */
function classifyFromFilename(filename) {
  if (!filename) return null;
  const name = filename.toLowerCase();

  // Check file extension for documents
  const ext = name.split('.').pop();
  if (DOCUMENT_EXTENSIONS.includes(ext)) {
    // Could be news, broker data, or general document
    if (/broker|net.?buy|net.?sell|akum|distri/i.test(name)) return EVIDENCE_TYPES.BROKER_SUMMARY;
    if (/news|berita|katalis|corporate|disclosure/i.test(name)) return EVIDENCE_TYPES.NEWS_OR_CORPORATE_ACTION;
    return EVIDENCE_TYPES.DOCUMENT_FILE;
  }

  // Image files - check name hints
  if (IMAGE_EXTENSIONS.includes(ext) || !ext || ext === name) {
    if (/orderbook|bid.?offer|antrian/i.test(name)) return EVIDENCE_TYPES.ORDERBOOK_BID_OFFER;
    if (/running|trade|tape/i.test(name)) return EVIDENCE_TYPES.RUNNING_TRADE;
    if (/broker|net.?buy|net.?sell/i.test(name)) return EVIDENCE_TYPES.BROKER_SUMMARY;
    if (/mm.?code|kode.?bandar|market.?maker/i.test(name)) return EVIDENCE_TYPES.MARKET_MAKER_CODE_REFERENCE;
    if (/news|berita|disclosure|corporate/i.test(name)) return EVIDENCE_TYPES.NEWS_OR_CORPORATE_ACTION;
    if (/chart|1w|1d|4h|weekly|daily|tradingview/i.test(name)) return EVIDENCE_TYPES.CHART;
  }

  return null;
}

/**
 * Build the Gemini prompt addition for evidence classification
 * Used when the system needs Gemini to classify an ambiguous image
 * @returns {string} Classification prompt section
 */
function buildClassificationPrompt() {
  return `
=== IMAGE CLASSIFICATION (WAJIB DILAKUKAN PERTAMA) ===
Sebelum menganalisis, KLASIFIKASIKAN gambar ini ke salah satu kategori:

1. CHART - candlestick, price scale, timeframe, TradingView, OHLC, volume bars
2. ORDERBOOK/BID-OFFER - bid, offer, lot, antrian, queue, price levels, freq
3. RUNNING TRADE - trade prints, time, price, lot, buyer/seller, freq
4. BROKER SUMMARY - broker code, top buyer/seller, net buy/sell, average price, period
5. MARKET MAKER CODE - tabel kode (777, 666, 999, dll), penjelasan kode
6. NEWS/CORPORATE ACTION - berita, pengumuman IDX, disclosure, corporate action
7. UNKNOWN - tidak bisa diklasifikasikan

OUTPUT KLASIFIKASI di awal jawaban (1 baris):
[TYPE: chart|orderbook|running_trade|broker_summary|mm_code|news|unknown]

ATURAN:
- Jika gambar BUKAN chart, JANGAN analisis sebagai chart
- Jika gambar adalah orderbook/bid-offer, analisis sebagai order flow
- Jika gambar adalah running trade, analisis sebagai tape reading
- Jika gambar adalah broker summary, analisis sebagai broker data
- Jika gambar tidak jelas, tanyakan: "Ini chart, bid-offer, running trade, broker summary, atau news?"
- JANGAN bilang "chart tidak bisa dianalisis" untuk gambar yang bukan chart
`;
}

/**
 * Build analyzer-specific prompt based on classified evidence type
 * @param {string} evidenceType - One of EVIDENCE_TYPES
 * @returns {string} Specific analysis instructions
 */
function buildAnalyzerPrompt(evidenceType) {
  switch (evidenceType) {
    case EVIDENCE_TYPES.ORDERBOOK_BID_OFFER:
      return `
=== MODE: BID-OFFER / ORDERBOOK READER ===
Ini saya baca sebagai bid-offer/order flow, bukan chart.

Analisis:
- Kondisi bid (tebal/tipis, lot total)
- Kondisi offer (tebal/tipis, lot total)
- Spread (ketat/lebar)
- Likuiditas (aktif/tipis)
- Fast tape indication (aktif/moderate/slow)
- Apakah ada indikasi fake bid/fake offer (butuh multiple snapshots untuk konfirmasi)
- Risiko false signal

Output format conversational, bukan report.
Akhiri dengan kesimpulan: WAIT / WATCHLIST / SCALP ONLY / NEED CHART CONFIRMATION
Dan satu follow-up question yang relevan.`;

    case EVIDENCE_TYPES.RUNNING_TRADE:
      return `
=== MODE: RUNNING TRADE READER ===
Ini saya baca sebagai running trade / tape reading.

Analisis:
- Kecepatan tape (fast/moderate/slow)
- Dominasi transaksi (buyer/seller/balanced)
- Lot dominan (besar/kecil/campuran)
- Pola berulang jika ada
- Indikasi absorption / big player / retail
- Apakah mendukung bid/offer reading

Output format conversational.
Akhiri dengan kesimpulan singkat dan follow-up.`;

    case EVIDENCE_TYPES.BROKER_SUMMARY:
      return `
=== MODE: BROKER SUMMARY READER ===
Ini saya baca sebagai broker summary.

Ekstrak:
- Periode (Today/7D/1M/3M)
- Top net buyer (broker code + value jika terlihat)
- Top net seller (broker code + value jika terlihat)
- Konsentrasi broker (High/Medium/Low)
- Net foreign flow jika terlihat
- Average price jika terlihat

Klasifikasi: Akumulasi / Distribusi / Rotasi / Retail-Driven / Unclear
Confidence: Low / Medium / High

WAJIB gunakan wording hati-hati:
- "terindikasi akumulasi" / "indikasi distribusi"
- JANGAN: "bandar pasti akumulasi" / "pasti distribusi"

Output format conversational.
Akhiri dengan dampak ke analisis dan follow-up.`;

    case EVIDENCE_TYPES.MARKET_MAKER_CODE_REFERENCE:
      return `
=== MODE: MARKET MAKER CODE READER ===
Ini saya baca sebagai referensi kode market maker / kode bandar.

Deteksi kode dari last 3-4 digit nilai bid/offer/lot/freq.
Referensi kode:
- 777: Bullish/ACCUM (HIGH)
- 666: End of markup/DISTRIBUTION (HIGH)
- 999: Puncak/DISTRIBUTION (HIGH)
- 555: Gap up/ACCUM (HIGH)
- 888: Sell on strength/DISTRIBUTION (HIGH)
- 404: Risiko turun/WARNING (HIGH)
- 911: Pending news/WARNING (MEDIUM)
- 500: Gap up/down/UNKNOWN (MEDIUM)
- 400: Sideways (MEDIUM)
- 200: Butuh beli/ACCUM (MEDIUM)
- 2100: Let it run/ACCUM (MEDIUM)
- 100: Butuh beli/ACCUM (MEDIUM)
- 700: Potensi naik/ACCUM (MEDIUM)

PENTING: Kode MM hanya secondary reference, bukan kepastian.
Jika likuiditas tipis, confidence turun.
Jika hanya satu snapshot, tidak bisa dikonfirmasi.

Output format conversational.`;

    case EVIDENCE_TYPES.NEWS_OR_CORPORATE_ACTION:
      return `
=== MODE: NEWS / CORPORATE ACTION READER ===
Ini saya baca sebagai news atau corporate action.

Klasifikasi:
- Type: news / corporate action / rumor / disclosure / financial report / other
- Status: confirmed / unverified / unclear
- Bias impact: bullish / bearish / neutral / mixed / unclear
- Impact strength: low / medium / high
- Time sensitivity: immediate / short-term / medium-term / long-term

Jika ada konteks sesi sebelumnya, jelaskan dampak terhadap analisis:
- Keputusan sebelumnya vs sekarang
- Apakah entry/SL/TP berubah
- Updated risk

Output format conversational.`;

    default:
      return '';
  }
}

/**
 * Determine the primary evidence type for a set of uploaded files
 * @param {object} params - { message, images, documents, userHint }
 * @returns {object} { primaryType, confidence, allTypes }
 */
function classifyEvidence(params) {
  const { message, images, documents, userHint } = params || {};
  const types = [];

  // 1. Check user message for hints
  const messageHint = classifyFromMessage(message);
  if (messageHint) types.push({ type: messageHint, source: 'message', weight: 3 });

  // 2. Check user explicit hint (from mode selector)
  if (userHint) {
    const hintMap = {
      'chart': EVIDENCE_TYPES.CHART,
      'ticker': EVIDENCE_TYPES.CHART,
      'orderbook': EVIDENCE_TYPES.ORDERBOOK_BID_OFFER,
      'bid_offer': EVIDENCE_TYPES.ORDERBOOK_BID_OFFER,
      'running_trade': EVIDENCE_TYPES.RUNNING_TRADE,
      'broker': EVIDENCE_TYPES.BROKER_SUMMARY,
      'broker_summary': EVIDENCE_TYPES.BROKER_SUMMARY,
      'mm_code': EVIDENCE_TYPES.MARKET_MAKER_CODE_REFERENCE,
      'news': EVIDENCE_TYPES.NEWS_OR_CORPORATE_ACTION,
      'corporate_action': EVIDENCE_TYPES.NEWS_OR_CORPORATE_ACTION
    };
    if (hintMap[userHint]) types.push({ type: hintMap[userHint], source: 'user_hint', weight: 5 });
  }

  // 3. Check filenames
  if (images && images.length > 0) {
    images.forEach(img => {
      const fnHint = classifyFromFilename(img.filename);
      if (fnHint) types.push({ type: fnHint, source: 'filename', weight: 2 });
    });
  }

  if (documents && documents.length > 0) {
    documents.forEach(doc => {
      const fnHint = classifyFromFilename(doc.filename);
      if (fnHint) types.push({ type: fnHint, source: 'filename', weight: 2 });
    });
  }

  // 4. If documents exist with text content, check text
  if (documents && documents.length > 0) {
    documents.forEach(doc => {
      if (doc.text) {
        const textHint = classifyFromMessage(doc.text.slice(0, 500));
        if (textHint) types.push({ type: textHint, source: 'doc_content', weight: 2 });
      }
    });
  }

  // Calculate primary type by weighted score
  const scoreMap = {};
  types.forEach(t => {
    scoreMap[t.type] = (scoreMap[t.type] || 0) + t.weight;
  });

  let primaryType = EVIDENCE_TYPES.CHART; // default for images
  let maxScore = 0;
  for (const [type, score] of Object.entries(scoreMap)) {
    if (score > maxScore) {
      maxScore = score;
      primaryType = type;
    }
  }

  // If no hints at all and images uploaded, default to chart (let Gemini classify)
  if (types.length === 0 && images && images.length > 0) {
    primaryType = EVIDENCE_TYPES.CHART;
  }

  // If only documents and no images, it's a document
  if ((!images || images.length === 0) && documents && documents.length > 0 && types.length === 0) {
    primaryType = EVIDENCE_TYPES.DOCUMENT_FILE;
  }

  const confidence = maxScore >= 5 ? 'high' : maxScore >= 3 ? 'medium' : 'low';

  return {
    primaryType,
    confidence,
    allTypes: types,
    needsGeminiClassification: confidence === 'low' && images && images.length > 0
  };
}

module.exports = {
  EVIDENCE_TYPES,
  classifyEvidence,
  classifyFromMessage,
  classifyFromFilename,
  buildClassificationPrompt,
  buildAnalyzerPrompt
};
