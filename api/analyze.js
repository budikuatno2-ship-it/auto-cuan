/**
 * Auto-Cuan Analyze API — Minimal real implementation (no local lib deps)
 * Deployment-safe: single file, no require('./lib/...'), no heavy init.
 */

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { ticker, currentPrice, source, chatMessage, image, images, fcaStatus } = req.body || {};

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
      return res.status(200).json({
        html: '<p class="text-sm text-yellow-400">Gemini API belum dikonfigurasi. Hubungi admin.</p>',
        error: 'no_api_key'
      });
    }

    const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

    // === CHAT MODE ===
    if (source === 'chat_mode' && chatMessage) {
      return await handleChat(res, GEMINI_URL, chatMessage, req.body.context);
    }

    // === IMAGE UPLOAD MODE ===
    if (source === 'chart_upload' && (image || (images && images.length > 0))) {
      return await handleImage(res, GEMINI_URL, req.body);
    }

    // === TICKER MODE ===
    if (ticker && currentPrice) {
      return await handleTicker(res, GEMINI_URL, ticker.toUpperCase(), parseFloat(currentPrice), fcaStatus);
    }

    return res.status(400).json({ error: 'Ticker dan harga wajib diisi, atau gunakan mode chat/upload.' });

  } catch (error) {
    console.error('analyze error:', error.message);
    return res.status(200).json({
      html: '<p class="text-sm text-red-400">Terjadi kesalahan server. Coba lagi.</p>',
      error: error.message
    });
  }
};

// === CHAT HANDLER ===
async function handleChat(res, geminiUrl, message, context) {
  let systemPrompt = `Kamu adalah Auto-Cuan AI, teman trading yang pintar dan santai. Paham SMC, analisis teknikal, pasar IDX/BEI.

GAYA: Bahasa Indonesia natural, santai, to the point. JANGAN format report/numbered list. Jawab seperti chat.
FORMAT OUTPUT: HTML sederhana (<p>, <strong>, <ul>, <li>). Class: text-sm text-gray-300.
ATURAN FCA: JANGAN sebut FCA kecuali user eksplisit menyebut FCA.
Disclaimer: 1 kalimat pendek di akhir jika perlu.`;

  if (context && typeof context === 'object' && context.ticker) {
    systemPrompt += `\n\nKonteks sesi: Ticker ${context.ticker}`;
    if (context.currentPrice) systemPrompt += `, Harga Rp ${context.currentPrice}`;
    if (context.finalDecision) systemPrompt += `, Keputusan: ${context.finalDecision}`;
    if (context.score) systemPrompt += `, Score: ${context.score}`;
    if (context.entryArea) systemPrompt += `, Entry: ${context.entryArea}`;
    if (context.stopLoss) systemPrompt += `, SL: ${context.stopLoss}`;
    if (context.takeProfits) systemPrompt += `, TP: ${context.takeProfits}`;
    systemPrompt += `\nGunakan konteks ini langsung. Jangan tanya ulang.`;
  }

  const html = await callGemini(geminiUrl, systemPrompt, message, null, {
    temperature: 0.6, topP: 0.9, topK: 40, maxOutputTokens: 2048
  });

  if (!html) return res.status(200).json({ html: '<p class="text-sm text-red-400">AI tidak tersedia. Coba lagi.</p>' });
  return res.status(200).json({ html, intent: 'chat' });
}

// === IMAGE HANDLER ===
async function handleImage(res, geminiUrl, body) {
  const { image, images, ticker, currentPrice, chatMessage, fcaStatus } = body;

  const imageArray = [];
  if (images && images.length > 0) {
    images.forEach(function(img) { imageArray.push(img); });
  } else if (image) {
    imageArray.push({ data: image, mimeType: body.mimeType || 'image/png' });
  }

  if (imageArray.length === 0) {
    return res.status(200).json({ html: '<p class="text-sm text-gray-400">Tidak ada gambar yang diterima.</p>' });
  }

  var safeTicker = ticker ? String(ticker).replace(/[^A-Za-z]/g, '').slice(0, 10).toUpperCase() : '';
  var safePrice = currentPrice ? String(currentPrice).replace(/[^0-9.]/g, '').slice(0, 15) : '';
  var fca = (fcaStatus === 'confirmed_by_mapping' || fcaStatus === 'confirmed_by_user' || fcaStatus === 'confirmed_by_uploaded_evidence') ? fcaStatus : 'not_detected';

  var prompt = 'Kamu adalah Auto-Cuan AI, teman trading pintar. Analisis gambar berikut.\n\n' +
    'PERTAMA, klasifikasikan gambar ini:\n' +
    '- CHART (candlestick, price scale, timeframe)\n' +
    '- ORDERBOOK/BID-OFFER (bid, offer, lot, antrian)\n' +
    '- RUNNING TRADE (trade prints, time, price, lot)\n' +
    '- BROKER SUMMARY (top buyer/seller, net buy/sell, broker code)\n' +
    '- MARKET MAKER CODE (tabel kode 777/666/999/dll)\n' +
    '- NEWS (berita, pengumuman, corporate action)\n' +
    '- UNKNOWN\n\n' +
    'Lalu analisis sesuai tipe:\n' +
    '- Chart: kesimpulan + entry + SL + TP + 3 skenario (Agresif/Moderat/Konservatif)\n' +
    '- Orderbook: kondisi bid/offer, spread, likuiditas, fast tape\n' +
    '- Running trade: kecepatan, dominasi, indikasi\n' +
    '- Broker summary: klasifikasi akumulasi/distribusi, top broker\n' +
    '- MM Code: kode terdeteksi + arti + confidence\n' +
    '- News: bias impact + strength + dampak ke analisis\n\n' +
    'GAYA: Conversational, BUKAN numbered report. Bahasa Indonesia santai.\n' +
    'FORMAT: HTML Tailwind dark (<div class="space-y-3">, text-sm text-gray-300, text-emerald-400, text-red-400).\n' +
    'FCA: ' + (fca === 'not_detected' ? 'DILARANG sebut FCA.' : 'FCA confirmed: ' + fca) + '\n' +
    (safeTicker ? 'Ticker: ' + safeTicker + '\n' : '') +
    (safePrice ? 'Harga: Rp ' + safePrice + '\n' : '') +
    '\nJika gambar BUKAN chart, JANGAN bilang "chart tidak bisa dianalisis". Analisis sesuai tipe.\n' +
    'Jika tidak bisa diklasifikasikan: "Gambar belum bisa diklasifikasikan. Ini chart, bid-offer, running trade, broker summary, atau news?"\n\n' +
    'Labels: AVOID|WAIT|WATCHLIST|NEED CHART CONFIRMATION|SPECULATIVE BUY|BUY ON CONFIRMATION|BUY ON PULLBACK|SCALP ONLY|SWING VALID|HOLD|TAKE PROFIT PARTIAL|CUT LOSS/EXIT\n' +
    'Disclaimer 1 kalimat di akhir.';

  var html = await callGemini(geminiUrl, prompt, chatMessage || '', imageArray, {
    temperature: 0.4, topP: 0.95, topK: 40, maxOutputTokens: 4096
  });

  if (!html || html.trim().length < 50) {
    return res.status(200).json({ html: '<div class="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4 text-center"><p class="text-yellow-400 font-semibold">AI belum berhasil menganalisis gambar.</p><p class="text-sm text-gray-400 mt-2">Coba lagi atau pastikan gambar cukup jelas.</p></div>' });
  }

  // Basic FCA sanitizer inline
  var output = html;
  if (fca === 'not_detected') {
    output = output.replace(/<[^>]*>[^<]*(?:FCA|Full\s*Call\s*Auction|papan\s*pemantauan\s*khusus)[^<]*<\/[^>]*>/gi, '');
  }

  return res.status(200).json({ html: output, intent: 'image_analysis' });
}

// === TICKER HANDLER ===
async function handleTicker(res, geminiUrl, ticker, price, fcaStatus) {
  var fca = (fcaStatus === 'confirmed_by_mapping' || fcaStatus === 'confirmed_by_user' || fcaStatus === 'confirmed_by_uploaded_evidence') ? fcaStatus : 'not_detected';

  var prompt = 'Kamu adalah Auto-Cuan AI, teman trading pintar. User tanya tentang ' + ticker + ' harga Rp ' + price + '.\n\n' +
    'GAYA: Conversational, santai, to the point. BUKAN numbered report.\n' +
    'ATURAN: Tanpa chart, jawab singkat: kesimpulan + estimasi level + saran upload chart.\n' +
    'FCA: ' + (fca === 'not_detected' ? 'DILARANG sebut FCA.' : 'FCA confirmed.') + '\n' +
    'Score max: 55 (tanpa chart). Label: WAIT / WATCHLIST / NEED CHART CONFIRMATION.\n\n' +
    'FORMAT OUTPUT: HTML (<div class="space-y-3">). Gunakan text-sm text-gray-300, text-emerald-400, text-white.\n' +
    'Sertakan: estimasi support, resistance, dan saran upload chart 1W/1D/4H.\n' +
    'Disclaimer 1 kalimat di akhir.';

  var html = await callGemini(geminiUrl, prompt, '', null, {
    temperature: 0.5, topP: 0.9, topK: 40, maxOutputTokens: 2048
  });

  if (!html || html.trim().length < 50) {
    var score = price > 500 ? 48 : price > 200 ? 45 : price > 100 ? 42 : price > 50 ? 40 : 38;
    var fallback = '<div class="space-y-3"><div class="bg-[#151a23] rounded-xl p-4 border border-[#1c2333]"><div class="flex items-center gap-3 mb-2"><span class="text-lg font-bold text-white">' + ticker + '</span><span class="text-sm text-gray-400">Rp ' + price + '</span><span class="px-2 py-0.5 rounded text-xs font-bold bg-yellow-500/20 text-yellow-400">NEED CHART CONFIRMATION</span></div><p class="text-sm text-gray-300">Data minim (ticker + harga saja). Upload chart 1W/1D/4H untuk analisis lengkap.</p><p class="text-xs text-gray-500 mt-1">Score: ' + score + '/55 | Risk: Medium-High</p></div></div>';
    return res.status(200).json({ html: fallback });
  }

  // Basic FCA sanitizer
  var output = html;
  if (fca === 'not_detected') {
    output = output.replace(/<[^>]*>[^<]*(?:FCA|Full\s*Call\s*Auction|papan\s*pemantauan\s*khusus)[^<]*<\/[^>]*>/gi, '');
  }

  return res.status(200).json({ html: output, intent: 'ticker_analysis' });
}

// === GEMINI CALL HELPER ===
async function callGemini(url, systemPrompt, userMessage, images, config) {
  var parts = [];
  parts.push({ text: systemPrompt });

  if (images && images.length > 0) {
    images.forEach(function(img) {
      var base64 = img.data || img.base64Data || '';
      if (base64.indexOf(',') !== -1) base64 = base64.split(',')[1];
      if (base64) {
        parts.push({ inline_data: { mime_type: img.mimeType || 'image/png', data: base64 } });
      }
    });
  }

  if (userMessage) parts.push({ text: userMessage });

  var payload = {
    contents: [{ parts: parts }],
    generationConfig: config || { temperature: 0.5, topP: 0.9, topK: 40, maxOutputTokens: 2048 }
  };

  try {
    var response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) return null;
    var result = await response.json();
    var candidates = result.candidates || [];
    if (candidates.length > 0) {
      var cparts = candidates[0].content && candidates[0].content.parts ? candidates[0].content.parts : [];
      if (cparts.length > 0 && cparts[0].text) {
        var html = cparts[0].text;
        return html.replace(/^```html\s*/i, '').replace(/```\s*$/i, '');
      }
    }
    return null;
  } catch (e) {
    console.error('Gemini call error:', e.message);
    return null;
  }
}
