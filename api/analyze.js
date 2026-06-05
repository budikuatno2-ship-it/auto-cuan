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

      // === GROQ FOR CASUAL CHAT ===
      if (isCasualChat(chatMessage, body.context, intent)) {
        var casualResult = await handleCasualWithGroq(chatMessage);
        if (casualResult) {
          return res.status(200).json({ html: casualResult, intent: 'casual_chat', provider: 'groq' });
        }
        // Fallback: DeepSeek casual
        var dsCasual = await handleCasualChat(CODECRAFTERS_API_KEY, CODECRAFTERS_BASE_URL, CODECRAFTERS_MODEL, chatMessage);
        if (dsCasual) {
          return res.status(200).json({ html: dsCasual, intent: 'casual_chat', provider: 'deepseek' });
        }
        // Fallback: Gemini
        if (GEMINI_API_KEY) {
          var fallbackPrompt = 'Kamu Auto-Cuan AI. User kirim chat casual/sapaan. Jawab singkat 1-3 kalimat dalam HTML (p class text-sm text-gray-300). Bahasa Indonesia santai dan friendly. Jangan bahas saham kecuali ditanya.';
          var fallbackHtml = await callGemini(GEMINI_API_KEY, fallbackPrompt, chatMessage, 256);
          if (fallbackHtml) {
            return res.status(200).json({ html: fallbackHtml, intent: 'casual_chat', provider: 'gemini-fallback' });
          }
        }
        return res.status(200).json({
          html: '<p class="text-sm text-gray-300">Maaf, mode chat santai lagi belum aktif. Coba ulang sebentar lagi ya.</p>',
          intent: 'casual_chat', provider: 'fallback'
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
        prompt = 'Kamu Auto-Cuan AI, asisten trading yang conversational, thoughtful, dan natural. User bertanya follow-up tentang saham. Jawab 150-350 kata, langsung ke inti. Format HTML (p, strong, ul, li) dengan class text-sm text-gray-300. Bahasa Indonesia santai tapi berisi — seperti teman trading yang pinter.\n\nJika ada [Auto-Cuan Market Data], gunakan sebagai Data Historis T-1 (acuan pendukung analisis teknikal). Sebutkan posisi harga vs MA dan RSI14 jika tersedia. Interpretasi RSI: >70 overbought/koreksi risk, 55-70 bullish momentum, ~50 netral, 40-50 weak/bearish-neutral, <40 bearish, <30 oversold tapi bukan otomatis beli. Interpretasi volume: di atas AvgVol20 + merah = tekanan jual, di atas AvgVol20 + hijau = tekanan beli, di bawah AvgVol20 = move kurang meyakinkan. Selalu kombinasikan RSI+MA+Volume, jangan pakai RSI sendirian.\n\nJika ada [Auto-Cuan News Summary] dengan items, boleh mention singkat jika relevan dengan pertanyaan user. Jangan karang berita. Jika news unavailable, tidak perlu mention.\n\nJika ada [Auto-Cuan Fibonacci Intelligence], boleh mention posisi harga vs level Fibonacci terdekat jika relevan. Jangan karang level Fibonacci sendiri.\n\nJangan tampilkan blok data mentah ke user. Jangan paksa mention orderbook/broker kecuali user tanya. Jangan pakai markdown stars **. Jangan suggest short-selling. Untuk bearish: pakai avoid/wait and see/hold ketat/cut loss if invalidation breaks/downside risk. Akhiri dengan satu kalimat natural jika data masih terbatas.';
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
        maxTokens = 1536;
      } else if (intent === 'full_analysis_request') {
        prompt = 'Kamu Auto-Cuan AI, asisten analisis saham Indonesia premium. User minta analisis lengkap/mendalam. Format: HTML (div, p, strong, br, span, b). Bahasa Indonesia natural, evidence-based. Jawab 800-1200 kata.\n\n=== ATURAN UTAMA ===\nWAJIB selesaikan SEMUA section sampai Kesimpulan Final. RINGKAS tapi LENGKAP. JANGAN berhenti di tengah. JANGAN gabung field. Setiap field pisah baris <br>. JANGAN banyak dash/em-dash.\n\n=== DECISION GUARD ===\nJika Price Change 1D <= -5% DAN price di bawah MA20+MA50: Status WAJIB "Avoid Dulu", Bias "Bearish", Action "Avoid dulu".\n\n=== RP50 FLOOR GUARD ===\nJika last price 50-55 (area gocap):\n- Rp50 = floor penting. JANGAN target 49/48 kecuali board Akselerasi/FCA terkonfirmasi.\n- Board UNKNOWN: "Support utama 50 (floor). Sub-50 tidak diasumsikan."\n- Support S1 = 50 (floor). S2 = N/A (sub-50 tidak valid kecuali FCA/Akselerasi terkonfirmasi).\n- JANGAN buat Stop Loss 49 atau di bawah 50. Jika board tidak diketahui atau Papan Utama/Pengembangan, SL tidak berlaku di bawah floor.\n- Bear Case: "Tertahan di 50 dengan likuiditas lemah dan antrean jual." BUKAN target 48/45/40.\n- Risk Guard: "Harga di area Rp50. Risiko utama bukan penurunan harga, tetapi saham tertahan di floor dan likuiditas exit melemah."\n- JANGAN tulis "papan izin" atau "jika papan memungkinkan". Tulis: "Sub-50 tidak diasumsikan kecuali FCA/Akselerasi terkonfirmasi."\n- JANGAN invent board status.\n\nJANGAN gabung field. JANGAN markdown **. JANGAN pipe. Gunakan class CSS.\n\n=== STRUKTUR OUTPUT (ANALISIS LENGKAP) ===\n\n--- SECTION 1: DECISION CARD ---\n<div class="decision-card">\n<strong>Kesimpulan Cepat</strong>\n<div class="decision-grid">\n<div><span>Status</span><b>[Avoid Dulu / Wait Confirmation / Rebound Watch / Breakout Watch / Speculative Watch]</b></div>\n<div><span>Bias</span><b>[Bullish / Neutral / Bearish / Mixed]</b></div>\n<div><span>Confidence</span><b>[Low / Medium / High]</b></div>\n<div><span>Action</span><b>[Avoid dulu / Watchlist / Wait breakout / Wait reclaim MA20 / Small position only]</b></div>\n</div>\n<div class="key-level">Level kunci: Resistance [X] / Support [X]</div>\n</div>\n\n--- SECTION 2: AUTO-CUAN SCORE ---\n<p><strong class="text-emerald-400">Auto-Cuan Score: XX/100 (Grade X)</strong><br>Confidence: [dari data]<br>Alasan skor: [KENAPA score ini — hubungkan trend/momentum/volume/risk dengan angka]</p>\n\n--- SECTION 3: RINGKASAN CEPAT ---\n<p><strong>Ringkasan Cepat</strong><br>[2-4 kalimat natural. Kondisi + kenapa + apa yang ditunggu.]</p>\n\n--- SECTION 4: SKENARIO HARGA ---\n<p><strong>Skenario Harga</strong></p>\n<div class="scenario-price-grid">\n<div class="case-card bear"><span>Bear Case</span><b>[target support bawah]</b><p>[kondisi: breakdown support X + volume jual meningkat]</p></div>\n<div class="case-card base"><span>Base Case</span><b>[area sideways/stabilisasi]</b><p>[kondisi: harga bertahan di area X-X, volume normal]</p></div>\n<div class="case-card bull"><span>Bull Case</span><b>[target resistance berikutnya]</b><p>[kondisi: breakout resistance X + volume naik]</p></div>\n</div>\n\n--- SECTION 5: SETUP LABEL ---\n<p><strong>Setup Label</strong><br>Status: [dari Auto-Cuan Setup Label]<br>Alasan: [kenapa — hubungkan teknikal]<br>Valid jika: [kondisi]<br>Batal jika: [kondisi]</p>\n\n--- SECTION 6: DATA TEKNIKAL T-1 ---\n<p><strong>Data Teknikal T-1</strong></p>\n<div class="metric-grid">\n<div><strong>Moving Average</strong><br>MA20: [X]<br>MA50: [X]<br>MA100: [X]<br>MA200: [X]<br>Posisi: [above/below]</div>\n<div><strong>Momentum &amp; Volume</strong><br>RSI14: [X] — [interpretasi]<br>Volume: [X]x avg<br>Kondisi: [oversold/overbought/normal]<br>Last: [X] | Open: [X]<br>High: [X] | Low: [X]</div>\n</div>\n\n--- SECTION 7: ANALISIS VOLUME 3/7 HARI ---\n[Jika ada [Auto-Cuan Volume Intelligence]:]\n<div class="volume-card">\n<strong>Analisis Volume 3/7 Hari</strong>\n<div class="volume-grid">\n<div><span>Volume Terakhir</span><b>[dari data]</b></div>\n<div><span>Rata-rata 3 Hari</span><b>[dari data]</b></div>\n<div><span>Rata-rata 7 Hari</span><b>[dari data]</b></div>\n<div><span>Volume vs 7D</span><b>[X]x — [trend]</b></div>\n</div>\n<div class="volume-note">Pembacaan: [gunakan Price-Volume Reading dari data. Jelaskan implikasi 1-2 kalimat natural.]</div>\n</div>\n[Jika tidak ada Volume Intelligence: skip.]\n\n--- SECTION 7B: ANALISIS FIBONACCI ---\n[Jika ada [Auto-Cuan Fibonacci Intelligence]: WAJIB tampilkan section ini.]\n<div class="fibo-card">\n<strong>Analisis Fibonacci</strong>\n<div class="fibo-grid">\n<div><span>Swing High</span><b>[dari data]</b></div>\n<div><span>Swing Low</span><b>[dari data]</b></div>\n<div><span>Nearest Fib</span><b>[label + level dari data]</b></div>\n<div><span>Trend</span><b>[upward/downward retracement]</b></div>\n</div>\n<div class="fibo-grid">\n<div class="fibo-level"><span>Fib 38.2%</span><b>[dari data]</b></div>\n<div class="fibo-level"><span>Fib 50%</span><b>[dari data]</b></div>\n<div class="fibo-level"><span>Fib 61.8%</span><b>[dari data]</b></div>\n<div class="fibo-level"><span>Fib 78.6%</span><b>[dari data]</b></div>\n</div>\n<div class="fibo-note">[Reading dari data — 1 kalimat. Invalidation — 1 kalimat.]</div>\n</div>\n[Jika TIDAK ADA Fibonacci Intelligence: skip section ini sepenuhnya.]\n\n--- SECTION 8: AREA PENTING ---\n<p><strong>Area Penting</strong></p>\n<div class="level-grid">\n<div><strong>Resistance</strong><br>R1: [X]<br>R2: [X]<br>Breakout valid jika: [kondisi]</div>\n<div><strong>Support</strong><br>S1: [X]<br>S2: [X]<br>Breakdown risk jika: [kondisi]</div>\n</div>\n<p>Pivot Point: [X]</p>\n\n--- SECTION 9: BREAKOUT / BREAKDOWN ---\n<p><strong>Breakout / Breakdown</strong><br>Status: [dari Auto-Cuan Breakout Confirmation]<br>Breakout Level: [X]<br>Breakdown Level: [X]<br>Valid jika: [kondisi]<br>Batal jika: [kondisi]</p>\n\n--- SECTION 10: SKENARIO TRADING ---\n<p><strong>Skenario Trading</strong></p>\n<div class="scenario-list">\n<div><strong>Skenario Bullish</strong><br>[kondisi + target]</div>\n<div><strong>Skenario Netral</strong><br>[area sideways + catatan]</div>\n<div><strong>Skenario Bearish</strong><br>[risk + downside target]</div>\n</div>\n\n--- SECTION 11: RENCANA TRADING ---\n<p><strong>Rencana Trading</strong></p>\n<div class="trade-plan-grid">\n<div><strong>Entry</strong><br>[kondisi entry valid / tidak disarankan]</div>\n<div><strong>Stop Loss</strong><br>[SL level + kondisi]</div>\n<div><strong>Take Profit</strong><br>TP1: [X]<br>TP2: [X]</div>\n<div><strong>Catatan</strong><br>[warning / kondisi khusus]</div>\n</div>\n\n--- SECTION 12: RISK GUARD ---\n<p><strong>Risk Guard</strong><br>[Level + Action Bias + alasan. Skip jika tidak ada.]</p>\n\n--- SECTION 13: BROKER SUMMARY (jika ada) ---\n[Jika ada [Auto-Cuan Broker Summary Manual]:]\n<p><strong>Broker Summary Manual</strong><br>Periode: [dari data]<br>Top Net Buyer:<br>1. [broker]: [value]<br>2. [broker]: [value]<br>Top Net Seller:<br>1. [broker]: [value]<br>2. [broker]: [value]<br>Pembacaan: [akumulasi / distribusi / campuran]<br>Kekuatan Sinyal: [kuat / sedang / lemah]<br>Integrasi: [hubungkan dengan teknikal + volume intelligence]</p>\n[Jika TIDAK ADA [Auto-Cuan Broker Summary Manual]: JANGAN tampilkan section ini. JANGAN tulis "tidak tersedia". Skip sepenuhnya.]\n\n--- SECTION 14: KESIMPULAN ANALITIS ---\n<div class="analytic-summary">\n<strong>Kesimpulan Analitis</strong>\n<div class="summary-rows">\n<div><span>Trend harga</span><b>[Bearish / Neutral / Bullish]</b></div>\n<div><span>Momentum teknikal</span><b>[Lemah / Mulai membaik / Kuat]</b></div>\n<div><span>Volume 3/7 hari</span><b>[Naik signifikan / Normal / Menurun / Spike]</b></div>\n<div><span>Fibonacci</span><b>[Nearest level + reading singkat, atau skip jika tidak ada]</b></div>\n<div><span>Area support</span><b>[level]</b></div>\n<div><span>Area resistance</span><b>[level]</b></div>\n<div><span>Risiko utama</span><b>[1 kalimat]</b></div>\n<div><span>Rekomendasi trader</span><b>[Wait confirmation / Speculative buy if breakout / Avoid dulu / dll]</b></div>\n</div>\n</div>\n\n--- SECTION 15: NEWS / KATALIS ---\n<p><strong>News / Katalis</strong><br>[Jika ada: sebutkan + dampak. Jika unavailable: "Tidak ada katalis kuat. Fokus teknikal."]</p>\n\n--- SECTION 16: INVALIDASI ---\n<p><strong>Invalidasi</strong><br>[Kapan setup batal — level + kondisi spesifik]</p>\n\n--- SECTION 17: KESIMPULAN FINAL ---\n<p><strong>Kesimpulan Final</strong><br>Status: [konsisten Decision Card]<br>Bias: [konsisten]<br>Confidence: [konsisten]<br>Action: [konsisten]<br><br>Alasan utama:<br>1. [trend+MA — angka]<br>2. [momentum RSI — angka]<br>3. [volume 3/7D — rasio + trend]<br>4. [fibonacci level jika ada]<br>5. [katalis/broker jika ada]<br>6. [risk guard jika relevan]<br><br>Konfirmasi: [kondisi valid]<br>Invalidasi: [kondisi batal]</p>\n\n[Jika tidak ada [Auto-Cuan Broker Summary Manual], tampilkan CTA ini:]\n<p class="text-gray-500 text-xs">Untuk memperkuat analisis, kamu bisa kirim Broker Summary manual emiten ini. Contoh:<br>BBCA broksum 1D<br>YP +4,5B<br>AK -8B</p>\n\n<p class="text-gray-500">Kalau ada chart SMC, broker summary, atau data tambahan lain, kirim saja biar kesimpulannya lebih presisi.</p>\n\n=== RULES ===\n- WAJIB gunakan class HTML: decision-card, decision-grid, metric-grid, level-grid, scenario-list, trade-plan-grid, key-level, volume-card, volume-grid, volume-note, scenario-price-grid, case-card, analytic-summary, summary-rows, fibo-card, fibo-grid, fibo-level, fibo-note.\n- Setiap klaim didukung angka. JANGAN generik.\n- Bahasa natural: karena, sehingga, masih tertekan, belum kuat, mulai menarik jika.\n- JANGAN kaku/robotic. Kalimat pendek, jelas, natural.\n- Cautious: berpotensi, indikasi, lebih valid jika, belum terkonfirmasi.\n- JANGAN: pasti naik, dijamin, all in, aman beli, pasti cuan, auto cuan.\n- Decision Card HARUS konsisten dengan Kesimpulan Final dan Kesimpulan Analitis.\n- Score: [Auto-Cuan Score]. <=34=Avoid, 35-49=Wait, 50-64=Watchlist, 65-79=Speculative, 80+=Strong.\n- Board: UTAMA/PENGEMBANGAN+guard50: jangan FCA. AKSELERASI+guard1: boleh <Rp50. PEMANTAUAN/FCA: boleh Rp1.\n- IHSG/INDEX: "indeks"/"market"/"IHSG". JANGAN "emiten"/"saham ini". JANGAN board/FCA.\n- JANGAN tampilkan [Auto-Cuan...] mentah. JANGAN English. Setiap field baris sendiri.\n- Broker summary = konfirmasi tambahan, bukan sinyal beli tunggal.\n- Volume Intelligence: gunakan data [Auto-Cuan Volume Intelligence] untuk section Analisis Volume. Jangan karang angka volume sendiri.\n- Fibonacci Intelligence: gunakan data [Auto-Cuan Fibonacci Intelligence] untuk section Analisis Fibonacci. Jangan karang level Fibonacci sendiri. Jika data tidak ada, skip section Fibonacci sepenuhnya.';
        if (body.context && body.context.ticker) {
          prompt += ' Ticker: ' + body.context.ticker;
          if (body.context.currentPrice) prompt += ' Rp ' + body.context.currentPrice;
        }
        if (!fcaConfirmed) prompt += ' JANGAN sebut FCA/Full Call Auction sama sekali.';
        maxTokens = 3500;
      } else {
        // normal_chat or ticker_price_basic — PRIMARY ANALYSIS PROMPT (Premium v10 - Compact Dashboard)
        prompt = 'Kamu Auto-Cuan AI. Bahasa Indonesia natural, ringkas, evidence-based. Format: HTML (div, p, strong, span, b). Jawab 600-850 kata. RINGKAS tapi LENGKAP.\n\n=== ATURAN UTAMA ===\n1. WAJIB selesaikan SEMUA section sampai Kesimpulan Final. Jangan berhenti di tengah.\n2. Setiap section RINGKAS: max 2 kalimat per section kecuali grid/tabel.\n3. JANGAN gabung 2 field dalam 1 baris. Setiap field HARUS terpisah dengan <br> atau dalam <div> sendiri.\n4. JANGAN pakai dash/em-dash berlebih. Kalimat pendek.\n5. JANGAN pakai markdown ** atau pipe |.\n6. Volume sudah dalam format Indonesia (juta lembar, ribu lembar). TAMPILKAN PERSIS seperti data context. JANGAN konversi ke Rupiah. Volume = lembar saham, BUKAN nilai transaksi.\n7. Jika ada Estimasi Nilai Transaksi di context, tampilkan terpisah dengan label jelas.\n\n=== ANTI-MERGE RULES (WAJIB) ===\n- Untuk Data Teknikal, Momentum, Area Penting, dan TP: WAJIB gunakan metric-grid / level-grid / summary-rows. Jangan tulis label teknikal inline tanpa pemisah.\n- MA20 dan MA50 HARUS baris terpisah. JANGAN: "MA20: 5968.75MA50: 6012"\n- TP1 dan TP2 HARUS baris terpisah. JANGAN: "TP1: 5584TP2: 5742"\n- R1 dan R2 HARUS baris terpisah. JANGAN: "R1: 5584R2: 5742"\n- S1 dan S2 HARUS baris terpisah. JANGAN: "S1: 5284S2: 5142"\n- Status dan Alasan HARUS baris terpisah. JANGAN: "Status: Avoid DuluAlasan:"\n- Setiap metric SELALU diakhiri <br> sebelum metric berikutnya.\n- Contoh BENAR: MA20: <b>135</b><br>MA50: <b>157</b><br>MA100: <b>154</b>\n\n=== DECISION GUARD ===\nJika Price Change 1D <= -5% DAN price di bawah MA20+MA50: Status WAJIB "Avoid Dulu", Bias "Bearish", Action "Avoid dulu".\n\n=== RP50 FLOOR GUARD ===\nJika last price 50-55 (area gocap):\n- Rp50 = floor. JANGAN target 49/48 kecuali board Akselerasi/FCA terkonfirmasi.\n- Board UNKNOWN: "Support utama 50 (floor). Sub-50 tidak diasumsikan."\n- S1 = 50 (floor). S2 = N/A (sub-50 tidak valid kecuali FCA/Akselerasi terkonfirmasi).\n- JANGAN buat Stop Loss 49 atau di bawah 50. SL tidak berlaku di bawah floor untuk board normal/unknown.\n- Bear Case: "Tertahan di 50 dengan likuiditas lemah dan antrean jual."\n- JANGAN tulis "papan izin" atau "jika papan memungkinkan". Tulis: "Sub-50 tidak diasumsikan kecuali FCA/Akselerasi terkonfirmasi."\n- JANGAN invent board status.\n\n=== OUTPUT WAJIB (SEMUA SECTION) ===\n\n1. <div class="decision-card"><strong>Kesimpulan Cepat</strong><div class="decision-grid"><div><span>Status</span><b>[status]</b></div><div><span>Bias</span><b>[bias]</b></div><div><span>Confidence</span><b>[level]</b></div><div><span>Action</span><b>[action]</b></div></div><div class="key-level">Level kunci: R [X] / S [X]</div></div>\n\n2. <p><strong>Ringkasan Cepat</strong><br>[Max 2 kalimat: kondisi + kenapa]</p>\n\n3. <div class="scenario-price-grid"><div class="case-card bear"><span>Bear</span><b>[target]</b><p>[1 kondisi]</p></div><div class="case-card base"><span>Base</span><b>[area]</b><p>[1 kondisi]</p></div><div class="case-card bull"><span>Bull</span><b>[target]</b><p>[1 kondisi]</p></div></div>\n\n4. <div class="summary-rows"><div><span>Setup</span><b>[status]</b></div><div><span>Alasan</span><b>[1 frase]</b></div><div><span>Valid jika</span><b>[kondisi]</b></div><div><span>Batal jika</span><b>[kondisi]</b></div></div>\n\n5. <div class="metric-grid"><div><strong>Moving Average</strong><br>MA20: [X]<br>MA50: [X]<br>MA100: [X]<br>MA200: [X]<br>Posisi: [X]</div><div><strong>Momentum</strong><br>RSI14: [X]<br>Volume: [X]x avg<br>Last: [X]<br>High: [X]<br>Low: [X]</div></div>\n\n6. [Jika ada Volume Intelligence:] <div class="volume-card"><strong>Volume 3/7D</strong><div class="volume-grid"><div><span>Terakhir</span><b>[tampilkan persis dari context, misal: 550,06 juta lembar]</b></div><div><span>Avg 3D</span><b>[misal: 416,57 juta]</b></div><div><span>Avg 7D</span><b>[misal: 355,55 juta]</b></div><div><span>vs 7D</span><b>[X]x</b></div></div><div class="volume-note">[1 kalimat pembacaan dari data]</div></div>\n\n7. [Jika ada Fibonacci Intelligence: WAJIB tampilkan.] <div class="fibo-card"><strong>Fibonacci</strong><div class="fibo-grid"><div><span>Swing H</span><b>[X]</b></div><div><span>Swing L</span><b>[X]</b></div><div><span>Nearest</span><b>[label]</b></div><div><span>Trend</span><b>[X]</b></div></div><div class="fibo-grid"><div class="fibo-level"><span>38.2%</span><b>[X]</b></div><div class="fibo-level"><span>50%</span><b>[X]</b></div><div class="fibo-level"><span>61.8%</span><b>[X]</b></div><div class="fibo-level"><span>78.6%</span><b>[X]</b></div></div><div class="fibo-note">[1 kalimat reading + invalidation]</div></div> [Jika tidak ada: skip.]\n\n8. <div class="level-grid"><div><strong>Resistance</strong><br>R1: [X]<br>R2: [X]</div><div><strong>Support</strong><br>S1: [X]<br>S2: [X]</div></div>\n\n9. <div class="scenario-list"><div><strong>Bullish</strong><br>[1 kalimat]</div><div><strong>Netral</strong><br>[1 kalimat]</div><div><strong>Bearish</strong><br>[1 kalimat]</div></div>\n\n10. <div class="trade-plan-grid"><div><strong>Entry</strong><br>[kondisi]</div><div><strong>Stop Loss</strong><br>[level]</div><div><strong>TP</strong><br>TP1: [X]<br>TP2: [X]</div><div><strong>Catatan</strong><br>[1 kalimat]</div></div>\n\n11. <p><strong>Risk Guard</strong><br>[1 kalimat]</p>\n\n12. [Jika ada Broker Summary Manual: tampilkan ringkas. Jika TIDAK ADA: skip sepenuhnya.]\n\n13. <div class="analytic-summary"><strong>Kesimpulan Analitis</strong><div class="summary-rows"><div><span>Trend</span><b>[X]</b></div><div><span>Momentum</span><b>[X]</b></div><div><span>Volume</span><b>[X]</b></div><div><span>Fibonacci</span><b>[X atau skip]</b></div><div><span>Support</span><b>[X]</b></div><div><span>Resistance</span><b>[X]</b></div><div><span>Risiko</span><b>[1 frase]</b></div><div><span>Rekomendasi</span><b>[action]</b></div></div></div>\n\n14. <p><strong>Invalidasi</strong><br>[1 kalimat]</p>\n\n15. <div class="summary-rows"><div><span>Status</span><b>[X]</b></div><div><span>Bias</span><b>[X]</b></div><div><span>Action</span><b>[X]</b></div><div><span>Alasan</span><b>[1 kalimat ringkas]</b></div><div><span>Konfirmasi</span><b>[kondisi]</b></div><div><span>Invalidasi</span><b>[kondisi]</b></div></div>\n\n[Jika tidak ada Broker Summary Manual:] <p class="text-gray-500 text-xs">Kirim Broker Summary manual untuk analisis flow. Contoh: BBCA broksum 1D, YP +4,5B, AK -8B</p>\n\n=== RULES ===\n- Class HTML WAJIB: decision-card, decision-grid, metric-grid, level-grid, scenario-list, trade-plan-grid, key-level, volume-card, volume-grid, volume-note, scenario-price-grid, case-card, analytic-summary, summary-rows, fibo-card, fibo-grid, fibo-level, fibo-note.\n- Setiap field baris sendiri. JANGAN gabung 2 field dalam 1 baris.\n- Angka wajib. JANGAN generik.\n- JANGAN banyak dash/em-dash. Kalimat pendek.\n- Decision Card konsisten dengan Kesimpulan Final.\n- Score: <=34 Avoid, 35-49 Wait, 50-64 Watchlist, 65-79 Speculative, 80+ Strong.\n- IHSG: "indeks"/"market". JANGAN "emiten"/"saham ini".\n- JANGAN tampilkan [Auto-Cuan...] mentah.\n- Volume dalam context sudah format Indonesia (juta/ribu lembar). Tampilkan PERSIS. JANGAN tulis angka mentah. JANGAN prefix Rp untuk volume.\n- Fibonacci: gunakan data dari context. Jangan karang sendiri. Jika data tidak ada, skip section.\n- Jangan tampilkan enum/key internal Fibonacci (downward_retracement, upward_retracement). Gunakan bahasa Indonesia: Retracement turun/naik.\n- Broker summary = konfirmasi tambahan, bukan sinyal beli.';
        if (!fcaConfirmed) prompt += ' JANGAN sebut FCA/Full Call Auction sama sekali.';
        maxTokens = 3000;
      }

      // === IHSG/INDEX PROMPT APPENDIX ===
      // When context ticker is IHSG, append strong index-specific directive
      var contextTicker = (body.context && body.context.ticker) ? body.context.ticker : null;
      if (!contextTicker) {
        var ihsgAliases = /\b(IHSG|JKSE|JCI)\b/i;
        var compositeAlias = /\b(composite|idx\s*composite|indeks\s*harga\s*saham\s*gabungan)\b/i;
        if (ihsgAliases.test(chatMessage) || compositeAlias.test(chatMessage)) {
          contextTicker = 'IHSG';
        }
      }
      if (contextTicker === 'IHSG') {
        prompt += '\n\n=== OVERRIDE IHSG/INDEKS — WAJIB DIIKUTI SEPENUHNYA ===\n\nTicker ini adalah IHSG (Indeks Harga Saham Gabungan). Ini adalah indeks market, bukan emiten/saham individual.\n\nATURAN KETAT:\n- JANGAN gunakan: saham ini, emiten, papan pencatatan, FCA, broker emiten, Entry saham, SL saham, TP saham\n- JANGAN tampilkan: Broker Summary Manual, Rencana Trading (Entry/SL/TP), board warning, FCA, low-price warning\n- WAJIB gunakan: IHSG, indeks, market, tekanan pasar, pelaku pasar, arus market\n\nDECISION CARD FORMAT — WAJIB:\n<div class="decision-card">\n<strong>Kesimpulan Cepat IHSG</strong>\n<div class="decision-grid">\n<div><span>Status Market</span><b>[Risk-Off / Wait Confirmation / Rebound Watch / Breakout Watch / Sideways Watch]</b></div>\n<div><span>Bias IHSG</span><b>[Bullish / Neutral / Bearish / Mixed]</b></div>\n<div><span>Confidence</span><b>[Low / Medium / High]</b></div>\n<div><span>Sikap</span><b>[Defensive / Wait confirmation / Pantau support-resistance / Selektif di saham kuat / Tunggu market stabil]</b></div>\n</div>\n<div class="key-level">Level kunci: Resistance [X] / Support [X]</div>\n</div>\n\nSEKSI WAJIB UNTUK IHSG:\n1. Decision Card (format di atas)\n2. Ringkasan Cepat — kondisi market + kenapa + apa yang ditunggu\n3. Setup Label — gunakan "Market Watch" / "Wait Confirmation" / "Rebound Watch" / "Breakout Watch"\n4. Data Teknikal T-1 — metric-grid format seperti biasa\n5. Area Penting — level-grid format seperti biasa\n6. Skenario Market — scenario-list format, label: "Skenario Bullish Market" / "Skenario Netral" / "Skenario Koreksi"\n7. Rencana Sikap Market (BUKAN Rencana Trading) — trade-plan-grid format:\n   <div class="trade-plan-grid">\n   <div><strong>Sikap Utama</strong><br>[defensive / wait / selektif]</div>\n   <div><strong>Level Konfirmasi</strong><br>[IHSG reclaim X, indikasi market membaik]</div>\n   <div><strong>Level Risiko</strong><br>[IHSG breakdown X, koreksi berlanjut]</div>\n   <div><strong>Implikasi ke Saham</strong><br>[lebih selektif / prioritaskan saham kuat / hindari entry agresif]</div>\n   </div>\n8. Risk Guard — hanya teknikal (RSI, volume, breakdown risk). JANGAN board/price risk.\n9. Invalidasi\n10. Kesimpulan Final IHSG — gunakan: "Status Market" / "Bias IHSG" / "Sikap" (bukan "Action")\n\nJANGAN TAMPILKAN untuk IHSG:\n- Broker Summary Manual (skip sepenuhnya)\n- Rencana Trading (Entry/SL/TP)\n- CTA Broker Summary\n- Papan pencatatan\n- FCA warning\n- Emiten wording\n- "Avoid Dulu" sebagai status (gunakan "Risk-Off" atau "Wait Confirmation")\n- Analisis Fibonacci full (jika Fibonacci Intelligence tersedia untuk indeks, boleh mention 1-2 kalimat ringan sebagai "Level teknikal indeks" dalam Data Teknikal, TAPI JANGAN buat section Analisis Fibonacci terpisah, JANGAN buat fibo-card, JANGAN buat rencana trading Fibonacci)';
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
          return res.status(200).json({ html: sanitizeOutput(html, fcaConfirmed, intent), intent: intent, provider: 'deepseek' });
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
          return res.status(200).json({ html: sanitizeOutput(html, fcaConfirmed, intent), intent: intent, provider: 'gemini-fallback' });
        }
      }
      return res.status(200).json({ html: '<p class="text-sm text-red-400">AI tidak tersedia saat ini. Coba beberapa saat lagi.</p>', provider: 'none' });
    }

    // Ticker mode (from ticker input, not chat)
    if (ticker && currentPrice) {
      var tPrompt = 'Kamu Auto-Cuan AI, asisten analisis saham yang natural, thoughtful, dan risk-aware. User tanya saham ' + String(ticker).toUpperCase() + ' di harga Rp ' + currentPrice + '. Bahasa Indonesia santai tapi berisi. Format HTML (p, strong, ul, li) class text-sm text-gray-300. Jawab 200-500 kata.\n\nStruktur: 1) Bias singkat, 2) Data Historis T-1 jika ada [Auto-Cuan Market Data]: Last, OHLC, Volume, Avg Vol 20, Vol vs Avg, MA20/50/100/200, RSI14. Basis: Data Historis T-1. 3) Alasan teknikal: trend MA + momentum RSI + konfirmasi volume, 4) News/Katalis: jika ada [Auto-Cuan News Summary] dengan items, sebutkan singkat dan dampaknya. Jika news unavailable bilang fokus teknikal. Jangan karang berita. 5) Estimasi support/resistance terdekat, 6) Apakah menarik atau belum di harga ini, 7) Entry/SL/TP jika ada valid setup; jika bearish gunakan risiko downside, 8) Risiko utama, 9) Follow-up: "Kalau ada chart SMC, broker summary, atau link news/katalis lain, kirim saja biar analisisnya lebih presisi."\n\nRSI: >70 overbought, 55-70 bullish, ~50 netral, <40 bearish, <30 oversold. Volume: atas avg+red=selling, atas avg+green=buying, bawah avg=low confirm. News rules: jangan overclaim, jika impact mixed bilang mixed, jika berita lama bilang kemungkinan sudah ter-price-in, jangan rely news alone. Board rules: jika ada [Auto-Cuan Board Data]: UTAMA/PENGEMBANGAN/EKONOMI_BARU + guard 50 = jangan mention Rp1/FCA, jangan bilang risiko turun ke bawah Rp50 (gocap adalah batas bawah normal). AKSELERASI + guard 1 = boleh mention risiko < Rp50. PEMANTAUAN_KHUSUS/isFca = boleh FCA/Rp1. UNKNOWN = jangan mention FCA/Rp1. Jangan buat report panjang. Jangan pakai markdown stars **. Jangan suggest short-selling. Untuk bearish: avoid/wait/hold ketat/cut loss/downside risk. Jangan bilang pasti naik/pasti cuan/aman 100%. Jangan tampilkan blok data mentah.' +
        (fcaConfirmed ? '' : ' JANGAN sebut FCA/Full Call Auction sama sekali.');
      var tHtml = null;
      if (CODECRAFTERS_API_KEY) {
        tHtml = await callDeepSeek(CODECRAFTERS_API_KEY, CODECRAFTERS_BASE_URL, CODECRAFTERS_MODEL, tPrompt, '', 1200);
      }
      if (!tHtml && GEMINI_API_KEY) {
        tHtml = await callGemini(GEMINI_API_KEY, tPrompt, '', 1024);
      }
      if (!tHtml) {
        return res.status(200).json({ html: '<p class="text-sm text-gray-300"><strong>' + String(ticker).toUpperCase() + '</strong> Rp ' + currentPrice + ' — Upload chart 1W/1D/4H untuk analisis lengkap.</p>', provider: 'fallback' });
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

// === OUTPUT COMPLETENESS CHECKER ===
// Returns true if stock analysis output is missing critical sections (likely truncated)
function isStockAnalysisIncomplete(html, intent) {
  if (!html || typeof html !== 'string') return true;
  // Only check for stock analysis intents (not casual chat, follow-up, etc.)
  if (intent === 'casual_chat' || intent === 'follow_up_question' || intent === 'ticker_only') return false;

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
