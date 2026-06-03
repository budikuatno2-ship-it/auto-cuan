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
        var obHtml = await handleOrderbook(GEMINI_API_KEY, images, image, body.mimeType, chatMessage);
        return res.status(200).json({ html: obHtml, evidenceType: evidenceType, intent: 'orderbook_analysis' });
      }
      if (evidenceType === 'running_trade') {
        return res.status(200).json({
          html: '<p class="text-sm text-gray-300">Ini saya baca sebagai <strong class="text-emerald-400">running trade/tape</strong>. Analisis running trade detail akan dipulihkan bertahap.</p>',
          evidenceType: evidenceType
        });
      }
      if (evidenceType === 'broker_summary') {
        var bsHtml = await handleBrokerSummary(GEMINI_API_KEY, images, image, body.mimeType, chatMessage, body.context);
        return res.status(200).json({ html: bsHtml, evidenceType: evidenceType, intent: 'broker_summary_analysis' });
      }
      if (evidenceType === 'market_maker_code_reference') {
        var mmHtml = handleMMCode(chatMessage || '');
        return res.status(200).json({ html: mmHtml, evidenceType: evidenceType, intent: 'mm_code_analysis' });
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
        prompt = 'Kamu Auto-Cuan AI, asisten trading yang conversational dan thoughtful. User bertanya follow-up tentang saham. Jawab 150-350 kata, langsung ke inti. Gunakan format HTML (p, strong, ul, li) dengan class text-sm text-gray-300. Bahasa Indonesia santai tapi berisi. Berikan reasoning singkat, bukan hanya ya/tidak. Jika relevan sertakan level harga spesifik. Akhiri dengan satu kalimat natural jika data masih terbatas (jangan paksa mention orderbook/broker kecuali user tanya).';
        if (body.context && body.context.ticker) {
          prompt += ' Konteks: ' + body.context.ticker;
          if (body.context.currentPrice) prompt += ' Rp ' + body.context.currentPrice;
          if (body.context.finalDecision) prompt += ', Decision: ' + body.context.finalDecision;
          if (body.context.entryArea) prompt += ', Entry: ' + body.context.entryArea;
          if (body.context.stopLoss) prompt += ', SL: ' + body.context.stopLoss;
          if (body.context.takeProfits) prompt += ', TP: ' + body.context.takeProfits;
          prompt += '. Jawab berdasarkan konteks ini.';
        }
        if (!fcaConfirmed) prompt += ' JANGAN sebut FCA/Full Call Auction sama sekali.';
        maxTokens = 1024;
      } else if (intent === 'full_analysis_request') {
        prompt = 'Kamu Auto-Cuan AI. User minta analisis lengkap. Jawab conversational tapi terstruktur. Gunakan HTML (div, p, strong, ul, li) dengan class text-sm text-gray-300. Format jawaban: 1) Kesimpulan/Bias (1-2 kalimat), 2) Alasan (2-3 poin), 3) Level penting (support/resistance), 4) Trading plan (Entry, SL, TP1, TP2), 5) Risiko utama (1-2 poin). Jangan buat lebih dari 5 section. Jangan buat section kosong. Jangan terlalu panjang (max 800 kata). Bahasa Indonesia. Jika data terbatas, jujur bilang dan sarankan kirim chart/data tambahan di satu kalimat penutup yang natural.';
        if (body.context && body.context.ticker) {
          prompt += ' Ticker: ' + body.context.ticker;
          if (body.context.currentPrice) prompt += ' Rp ' + body.context.currentPrice;
        }
        if (!fcaConfirmed) prompt += ' JANGAN sebut FCA/Full Call Auction sama sekali.';
        maxTokens = 2048;
      } else {
        // normal_chat or ticker_price_basic
        prompt = 'Kamu Auto-Cuan AI, asisten analisis saham yang conversational dan thoughtful. Jawab dalam HTML (p, strong, ul, li) dengan class text-sm text-gray-300. Bahasa Indonesia santai tapi berisi. Jawab 200-400 kata. Struktur jawaban untuk pertanyaan saham: 1) Kesimpulan/Bias singkat, 2) Alasan (2-3 poin key reasoning), 3) Jika bisa estimasi: Entry, SL, TP1, TP2, 4) Risiko utama, 5) Satu kalimat penutup natural jika data terbatas. Jangan buat 15-section report. Jangan terlalu pendek tanpa reasoning. Jangan robotik. Jangan paksa mention broker/orderbook/news kecuali user tanya. Jika pertanyaan bukan soal saham spesifik (edukasi, konsep), jawab langsung tanpa format trading plan.';
        if (!fcaConfirmed) prompt += ' JANGAN sebut FCA/Full Call Auction sama sekali.';
        maxTokens = 1024;
      }

      var html = await callGemini(GEMINI_API_KEY, prompt, chatMessage, maxTokens);
      if (!html) return res.status(200).json({ html: '<p class="text-sm text-red-400">AI tidak tersedia saat ini.</p>' });
      return res.status(200).json({ html: sanitizeOutput(html, fcaConfirmed, intent), intent: intent });
    }

    // Ticker mode (from ticker input, not chat)
    if (ticker && currentPrice) {
      var tPrompt = 'Kamu Auto-Cuan AI, asisten analisis saham yang conversational dan thoughtful. User tanya saham ' + String(ticker).toUpperCase() + ' di harga Rp ' + currentPrice + '. Jawab 200-400 kata dalam HTML (p, strong, ul, li) dengan class text-sm text-gray-300. Berikan: 1) Bias singkat, 2) Estimasi support/resistance terdekat jika bisa, 3) Apakah menarik di harga ini atau belum, 4) Saran next step (upload chart untuk konfirmasi visual). Jangan buat report panjang. Bahasa Indonesia santai tapi berisi.' +
        (fcaConfirmed ? '' : ' JANGAN sebut FCA/Full Call Auction sama sekali.');
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


// === ORDERBOOK / BID-OFFER READER ===
async function handleOrderbook(apiKey, images, singleImage, mimeType, userMessage) {
  var prompt = 'Kamu Auto-Cuan AI. Ini gambar bid-offer/orderbook, BUKAN chart.\n\n' +
    'Analisis order flow dari gambar:\n' +
    '1. Kondisi bid (tebal/tipis/normal)\n' +
    '2. Kondisi offer (tebal/tipis/normal)\n' +
    '3. Spread (ketat/normal/lebar)\n' +
    '4. Likuiditas (aktif/tipis)\n' +
    '5. Apakah ada indikasi tekanan beli atau jual\n' +
    '6. Risiko false signal\n\n' +
    'ATURAN:\n' +
    '- JANGAN bilang ini chart yang tidak jelas\n' +
    '- Ini BUKAN chart, ini orderbook/bid-offer\n' +
    '- Jangan pernah bilang: pasti bandar, pasti fake, pasti naik, pasti turun\n' +
    '- Gunakan: terindikasi, belum bisa dikonfirmasi, perlu validasi\n' +
    '- Dari satu screenshot TIDAK bisa memastikan fake bid/fake offer\n' +
    '- Jika bid lebih tebal: "Bid terlihat lebih tebal, tetapi belum tentu support valid karena bisa saja berubah atau ditarik."\n' +
    '- Jika offer lebih tebal: "Offer terlihat lebih tebal, sehingga ada indikasi tekanan jual / sell wall, tetapi belum bisa dipastikan dari satu snapshot."\n' +
    '- Jika tipis: "Likuiditas terlihat tipis, jadi risiko false signal lebih tinggi."\n' +
    '- Jika spread lebar: "Spread terlihat lebar, sehingga risiko eksekusi lebih tinggi."\n' +
    '- Jika data tidak jelas: "Sebagian angka bid-offer belum terbaca jelas, jadi kesimpulannya masih terbatas."\n' +
    '- JANGAN sebut FCA\n\n' +
    'FORMAT OUTPUT: HTML Tailwind dark. Wrap dalam <div class="space-y-3">.\n' +
    'Gunakan text-sm text-gray-300, text-emerald-400, text-red-400, text-white.\n\n' +
    'Struktur jawaban:\n' +
    '1. Pembuka: "Ini saya baca sebagai bid-offer/orderbook, bukan chart."\n' +
    '2. Analisis singkat (kondisi bid, offer, spread, likuiditas, risiko)\n' +
    '3. Kesimpulan: salah satu label WAIT / WATCHLIST / SCALP ONLY / NEED CHART CONFIRMATION\n' +
    '4. Follow-up: "Kalau ada beberapa screenshot orderbook berurutan atau chart 1D/4H, kirim supaya bisa divalidasi lebih kuat."\n\n' +
    'Jawab conversational, BUKAN numbered report. Max 300 kata.';

  // Build image parts
  var parts = [{ text: prompt + (userMessage ? '\n\nUser: ' + userMessage : '') }];

  if (images && images.length > 0) {
    images.forEach(function(img) {
      var base64 = img.data || img.base64Data || '';
      if (base64.indexOf(',') !== -1) base64 = base64.split(',')[1];
      if (base64) parts.push({ inline_data: { mime_type: img.mimeType || 'image/png', data: base64 } });
    });
  } else if (singleImage) {
    var base64 = singleImage;
    if (base64.indexOf(',') !== -1) base64 = base64.split(',')[1];
    if (base64) parts.push({ inline_data: { mime_type: mimeType || 'image/png', data: base64 } });
  }

  var url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + apiKey;
  var payload = {
    contents: [{ parts: parts }],
    generationConfig: { temperature: 0.4, topP: 0.9, maxOutputTokens: 1536 }
  };

  try {
    var response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!response.ok) return '<p class="text-sm text-red-400">AI tidak tersedia untuk analisis orderbook saat ini.</p>';
    var result = await response.json();
    var candidates = result.candidates || [];
    if (candidates.length > 0 && candidates[0].content && candidates[0].content.parts && candidates[0].content.parts[0]) {
      var text = candidates[0].content.parts[0].text || '';
      text = text.replace(/^```html\s*/i, '').replace(/```\s*$/i, '');
      // Sanitize FCA just in case
      text = text.replace(/<[^>]*>[^<]*(?:FCA|Full\s*Call\s*Auction|papan\s*pemantauan\s*khusus)[^<]*<\/[^>]*>/gi, '');
      return text;
    }
    return '<p class="text-sm text-gray-300">Ini saya baca sebagai <strong class="text-emerald-400">bid-offer/orderbook</strong>, tetapi AI belum berhasil menganalisis detail. Coba lagi.</p>';
  } catch (e) {
    return '<p class="text-sm text-red-400">Terjadi kesalahan saat analisis orderbook.</p>';
  }
}

// === BROKER SUMMARY READER ===
async function handleBrokerSummary(apiKey, images, singleImage, mimeType, userMessage, context) {
  var prompt = 'Kamu Auto-Cuan AI. Ini data broker summary, BUKAN chart.\n\n' +
    'Analisis broker flow dari gambar/teks:\n' +
    '1. Periode (Today/7D/1M/3M) jika terlihat\n' +
    '2. Top net buyer (broker code + value jika terlihat)\n' +
    '3. Top net seller (broker code + value jika terlihat)\n' +
    '4. Konsentrasi (High: 1-2 broker dominan >50%, Medium: 3-5 broker, Low: tersebar)\n' +
    '5. Klasifikasi: Akumulasi / Distribusi / Rotasi / Retail-driven / Unclear\n' +
    '6. Dampak ke analisis jika ada konteks chart sebelumnya\n\n' +
    'ATURAN:\n' +
    '- Ini BUKAN chart, ini broker summary\n' +
    '- JANGAN bilang gambar chart tidak jelas\n' +
    '- Broker summary hanya menunjukkan aktivitas melalui broker, BUKAN identitas bandar sebenarnya\n' +
    '- Jangan pernah bilang: bandar pasti akumulasi, pasti distribusi, pasti naik, pasti turun\n' +
    '- Gunakan: terindikasi akumulasi, indikasi distribusi, mixed/rotasi, belum cukup memastikan\n' +
    '- Jika data tidak lengkap/terbaca: "Sebagian data broker summary belum terbaca jelas"\n' +
    '- Jika periode tidak jelas: "Periode belum bisa dikonfirmasi dari data yang diberikan"\n' +
    '- JANGAN sebut FCA\n\n';

  // Add chart context if available
  if (context && context.ticker) {
    prompt += 'KONTEKS SESI: Ticker ' + context.ticker;
    if (context.currentPrice) prompt += ', Harga Rp ' + context.currentPrice;
    if (context.finalDecision) prompt += ', Keputusan chart: ' + context.finalDecision;
    prompt += '\nGunakan konteks chart ini untuk menilai apakah broker summary memperkuat atau melemahkan setup.\n';
    prompt += '- Chart bullish + akumulasi broker = confidence naik\n';
    prompt += '- Chart bearish + akumulasi broker = WATCHLIST, belum tentu reversal\n';
    prompt += '- Chart bullish + distribusi broker = hati-hati, possible bull trap\n';
    prompt += '- Chart bearish + distribusi broker = risiko bertambah\n\n';
  }

  prompt += 'FORMAT OUTPUT: HTML Tailwind dark. Wrap dalam <div class="space-y-3">.\n' +
    'Gunakan text-sm text-gray-300, text-emerald-400, text-red-400, text-white.\n\n' +
    'Struktur jawaban:\n' +
    '1. Pembuka: "Ini saya baca sebagai broker summary. Broker summary hanya menunjukkan aktivitas melalui broker, bukan identitas bandar sebenarnya."\n' +
    '2. Broker Summary Check (periode, net buyer/seller, bias, strength, catatan)\n' +
    '3. Dampak ke analisis (jika ada konteks chart)\n' +
    '4. Kesimpulan: WAIT / WATCHLIST / NEED CHART CONFIRMATION\n' +
    '5. Follow-up: saran kirim chart atau periode lain\n\n' +
    'Jawab conversational, BUKAN numbered report. Max 400 kata.';

  // Build image parts
  var parts = [{ text: prompt + (userMessage ? '\n\nUser: ' + userMessage : '') }];

  if (images && images.length > 0) {
    images.forEach(function(img) {
      var base64 = img.data || img.base64Data || '';
      if (base64.indexOf(',') !== -1) base64 = base64.split(',')[1];
      if (base64) parts.push({ inline_data: { mime_type: img.mimeType || 'image/png', data: base64 } });
    });
  } else if (singleImage) {
    var base64 = singleImage;
    if (base64.indexOf(',') !== -1) base64 = base64.split(',')[1];
    if (base64) parts.push({ inline_data: { mime_type: mimeType || 'image/png', data: base64 } });
  }

  var url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + apiKey;
  var payload = {
    contents: [{ parts: parts }],
    generationConfig: { temperature: 0.4, topP: 0.9, maxOutputTokens: 1536 }
  };

  try {
    var response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!response.ok) return '<p class="text-sm text-red-400">AI tidak tersedia untuk analisis broker summary saat ini.</p>';
    var result = await response.json();
    var candidates = result.candidates || [];
    if (candidates.length > 0 && candidates[0].content && candidates[0].content.parts && candidates[0].content.parts[0]) {
      var text = candidates[0].content.parts[0].text || '';
      text = text.replace(/^```html\s*/i, '').replace(/```\s*$/i, '');
      text = text.replace(/<[^>]*>[^<]*(?:FCA|Full\s*Call\s*Auction|papan\s*pemantauan\s*khusus)[^<]*<\/[^>]*>/gi, '');
      return text;
    }
    return '<p class="text-sm text-gray-300">Ini saya baca sebagai <strong class="text-emerald-400">broker summary</strong>, tetapi AI belum berhasil menganalisis detail. Coba lagi.</p>';
  } catch (e) {
    return '<p class="text-sm text-red-400">Terjadi kesalahan saat analisis broker summary.</p>';
  }
}

// === MARKET MAKER CODE MAPPING ===
var MM_CODES = {
  '666': { meaning: 'Akhir dari mark up, potensi jual segera, risiko turun dalam.', bias: 'DISTRIBUTION', strength: 'HIGH' },
  '400': { meaning: 'Saham cenderung sideways / belum bergerak jelas.', bias: 'SIDEWAYS', strength: 'MEDIUM' },
  '999': { meaning: 'Harga diduga sudah di puncak, risiko distribusi / perubahan drastis.', bias: 'DISTRIBUTION', strength: 'HIGH' },
  '500': { meaning: 'Potensi menuju gap up atau gap down, butuh kode/konfirmasi lanjutan.', bias: 'UNKNOWN', strength: 'MEDIUM' },
  '777': { meaning: 'Referensi bullish / potensi harga naik tinggi.', bias: 'ACCUM', strength: 'HIGH' },
  '200': { meaning: 'Indikasi butuh saham untuk dibeli, tetapi jangan turunkan harga drastis.', bias: 'ACCUM', strength: 'MEDIUM' },
  '2100': { meaning: 'Let it run, tahan selama tren masih valid.', bias: 'ACCUM', strength: 'MEDIUM' },
  '555': { meaning: 'Gap up / beli sebelum naik / potensi fase akumulasi mingguan.', bias: 'ACCUM', strength: 'HIGH' },
  '888': { meaning: 'Sell on strength / jual saat harga diangkat.', bias: 'DISTRIBUTION', strength: 'HIGH' },
  '404': { meaning: 'Risiko turun dalam kondisi sideways, bisa muncul sebelum turun / ARB.', bias: 'WARNING', strength: 'HIGH' },
  '911': { meaning: 'Pending news / menunggu news keluar / harga ditahan menjelang news.', bias: 'WARNING', strength: 'MEDIUM' },
  '100': { meaning: 'Membutuhkan saham untuk dibeli.', bias: 'ACCUM', strength: 'MEDIUM' },
  '700': { meaning: 'Harga berpotensi naik, tetapi tetap butuh validasi.', bias: 'ACCUM', strength: 'MEDIUM' }
};

// === MARKET MAKER CODE READER ===
function handleMMCode(text) {
  var detected = detectMMCodes(text);

  if (detected.length === 0) {
    return '<div class="space-y-3"><p class="text-sm text-gray-300">Ini saya baca sebagai referensi <strong class="text-emerald-400">kode market maker/kode bandar</strong>. Ini hanya referensi tambahan, bukan sinyal pasti.</p><p class="text-sm text-gray-400">Tidak ada kode yang valid terdeteksi dari teks yang diberikan. Coba sebutkan kode spesifik (contoh: 777, 666, 999) atau kirim screenshot orderbook/running trade.</p></div>';
  }

  var html = '<div class="space-y-3">';
  html += '<p class="text-sm text-gray-300">Ini saya baca sebagai kode market maker/kode bandar. Ini hanya <strong class="text-yellow-400">referensi tambahan</strong>, bukan sinyal pasti.</p>';

  detected.forEach(function(item) {
    var biasColor = item.bias === 'ACCUM' ? 'text-emerald-400' : item.bias === 'DISTRIBUTION' ? 'text-red-400' : 'text-yellow-400';
    html += '<div class="bg-[#151a23] rounded-lg p-3 border border-[#1c2333]">';
    html += '<p class="text-sm text-white font-semibold">Kode: ' + item.code + (item.location ? ' <span class="text-gray-400 font-normal">(' + item.location + ')</span>' : '') + '</p>';
    html += '<p class="text-sm text-gray-300">Arti: ' + item.meaning + '</p>';
    html += '<p class="text-sm ' + biasColor + '">Bias: ' + item.bias + ' | Strength: ' + item.strength + '</p>';
    html += '<p class="text-xs text-gray-500">Confidence: ' + item.confidence + '</p>';
    html += '</div>';
  });

  html += '<p class="text-sm text-gray-400 italic">Kode ini baru terlihat dari satu snapshot/teks, jadi belum bisa dipastikan valid atau hanya muncul sesaat. Perlu validasi chart/orderbook.</p>';
  html += '<p class="text-sm text-gray-300"><strong class="text-white">Kesimpulan:</strong> WATCHLIST — kode hanya secondary reference, butuh konfirmasi price action.</p>';
  html += '<p class="text-xs text-gray-500">Kalau ada chart 1D/4H atau beberapa screenshot orderbook berurutan, kirim supaya kode ini bisa divalidasi dengan price action dan order flow.</p>';
  html += '</div>';

  return html;
}

function detectMMCodes(text) {
  if (!text) return [];
  var results = [];
  var seen = {};

  // Detect location context
  var locationHint = 'unknown';
  if (/\b(bid|beli|buyer)\b/i.test(text)) locationHint = 'bid';
  else if (/\b(offer|jual|seller)\b/i.test(text)) locationHint = 'offer';
  else if (/\b(freq|frekuensi|frequency)\b/i.test(text)) locationHint = 'freq';
  else if (/\b(lot)\b/i.test(text)) locationHint = 'lot';
  else if (/\b(running|trade|tape)\b/i.test(text)) locationHint = 'running trade';

  // Detect confidence hints
  var isRepeated = /\b(berulang|repeated|muncul.*lagi|terus.*muncul)\b/i.test(text);
  var isThin = /\b(tipis|thin|sepi|illiquid)\b/i.test(text);
  var isFast = /\b(fast|cepat|aktif|ramai)\b/i.test(text);

  var baseConfidence = 'Low';
  if (isRepeated) baseConfidence = 'Medium';
  if (isThin) baseConfidence = 'Low';
  if (isFast && !isThin) baseConfidence = 'Medium';

  // Check 4-digit codes first (2100)
  var match4 = text.match(/\b(2100)\b/g);
  if (match4) {
    match4.forEach(function(m) {
      if (!seen[m] && MM_CODES[m]) {
        seen[m] = true;
        results.push({ code: m, meaning: MM_CODES[m].meaning, bias: MM_CODES[m].bias, strength: MM_CODES[m].strength, location: locationHint, confidence: baseConfidence });
      }
    });
  }

  // Check 3-digit codes
  var match3 = text.match(/\b(100|200|400|404|500|555|666|700|777|888|911|999)\b/g);
  if (match3) {
    match3.forEach(function(m) {
      if (!seen[m] && MM_CODES[m]) {
        seen[m] = true;
        results.push({ code: m, meaning: MM_CODES[m].meaning, bias: MM_CODES[m].bias, strength: MM_CODES[m].strength, location: locationHint, confidence: baseConfidence });
      }
    });
  }

  // Check last 3 digits of larger numbers (e.g. 10,777 -> 777)
  var matchLarge = text.match(/\d{1,3}[.,]?(777|666|999|555|888|404|911)\b/g);
  if (matchLarge) {
    matchLarge.forEach(function(m) {
      var last3 = m.slice(-3);
      if (!seen[last3] && MM_CODES[last3]) {
        seen[last3] = true;
        results.push({ code: last3 + ' (dari ' + m + ')', meaning: MM_CODES[last3].meaning, bias: MM_CODES[last3].bias, strength: MM_CODES[last3].strength, location: locationHint, confidence: 'Low' });
      }
    });
  }

  return results;
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
