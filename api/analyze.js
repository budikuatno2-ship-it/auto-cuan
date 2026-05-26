/**
 * Auto-Cuan Analyze API — Minimal real implementation
 * Single file, no local lib deps, deployment-safe.
 * Includes: Intent Router, Output Sanitizer, FCA Guard.
 */

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.body || {};
    const { ticker, currentPrice, source, chatMessage, image, images } = body;

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
      return res.status(200).json({
        html: '<p class="text-sm text-yellow-400">Gemini API belum dikonfigurasi. Hubungi admin.</p>'
      });
    }

    // Image/file upload — classify evidence type first
    if (source === 'chart_upload' && (image || (images && images.length > 0))) {
      var evidenceType = classifyEvidence(chatMessage || '', images, body.documents);

      if (evidenceType === 'chart') {
        return res.status(200).json({
          html: '<p class="text-sm text-gray-300">Chart diterima. Analisis chart visual sedang dipulihkan bertahap. Sementara gunakan mode Nama Saham (ticker + harga) untuk analisis teks.</p>',
          evidenceType: evidenceType
        });
      }
      if (evidenceType === 'orderbook_bid_offer') {
        return res.status(200).json({
          html: '<p class="text-sm text-gray-300">Ini saya baca sebagai <strong class="text-emerald-400">bid-offer/orderbook</strong>. Analisis order flow detail akan dipulihkan bertahap.</p>',
          evidenceType: evidenceType
        });
      }
      if (evidenceType === 'running_trade') {
        return res.status(200).json({
          html: '<p class="text-sm text-gray-300">Ini saya baca sebagai <strong class="text-emerald-400">running trade/tape</strong>. Analisis running trade detail akan dipulihkan bertahap.</p>',
          evidenceType: evidenceType
        });
      }
      if (evidenceType === 'broker_summary') {
        return res.status(200).json({
          html: '<p class="text-sm text-gray-300">Ini saya baca sebagai <strong class="text-emerald-400">broker summary</strong>. Analisis broker detail akan dipulihkan bertahap.</p>',
          evidenceType: evidenceType
        });
      }
      if (evidenceType === 'market_maker_code_reference') {
        return res.status(200).json({
          html: '<p class="text-sm text-gray-300">Ini saya baca sebagai <strong class="text-emerald-400">referensi kode market maker/kode bandar</strong>. Mapping kode akan dipulihkan bertahap.</p>',
          evidenceType: evidenceType
        });
      }
      if (evidenceType === 'news_or_corporate_action') {
        return res.status(200).json({
          html: '<p class="text-sm text-gray-300">Ini saya baca sebagai <strong class="text-emerald-400">news/corporate action</strong>. Dampaknya bisa mengubah penilaian setelah fitur reader dipulihkan.</p>',
          evidenceType: evidenceType
        });
      }
      // unknown
      return res.status(200).json({
        html: '<p class="text-sm text-gray-300">Ini gambar/data jenis apa: chart, bid-offer, running trade, broker summary, atau news? Ketik keterangan supaya saya bisa analisis dengan benar.</p>',
        evidenceType: 'unknown'
      });
    }

    // Determine FCA status
    var fcaConfirmed = isFCAConfirmed(body.fcaStatus, chatMessage || '');

    // Chat mode — use Intent Router
    if (source === 'chat_mode' && chatMessage) {
      var intent = routeIntent(chatMessage, body.context);
      var prompt;
      var maxTokens = 1024;

      if (intent === 'ticker_only') {
        // Just a ticker, ask for price
        return res.status(200).json({
          html: '<p class="text-sm text-gray-300"><strong class="text-emerald-400">' + chatMessage.trim().toUpperCase() + '</strong> terdeteksi. Harga sekarang berapa? Contoh: "WMUU 58"</p>',
          intent: intent
        });
      }

      if (intent === 'follow_up_question') {
        prompt = 'Kamu Auto-Cuan AI, teman trading santai. User bertanya follow-up. Jawab langsung 100-300 kata, to the point. HTML (p, strong, ul, li). Bahasa Indonesia santai.';
        if (body.context && body.context.ticker) {
          prompt += ' Konteks: ' + body.context.ticker;
          if (body.context.currentPrice) prompt += ' Rp ' + body.context.currentPrice;
          if (body.context.finalDecision) prompt += ', ' + body.context.finalDecision;
          if (body.context.entryArea) prompt += ', Entry: ' + body.context.entryArea;
          if (body.context.stopLoss) prompt += ', SL: ' + body.context.stopLoss;
          if (body.context.takeProfits) prompt += ', TP: ' + body.context.takeProfits;
          prompt += '. Jawab dari konteks ini.';
        }
        if (!fcaConfirmed) prompt += ' JANGAN sebut FCA.';
        maxTokens = 1024;
      } else if (intent === 'full_analysis_request') {
        prompt = 'Kamu Auto-Cuan AI. User minta analisis lengkap. Jawab terstruktur tapi tetap conversational. Sertakan: kesimpulan, level penting, entry/SL/TP, risiko, action plan. HTML (div, p, strong, ul, li). Max 1200 kata.';
        if (body.context && body.context.ticker) {
          prompt += ' Ticker: ' + body.context.ticker;
          if (body.context.currentPrice) prompt += ' Rp ' + body.context.currentPrice;
        }
        if (!fcaConfirmed) prompt += ' JANGAN sebut FCA.';
        maxTokens = 2048;
      } else {
        // normal_chat or ticker_price_basic
        prompt = 'Kamu Auto-Cuan AI, teman trading santai. Jawab singkat dalam HTML (p, strong, ul, li). Bahasa Indonesia. Jangan format report.';
        if (!fcaConfirmed) prompt += ' JANGAN sebut FCA/Full Call Auction.';
        maxTokens = 1024;
      }

      var html = await callGemini(GEMINI_API_KEY, prompt, chatMessage, maxTokens);
      if (!html) return res.status(200).json({ html: '<p class="text-sm text-red-400">AI tidak tersedia saat ini.</p>' });
      return res.status(200).json({ html: sanitizeOutput(html, fcaConfirmed, intent), intent: intent });
    }

    // Ticker mode (from ticker input, not chat)
    if (ticker && currentPrice) {
      var tPrompt = 'Kamu Auto-Cuan AI. User tanya ' + String(ticker).toUpperCase() + ' harga Rp ' + currentPrice + '. Jawab singkat: estimasi support/resistance, saran upload chart. HTML (p, strong).' +
        (fcaConfirmed ? '' : ' JANGAN sebut FCA/Full Call Auction.');
      var tHtml = await callGemini(GEMINI_API_KEY, tPrompt, '', 1024);
      if (!tHtml) {
        return res.status(200).json({ html: '<p class="text-sm text-gray-300"><strong>' + String(ticker).toUpperCase() + '</strong> Rp ' + currentPrice + ' — Upload chart 1W/1D/4H untuk analisis lengkap.</p>' });
      }
      return res.status(200).json({ html: sanitizeOutput(tHtml, fcaConfirmed, 'ticker_price_basic'), intent: 'ticker_price_basic' });
    }

    return res.status(400).json({ error: 'Kirim ticker+harga atau gunakan mode chat/upload.' });

  } catch (err) {
    console.error('analyze error:', err);
    return res.status(200).json({ html: '<p class="text-sm text-red-400">Terjadi kesalahan. Coba lagi.</p>' });
  }
};

async function callGemini(apiKey, systemPrompt, userMessage, maxTokens) {
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + apiKey;
  var payload = {
    contents: [{ parts: [{ text: systemPrompt + (userMessage ? '\n\nUser: ' + userMessage : '') }] }],
    generationConfig: { temperature: 0.6, topP: 0.9, maxOutputTokens: maxTokens || 1024 }
  };

  var response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) return null;
  var result = await response.json();
  var candidates = result.candidates || [];
  if (candidates.length > 0 && candidates[0].content && candidates[0].content.parts && candidates[0].content.parts[0]) {
    var text = candidates[0].content.parts[0].text || '';
    return text.replace(/^```html\s*/i, '').replace(/```\s*$/i, '');
  }
  return null;
}

// === INTENT ROUTER ===
function routeIntent(message, context) {
  var msg = String(message || '').trim();
  var msgLower = msg.toLowerCase();

  // Full analysis request
  if (/analisis\s*(lengkap|penuh|detail|full|mendalam)|full\s*analysis|deep\s*analysis|bahas\s*(semua|lengkap|detail)/i.test(msgLower)) {
    return 'full_analysis_request';
  }

  // Follow-up patterns (short conversational questions)
  if (context && context.ticker) {
    if (/^(bagus|aman|mantap|oke|ok)\s*(gak|ga|nggak|tidak|kah|dong|sih)?\s*\??$/i.test(msg)) return 'follow_up_question';
    if (/^(gimana|gmn|gmana)\s*(nih|ini|tuh|dong)?\s*\??$/i.test(msg)) return 'follow_up_question';
    if (/^(entry|masuk|beli|buy)\s*(di\s*)?mana\s*\??$/i.test(msg)) return 'follow_up_question';
    if (/^(tp|take\s*profit|target|sl|stop\s*loss|cut\s*loss)\s*(berapa|mana|di\s*mana)?\s*\??$/i.test(msg)) return 'follow_up_question';
    if (/^(tp|sl|tp\s*sl|sl\s*tp)\s*\??$/i.test(msg)) return 'follow_up_question';
    if (/^(hold|tahan|pegang)\s*(atau|apa)\s*(cut|jual|lepas)?\s*\??$/i.test(msg)) return 'follow_up_question';
    if (/^(nambah|tambah|averaging)\s*(gak|ga|boleh|bisa)?\s*\??$/i.test(msg)) return 'follow_up_question';
    if (/^(lanjut|terus|next)\s*(gak|ga|gimana)?\s*\??$/i.test(msg)) return 'follow_up_question';
    if (/^(cut|jual|lepas|keluar)\s*(gak|ga|aja|sekarang)?\s*\??$/i.test(msg)) return 'follow_up_question';
    if (/^(risky|risiko|bahaya)\s*(gak|ga|tinggi)?\s*\??$/i.test(msg)) return 'follow_up_question';
    if (/^(worth|layak)\s*(beli|buy|entry|masuk)?\s*(gak|ga)?\s*\??$/i.test(msg)) return 'follow_up_question';
    // Short message with question mark when context exists
    if (msg.length < 40 && msg.includes('?')) return 'follow_up_question';
  }

  // Ticker only (1-5 uppercase letters, nothing else)
  if (/^[A-Z]{1,5}$/i.test(msg) && msg.length <= 5) {
    return 'ticker_only';
  }

  // Ticker + price pattern in message
  if (/\b[A-Z]{3,5}\b.*\b\d{2,6}\b/i.test(msg) || /harga\s*\d/i.test(msg)) {
    return 'ticker_price_basic';
  }

  return 'normal_chat';
}

// === OUTPUT SANITIZER ===
function sanitizeOutput(html, fcaConfirmed, intent) {
  if (!html) return html;
  var output = html;

  // A. FCA Guard — remove all FCA content if not confirmed
  if (!fcaConfirmed) {
    output = output.replace(/<(?:p|li|span|strong|div|h[1-6])[^>]*>[^<]*(?:FCA|Full\s*Call\s*Auction|papan\s*pemantauan\s*khusus|saham\s*FCA|risiko\s*FCA|FCA\s*score\s*cap|Position\s*Sizing\s*FCA|PERINGATAN\s*FCA)[^<]*<\/(?:p|li|span|strong|div|h[1-6])>/gi, '');
    output = output.replace(/(?:Status\s+FCA\s*:\s*[^<.]*\.?)/gi, '');
  }

  // B. Remove report-style headers (unless full_analysis_request)
  if (intent !== 'full_analysis_request') {
    output = output.replace(/\d+\.\s*INPUT QUALITY[^<]*/gi, '');
    output = output.replace(/\d+\.\s*TECHNICAL ANALYSIS[^<]*/gi, '');
    output = output.replace(/\d+\.\s*RISK MANAGEMENT[^<]*/gi, '');
    output = output.replace(/\d+\.\s*SCORE\s*&?\s*DECISION[^<]*/gi, '');
    output = output.replace(/\d+\.\s*WHAT COULD GO WRONG[^<]*/gi, '');
    output = output.replace(/\d+\.\s*ACTION PLAN[^<]*/gi, '');
    output = output.replace(/INPUT QUALITY\s*&?\s*EVIDENCE SUMMARY[^<]*/gi, '');
  }

  // C. Remove empty paragraphs left over
  output = output.replace(/<p[^>]*>\s*<\/p>/gi, '');

  return output;
}

// === FCA STATUS CHECK ===
function isFCAConfirmed(bodyFcaStatus, message) {
  // Confirmed by system (from frontend FCA mapping or previous confirmation)
  if (bodyFcaStatus === 'confirmed_by_mapping' ||
      bodyFcaStatus === 'confirmed_by_user' ||
      bodyFcaStatus === 'confirmed_by_uploaded_evidence') {
    return true;
  }
  // Confirmed by user explicitly mentioning FCA in message
  if (message && /\b(?:FCA|full\s*call\s*auction|papan\s*pemantauan\s*khusus|saham\s*ini\s*FCA|masuk\s*FCA)\b/i.test(message)) {
    return true;
  }
  return false;
}


// === EVIDENCE CLASSIFIER ===
function classifyEvidence(message, images, documents) {
  var hints = (message || '').toLowerCase();

  // Also check filenames
  if (images && images.length > 0) {
    images.forEach(function(img) {
      if (img.filename) hints += ' ' + img.filename.toLowerCase();
    });
  }
  if (documents && documents.length > 0) {
    documents.forEach(function(doc) {
      if (doc.filename) hints += ' ' + doc.filename.toLowerCase();
      if (doc.text) hints += ' ' + doc.text.slice(0, 300).toLowerCase();
    });
  }

  // Check document file types first
  if (/\.(pdf|doc|docx|xls|xlsx|csv|txt)\b/.test(hints)) {
    // Could be broker data, news, or generic doc — check content
    if (/broker|net\s*buy|net\s*sell|top\s*buyer|top\s*seller|avg/i.test(hints)) return 'broker_summary';
    if (/news|berita|corporate\s*action|aksi\s*korporasi|rights?\s*issue|private\s*placement|dividen|merger|akuisisi|suspensi|uma|pkpu|buyback|inbreng/i.test(hints)) return 'news_or_corporate_action';
    return 'document_file';
  }

  // Orderbook / bid-offer
  if (/\b(orderbook|order\s*book|bid.?offer|antrian|queue|lot\s*bid|lot\s*offer|harga\s*bid|harga\s*offer)\b/.test(hints)) return 'orderbook_bid_offer';

  // Running trade
  if (/\b(running\s*trade|trade\s*print|fast\s*tape|tape\s*reading|transaksi\s*berjalan)\b/.test(hints)) return 'running_trade';

  // Broker summary
  if (/\b(broker\s*summary|top\s*buyer|top\s*seller|net\s*buy|net\s*sell|bandarmology|broker\s*akum|broker\s*distribusi|data\s*broker)\b/.test(hints)) return 'broker_summary';

  // Market maker code
  if (/\b(kode\s*bandar|kode\s*market\s*maker|kode\s*mm|mm\s*code|market\s*maker)\b/.test(hints)) return 'market_maker_code_reference';
  if (/\b(777|666|999|555|888|404|911|2100)\b/.test(hints) && /\b(kode|code|arti|meaning|bandar)\b/.test(hints)) return 'market_maker_code_reference';

  // News / corporate action
  if (/\b(news|berita|corporate\s*action|aksi\s*korporasi|rights?\s*issue|private\s*placement|dividen|dividend|merger|akuisisi|acquisition|suspensi|suspension|uma|pkpu|buyback|inbreng|tender\s*offer|delisting)\b/.test(hints)) return 'news_or_corporate_action';

  // Chart (explicit keywords)
  if (/\b(chart|tradingview|candle|candlestick|timeframe|1w|1d|4h|1h|15m|weekly|daily|support|resistance|bos|choch|order\s*block|demand|supply|fvg)\b/.test(hints)) return 'chart';

  // Default for image uploads without text hints = chart (most common)
  if (images && images.length > 0) return 'chart';

  return 'unknown';
}
