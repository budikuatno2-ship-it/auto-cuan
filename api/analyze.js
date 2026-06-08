/**
 * Auto-Cuan Analyze API — Minimal real implementation
 * Single file, no local lib deps, deployment-safe.
 * Primary AI: DeepSeek V4 Flash via CodeCrafters
 * Fallback: Gemini (also used for vision/image tasks)
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
    const CODECRAFTERS_API_KEY = process.env.CODECRAFTERS_API_KEY;
    const CODECRAFTERS_BASE_URL = process.env.CODECRAFTERS_BASE_URL || 'https://api.codecrafters.id/v1';
    const CODECRAFTERS_MODEL = process.env.CODECRAFTERS_MODEL || 'deepseek-v4-flash';

    if (!GEMINI_API_KEY && !CODECRAFTERS_API_KEY) {
      return res.status(200).json({
        html: '<p class="text-sm text-yellow-400">AI provider belum dikonfigurasi. Hubungi admin.</p>'
      });
    }

    // Image/file upload — use Gemini for vision tasks
    if (source === 'chart_upload' && (image || (images && images.length > 0))) {
      if (!GEMINI_API_KEY) {
        return res.status(200).json({
          html: '<p class="text-sm text-yellow-400">Upload gambar memerlukan Gemini API. Hubungi admin.</p>',
          provider: 'none'
        });
      }
      var evidenceType = classifyEvidence(chatMessage || '', images, body.documents);

      if (evidenceType === 'chart') {
        // Try DeepSeek image first, fallback to Gemini Vision
        var chartHtml = null;
        var chartProvider = 'fallback';
        if (CODECRAFTERS_API_KEY) {
          chartHtml = await handleChartDeepSeek(CODECRAFTERS_API_KEY, CODECRAFTERS_BASE_URL, CODECRAFTERS_MODEL, images, image, body.mimeType, chatMessage);
          if (chartHtml) chartProvider = 'deepseek-image';
        }
        if (!chartHtml && GEMINI_API_KEY) {
          chartHtml = await handleChartVision(GEMINI_API_KEY, images, image, body.mimeType, chatMessage);
          if (chartHtml) chartProvider = 'gemini-vision';
        }
        if (!chartHtml) {
          chartHtml = '<p class="text-sm text-gray-300">Chart diterima, tetapi analisis gagal. Coba upload ulang atau tambahkan keterangan ticker + harga.</p>';
        }
        return res.status(200).json({
          html: chartHtml,
          evidenceType: evidenceType,
          provider: chartProvider
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

      // === DETECT IHSG EARLY FOR FIXED TEMPLATE ===
      var detectedIHSG = false;
      var ihsgAliasesEarly = /\b(IHSG|JKSE|JCI)\b|\^JKSE/i;
      var compositeAliasEarly = /\b(composite|idx\s*composite|indeks\s*harga\s*saham\s*gabungan)\b/i;
      if (ihsgAliasesEarly.test(chatMessage) || compositeAliasEarly.test(chatMessage)) {
        detectedIHSG = true;
      }
      if (body.context && body.context.ticker === 'IHSG') detectedIHSG = true;

      // === FIXED IHSG TEMPLATE (deterministic, data-driven) ===
      // Runs for ALL intents EXCEPT follow_up_question and casual_chat.
      // Must run before AI to ensure deterministic structured output.
      if (detectedIHSG && intent !== 'follow_up_question' && intent !== 'casual_chat') {
        var ihsgData = parseMarketDataFromMessage(chatMessage);
        // If market data unavailable, build minimal data from message
        if (!ihsgData || !ihsgData.last) {
          var ihsgPriceMatch = chatMessage.match(/\b(\d{4,5}(?:\.\d+)?)\b/);
          if (ihsgPriceMatch) {
            ihsgData = { last: parseFloat(ihsgPriceMatch[1]), priceChange1D: null, volumeVsAvg20: null, rsi14: null, ma20: null, ma50: null, ma100: null, ma200: null, high: null, low: null, resistance1: null, resistance2: null, support1: null, support2: null, pivotPoint: null, fib382: null, fib500: null, fib618: null, fib786: null };
          }
        }
        if (ihsgData && ihsgData.last) {
          var ihsgHtml = buildIHSGFixedTemplate(ihsgData, chatMessage);
          if (ihsgHtml) {
            return res.status(200).json({ html: ihsgHtml, intent: 'ihsg_fixed_report', provider: 'template' });
          }
        }
      }

      // === FIXED STOCK TEMPLATE (structured report, data-driven) ===
      // Runs for ALL intents EXCEPT follow_up_question and casual_chat.
      // Prioritizes deterministic template BEFORE any AI fallback.
      var detectedStockTicker = null;
      if (!detectedIHSG && intent !== 'follow_up_question' && intent !== 'casual_chat') {
        // Try to detect ticker from message
        var stockMatch = chatMessage.match(/\b([A-Z]{4})\b/);
        if (stockMatch) {
          detectedStockTicker = stockMatch[1];
        }
        if (body.context && body.context.ticker && body.context.ticker !== 'IHSG') {
          detectedStockTicker = body.context.ticker;
        }
      }
      if (detectedStockTicker) {
        var stockData = parseMarketDataFromMessage(chatMessage);
        // If no market data from [Auto-Cuan Market Data] block, try to extract price from message
        if (!stockData || !stockData.last) {
          var priceMatch = chatMessage.match(/\b(\d{2,6})\b/);
          var extractedPrice = priceMatch ? parseFloat(priceMatch[1]) : null;
          // Even without a price, if we have a valid ticker, use currentPrice from context or default
          if (!extractedPrice && body.context && body.context.currentPrice) {
            extractedPrice = parseFloat(body.context.currentPrice);
          }
          if (extractedPrice && extractedPrice > 0) {
            stockData = { last: extractedPrice, priceChange1D: null, volumeVsAvg20: null, rsi14: null, ma20: null, ma50: null, ma100: null, ma200: null, high: null, low: null, resistance1: null, resistance2: null, support1: null, support2: null, pivotPoint: null, fib382: null, fib500: null, fib618: null, fib786: null };
          }
        }
        if (stockData && stockData.last) {
          var stockHtml = buildStockFixedTemplate(stockData, detectedStockTicker, chatMessage);
          if (stockHtml) {
            return res.status(200).json({ html: stockHtml, intent: 'stock_fixed_report', provider: 'template', ticker: detectedStockTicker });
          }
        }
      }

      // === GROQ FOR CASUAL CHAT ===
      if (isCasualChat(chatMessage, body.context, intent)) {
        var casualResult = await handleCasualWithGroq(chatMessage);
        if (casualResult) {
          return res.status(200).json({ html: casualResult, intent: 'casual_chat', response_type: 'casual', provider: 'groq' });
        }
        // Fallback: DeepSeek casual
        var dsCasual = await handleCasualChat(CODECRAFTERS_API_KEY, CODECRAFTERS_BASE_URL, CODECRAFTERS_MODEL, chatMessage);
        if (dsCasual) {
          return res.status(200).json({ html: dsCasual, intent: 'casual_chat', response_type: 'casual', provider: 'deepseek' });
        }
        // Fallback: Gemini
        if (GEMINI_API_KEY) {
          var fallbackPrompt = 'Kamu Auto-Cuan AI. User kirim chat casual/sapaan. Jawab singkat 1-3 kalimat dalam HTML (p class text-sm text-gray-300). Bahasa Indonesia santai dan friendly. Jangan bahas saham kecuali ditanya.';
          var fallbackHtml = await callGemini(GEMINI_API_KEY, fallbackPrompt, chatMessage, 256);
          if (fallbackHtml) {
            return res.status(200).json({ html: fallbackHtml, intent: 'casual_chat', response_type: 'casual', provider: 'gemini-fallback' });
          }
        }
        return res.status(200).json({
          html: '<p class="text-sm text-gray-300">Maaf, mode chat santai lagi belum aktif. Coba ulang sebentar lagi ya.</p>',
          intent: 'casual_chat', response_type: 'casual', provider: 'fallback'
        });
      }

      if (intent === 'ticker_only') {
        // Just a ticker, ask for price
        return res.status(200).json({
          html: '<p class="text-sm text-gray-300"><strong class="text-emerald-400">' + chatMessage.trim().toUpperCase() + '</strong> terdeteksi. Harga sekarang berapa? Contoh: "WMUU 58"</p>',
          intent: intent
        });
      }

      if (intent === 'follow_up_question') {
        prompt = 'Kamu Auto-Cuan AI, asisten trading yang conversational, thoughtful, dan natural. User bertanya follow-up tentang saham. Jawab pertanyaan follow-up secara RINGKAS menggunakan data analisis sebelumnya. JANGAN ulangi Kesimpulan Cepat atau blok analisis lengkap. Langsung jawab pertanyaan spesifik dalam 2-4 kalimat.\n\nJawab 100-250 kata, langsung ke inti. Format HTML (p, strong, ul, li) dengan class text-sm text-gray-300. Bahasa Indonesia santai tapi berisi — seperti teman trading yang pinter.\n\nJika ada [Auto-Cuan Market Data], gunakan sebagai Data Historis T-1 (acuan pendukung analisis teknikal). Sebutkan posisi harga vs MA dan RSI14 jika tersedia. Interpretasi RSI: >70 overbought/koreksi risk, 55-70 bullish momentum, ~50 netral, 40-50 weak/bearish-neutral, <40 bearish, <30 oversold tapi bukan otomatis beli. Interpretasi volume: di atas AvgVol20 + merah = tekanan jual, di atas AvgVol20 + hijau = tekanan beli, di bawah AvgVol20 = move kurang meyakinkan. Selalu kombinasikan RSI+MA+Volume, jangan pakai RSI sendirian.\n\nJika ada [Auto-Cuan News Summary] dengan items, boleh mention singkat jika relevan dengan pertanyaan user. Jangan karang berita. Jika news unavailable, tidak perlu mention.\n\nJika ada [Auto-Cuan Fibonacci Intelligence], boleh mention posisi harga vs level Fibonacci terdekat jika relevan. Jangan karang level Fibonacci sendiri.\n\nJangan tampilkan blok data mentah ke user. Jangan paksa mention orderbook/broker kecuali user tanya. Jangan pakai markdown stars **. Jangan suggest short-selling. Untuk bearish: pakai avoid/wait and see/hold ketat/cut loss if invalidation breaks/downside risk.\n\nLARANGAN MUTLAK: JANGAN gunakan template full analysis. JANGAN tampilkan section: Kesimpulan Cepat, Ringkasan Market, Data Teknikal, Skenario Harga, Rencana Trading, Kesimpulan Final, Kesimpulan Analitis. JANGAN gunakan class: decision-card, decision-grid, metric-grid, level-grid, scenario-price-grid, trade-plan-grid. Jawab LANGSUNG ke pertanyaan user saja.';
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
        maxTokens = 800;
      } else if (intent === 'contextual_data_followup') {
        // Build rich context string from all available technical data
        var techContext = '';
        if (body.context) {
          var c = body.context;
          if (c.ticker) techContext += 'Ticker: ' + c.ticker + '. ';
          if (c.currentPrice) techContext += 'Last price: ' + c.currentPrice + '. ';
          if (c.finalDecision) techContext += 'Decision sebelumnya: ' + c.finalDecision + '. ';
          if (c.entryArea) techContext += 'Entry area: ' + c.entryArea + '. ';
          if (c.stopLoss) techContext += 'Stop loss: ' + c.stopLoss + '. ';
          if (c.takeProfits) techContext += 'Take profit: ' + c.takeProfits + '. ';
          if (c.support) techContext += 'Support levels: ' + (Array.isArray(c.support) ? c.support.join(', ') : c.support) + '. ';
          if (c.resistance) techContext += 'Resistance levels: ' + (Array.isArray(c.resistance) ? c.resistance.join(', ') : c.resistance) + '. ';
          if (c.pivotPoint) techContext += 'Pivot: ' + c.pivotPoint + '. ';
          if (c.maValues) {
            var ma = c.maValues;
            if (ma.ma20) techContext += 'MA20: ' + ma.ma20 + '. ';
            if (ma.ma50) techContext += 'MA50: ' + ma.ma50 + '. ';
            if (ma.ma100) techContext += 'MA100: ' + ma.ma100 + '. ';
            if (ma.ma200) techContext += 'MA200: ' + ma.ma200 + '. ';
          }
          if (c.rsiValue) techContext += 'RSI14: ' + c.rsiValue + '. ';
          if (c.chartSummary) techContext += 'Chart summary: ' + c.chartSummary + '. ';
        }

        prompt = 'Kamu Auto-Cuan AI, asisten trading yang conversational dan data-driven. User menanyakan follow-up kontekstual tentang level/target/support/resistance berdasarkan analisis sebelumnya.\n\n' +
          '=== KONTEKS TEKNIKAL ===\n' + techContext + '\n\n' +
          '=== ATURAN WAJIB ===\n' +
          '1. Jawab LANGSUNG ke pertanyaan user, 150-350 kata.\n' +
          '2. Gunakan DATA dari konteks: harga terakhir, support, resistance, MA, RSI, pivot.\n' +
          '3. Jika user sebut angka tertentu (misal 4700, 5416), jelaskan posisi angka tersebut relatif terhadap data.\n' +
          '4. Hitung jarak/persentase jika relevan.\n' +
          '5. Jelaskan konfirmasi dan invalidasi secara spesifik.\n' +
          '6. Jika data teknikal tidak cukup, bilang: "Dari data teknikal yang tersedia..."\n' +
          '7. Jika katalis/berita tidak tersedia, bilang: "Katalis eksternal belum cukup tersedia di data saat ini."\n\n' +
          '=== LARANGAN MUTLAK ===\n' +
          'JANGAN gunakan template full analysis. JANGAN tampilkan section/header berikut:\n' +
          '- Kesimpulan Cepat\n- Ringkasan Market\n- Potensi Besok\n- Data Teknikal\n- Momentum Market\n- Resistance IHSG\n- Support IHSG\n- Fibonacci Market\n- Kesimpulan Final Market\n- Kesimpulan Final\n- Kesimpulan Analitis\n- Skenario Harga\n- Rencana Trading\n- Setup Label\n- Risk Guard\n- decision-card\n- decision-grid\n- metric-grid\n- scenario-price-grid\n' +
          'JANGAN gunakan class: decision-card, decision-grid, metric-grid, level-grid, scenario-price-grid, trade-plan-grid.\n' +
          'Jawab NATURAL dan CONVERSATIONAL seperti teman trading yang pinter.\n\n' +
          '=== FORMAT OUTPUT ===\n' +
          'HTML sederhana: <p>, <strong>, <br>, <ul>, <li>. Class: text-sm text-gray-300.\n' +
          'Boleh pakai <strong class="text-emerald-400"> untuk highlight angka positif dan <strong class="text-red-400"> untuk angka negatif/risk.\n' +
          'JANGAN pakai markdown stars **. JANGAN suggest short-selling.';
        if (!fcaConfirmed) prompt += ' JANGAN sebut FCA/Full Call Auction sama sekali.';
        maxTokens = 1536;
      } else if (intent === 'full_analysis_request') {
        prompt = 'Kamu Auto-Cuan AI, asisten analisis saham Indonesia premium. User minta analisis lengkap/mendalam. Format: HTML (div, p, strong, br, span, b). Bahasa Indonesia natural, evidence-based. Jawab 800-1200 kata.\n\n=== ATURAN UTAMA ===\nWAJIB selesaikan SEMUA section sampai Kesimpulan Final. RINGKAS tapi LENGKAP. JANGAN berhenti di tengah. JANGAN gabung field. Setiap field pisah baris <br>. JANGAN banyak dash/em-dash.\n\n=== DECISION GUARD ===\nJika Price Change 1D <= -5% DAN price di bawah MA20+MA50: Status WAJIB "Avoid Dulu", Bias "Bearish", Action "Avoid dulu".\n\n=== RP50 FLOOR GUARD ===\nJika last price 50-55 (area gocap):\n- Rp50 = floor penting. JANGAN target 49/48 kecuali board Akselerasi/FCA terkonfirmasi.\n- Board UNKNOWN: "Support utama 50 (floor). Sub-50 tidak diasumsikan."\n- Support S1 = 50 (floor). S2 = N/A (sub-50 tidak valid kecuali FCA/Akselerasi terkonfirmasi).\n- JANGAN buat Stop Loss 49 atau di bawah 50. Jika board tidak diketahui atau Papan Utama/Pengembangan, SL tidak berlaku di bawah floor.\n- Bear Case: "Tertahan di 50 dengan likuiditas lemah dan antrean jual." BUKAN target 48/45/40.\n- Risk Guard: "Harga di area Rp50. Risiko utama bukan penurunan harga, tetapi saham tertahan di floor dan likuiditas exit melemah."\n- JANGAN tulis "papan izin" atau "jika papan memungkinkan". Tulis: "Sub-50 tidak diasumsikan kecuali FCA/Akselerasi terkonfirmasi."\n- JANGAN invent board status.\n\nJANGAN gabung field. JANGAN markdown **. JANGAN pipe. Gunakan class CSS.\n\n=== STRUKTUR OUTPUT (ANALISIS LENGKAP) ===\n\n--- SECTION 1: DECISION CARD ---\n<div class="decision-card">\n<strong>Kesimpulan Cepat</strong>\n<div class="decision-grid">\n<div><span>Status</span><b>[Avoid Dulu / Wait Confirmation / Rebound Watch / Breakout Watch / Speculative Watch]</b></div>\n<div><span>Bias</span><b>[Bullish / Neutral / Bearish / Mixed]</b></div>\n<div><span>Confidence</span><b>[Low / Medium / High]</b></div>\n<div><span>Action</span><b>[Avoid dulu / Watchlist / Wait breakout / Wait reclaim MA20 / Small position only]</b></div>\n</div>\n<div class="key-level">Level kunci: Resistance [X] / Support [X]</div>\n</div>\n\n--- SECTION 2: AUTO-CUAN SCORE ---\n<p><strong class="text-emerald-400">Auto-Cuan Score: XX/100 (Grade X)</strong><br>Confidence: [dari data]<br>Alasan skor: [KENAPA score ini — hubungkan trend/momentum/volume/risk dengan angka]</p>\n\n--- SECTION 3: RINGKASAN CEPAT ---\n<p><strong>Ringkasan Cepat</strong><br>[2-4 kalimat natural. Kondisi + kenapa + apa yang ditunggu.]</p>\n\n--- SECTION 4: SKENARIO HARGA ---\n<p><strong>Skenario Harga</strong></p>\n<div class="scenario-price-grid">\n<div class="case-card bear"><span>Bear Case</span><b>[target support bawah]</b><p>[kondisi: breakdown support X + volume jual meningkat]</p></div>\n<div class="case-card base"><span>Base Case</span><b>[area sideways/stabilisasi]</b><p>[kondisi: harga bertahan di area X-X, volume normal]</p></div>\n<div class="case-card bull"><span>Bull Case</span><b>[target resistance berikutnya]</b><p>[kondisi: breakout resistance X + volume naik]</p></div>\n</div>\n\n--- SECTION 5: SETUP LABEL ---\n<p><strong>Setup Label</strong><br>Status: [dari Auto-Cuan Setup Label]<br>Alasan: [kenapa — hubungkan teknikal]<br>Valid jika: [kondisi]<br>Batal jika: [kondisi]</p>\n\n--- SECTION 6: DATA TEKNIKAL T-1 ---\n<p><strong>Data Teknikal T-1</strong></p>\n<div class="metric-grid">\n<div><strong>Moving Average</strong><br>MA20: [X]<br>MA50: [X]<br>MA100: [X]<br>MA200: [X]<br>Posisi: [above/below]</div>\n<div><strong>Momentum &amp; Volume</strong><br>RSI14: [X] — [interpretasi]<br>Volume: [X]x avg<br>Kondisi: [oversold/overbought/normal]<br>Last: [X] | Open: [X]<br>High: [X] | Low: [X]</div>\n</div>\n\n--- SECTION 7: ANALISIS VOLUME 3/7 HARI ---\n[Jika ada [Auto-Cuan Volume Intelligence]:]\n<div class="volume-card">\n<strong>Analisis Volume 3/7 Hari</strong>\n<div class="volume-grid">\n<div><span>Volume Terakhir</span><b>[dari data]</b></div>\n<div><span>Rata-rata 3 Hari</span><b>[dari data]</b></div>\n<div><span>Rata-rata 7 Hari</span><b>[dari data]</b></div>\n<div><span>Volume vs 7D</span><b>[X]x — [trend]</b></div>\n</div>\n<div class="volume-note">Pembacaan: [gunakan Price-Volume Reading dari data. Jelaskan implikasi 1-2 kalimat natural.]</div>\n</div>\n[Jika tidak ada Volume Intelligence: skip.]\n\n--- SECTION 7B: ANALISIS FIBONACCI ---\n[Jika ada [Auto-Cuan Fibonacci Intelligence]: WAJIB tampilkan section ini.]\n<div class="fibo-card">\n<strong>Analisis Fibonacci</strong>\n<div class="fibo-grid">\n<div><span>Swing High</span><b>[dari data]</b></div>\n<div><span>Swing Low</span><b>[dari data]</b></div>\n<div><span>Nearest Fib</span><b>[label + level dari data]</b></div>\n<div><span>Trend</span><b>[upward/downward retracement]</b></div>\n</div>\n<div class="fibo-grid">\n<div class="fibo-level"><span>Fib 38.2%</span><b>[dari data]</b></div>\n<div class="fibo-level"><span>Fib 50%</span><b>[dari data]</b></div>\n<div class="fibo-level"><span>Fib 61.8%</span><b>[dari data]</b></div>\n<div class="fibo-level"><span>Fib 78.6%</span><b>[dari data]</b></div>\n</div>\n<div class="fibo-note">[Reading dari data — 1 kalimat. Invalidation — 1 kalimat.]</div>\n</div>\n[Jika TIDAK ADA Fibonacci Intelligence: skip section ini sepenuhnya.]\n\n--- SECTION 8: AREA PENTING ---\n<p><strong>Area Penting</strong></p>\n<div class="level-grid">\n<div><strong>Resistance</strong><br>R1: [X]<br>R2: [X]<br>Breakout valid jika: [kondisi]</div>\n<div><strong>Support</strong><br>S1: [X]<br>S2: [X]<br>Breakdown risk jika: [kondisi]</div>\n</div>\n<p>Pivot Point: [X]</p>\n\n--- SECTION 9: BREAKOUT / BREAKDOWN ---\n<p><strong>Breakout / Breakdown</strong><br>Status: [dari Auto-Cuan Breakout Confirmation]<br>Breakout Level: [X]<br>Breakdown Level: [X]<br>Valid jika: [kondisi]<br>Batal jika: [kondisi]</p>\n\n--- SECTION 10: SKENARIO TRADING ---\n<p><strong>Skenario Trading</strong></p>\n<div class="scenario-list">\n<div><strong>Skenario Bullish</strong><br>[kondisi + target]</div>\n<div><strong>Skenario Netral</strong><br>[area sideways + catatan]</div>\n<div><strong>Skenario Bearish</strong><br>[risk + downside target]</div>\n</div>\n\n--- SECTION 11: RENCANA TRADING ---\n<p><strong>Rencana Trading</strong></p>\n<div class="trade-plan-grid">\n<div><strong>Entry Terbaik</strong><br>[Entry area berdasarkan support/MA/pullback zone. Harus realistis - dekat current price kecuali clearly wait-pullback setup.]</div>\n<div><strong>Stop Loss</strong><br>[SL level di bawah entry/support terdekat + buffer. Jelaskan kenapa level ini.]</div>\n<div><strong>Take Profit</strong><br>TP1: [X] (resistance terdekat / mean reversion)<br>TP2: [X] (resistance kuat / Fib extension)</div>\n<div><strong>Risk:Reward</strong><br>[X:X dari entry ke TP1. Jika < 1.5, sebutkan RR belum ideal.]</div>\n</div>\n<p>Catatan: [Jika bearish/avoid: Entry tidak disarankan saat ini. Tunggu reclaim [level] dengan volume. / Jika breakout watch: Entry agresif hanya jika breakout [level] dengan volume. Konservatif tunggu retest.]</p>\n\n--- SECTION 12: RISK GUARD ---\n<p><strong>Risk Guard</strong><br>[Level + Action Bias + alasan. Skip jika tidak ada.]</p>\n\n--- SECTION 13: BROKER SUMMARY (jika ada) ---\n[Jika ada [Auto-Cuan Broker Summary Manual]:]\n<p><strong>Broker Summary Manual</strong><br>Periode: [dari data]<br>Top Net Buyer:<br>1. [broker]: [value]<br>2. [broker]: [value]<br>Top Net Seller:<br>1. [broker]: [value]<br>2. [broker]: [value]<br>Pembacaan: [akumulasi / distribusi / campuran]<br>Kekuatan Sinyal: [kuat / sedang / lemah]<br>Integrasi: [hubungkan dengan teknikal + volume intelligence]</p>\n[Jika TIDAK ADA [Auto-Cuan Broker Summary Manual]: JANGAN tampilkan section ini. JANGAN tulis "tidak tersedia". Skip sepenuhnya.]\n\n--- SECTION 14: KESIMPULAN ANALITIS ---\n<div class="analytic-summary">\n<strong>Kesimpulan Analitis</strong>\n<div class="summary-rows">\n<div><span>Trend harga</span><b>[Bearish / Neutral / Bullish]</b></div>\n<div><span>Momentum teknikal</span><b>[Lemah / Mulai membaik / Kuat]</b></div>\n<div><span>Volume 3/7 hari</span><b>[Naik signifikan / Normal / Menurun / Spike]</b></div>\n<div><span>Fibonacci</span><b>[Nearest level + reading singkat, atau skip jika tidak ada]</b></div>\n<div><span>Area support</span><b>[level]</b></div>\n<div><span>Area resistance</span><b>[level]</b></div>\n<div><span>Risiko utama</span><b>[1 kalimat]</b></div>\n<div><span>Rekomendasi trader</span><b>[Wait confirmation / Speculative buy if breakout / Avoid dulu / dll]</b></div>\n</div>\n</div>\n\n--- SECTION 15: NEWS / KATALIS ---\n<p><strong>News / Katalis</strong><br>[Jika ada: sebutkan + dampak. Jika unavailable: "Tidak ada katalis kuat. Fokus teknikal."]</p>\n\n--- SECTION 16: INVALIDASI ---\n<p><strong>Invalidasi</strong><br>[Kapan setup batal — level + kondisi spesifik]</p>\n\n--- SECTION 17: KESIMPULAN FINAL ---\n<p><strong>Kesimpulan Final</strong><br>Status: [konsisten Decision Card]<br>Bias: [konsisten]<br>Confidence: [konsisten]<br>Action: [konsisten]<br><br>Alasan utama:<br>1. [trend+MA — angka]<br>2. [momentum RSI — angka]<br>3. [volume 3/7D — rasio + trend]<br>4. [fibonacci level jika ada]<br>5. [katalis/broker jika ada]<br>6. [risk guard jika relevan]<br><br>Konfirmasi: [kondisi valid]<br>Invalidasi: [kondisi batal]</p>\n\n[Jika tidak ada [Auto-Cuan Broker Summary Manual], tampilkan CTA ini:]\n<p class="text-gray-500 text-xs">Untuk memperkuat analisis, kamu bisa kirim Broker Summary manual emiten ini. Contoh:<br>BBCA broksum 1D<br>YP +4,5B<br>AK -8B</p>\n\n<p class="text-gray-500">Kalau ada chart SMC, broker summary, atau data tambahan lain, kirim saja biar kesimpulannya lebih presisi.</p>\n\n=== RULES ===\n- WAJIB gunakan class HTML: decision-card, decision-grid, metric-grid, level-grid, scenario-list, trade-plan-grid, key-level, volume-card, volume-grid, volume-note, scenario-price-grid, case-card, analytic-summary, summary-rows, fibo-card, fibo-grid, fibo-level, fibo-note.\n- Setiap klaim didukung angka. JANGAN generik.\n- Bahasa natural: karena, sehingga, masih tertekan, belum kuat, mulai menarik jika.\n- JANGAN kaku/robotic. Kalimat pendek, jelas, natural.\n- Cautious: berpotensi, indikasi, lebih valid jika, belum terkonfirmasi.\n- JANGAN: pasti naik, dijamin, all in, aman beli, pasti cuan, auto cuan.\n- Decision Card HARUS konsisten dengan Kesimpulan Final dan Kesimpulan Analitis.\n- Score: [Auto-Cuan Score]. <=34=Avoid, 35-49=Wait, 50-64=Watchlist, 65-79=Speculative, 80+=Strong.\n- Board: UTAMA/PENGEMBANGAN+guard50: jangan FCA. AKSELERASI+guard1: boleh <Rp50. PEMANTAUAN/FCA: boleh Rp1.\n- IHSG/INDEX: "indeks"/"market"/"IHSG". JANGAN "emiten"/"saham ini". JANGAN board/FCA.\n- JANGAN tampilkan [Auto-Cuan...] mentah. JANGAN English. Setiap field baris sendiri.\n- Broker summary = konfirmasi tambahan, bukan sinyal beli tunggal.\n- Volume Intelligence: gunakan data [Auto-Cuan Volume Intelligence] untuk section Analisis Volume. Jangan karang angka volume sendiri.\n- Fibonacci Intelligence: gunakan data [Auto-Cuan Fibonacci Intelligence] untuk section Analisis Fibonacci. Jangan karang level Fibonacci sendiri. Jika data tidak ada, skip section Fibonacci sepenuhnya.';
        if (body.context && body.context.ticker) {
          prompt += ' Ticker: ' + body.context.ticker;
          if (body.context.currentPrice) prompt += ' Rp ' + body.context.currentPrice;
        }
        if (!fcaConfirmed) prompt += ' JANGAN sebut FCA/Full Call Auction sama sekali.';
        maxTokens = 3500;
      } else {
        // normal_chat or ticker_price_basic — CONVERSATIONAL DATA-BASED ANALYSIS
        prompt = 'Kamu Auto-Cuan AI, asisten analisis saham Indonesia yang conversational, thoughtful, dan data-driven. Bahasa Indonesia santai tapi berisi — seperti teman trading yang pinter dan berpengalaman.\n\nJawab 250-500 kata dalam format PARAGRAF NATURAL. Format HTML sederhana: <p class="text-sm text-gray-300">, <strong>, <br>, <ul>, <li>. Boleh pakai <strong class="text-emerald-400"> untuk highlight positif dan <strong class="text-red-400"> untuk negatif/risk.\n\n=== GAYA JAWABAN ===\nJawab seperti teman trading yang menjelaskan kondisi saham secara natural dalam paragraf mengalir:\n1. Buka dengan sapaan singkat + kondisi harga terkini (harga terakhir, perubahan hari ini jika ada).\n2. Jelaskan kondisi teknikal: posisi harga vs MA utama, RSI14, volume vs rata-rata. Sebutkan angka spesifik inline dalam kalimat.\n3. Sebutkan support dan resistance terdekat secara natural dalam paragraf (bukan list/grid/card terpisah).\n4. Jika ada berita/katalis dari [Auto-Cuan News Summary], mention dampaknya singkat.\n5. Berikan kesimpulan: apakah menarik, perlu tunggu konfirmasi, atau avoid — dengan alasan data.\n6. Tutup dengan kondisi konfirmasi pemulihan/lanjut dan risiko jika turun.\n\n=== LARANGAN MUTLAK ===\n- JANGAN gunakan template/card/grid/dashboard structured output.\n- JANGAN tampilkan: decision-card, decision-grid, metric-grid, level-grid, scenario-price-grid, trade-plan-grid, volume-card, fibo-card, analytic-summary, summary-rows.\n- JANGAN buat list panjang level breakdown (R1, R2, S1, S2 dalam format grid).\n- JANGAN tampilkan header section formal (Kesimpulan Cepat, Skenario Harga, Data Teknikal, dll).\n- JANGAN pakai Auto-Cuan Score / Grade.\n- JANGAN pakai markdown stars **.\n- JANGAN suggest short-selling.\n- JANGAN tampilkan blok data mentah [Auto-Cuan...] ke user.\n- Untuk bearish: pakai avoid/wait and see/hold ketat/cut loss if breaks/downside risk.\n- JANGAN: pasti naik, dijamin, all in, aman beli, pasti cuan.\n\n=== DATA RULES ===\n- Jika ada [Auto-Cuan Market Data], gunakan sebagai Data Historis T-1. Sebutkan angka inline (bukan dalam tabel).\n- RSI: >70 overbought, 55-70 bullish momentum, ~50 netral, 40-50 weak, <40 bearish, <30 oversold.\n- Volume: di atas AvgVol20 + merah = tekanan jual, di atas AvgVol20 + hijau = tekanan beli, di bawah AvgVol20 = kurang meyakinkan.\n- Kombinasikan RSI+MA+Volume, jangan pakai satu indikator sendirian.\n- Jika data tidak tersedia untuk suatu aspek, bilang "data belum tersedia" — jangan karang.\n- Jika ada [Auto-Cuan News Summary] dengan items, boleh mention singkat. Jangan karang berita.\n\n=== PENUTUP ===\nAkhiri dengan 1 kalimat natural: "Kalau mau analisis mendalam, coba pakai menu Analisis Saham di atas."';
        if (!fcaConfirmed) prompt += ' JANGAN sebut FCA/Full Call Auction sama sekali.';
        maxTokens = 1536;
      }

      // === IHSG/INDEX PROMPT APPENDIX ===
      // When context ticker is IHSG, append strong index-specific directive
      var contextTicker = (body.context && body.context.ticker) ? body.context.ticker : null;
      if (!contextTicker) {
        var ihsgAliases = /\b(IHSG|JKSE|JCI)\b|\^JKSE/i;
        var compositeAlias = /\b(composite|idx\s*composite|indeks\s*harga\s*saham\s*gabungan)\b/i;
        if (ihsgAliases.test(chatMessage) || compositeAlias.test(chatMessage)) {
          contextTicker = 'IHSG';
        }
      }
      if (contextTicker === 'IHSG') {
        prompt += '\n\n=== PERINGATAN UTAMA: INI BUKAN SAHAM, INI INDEKS ===\nABAIKAN seluruh template stock/emiten di atas. IHSG adalah INDEKS PASAR. JANGAN gunakan template saham.\n\n=== OVERRIDE IHSG/INDEKS — WAJIB DIIKUTI SEPENUHNYA ===\n\nTicker ini adalah IHSG (Indeks Harga Saham Gabungan). Ini adalah indeks market, bukan emiten/saham individual.\n\nLARANGAN MUTLAK (JANGAN TAMPILKAN):\n- Entry / Stop Loss / Take Profit / TP1 / TP2\n- Rencana Trading\n- Broker Summary Manual\n- CTA "Kirim Broker Summary manual"\n- fibo-card / Analisis Fibonacci lengkap gaya saham\n- Setup Label saham\n- Skenario Trading saham\n- Wording: saham ini, emiten, papan, FCA, board\n- Status "Avoid Dulu" (gunakan "Risk-Off" atau "Wait Confirmation")\n\nWAJIB gunakan: IHSG, indeks, market, tekanan pasar, pelaku pasar\n\nSTRUKTUR OUTPUT IHSG (HANYA INI, WAJIB LENGKAP):\n\n1. <div class="decision-card"><strong>Kesimpulan Cepat IHSG</strong><div class="decision-grid"><div><span>Status Market</span><b>[Risk-Off / Wait Confirmation / Rebound Watch / Breakout Watch]</b></div><div><span>Bias IHSG</span><b>[Bullish / Neutral / Bearish / Mixed]</b></div><div><span>Confidence</span><b>[Low / Medium / High]</b></div><div><span>Sikap</span><b>[Defensive / Wait / Selektif / Pantau]</b></div></div><div class="key-level">Level kunci: R [X] / S [X]</div></div>\n\n2. <p><strong>Ringkasan Market</strong><br>[2 kalimat kondisi market hari ini]</p>\n\n3. <div class="scenario-list"><div><strong>Potensi Besok</strong><br>Arah Utama: [1 kalimat arah likely besok berdasarkan teknikal hari ini]<br>Uji Resistance: [level R1 lalu R2]<br>Uji Support: [level S1 lalu S2]<br>Syarat Rebound: [kondisi agar IHSG bisa rebound, misal bertahan di atas S1 + volume beli naik]<br>Risiko Breakdown: [kondisi breakdown, misal jika S1 ditembus tekanan lanjut ke S2]</div></div>\n\n4. <div class="metric-grid"><div><strong>Data Teknikal IHSG</strong><br>MA20: [X]<br>MA50: [X]<br>MA100: [X]<br>MA200: [X]<br>Posisi: [X]</div><div><strong>Momentum Market</strong><br>RSI14: [X]<br>Volume: [X]x avg<br>Last: [X]<br>High: [X]<br>Low: [X]</div></div>\n\n5. <div class="level-grid"><div><strong>Resistance IHSG</strong><br>R1: [X]<br>R2: [X]</div><div><strong>Support IHSG</strong><br>S1: [X]<br>S2: [X]</div></div>\n\n6. <div class="level-grid"><div><strong>Level Konfirmasi</strong><br>[IHSG reclaim X]</div><div><strong>Level Risiko</strong><br>[IHSG breakdown X]</div></div>\n\n7. <div class="scenario-list"><div><strong>Skenario Bullish Market</strong><br>[1 kalimat]</div><div><strong>Skenario Netral</strong><br>[1 kalimat]</div><div><strong>Skenario Bearish</strong><br>[1 kalimat]</div></div>\n\n8. FIBONACCI MARKET (OPSIONAL — hanya jika ada data OHLCV/fibonacci yang tersedia di [Auto-Cuan Market Data]):\n<div class="metric-grid"><div><strong>Fibonacci Market</strong><br>Fib 38,2%: [X]<br>Fib 50%: [X]<br>Fib 61,8%: [X]<br>Fib 78,6%: [X]<br>Posisi IHSG: [di atas/bawah level mana]<br>Implikasi Market: [1 kalimat]</div></div>\nJika TIDAK ada data fibonacci, JANGAN tampilkan section ini sama sekali.\n\n9. <p><strong>Implikasi ke Saham</strong><br>Big caps: [1 kalimat]<br>Second liners: [1 kalimat]<br>Defensive sectors: [1 kalimat]</p>\n\n10. <p><strong>Katalis / Sentimen IHSG</strong><br>[Jika ada data news di [Auto-Cuan News Summary], sebutkan singkat. Jika tidak ada, tulis: "Data katalis tidak tersedia saat ini, fokus teknikal."]</p>\n\n11. <p><strong>Risk Guard Market</strong><br>[1 kalimat teknikal risiko utama]</p>\n\n12. <div class="analytic-summary"><strong>Kesimpulan Final Market</strong><div class="summary-rows"><div><span>Status Market</span><b>[X]</b></div><div><span>Bias</span><b>[X]</b></div><div><span>Sikap</span><b>[X]</b></div><div><span>Konfirmasi</span><b>[kondisi]</b></div><div><span>Risiko</span><b>[kondisi]</b></div></div></div>\n\nATURAN PENTING:\n- Setiap field PISAH BARIS (<br>). JANGAN gabung 2 field dalam 1 baris.\n- JANGAN tambahkan Entry/SL/TP/Broker CTA.\n- JANGAN tambahkan section lain di luar struktur di atas untuk IHSG.\n- Section Potensi Besok WAJIB ada dan harus spesifik dengan level angka.';
      }

      var html = null;
      if (CODECRAFTERS_API_KEY) {
        html = await callDeepSeek(CODECRAFTERS_API_KEY, CODECRAFTERS_BASE_URL, CODECRAFTERS_MODEL, prompt, chatMessage, maxTokens);
        // === COMPLETENESS GUARD: retry once if output truncated ===
        if (html && isStockAnalysisIncomplete(html, intent)) {
          var retryPrompt = 'Output sebelumnya terpotong. Buat ulang SELURUH dashboard analisis saham dari awal (Decision Card sampai Kesimpulan Final) secara RINGKAS tapi LENGKAP. Jangan skip section apapun. Gunakan data yang sama.';
          var retryHtml = await callDeepSeek(CODECRAFTERS_API_KEY, CODECRAFTERS_BASE_URL, CODECRAFTERS_MODEL, prompt, chatMessage + '\n\n' + retryPrompt, maxTokens);
          if (retryHtml && !isStockAnalysisIncomplete(retryHtml, intent)) {
            html = retryHtml;
          }
        }
        if (html) {
          var _responseType = (intent === 'follow_up_question' || intent === 'contextual_data_followup') ? 'follow_up' : (intent === 'casual_chat' ? 'casual' : 'full_analysis');
          return res.status(200).json({ html: sanitizeOutput(html, fcaConfirmed, intent), intent: intent, response_type: _responseType, provider: 'deepseek' });
        }
      }
      if (GEMINI_API_KEY) {
        html = await callGemini(GEMINI_API_KEY, prompt, chatMessage, maxTokens);
        // === COMPLETENESS GUARD for Gemini fallback ===
        if (html && isStockAnalysisIncomplete(html, intent)) {
          var retryPrompt2 = 'Output sebelumnya terpotong. Buat ulang SELURUH dashboard analisis saham dari awal (Decision Card sampai Kesimpulan Final) secara RINGKAS tapi LENGKAP.';
          var retryHtml2 = await callGemini(GEMINI_API_KEY, prompt, chatMessage + '\n\n' + retryPrompt2, maxTokens);
          if (retryHtml2 && !isStockAnalysisIncomplete(retryHtml2, intent)) {
            html = retryHtml2;
          }
        }
        if (html) {
          var _responseType2 = (intent === 'follow_up_question' || intent === 'contextual_data_followup') ? 'follow_up' : (intent === 'casual_chat' ? 'casual' : 'full_analysis');
          return res.status(200).json({ html: sanitizeOutput(html, fcaConfirmed, intent), intent: intent, response_type: _responseType2, provider: 'gemini-fallback' });
        }
      }
      return res.status(200).json({ html: '<p class="text-sm text-red-400">AI tidak tersedia saat ini. Coba beberapa saat lagi.</p>', provider: 'none' });
    }

    // Ticker mode (from ticker input, not chat)
    if (ticker && currentPrice) {
      // Use fixed stock template with available data (price only, no full market data)
      var tickerUpper = String(ticker).toUpperCase();
      var minimalData = { last: parseFloat(String(currentPrice).replace(/,/g, '')), priceChange1D: null, volumeVsAvg20: null, rsi14: null, ma20: null, ma50: null, ma100: null, ma200: null, high: null, low: null, resistance1: null, resistance2: null, support1: null, support2: null };
      if (!isNaN(minimalData.last) && minimalData.last > 0) {
        var tickerHtml = buildStockFixedTemplate(minimalData, tickerUpper, '');
        if (tickerHtml) {
          return res.status(200).json({ html: tickerHtml, intent: 'stock_fixed_report', provider: 'template', ticker: tickerUpper });
        }
      }
      // Fallback to AI only if template fails
      var tPrompt = 'Kamu Auto-Cuan AI, asisten analisis saham yang natural, thoughtful, dan risk-aware. User tanya saham ' + tickerUpper + ' di harga Rp ' + currentPrice + '. Bahasa Indonesia santai tapi berisi. Format HTML (p, strong, ul, li) class text-sm text-gray-300. Jawab 200-500 kata.\n\nStruktur: 1) Bias singkat, 2) Data Historis T-1 jika ada [Auto-Cuan Market Data]: Last, OHLC, Volume, Avg Vol 20, Vol vs Avg, MA20/50/100/200, RSI14. Basis: Data Historis T-1. 3) Alasan teknikal: trend MA + momentum RSI + konfirmasi volume, 4) News/Katalis: jika ada [Auto-Cuan News Summary] dengan items, sebutkan singkat dan dampaknya. Jika news unavailable bilang fokus teknikal. Jangan karang berita. 5) Estimasi support/resistance terdekat, 6) Apakah menarik atau belum di harga ini, 7) Entry/SL/TP jika ada valid setup; jika bearish gunakan risiko downside, 8) Risiko utama, 9) Follow-up: "Kalau ada chart SMC, broker summary, atau link news/katalis lain, kirim saja biar analisisnya lebih presisi."\n\nRSI: >70 overbought, 55-70 bullish, ~50 netral, <40 bearish, <30 oversold. Volume: atas avg+red=selling, atas avg+green=buying, bawah avg=low confirm. News rules: jangan overclaim, jika impact mixed bilang mixed, jika berita lama bilang kemungkinan sudah ter-price-in, jangan rely news alone. Board rules: jika ada [Auto-Cuan Board Data]: UTAMA/PENGEMBANGAN/EKONOMI_BARU + guard 50 = jangan mention Rp1/FCA, jangan bilang risiko turun ke bawah Rp50 (gocap adalah batas bawah normal). AKSELERASI + guard 1 = boleh mention risiko < Rp50. PEMANTAUAN_KHUSUS/isFca = boleh FCA/Rp1. UNKNOWN = jangan mention FCA/Rp1. Jangan buat report panjang. Jangan pakai markdown stars **. Jangan suggest short-selling. Untuk bearish: avoid/wait/hold ketat/cut loss/downside risk. Jangan bilang pasti naik/pasti cuan/aman 100%. Jangan tampilkan blok data mentah.' +
        (fcaConfirmed ? '' : ' JANGAN sebut FCA/Full Call Auction sama sekali.');
      var tHtml = null;
      if (CODECRAFTERS_API_KEY) {
        tHtml = await callDeepSeek(CODECRAFTERS_API_KEY, CODECRAFTERS_BASE_URL, CODECRAFTERS_MODEL, tPrompt, '', 1200);
      }
      if (!tHtml && GEMINI_API_KEY) {
        tHtml = await callGemini(GEMINI_API_KEY, tPrompt, '', 1024);
      }
      if (!tHtml) {
        return res.status(200).json({ html: '<p class="text-sm text-gray-300"><strong>' + tickerUpper + '</strong> Rp ' + currentPrice + ' — Upload chart 1W/1D/4H untuk analisis lengkap.</p>', provider: 'fallback' });
      }
      return res.status(200).json({ html: sanitizeOutput(tHtml, fcaConfirmed, 'ticker_price_basic'), intent: 'ticker_price_basic', provider: tHtml ? 'deepseek' : 'gemini-fallback' });
    }

    return res.status(400).json({ error: 'Kirim ticker+harga atau gunakan mode chat/upload.' });

  } catch (err) {
    console.error('analyze error:', err);
    return res.status(200).json({ html: '<p class="text-sm text-red-400">Terjadi kesalahan. Coba kirim ulang beberapa saat lagi.</p>' });
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

// === DEEPSEEK: PRIMARY AI PROVIDER ===
async function callDeepSeek(apiKey, baseUrl, model, systemPrompt, userMessage, maxTokens) {
  var url = (baseUrl || 'https://api.codecrafters.id/v1') + '/chat/completions';
  var payload = {
    model: model || 'deepseek-v4-flash',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage || '' }
    ],
    temperature: 0.7,
    max_tokens: maxTokens || 1200,
    stream: false
  };

  try {
    var response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) return null;
    var result = await response.json();
    var choices = result.choices || [];
    if (choices.length > 0 && choices[0].message && choices[0].message.content) {
      var text = choices[0].message.content.trim();
      // Wrap in HTML if not already wrapped
      if (!text.startsWith('<')) {
        text = '<p class="text-sm text-gray-300">' + text.replace(/\n\n/g, '</p><p class="text-sm text-gray-300">').replace(/\n/g, '<br>') + '</p>';
      }
      return text.replace(/^```html\s*/i, '').replace(/```\s*$/i, '');
    }
    return null;
  } catch (e) {
    return null;
  }
}

// === GEMINI SEARCH: BACKGROUND NEWS RESEARCHER ===
// NOTE: Real Google Search grounding (tools: google_search) is NOT yet implemented.
// Returns null to prevent hallucinated news from model memory.
// When grounding is available, re-enable with proper search tool configuration.
async function geminiSearchNews(apiKey, ticker) {
  return null;
}

// === CHART ANALYSIS: DEEPSEEK IMAGE (primary) ===
async function handleChartDeepSeek(apiKey, baseUrl, model, images, singleImage, mimeType, userMessage) {
  if (!apiKey) return null;

  var prompt = 'Kamu Auto-Cuan AI. Ini screenshot chart saham. Analisis visual chart ini: 1) Timeframe yang terlihat, 2) Trend (bullish/bearish/sideways), 3) Level support/resistance yang terlihat, 4) Pattern jika ada (BOS, CHoCH, order block, FVG, dll), 5) Bias dan saran aksi. Jawab conversational dalam HTML (p, strong, ul, li) class text-sm text-gray-300. Bahasa Indonesia. Max 400 kata. Jangan bilang pasti naik/pasti cuan. JANGAN sebut FCA. Jangan pakai markdown stars **. Jangan suggest short-selling.';

  // Build image data URL for OpenAI-compatible vision format
  var imageDataUrl = null;
  if (images && images.length > 0) {
    var img = images[0];
    var base64 = img.data || img.base64Data || '';
    if (base64.indexOf(',') !== -1) {
      imageDataUrl = base64; // Already a data URL
    } else if (base64) {
      imageDataUrl = 'data:' + (img.mimeType || 'image/png') + ';base64,' + base64;
    }
  } else if (singleImage) {
    if (singleImage.indexOf(',') !== -1) {
      imageDataUrl = singleImage;
    } else {
      imageDataUrl = 'data:' + (mimeType || 'image/png') + ';base64,' + singleImage;
    }
  }

  if (!imageDataUrl) return null;

  var url = (baseUrl || 'https://api.codecrafters.id/v1') + '/chat/completions';
  var payload = {
    model: model || 'deepseek-v4-flash',
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: [
        { type: 'text', text: userMessage || 'Analisis chart ini.' },
        { type: 'image_url', image_url: { url: imageDataUrl } }
      ] }
    ],
    temperature: 0.5,
    max_tokens: 1536,
    stream: false
  };

  try {
    var response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify(payload)
    });

    // If DeepSeek returns 400/415/422 (unsupported image), return null for Gemini fallback
    if (!response.ok) return null;

    var result = await response.json();
    var choices = result.choices || [];
    if (choices.length > 0 && choices[0].message && choices[0].message.content) {
      var text = choices[0].message.content.trim();
      if (!text.startsWith('<')) {
        text = '<p class="text-sm text-gray-300">' + text.replace(/\n\n/g, '</p><p class="text-sm text-gray-300">').replace(/\n/g, '<br>') + '</p>';
      }
      text = text.replace(/^```html\s*/i, '').replace(/```\s*$/i, '');
      text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      return text;
    }
    return null;
  } catch (e) {
    return null; // Silent fail, Gemini Vision will handle
  }
}

// === CHART VISION HANDLER (Gemini) ===
async function handleChartVision(apiKey, images, singleImage, mimeType, userMessage) {
  var prompt = 'Kamu Auto-Cuan AI. Ini screenshot chart saham. Analisis visual chart ini: 1) Timeframe yang terlihat, 2) Trend (bullish/bearish/sideways), 3) Level support/resistance yang terlihat, 4) Pattern jika ada (BOS, CHoCH, order block, FVG, dll), 5) Bias dan saran aksi. Jawab conversational dalam HTML (p, strong, ul, li) class text-sm text-gray-300. Bahasa Indonesia. Max 400 kata. Jangan bilang pasti naik/pasti cuan. JANGAN sebut FCA.';

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
  var payload = { contents: [{ parts: parts }], generationConfig: { temperature: 0.5, topP: 0.9, maxOutputTokens: 1536 } };

  try {
    var response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!response.ok) return '<p class="text-sm text-red-400">Analisis chart gagal. Coba upload ulang.</p>';
    var result = await response.json();
    var candidates = result.candidates || [];
    if (candidates.length > 0 && candidates[0].content && candidates[0].content.parts && candidates[0].content.parts[0]) {
      var text = candidates[0].content.parts[0].text || '';
      text = text.replace(/^```html\s*/i, '').replace(/```\s*$/i, '');
      text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      return text;
    }
    return '<p class="text-sm text-gray-300">Chart diterima, tetapi AI belum berhasil menganalisis detail visual. Coba upload dengan resolusi lebih jelas atau tambahkan keterangan ticker + harga.</p>';
  } catch (e) {
    return '<p class="text-sm text-red-400">Terjadi kesalahan saat analisis chart.</p>';
  }
}

// === DEEPSEEK CASUAL CHAT ===
async function handleCasualChat(apiKey, baseUrl, model, message) {
  if (!apiKey) return null;

  // Detect WIB time for natural greeting
  var now = new Date();
  var wibHour = (now.getUTCHours() + 7) % 24;
  var timeContext = '';
  if (wibHour >= 4 && wibHour < 11) timeContext = 'Sekarang pagi hari (WIB).';
  else if (wibHour >= 11 && wibHour < 15) timeContext = 'Sekarang siang hari (WIB).';
  else if (wibHour >= 15 && wibHour < 18) timeContext = 'Sekarang sore hari (WIB).';
  else timeContext = 'Sekarang malam hari (WIB).';

  var systemPrompt = 'Kamu Auto-Cuan AI, asisten analisis saham Indonesia yang friendly dan supportive. ' + timeContext + '\n\n' +
    'PERSONALITY:\n' +
    '- Bahasa Indonesia santai, natural, warm\n' +
    '- Boleh sedikit Gen Z tapi tetap sopan dan berguna\n' +
    '- Seperti teman trading yang supportive\n' +
    '- Jangan kaku atau formal berlebihan\n' +
    '- Jangan terlalu panjang (max 2-4 kalimat)\n\n' +
    'SAPAAN:\n' +
    '- Jika user menyapa (hai/halo/pagi/siang/sore/malam), balas sesuai waktu WIB\n' +
    '- Tambahkan "Semoga sehat selalu ya."\n' +
    '- Akhiri dengan ajakan: "Mau bahas saham apa hari ini? Bisa langsung ketik ticker kayak BBCA, WMUU, atau kirim chart juga."\n\n' +
    'EMPATI (minus/rugi/nyangkut/floating loss/portofolio merah/sedih/galau/bingung):\n' +
    '- Tenangkan dulu, jangan panik\n' +
    '- JANGAN bilang: pasti balik modal, pasti cuan, aman 100%\n' +
    '- JANGAN rekomendasikan secara buta\n' +
    '- Bilang: "Ini bukan rekomendasi investasi pasti, tapi aku bantu analisis semaksimal mungkin."\n' +
    '- Ajak user kirim detail: ticker, harga beli, harga sekarang, chart/news kalau ada\n' +
    '- Tone: supportive, calm, rational\n\n' +
    'FITUR/CARA PAKAI:\n' +
    '- Auto-Cuan membantu analisis saham IDX (BEI) berbasis Smart Money Concepts\n' +
    '- User bisa: ketik ticker+harga (BBCA 9250), tanya casual (NAYZ gimana?), upload chart, kirim news/broker summary\n' +
    '- Data didukung Yahoo Finance (delayed) untuk OHLCV dan Moving Average\n\n' +
    'FORMAT OUTPUT: HTML sederhana (p tag saja, class text-sm text-gray-300). Jangan pakai markdown. Jangan pakai ```.';

  return await callDeepSeek(apiKey, baseUrl, model, systemPrompt, message, 800);
}

// === GROQ (kept for backward compatibility, not used as primary) ===
async function handleCasualWithGroq(message) {
  var GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY) return null;
  return await callGroq(GROQ_API_KEY, 'Kamu Auto-Cuan AI. Jawab casual singkat dalam HTML (p class text-sm text-gray-300). Bahasa Indonesia santai.', message);
}
function isCasualChat(message, context, intent) {
  // If there's an active ticker context, it's likely stock-related
  if (context && context.ticker) return false;
  // If intent is stock-related, not casual
  if (intent === 'ticker_only' || intent === 'ticker_price_basic' || intent === 'full_analysis_request' || intent === 'follow_up_question') return false;

  var msg = String(message || '').trim();
  // Strip [Auto-Cuan Market Data] and [Info:] blocks for classification
  var cleanMsg = msg.replace(/\n?\[Auto-Cuan Market Data\][\s\S]*/i, '').replace(/\n?\[Info:[^\]]*\]/gi, '').trim();
  var lower = cleanMsg.toLowerCase();

  // If message contains stock keywords, not casual
  if (/\b(saham|emiten|chart|volume|MA\d|entry|tp|sl|stop\s*loss|take\s*profit|support|resistance|broker|orderbook|order\s*book|bid|offer|analisis|analisa|cut\s*loss|hold|averaging|nambah|beli|jual|scalp|swing|intraday|dividen|right\s*issue|akuisisi|merger)\b/i.test(lower)) return false;
  // If emotional word followed by "di" + something (implies stuck in a specific stock)
  if (/\b(rungkad|nyangkut|minus|rugi)\s+(di|sama)\s+\w/i.test(lower)) return false;
  // If message contains a 4-letter uppercase word that could be a ticker
  if (/\b[A-Z]{4}\b/.test(cleanMsg)) return false;
  // If message has price patterns
  if (/\b\d{2,6}\b/.test(lower) && /harga|rp|rupiah/i.test(lower)) return false;

  // Casual patterns
  if (/^(hai|halo|hi|hello|hey|pagi|siang|sore|malam|selamat|assalamualaikum|waalaikumsalam)\b/i.test(lower)) return true;
  if (/^(makasih|terima\s*kasih|thanks|thank\s*you|thx|tq|trims)\b/i.test(lower)) return true;
  if (/^(oke|ok|siap|sip|mantap|good|nice|baik|iya|ya|yap|yup|yoi)\s*[.!]?\s*$/i.test(lower)) return true;
  if (/^(kamu\s*(siapa|apa)|lu\s*siapa|ini\s*apa|web\s*ini|app\s*ini|fitur|cara\s*pakai|cara\s*pake|gimana\s*cara|cara\s*kerja|fungsi|buat\s*apa)/i.test(lower)) return true;
  if (/^(jelasin|tolong\s*jelasin|explain|bantuin|bantu\s*dong|help)\s*(dong|ya|please)?\s*$/i.test(lower)) return true;
  if (/^(lanjut|terus|next|oke\s*lanjut|yuk|gas|gass|let'?s\s*go)\s*[.!]?\s*$/i.test(lower)) return true;
  // Emotional / loss-related casual (no ticker mentioned, just venting)
  // Must NOT contain potential ticker (4-letter word that isn't a common Indonesian word)
  var commonWords4 = /\b(yang|saya|lagi|bisa|dari|buat|mana|kamu|kami|juga|baru|sama|udah|gitu|gini|dong|dulu|pagi|sore|soal|baik|atas|lalu|cuma|abis|akan|agar|biar|saat|guys|boss|bang|halo|stop|naik|jadi|tapi|juga|terus)\b/gi;
  var strippedForTicker = cleanMsg.replace(commonWords4, '').replace(/[^a-zA-Z\s]/g, '');
  var hasPotentialTicker = /\b[a-zA-Z]{4}\b/.test(strippedForTicker);
  // Also check if message mentions price patterns (e.g. "stop di 50")
  var hasPriceHint = /\b\d{2,6}\b/.test(lower) || /\b(di|harga|stop|nyangkut)\s+\d/i.test(lower);
  if (/\b(minus|rugi|nyangkut|rungkad|floating\s*loss|portofolio?\s*merah|porto\s*merah|merah\s*semua|lagi\s*merah|sedih|galau|bingung\s*nih|stress|pusing|panik|takut|capek|males)\b/i.test(lower) && !hasPotentialTicker && !hasPriceHint) return true;
  // Very short non-stock messages (< 15 chars, no ticker patterns)
  if (lower.length < 15 && !/[A-Z]{4}/.test(cleanMsg) && !/\d{2,}/.test(lower)) return true;

  return false;
}

async function callGroq(apiKey, systemPrompt, userMessage) {
  var url = 'https://api.groq.com/openai/v1/chat/completions';
  var payload = {
    model: 'llama-3.1-8b-instant',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ],
    temperature: 0.7,
    max_tokens: 256,
    stream: false
  };

  try {
    var response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) return null;
    var result = await response.json();
    var choices = result.choices || [];
    if (choices.length > 0 && choices[0].message && choices[0].message.content) {
      var text = choices[0].message.content.trim();
      // Wrap in HTML if not already
      if (!text.startsWith('<')) {
        text = '<p class="text-sm text-gray-300">' + text.replace(/\n/g, '</p><p class="text-sm text-gray-300">') + '</p>';
      }
      return text.replace(/^```html\s*/i, '').replace(/```\s*$/i, '');
    }
    return null;
  } catch (e) {
    return null; // Silent fail, will fallback to Gemini
  }
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
    if (/^(masih\s*)?(aman|bahaya)\s*(gak|ga|tidak|nggak)?\s*(ya|sih|nih|dong)?\s*\??$/i.test(msg)) return 'follow_up_question';

    // Contextual data follow-up: level-related keywords when context exists
    // MUST be checked before the short-message catch-all to avoid misrouting
    if (/\b(tembus|jebol|breakdown|breakout|target|support|resistance|entry|cutloss|cut\s*loss|hold|aman|bahaya|reclaim|rebound|lanjut|koreksi|turun\s*ke|naik\s*ke|sampai|mentok|level)\b/i.test(msgLower)) {
      return 'contextual_data_followup';
    }

    // Short message with question mark when context exists (catch-all for simple follow-ups)
    if (msg.length < 40 && msg.includes('?')) return 'follow_up_question';

    // Broader catch-all: short message (<100 chars) that doesn't contain the ticker itself
    // These are follow-up questions referencing existing context
    if (msg.length < 100 && context.ticker && !msg.toUpperCase().includes(context.ticker)) {
      return 'follow_up_question';
    }
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

// === OUTPUT COMPLETENESS CHECKER ===
// Returns true if stock analysis output is missing critical sections (likely truncated)
function isStockAnalysisIncomplete(html, intent) {
  if (!html || typeof html !== 'string') return true;
  // Only check for stock analysis intents (not casual chat, follow-up, etc.)
  if (intent === 'casual_chat' || intent === 'follow_up_question' || intent === 'ticker_only' || intent === 'contextual_data_followup') return false;

  var lower = html.toLowerCase();
  var requiredMarkers = [
    'kesimpulan final',
    'kesimpulan analitis'
  ];
  // If output has less than 800 chars, likely incomplete
  if (html.length < 800) return true;

  // Check for at least one of the final markers
  var hasConclusion = false;
  for (var i = 0; i < requiredMarkers.length; i++) {
    if (lower.indexOf(requiredMarkers[i]) > -1) {
      hasConclusion = true;
      break;
    }
  }
  return !hasConclusion;
}

// === OUTPUT SANITIZER ===
function sanitizeOutput(html, fcaConfirmed, intent) {
  if (!html) return html;
  var output = html;

  // A. Strip raw markdown bold ** stars → convert to <strong>
  output = output.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Strip remaining single * that might be leftover
  output = output.replace(/(?<![<\/])\*([^*\n]+)\*(?![>])/g, '<em>$1</em>');

  // B. FCA Guard — remove all FCA content if not confirmed
  if (!fcaConfirmed) {
    output = output.replace(/<(?:p|li|span|strong|div|h[1-6])[^>]*>[^<]*(?:FCA|Full\s*Call\s*Auction|papan\s*pemantauan\s*khusus|saham\s*FCA|risiko\s*FCA|FCA\s*score\s*cap|Position\s*Sizing\s*FCA|PERINGATAN\s*FCA)[^<]*<\/(?:p|li|span|strong|div|h[1-6])>/gi, '');
    output = output.replace(/(?:Status\s+FCA\s*:\s*[^<.]*\.?)/gi, '');
  }

  // C. Remove report-style headers (unless full_analysis_request)
  if (intent !== 'full_analysis_request') {
    output = output.replace(/\d+\.\s*INPUT QUALITY[^<]*/gi, '');
    output = output.replace(/\d+\.\s*TECHNICAL ANALYSIS[^<]*/gi, '');
    output = output.replace(/\d+\.\s*RISK MANAGEMENT[^<]*/gi, '');
    output = output.replace(/\d+\.\s*SCORE\s*&?\s*DECISION[^<]*/gi, '');
    output = output.replace(/\d+\.\s*WHAT COULD GO WRONG[^<]*/gi, '');
    output = output.replace(/\d+\.\s*ACTION PLAN[^<]*/gi, '');
    output = output.replace(/INPUT QUALITY\s*&?\s*EVIDENCE SUMMARY[^<]*/gi, '');
  }

  // D. Remove empty paragraphs left over
  output = output.replace(/<p[^>]*>\s*<\/p>/gi, '');

  // E. Remove raw [Auto-Cuan ...] blocks that leaked
  output = output.replace(/\[Auto-Cuan[^\]]*\]/gi, '');
  output = output.replace(/\[End News Research\]/gi, '');
  output = output.replace(/\[Auto-Cuan Board Data\]/gi, '');
  output = output.replace(/\[Auto-Cuan News Summary\]/gi, '');
  output = output.replace(/\[Auto-Cuan Score\]/gi, '');
  output = output.replace(/News Summary: unavailable/gi, '');

  // Minimal safety for contextual_data_followup: warn if full template leaked
  if (intent === 'contextual_data_followup') {
    var templateHeaders = ['kesimpulan cepat', 'ringkasan market', 'potensi besok', 'data teknikal', 'momentum market', 'kesimpulan final', 'kesimpulan analitis', 'skenario harga', 'rencana trading'];
    var headerCount = 0;
    var outputLower = output.toLowerCase();
    for (var th = 0; th < templateHeaders.length; th++) {
      if (outputLower.indexOf(templateHeaders[th]) !== -1) headerCount++;
    }
    // If 3+ template headers leaked, strip the strong/header tags but keep content
    if (headerCount >= 3) {
      output = output.replace(/<strong[^>]*>(?:Kesimpulan Cepat|Ringkasan Market|Potensi Besok|Data Teknikal|Momentum Market|Kesimpulan Final|Kesimpulan Analitis|Skenario Harga|Rencana Trading|Risk Guard|Setup Label)[^<]*<\/strong>/gi, '');
      output = output.replace(/<div\s+class="(?:decision-card|decision-grid|metric-grid|scenario-price-grid|trade-plan-grid|level-grid)"[^>]*>/gi, '<div>');
    }
  }

  return output;
}

// === FIXED TEMPLATE: Parse Market Data from enriched message ===
function parseMarketDataFromMessage(msg) {
  if (!msg || typeof msg !== 'string') return null;
  var dataBlock = msg.match(/\[Auto-Cuan Market Data\]([\s\S]*?)(?:\[Auto-Cuan|$)/i);
  if (!dataBlock) return null;
  var block = dataBlock[1];
  function extract(label) {
    var re = new RegExp(label + '\\s*[:]\\s*([^\\n]+)', 'i');
    var m = block.match(re);
    return m ? m[1].trim() : null;
  }
  function num(label) {
    var v = extract(label);
    if (!v) return null;
    var n = parseFloat(v.replace(/,/g, ''));
    return isNaN(n) ? null : n;
  }
  return {
    last: num('Last'),
    open: num('Open'),
    high: num('High'),
    low: num('Low'),
    volume: num('Volume') || 0,
    prevClose: num('Prev Close'),
    priceChange1D: num('Price Change 1D'),
    volumeVsAvg20: num('Volume vs Avg 20'),
    volumeAvg20: num('Avg Volume 20'),
    ma20: num('MA20'),
    ma50: num('MA50'),
    ma100: num('MA100'),
    ma200: num('MA200'),
    rsi14: num('RSI14'),
    support1: num('Support 1'),
    support2: num('Support 2'),
    resistance1: num('Resistance 1'),
    resistance2: num('Resistance 2'),
    pivotPoint: num('Pivot Point'),
    fib382: num('Fib 38\\.2%'),
    fib500: num('Fib 50%'),
    fib618: num('Fib 61\\.8%'),
    fib786: num('Fib 78\\.6%'),
    volumeTrend: extract('Volume Trend'),
    priceVolumeReading: extract('Price-Volume Reading')
  };
}

// === FIXED TEMPLATE: IHSG Market Report ===
function buildIHSGFixedTemplate(d, rawMsg) {
  if (!d || !d.last) return null;
  var last = d.last;
  var changePct = d.priceChange1D != null ? d.priceChange1D : 0;
  var volRatio = d.volumeVsAvg20 != null ? d.volumeVsAvg20 : 1;
  var rsi14 = d.rsi14 || 50;
  var ma20 = d.ma20 || '-';
  var ma50 = d.ma50 || '-';
  var ma100 = d.ma100 || '-';
  var ma200 = d.ma200 || '-';
  var high = d.high || '-';
  var low = d.low || '-';
  var r1 = d.resistance1 || '-';
  var r2 = d.resistance2 || '-';
  var s1 = d.support1 || '-';
  var s2 = d.support2 || '-';

  // Determine status/bias/confidence/sikap from data
  var statusMarket, biasIHSG, confidence, sikap;
  if (changePct <= -1.5 && rsi14 < 40) { statusMarket = 'Risk-Off'; biasIHSG = 'Bearish'; confidence = 'High'; sikap = 'Defensive'; }
  else if (changePct <= -0.5 && rsi14 < 50) { statusMarket = 'Wait Confirmation'; biasIHSG = 'Bearish'; confidence = 'Medium'; sikap = 'Defensive'; }
  else if (changePct >= 1 && rsi14 > 55) { statusMarket = 'Breakout Watch'; biasIHSG = 'Bullish'; confidence = 'High'; sikap = 'Aggressive'; }
  else if (changePct >= 0.3 && rsi14 > 50) { statusMarket = 'Rebound Watch'; biasIHSG = 'Bullish'; confidence = 'Medium'; sikap = 'Selective'; }
  else if (rsi14 < 30) { statusMarket = 'Rebound Watch'; biasIHSG = 'Bearish'; confidence = 'Medium'; sikap = 'Wait'; }
  else { statusMarket = 'Neutral'; biasIHSG = 'Neutral'; confidence = 'Medium'; sikap = 'Selective'; }

  // RSI condition
  var rsiCondition = rsi14 > 70 ? 'overbought' : rsi14 > 55 ? 'bullish momentum' : rsi14 > 45 ? 'netral' : rsi14 > 30 ? 'bearish' : 'oversold';

  // MA position
  var maPosition = '';
  if (d.ma20 && d.ma50) {
    if (last > d.ma20 && last > d.ma50) maPosition = 'di atas MA20 dan MA50';
    else if (last > d.ma20) maPosition = 'di atas MA20, di bawah MA50';
    else if (last > d.ma50) maPosition = 'di bawah MA20, di atas MA50';
    else maPosition = 'di bawah MA20 dan MA50';
  } else { maPosition = '-'; }

  // Market pressure
  var marketPressure = changePct < -1 ? 'tekanan jual dominan' : changePct < 0 ? 'tekanan jual ringan' : changePct > 1 ? 'tekanan beli dominan' : changePct > 0 ? 'tekanan beli ringan' : 'keseimbangan sementara';

  // Direction
  var arahUtama = changePct >= 0.5 ? 'Potensi lanjut naik jika momentum terjaga' : changePct <= -0.5 ? 'Potensi tekanan lanjut jika support tidak bertahan' : 'Sideways, menunggu katalis arah';
  var syaratRebound = 'IHSG bertahan di atas ' + s1 + ' dengan volume beli meningkat';
  var risikoBreakdown = 'Jika ' + s1 + ' ditembus, tekanan lanjut ke ' + s2;

  // Skenario
  var skenarioBullish = 'IHSG break ' + r1 + ' dengan volume meningkat, target selanjutnya ' + r2;
  var skenarioNetral = 'IHSG bergerak sideways di range ' + s1 + '-' + r1 + ', volume normal';
  var skenarioBearish = 'IHSG breakdown ' + s1 + ', tekanan lanjut ke ' + s2 + ' dengan volume jual tinggi';

  // Konfirmasi & Risiko
  var levelKonfirmasi = 'IHSG reclaim ' + r1 + ' dengan volume di atas rata-rata';
  var levelRisiko = 'IHSG breakdown ' + s1 + ' dengan volume jual meningkat';

  // Fibonacci (if available)
  var fibSection = '';
  if (d.fib382 && d.fib500 && d.fib618) {
    var posisiFib = '';
    if (last > d.fib382) posisiFib = 'di atas Fib 38,2%';
    else if (last > d.fib500) posisiFib = 'antara Fib 50% dan Fib 38,2%';
    else if (last > d.fib618) posisiFib = 'antara Fib 61,8% dan Fib 50%';
    else posisiFib = 'di bawah Fib 61,8%';
    var implikasiFib = last > d.fib500 ? 'Retracement masih wajar, potensi recovery ada' : 'Retracement cukup dalam, waspada tekanan lanjutan';
    fibSection = '<div class="metric-grid"><div><strong>Fibonacci Market</strong>' +
      '<div>Fib 38,2%: ' + d.fib382 + '</div>' +
      '<div>Fib 50%: ' + d.fib500 + '</div>' +
      '<div>Fib 61,8%: ' + d.fib618 + '</div>' +
      (d.fib786 ? '<div>Fib 78,6%: ' + d.fib786 + '</div>' : '') +
      '<div>Posisi IHSG: ' + posisiFib + '</div>' +
      '<div>Implikasi Market: ' + implikasiFib + '</div>' +
      '</div></div>';
  }

  // Implikasi ke Saham
  var implBigCaps = changePct >= 0 ? 'Big caps berpotensi stabil, bisa jadi penggerak jika momentum lanjut' : 'Big caps ikut tertekan, potensi tekanan jual dari asing';
  var implSecondLiners = changePct >= 0 ? 'Second liners bisa ikut bergerak jika IHSG konfirmasi bullish' : 'Second liners lebih rentan, likuiditas bisa menyusut';
  var implDefensive = changePct >= 0 ? 'Sektor defensif bisa underperform jika risk-on dominan' : 'Sektor defensif (consumer, telco) bisa jadi tempat parking dana';

  // Sentimen/Katalis
  var newsBlock = rawMsg.match(/\[Auto-Cuan News Summary\]([\s\S]*?)(?:\[Auto-Cuan|$)/i);
  var katalisText = 'Data katalis tidak tersedia saat ini, fokus teknikal.';
  if (newsBlock && newsBlock[1] && newsBlock[1].indexOf('unavailable') === -1 && newsBlock[1].indexOf('- ') !== -1) {
    katalisText = 'Terdapat beberapa katalis dari data yang tersedia yang dapat mempengaruhi sentimen market.';
  }

  // Risk Guard
  var riskGuard = rsi14 < 30 ? 'RSI14 sudah oversold (' + rsi14 + '), potensi technical rebound ada tapi butuh konfirmasi volume.' : changePct <= -2 ? 'Penurunan signifikan (' + changePct + '%), waspada tekanan lanjutan jika support ' + s1 + ' tidak bertahan.' : 'Kondisi teknikal ' + rsiCondition + ', pantau level ' + s1 + ' sebagai acuan risiko.';

  // Build HTML
  var html = '';
  html += '<div class="decision-card"><strong>Kesimpulan Cepat IHSG</strong><div class="decision-grid">';
  html += '<div><span>Status Market</span><b>' + statusMarket + '</b></div>';
  html += '<div><span>Bias IHSG</span><b>' + biasIHSG + '</b></div>';
  html += '<div><span>Confidence</span><b>' + confidence + '</b></div>';
  html += '<div><span>Sikap</span><b>' + sikap + '</b></div>';
  html += '</div><div class="key-level">Level kunci: R ' + r1 + ' / S ' + s1 + '</div></div>';

  html += '<p><strong>Ringkasan Market</strong><br>';
  html += 'IHSG ditutup ' + last + ', ' + (changePct >= 0 ? 'naik' : (changePct <= -3 ? 'anjlok' : 'turun')) + ' ' + String(Math.abs(changePct).toFixed(2)).replace('.', ',') + '% dengan volume ' + String(volRatio).replace('.', ',') + 'x rata-rata. ';
  html += 'Harga ' + maPosition + ' dan RSI 14 menyentuh ' + String(rsi14).replace('.', ',') + ' (' + rsiCondition + '), menunjukkan ' + marketPressure + '.</p>';

  html += '<div class="scenario-list"><div><strong>Potensi Besok</strong><br><br>';
  html += '<strong class="text-gray-400">Arah Utama:</strong> ' + arahUtama + '<br><br>';
  html += '<strong class="text-gray-400">Uji Resistance:</strong> Resistance terdekat di ' + r1 + ' (R1), kemudian ' + r2 + ' (R2).<br><br>';
  html += '<strong class="text-gray-400">Uji Support:</strong> Support pertama ' + s1 + ' (S1), kemudian ' + s2 + ' (S2).<br><br>';
  html += '<strong class="text-gray-400">Syarat Rebound:</strong> ' + syaratRebound + '.<br><br>';
  html += '<strong class="text-gray-400">Risiko Breakdown:</strong> ' + risikoBreakdown + '.</div></div>';

  html += '<div class="metric-grid"><div><strong>Data Teknikal IHSG</strong>';
  html += '<div>MA20: ' + ma20 + '</div>';
  html += '<div>MA50: ' + ma50 + '</div>';
  html += '<div>MA100: ' + ma100 + '</div>';
  html += '<div>MA200: ' + ma200 + '</div>';
  html += '<div>Posisi: ' + maPosition + '</div>';
  html += '</div>';
  html += '<div><strong>Momentum Market</strong>';
  html += '<div>RSI14: ' + rsi14 + '</div>';
  html += '<div>Volume: ' + volRatio + 'x avg20</div>';
  html += '<div>Last: ' + last + '</div>';
  html += '<div>High: ' + high + '</div>';
  html += '<div>Low: ' + low + '</div>';
  html += '</div></div>';

  html += '<div class="level-grid"><div><strong>Resistance IHSG</strong><div>R1: ' + r1 + '</div><div>R2: ' + r2 + '</div></div>';
  html += '<div><strong>Support IHSG</strong><div>S1: ' + s1 + '</div><div>S2: ' + s2 + '</div></div></div>';

  html += '<div class="level-grid"><div><strong>Level Konfirmasi</strong><br><br>' + levelKonfirmasi + '</div>';
  html += '<div><strong>Level Risiko</strong><br><br>' + levelRisiko + '</div></div>';

  html += '<div class="scenario-list"><div><strong>Skenario Bullish Market</strong><br><br>' + skenarioBullish + '</div>';
  html += '<div><strong>Skenario Netral</strong><br><br>' + skenarioNetral + '</div>';
  html += '<div><strong>Skenario Bearish</strong><br><br>' + skenarioBearish + '</div></div>';

  if (fibSection) html += fibSection;

  html += '<p><strong>Implikasi ke Saham</strong></p>';
  html += '<div>Big caps: ' + implBigCaps + '</div>';
  html += '<div>Second liners: ' + implSecondLiners + '</div>';
  html += '<div>Defensive sectors: ' + implDefensive + '</div>';

  html += '<p><strong>Katalis / Sentimen IHSG</strong><br><br>' + katalisText + '</p>';

  html += '<p><strong>Risk Guard Market</strong><br><br>' + riskGuard + '</p>';

  html += '<div class="analytic-summary"><strong>Kesimpulan Final Market</strong><div class="summary-rows">';
  html += '<div><span>Status Market</span><b>' + statusMarket + '</b></div>';
  html += '<div><span>Bias</span><b>' + biasIHSG + '</b></div>';
  html += '<div><span>Sikap</span><b>' + sikap + '</b></div>';
  html += '<div><span>Konfirmasi</span><b>' + levelKonfirmasi + '</b></div>';
  html += '<div><span>Risiko</span><b>' + levelRisiko + '</b></div>';
  html += '</div></div>';

  return html;
}

// === FIXED TEMPLATE: Stock Structured Report ===
function buildStockFixedTemplate(d, ticker, rawMsg) {
  if (!d || !d.last) return null;
  var last = d.last;
  var changePct = d.priceChange1D != null ? d.priceChange1D : 0;
  var volRatio = d.volumeVsAvg20 != null ? d.volumeVsAvg20 : 1;
  var rsi14 = d.rsi14 || 50;
  var ma20 = d.ma20;
  var ma50 = d.ma50;
  var ma100 = d.ma100;
  var ma200 = d.ma200;
  var high = d.high || '\u2014';
  var low = d.low || '\u2014';
  var r1 = d.resistance1;
  var r2 = d.resistance2;
  var s1 = d.support1;
  var s2 = d.support2;

  // Need at least last price (rsi/ma/support are filled with defaults if null)
  if (!last) return null;

  // Indonesian number format: decimals use comma (6,45), integers stay plain (5075)
  function idn(val) {
    if (val == null) return '\u2014';
    var n = Number(val);
    if (isNaN(n)) return String(val);
    // Integer: plain number, no thousand separator
    if (n === Math.floor(n)) return String(n);
    // Decimal: replace dot with comma
    return String(parseFloat(n.toPrecision(6))).replace('.', ',');
  }
  function pct(val) { if (val == null) return '\u2014'; return String(Math.abs(val).toFixed(2)).replace('.', ',') + '%'; }
  function ratio(val) { if (val == null) return '\u2014'; return String(val).replace('.', ',') + 'x'; }
  // Safe display value (keeps string as-is, formats numbers Indonesian)
  function v(val) { if (val == null) return '\u2014'; if (typeof val === 'number') return idn(val); return String(val); }

  // === DECISION LOGIC ===
  var status, bias, confidence, action;
  if (changePct <= -5 && last < (ma20 || Infinity) && last < (ma50 || Infinity)) {
    status = 'Avoid Dulu'; bias = 'Bearish'; confidence = 'High'; action = 'Avoid dulu';
  } else if (changePct <= -2 && rsi14 < 40) {
    status = 'Avoid Dulu'; bias = 'Bearish'; confidence = 'High'; action = 'Avoid dulu';
  } else if (changePct <= -1 && rsi14 < 45) {
    status = 'Tunggu Konfirmasi'; bias = 'Bearish'; confidence = 'Medium'; action = 'Tunggu konfirmasi';
  } else if (rsi14 < 30) {
    status = 'Rebound Watch'; bias = 'Bearish'; confidence = 'Medium'; action = 'Tunggu konfirmasi rebound';
  } else if (changePct >= 2 && rsi14 > 55 && last > (ma20 || 0)) {
    status = 'Breakout Watch'; bias = 'Bullish'; confidence = 'High'; action = 'Beli saat breakout terkonfirmasi';
  } else if (changePct >= 0.5 && rsi14 > 50 && last > (ma20 || 0)) {
    status = 'Speculative Watch'; bias = 'Bullish'; confidence = 'Medium'; action = 'Posisi kecil saja';
  } else if (last > (ma20 || 0) && last > (ma50 || 0) && rsi14 > 50) {
    status = 'Breakout Watch'; bias = 'Bullish'; confidence = 'Medium'; action = 'Watchlist';
  } else {
    status = 'Tunggu Konfirmasi'; bias = 'Neutral'; confidence = 'Medium'; action = 'Watchlist';
  }

  var rsiLabel = rsi14 > 70 ? 'overbought' : rsi14 > 55 ? 'bullish momentum' : rsi14 > 45 ? 'netral' : rsi14 > 30 ? 'bearish/lemah' : 'oversold';
  var maPosition = '\u2014';
  if (ma20 && ma50 && ma100 && ma200) {
    if (last > ma20 && last > ma50 && last > ma100 && last > ma200) maPosition = 'Di atas semua MA utama';
    else if (last < ma20 && last < ma50 && last < ma100 && last < ma200) maPosition = 'Di bawah semua MA utama';
    else if (last > ma20 && last > ma50) maPosition = 'Di atas MA20 dan MA50';
    else maPosition = 'Di bawah MA20 dan MA50';
  } else if (ma20 && ma50) {
    if (last > ma20 && last > ma50) maPosition = 'Di atas MA20 dan MA50';
    else if (last < ma20 && last < ma50) maPosition = 'Di bawah MA20 dan MA50';
    else maPosition = 'Mixed';
  }
  var changeText = changePct >= 0 ? 'naik ' + pct(changePct) : (changePct <= -5 ? 'anjlok ' : 'turun ') + pct(changePct);
  var pressureSummary = changePct <= -3 ? 'Tekanan jual masih dominan, belum ada sinyal pemulihan' : changePct <= -1 ? 'Tekanan jual terlihat, perlu konfirmasi support' : changePct >= 2 ? 'Tekanan beli dominan, momentum positif' : 'Belum ada tekanan dominan yang jelas';
  var bearLevel = s2 || (s1 ? Math.round(s1 * 0.98) : '\u2014');
  var baseRange = v(s1) + '\u2013' + v(r1);
  var bullLevel = r1 || '\u2014';
  var bearDesc = s1 ? 'Tembus S1 ' + s1 + ' dan lanjut ke S2 dengan volume jual meningkat' : 'Breakdown support terdekat';
  var baseDesc = 'Konsolidasi di area support-resistance, volume normal';
  var bullDesc = r1 ? 'Breakout di atas ' + r1 + ' dengan volume meningkat' : 'Breakout resistance terdekat';
  var setupAction, setupReason, setupValid, setupCancel;
  if (bias === 'Bearish') { setupAction = 'Avoid Dulu'; setupReason = 'Momentum negatif, harga ' + maPosition.charAt(0).toLowerCase() + maPosition.slice(1) + ', RSI ' + rsiLabel; setupValid = 'Harga reclaim ' + v(r1) + ' dengan volume di atas rata-rata'; setupCancel = 'Breakdown di bawah ' + v(s1) + ' menuju ' + v(s2); }
  else if (bias === 'Bullish') { setupAction = 'Entry saat konfirmasi'; setupReason = 'Momentum positif, harga ' + maPosition.charAt(0).toLowerCase() + maPosition.slice(1) + ', RSI ' + rsiLabel; setupValid = 'Harga bertahan di atas ' + v(ma20) + ' dan volume konsisten'; setupCancel = 'Harga breakdown ' + v(s1) + ' atau volume menurun'; }
  else { setupAction = 'Watchlist'; setupReason = 'Kondisi netral, menunggu konfirmasi arah'; setupValid = 'Breakout ' + v(r1) + ' atau reclaim MA20 dengan volume'; setupCancel = 'Breakdown ' + v(s1) + ' dengan volume jual'; }
  var volBlock = rawMsg.match(/\[Auto-Cuan Volume Intelligence\]([\s\S]*?)(?:\[Auto-Cuan|$)/i);
  var volToday = '\u2014', volAvg3 = '\u2014', volAvg7 = '\u2014', volVs7 = '\u2014', volCommentary = '\u2014';
  if (volBlock) { var vb = volBlock[1]; var ve = function(lbl) { var m = vb.match(new RegExp(lbl + '\\s*[:]\\s*([^\\n]+)', 'i')); return m ? m[1].trim() : '\u2014'; }; volToday = ve('Volume Terakhir'); volAvg3 = ve('Rata-rata 3 Hari'); volAvg7 = ve('Rata-rata 7 Hari'); volVs7 = ve('Volume vs Avg 7D'); volCommentary = ve('Pembacaan'); }
  var fibBlock = rawMsg.match(/\[Auto-Cuan Fibonacci Intelligence\]([\s\S]*?)(?:\[Auto-Cuan|$)/i);
  var fibSwingH = '\u2014', fibSwingL = '\u2014', fibNearest = '\u2014', fibTrend = '\u2014', fib382 = d.fib382 != null ? d.fib382 : '\u2014', fib500 = d.fib500 != null ? d.fib500 : '\u2014', fib618 = d.fib618 != null ? d.fib618 : '\u2014', fib786 = d.fib786 != null ? d.fib786 : '\u2014', fibCommentary = '\u2014', hasFib = false;
  if (fibBlock) { hasFib = true; var fb = fibBlock[1]; var fe = function(lbl) { var m = fb.match(new RegExp(lbl + '\\s*[:]\\s*([^\\n]+)', 'i')); return m ? m[1].trim() : '\u2014'; }; fibSwingH = fe('Swing High'); fibSwingL = fe('Swing Low'); fibNearest = fe('Nearest Fib'); fibTrend = fe('Trend Context'); fibCommentary = fe('Reading'); if (fibCommentary === '\u2014') fibCommentary = fe('Invalidation');
    // Extract actual Fib level numbers from Fibonacci Intelligence block (overrides Market Data if available)
    var fibVal382 = fe('Fib 38\\.2%'); if (fibVal382 !== '\u2014') fib382 = fibVal382;
    var fibVal500 = fe('Fib 50%'); if (fibVal500 !== '\u2014') fib500 = fibVal500;
    var fibVal618 = fe('Fib 61\\.8%'); if (fibVal618 !== '\u2014') fib618 = fibVal618;
    var fibVal786 = fe('Fib 78\\.6%'); if (fibVal786 !== '\u2014') fib786 = fibVal786;
  } else if (d.fib382) { hasFib = true; }
  // Normalize Fibonacci values to Indonesian
  fibNearest = fibNearest.replace(/^Below\b/i, 'Di bawah').replace(/^Above\b/i, 'Di atas');
  fibTrend = fibTrend.replace(/downward_retracement/gi, 'Retracement turun').replace(/upward_retracement/gi, 'Retracement naik').replace(/sideways_range/gi, 'Sideways').replace(/_/g, ' ');
  var scenBullish = r1 ? 'Breakout ' + r1 + ' dengan volume meningkat, target ' + v(r2) : 'Breakout resistance terdekat';
  var scenNeutral = 'Sideways di range ' + v(s1) + '\u2013' + v(r1) + ', volume normal';
  var scenBearish = s1 ? 'Breakdown ' + s1 + ', tekanan lanjut ke ' + v(s2) : 'Breakdown support terdekat';
  var entryPlan, stopLoss, tp1, tp2, catatan;
  // reclaimLevel: use pivot from data; fallback to midpoint(S1,R1) rounded to IDX tick
  function roundToIdxTick(price) {
    if (!price || price <= 0) return price;
    // IDX tick: <=200 → multiple of 1; 200-500 → multiple of 2; 500-2000 → multiple of 5; 2000-5000 → multiple of 10; >5000 → multiple of 25
    if (price > 5000) return Math.round(price / 25) * 25;
    if (price > 2000) return Math.round(price / 10) * 10;
    if (price > 500) return Math.round(price / 5) * 5;
    if (price > 200) return Math.round(price / 2) * 2;
    return Math.round(price);
  }
  var reclaimLevel = d.pivotPoint || (s1 && r1 ? roundToIdxTick((s1 + r1) / 2) : null) || ma20 || r1 || s1;
  if (bias === 'Bearish') { entryPlan = 'Tunggu konfirmasi rebound di atas ' + v(reclaimLevel) + ' dengan volume.'; stopLoss = s1 ? 'Di bawah ' + v(s1) : '\u2014'; tp1 = v(r1); tp2 = v(r2); catatan = 'Hindari beli saat tekanan jual masih dominan dan RSI ' + rsiLabel + ' tanpa konfirmasi.'; }
  else if (bias === 'Bullish') { entryPlan = 'Area ' + v(s1) + '\u2013' + v(ma20) + ' jika ada konfirmasi volume.'; stopLoss = s1 ? 'Di bawah ' + v(s1) : '\u2014'; tp1 = v(r1); tp2 = v(r2); catatan = 'Entry valid jika volume meningkat dan harga bertahan di atas support.'; }
  else { entryPlan = 'Tunggu konfirmasi breakout ' + v(r1) + ' atau rebound dari ' + v(s1) + '.'; stopLoss = s1 ? 'Di bawah ' + v(s1) : '\u2014'; tp1 = v(r1); tp2 = v(r2); catatan = 'Kondisi netral, perlu trigger arah sebelum ambil posisi.'; }
  // setupValid uses reclaimLevel for consistency with Entry/Konfirmasi
  var setupValidFinal = bias === 'Bearish' ? 'Harga reclaim ' + v(reclaimLevel) + ' dengan volume di atas rata-rata' : setupValid;
  var riskGuard = rsi14 < 30 ? 'RSI oversold (' + idn(rsi14) + ') tapi bukan otomatis sinyal beli. Tunggu konfirmasi volume.' : changePct <= -5 ? 'Penurunan sangat besar (' + pct(changePct) + '). Hindari averaging tanpa konfirmasi.' : changePct <= -2 ? 'Tekanan jual kuat. Cut loss jika breakdown ' + v(s1) + '.' : 'Pantau level ' + v(s1) + ' sebagai acuan risiko. Disiplin stop loss.';
  var trendSummary = bias === 'Bullish' ? 'Bullish' : bias === 'Bearish' ? 'Bearish' : 'Neutral';
  var momentumSummary = rsi14 > 55 ? 'Kuat' : rsi14 > 45 ? 'Netral' : rsi14 > 30 ? 'Lemah' : 'Sangat lemah (oversold)';
  var volumeSummary = volRatio > 2 ? 'Spike (' + ratio(volRatio) + ' avg)' : volRatio > 1.3 ? 'Di atas rata-rata' : volRatio > 0.7 ? 'Normal' : 'Di bawah rata-rata';
  var fibSummary = hasFib ? fibNearest : '\u2014';
  var riskSummary = changePct <= -3 ? 'Tinggi' : changePct <= -1 ? 'Sedang' : 'Rendah-Sedang';
  var newsBlock2 = rawMsg.match(/\[Auto-Cuan News Summary\]([\s\S]*?)(?:\[Auto-Cuan|$)/i);
  var newsText = 'Tidak ada katalis kuat. Fokus teknikal.';
  if (newsBlock2 && newsBlock2[1] && newsBlock2[1].indexOf('unavailable') === -1 && newsBlock2[1].indexOf('- ') !== -1) { newsText = 'Terdapat katalis yang bisa mempengaruhi pergerakan. Validasi apakah sudah ter-price-in.'; }
  var invalidation = bias === 'Bearish' ? 'Breakdown di bawah ' + v(s1) + ' menuju ' + v(s2) + ' dengan volume jual meningkat.' : 'Setup batal jika harga breakdown ' + v(s1) + ' dengan volume jual signifikan.';
  var finalReason = '<div>1. Trend: harga ' + maPosition.charAt(0).toLowerCase() + maPosition.slice(1) + '</div><div>2. Momentum: RSI ' + idn(rsi14) + ' (' + rsiLabel + ')</div><div>3. Volume: ' + ratio(volRatio) + ' rata-rata</div>' + (hasFib ? '<div>4. Fibonacci: ' + fibNearest + '</div><div>5. Perubahan harga: ' + changeText + '</div>' : '<div>4. Perubahan harga: ' + changeText + '</div>');

  // === BUILD HTML ===
  var html = '';
  // 1. Kesimpulan Cepat
  html += '<div class="decision-card"><strong>Kesimpulan Cepat</strong><div class="decision-grid">';
  html += '<div><span>Status</span><b>' + status + '</b></div>';
  html += '<div><span>Bias</span><b>' + bias + '</b></div>';
  html += '<div><span>Confidence</span><b>' + confidence + '</b></div>';
  html += '<div><span>Action</span><b>' + action + '</b></div>';
  html += '</div><div class="key-level">Level kunci: R ' + v(r1) + ' / S ' + v(s1) + '</div></div>';
  // 2. Ringkasan Cepat
  html += '<p><strong>Ringkasan Cepat</strong><br>' + ticker + ' ' + changeText + ' dengan volume ' + ratio(volRatio) + ' rata-rata. Harga ' + maPosition.charAt(0).toLowerCase() + maPosition.slice(1) + ' dan RSI ' + rsiLabel + '. ' + pressureSummary + '.</p>';
  // 3. Skenario Harga
  html += '<div class="scenario-price-grid">';
  html += '<div class="case-card bear"><span>BEAR</span><b>' + bearLevel + '</b><p>' + bearDesc + '</p></div>';
  html += '<div class="case-card base"><span>BASE</span><b>' + baseRange + '</b><p>' + baseDesc + '</p></div>';
  html += '<div class="case-card bull"><span>BULL</span><b>' + bullLevel + '</b><p>' + bullDesc + '</p></div>';
  html += '</div>';
  // 4. Setup
  html += '<p><strong>Setup</strong><br>' + setupAction + '</p>';
  html += '<p><strong>Alasan</strong><br>' + setupReason + '</p>';
  html += '<p><strong>Valid jika</strong><br>' + setupValidFinal + '</p>';
  html += '<p><strong>Batal jika</strong><br>' + setupCancel + '</p>';
  // 5. Moving Average + Momentum
  html += '<div class="metric-grid"><div><strong>Moving Average</strong>';
  html += '<div>MA20: ' + v(ma20) + '</div>';
  html += '<div>MA50: ' + v(ma50) + '</div>';
  html += '<div>MA100: ' + v(ma100) + '</div>';
  html += '<div>MA200: ' + v(ma200) + '</div>';
  html += '<div>Posisi: ' + maPosition + '</div>';
  html += '</div>';
  html += '<div><strong>Momentum</strong>';
  html += '<div>RSI14: ' + idn(rsi14) + ' (' + rsiLabel + ')</div>';
  html += '<div>Volume: ' + ratio(volRatio) + ' avg 20D</div>';
  html += '<div>Last: ' + idn(last) + '</div>';
  html += '<div>High: ' + idn(d.high) + '</div>';
  html += '<div>Low: ' + idn(d.low) + '</div>';
  html += '</div></div>';
  // 6. Volume 3/7D
  html += '<div class="volume-card"><strong>Volume 3/7D</strong><div class="volume-grid">';
  html += '<div><span>Terakhir</span><b>' + volToday + '</b></div>';
  html += '<div><span>Avg 3D</span><b>' + volAvg3 + '</b></div>';
  html += '<div><span>Avg 7D</span><b>' + volAvg7 + '</b></div>';
  html += '<div><span>vs 7D</span><b>' + volVs7 + '</b></div>';
  html += '</div><div class="volume-note">' + volCommentary + '</div></div>';
  // 7. Fibonacci (always shown; use — for missing values)
  html += '<div class="fibo-card"><strong>Fibonacci</strong><div class="fibo-grid">';
  html += '<div><span>Swing H</span><b>' + fibSwingH + '</b></div>';
  html += '<div><span>Swing L</span><b>' + fibSwingL + '</b></div>';
  html += '<div><span>Nearest</span><b>' + fibNearest + '</b></div>';
  html += '<div><span>Trend</span><b>' + fibTrend + '</b></div>';
  html += '</div><div class="fibo-grid">';
  html += '<div class="fibo-level"><span>38,2%</span><b>' + fib382 + '</b></div>';
  html += '<div class="fibo-level"><span>50%</span><b>' + fib500 + '</b></div>';
  html += '<div class="fibo-level"><span>61,8%</span><b>' + fib618 + '</b></div>';
  html += '<div class="fibo-level"><span>78,6%</span><b>' + fib786 + '</b></div>';
  html += '</div><div class="fibo-note">' + fibCommentary + '</div></div>';
  // 8. Resistance + Support
  html += '<div class="level-grid"><div><strong>Resistance</strong>';
  html += '<div>R1: ' + v(r1) + '</div>';
  html += '<div>R2: ' + v(r2) + '</div>';
  html += '</div>';
  html += '<div><strong>Support</strong>';
  html += '<div>S1: ' + v(s1) + '</div>';
  html += '<div>S2: ' + v(s2) + '</div>';
  html += '</div></div>';
  // 9. Skenario Trading
  html += '<div class="scenario-list">';
  html += '<div><strong>Bullish</strong><br><br>' + scenBullish + '</div>';
  html += '<div><strong>Netral</strong><br><br>' + scenNeutral + '</div>';
  html += '<div><strong>Bearish</strong><br><br>' + scenBearish + '</div></div>';
  // 10. Rencana Trading
  html += '<div class="trade-plan-grid">';
  html += '<div><strong>Entry</strong><br><br>' + entryPlan + '</div>';
  html += '<div><strong>Stop Loss</strong><br><br>' + stopLoss + '</div>';
  html += '<div><strong>TP</strong><br><br><div>TP1: ' + tp1 + '</div><div>TP2: ' + tp2 + '</div></div>';
  html += '<div><strong>Catatan</strong><br><br>' + catatan + '</div></div>';
  // 11. Risk Guard
  html += '<p><strong>Risk Guard</strong><br>' + riskGuard + '</p>';
  // 12. Kesimpulan Analitis
  html += '<div class="analytic-summary"><strong>Kesimpulan Analitis</strong><div class="summary-rows">';
  html += '<div><span>Trend</span><b>' + trendSummary + '</b></div>';
  html += '<div><span>Momentum</span><b>' + momentumSummary + '</b></div>';
  html += '<div><span>Volume</span><b>' + volumeSummary + '</b></div>';
  html += '<div><span>Fibonacci</span><b>' + fibSummary + '</b></div>';
  html += '<div><span>Support</span><b>' + v(s1) + '</b></div>';
  html += '<div><span>Resistance</span><b>' + v(r1) + '</b></div>';
  html += '<div><span>Risiko</span><b>' + riskSummary + '</b></div>';
  html += '<div><span>Rekomendasi</span><b>' + action + '</b></div>';
  html += '</div></div>';
  // 13. News/Katalis
  html += '<p><strong>News/Katalis</strong><br>' + newsText + '</p>';
  // 14. Invalidasi
  html += '<p><strong>Invalidasi</strong><br>' + invalidation + '</p>';
  // 15. Final (no "Kesimpulan Final" header — directly Status/Bias/Action)
  html += '<div class="analytic-summary"><div class="summary-rows">';
  html += '<div><span>Status</span><b>' + status + '</b></div>';
  html += '<div><span>Bias</span><b>' + bias + '</b></div>';
  html += '<div><span>Action</span><b>' + action + '</b></div>';
  html += '</div></div>';
  html += '<p><strong>Alasan</strong><br>' + finalReason + '</p>';
  html += '<p><strong>Konfirmasi</strong><br>' + setupValidFinal + '</p>';
  html += '<p><strong>Invalidasi</strong><br>' + invalidation + '</p>';
  return html;
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
