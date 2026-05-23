// === HELPER FUNCTIONS ===

function calculateEvidenceLevel(req) {
  const { images, documents, image, ticker, currentPrice } = req.body || {};
  const hasImages = (images && images.length > 0) || !!image;
  const imageCount = images ? images.length : (image ? 1 : 0);
  const hasDocuments = documents && documents.length > 0 && documents.some(function(d) { return d.text && d.text.length > 0; });

  if (!hasImages && !hasDocuments) return 1; // ticker + price only
  if (imageCount === 1 && !hasDocuments) return 2; // single chart
  if (imageCount >= 2) return hasDocuments ? 4 : 3; // multi-chart
  if (hasDocuments) return 2; // docs without chart still level 2
  return 1;
}

function buildFCASection(fcaStatus, evidenceLevel) {
  if (fcaStatus === 'not_detected') return '';

  var statusLabel = fcaStatus === 'confirmed_mapping' ? 'Confirmed by local mapping' : 'Mentioned by user';
  var scorePenalty = fcaStatus === 'confirmed_mapping' ? 20 : 15;

  var maxScore;
  if (evidenceLevel === 1) maxScore = 45;
  else if (evidenceLevel === 2) maxScore = 60;
  else if (evidenceLevel === 3) maxScore = 70;
  else maxScore = 80;

  return '\n\n=== FCA / FULL CALL AUCTION SPECIAL HANDLING ===\n' +
    'STATUS FCA: ' + statusLabel + '\n' +
    'SKOR MAKSIMUM UNTUK SAHAM FCA: ' + maxScore + '\n' +
    'PENALTY SKOR: -' + scorePenalty + ' poin dari skor normal\n\n' +
    'ATURAN FCA WAJIB:\n' +
    '- Saham FCA TIDAK BOLEH dianalisis dengan confidence yang sama seperti saham reguler\n' +
    '- Saham FCA lebih sulit diprediksi karena likuiditas terbatas dan mekanisme perdagangan berbeda\n' +
    '- Support/resistance, order block, demand/supply, BOS, CHoCH, breakout KURANG RELIABLE pada saham FCA\n' +
    '- DILARANG memberikan rekomendasi BUY yang kuat untuk saham FCA\n' +
    '- Label yang DIREKOMENDASIKAN untuk FCA: AVOID, WAIT, WATCHLIST, NEED CHART CONFIRMATION\n' +
    '- SPECULATIVE BUY hanya jika chart evidence kuat DAN tetap warn risiko FCA\n' +
    '- BUY ON CONFIRMATION atau SWING VALID SANGAT JARANG untuk FCA\n\n' +
    'WAJIB TAMPILKAN SECTION: "FCA / Full Call Auction Risk Check" dengan:\n' +
    '1. Status FCA: ' + statusLabel + '\n' +
    '2. Dampak terhadap analisis:\n' +
    '   - Saham FCA lebih sulit diprediksi\n' +
    '   - Likuiditas dan eksekusi transaksi bisa berbeda dari saham reguler\n' +
    '   - Analisis teknikal/SMC normal menjadi kurang kuat\n' +
    '   - Support, resistance, order block, demand/supply, dan breakout perlu dianggap lebih lemah\n' +
    '3. Position Sizing FCA: SANGAT KECIL (max 1-3% portfolio, hindari all-in)\n\n' +
    'WAJIB TAMPILKAN WARNING:\n' +
    '"PERINGATAN FCA: Saham FCA / Full Call Auction memiliki karakter pergerakan yang berbeda dari saham reguler. ' +
    'Harga bisa sulit diprediksi, likuiditas bisa terbatas, spread bisa melebar, dan eksekusi transaksi tidak selalu mudah. ' +
    'Analisis teknikal pada saham FCA harus dianggap lebih lemah dibanding saham reguler. ' +
    'Gunakan modal kecil, hindari all-in, dan wajib punya batas risiko."\n\n' +
    'DILARANG menggunakan kata-kata: pasti, aman, mudah naik, tinggal gas, auto cuan, pasti mantul, gas buy untuk saham FCA.';
}

function buildDocumentContext(documents) {
  if (!documents || documents.length === 0) return '';
  var validDocs = documents.filter(function(d) { return d.text && d.text.trim().length > 0; });
  if (validDocs.length === 0) return '';

  var context = '\n\n=== DOKUMEN YANG DIUNGGAH USER (USER-PROVIDED EVIDENCE) ===\n';
  validDocs.forEach(function(doc, i) {
    var truncatedText = doc.text.length > 5000 ? doc.text.slice(0, 5000) + '\n[...teks dipotong, terlalu panjang]' : doc.text;
    context += '\nDokumen ' + (i + 1) + ': ' + (doc.filename || 'unknown') + ' (' + (doc.type || 'unknown') + ')\n';
    context += '--- KONTEN DOKUMEN ---\n' + truncatedText + '\n--- AKHIR DOKUMEN ---\n';
  });
  context += '\nGunakan informasi dari dokumen di atas sebagai EVIDENCE tambahan jika relevan dengan analisis saham.\n';
  return context;
}

var FORBIDDEN_WORDS_PROMPT = '\n\n=== KATA-KATA TERLARANG (JANGAN GUNAKAN) ===\n' +
  '- pasti naik / pasti turun\n' +
  '- dijamin / akurat 100%\n' +
  '- pasti cuan / auto cuan\n' +
  '- aman / tinggal gas\n' +
  '- pasti mantul\n\n' +
  'Jika tidak ada bukti, WAJIB tulis: "Belum bisa dikonfirmasi dari data yang ada."\n';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { ticker, currentPrice, image, mimeType, source, username, isAdmin, chatMessage, images, documents, fcaStatus, evidenceLevel } = req.body || {};

    // === CHAT MODE ===
    if (source === 'chat_mode' && chatMessage) {
      return await handleChatMode(req, res, chatMessage);
    }

    // === CHART UPLOAD MODE ===
    if (source === 'chart_upload' && (image || (images && images.length > 0))) {
      return await handleChartUpload(req, res, image, mimeType);
    }

    // === TICKER MODE ===
    if (!ticker || !currentPrice) {
      return res.status(400).json({ error: 'Ticker dan harga sekarang wajib diisi.' });
    }

    const tickerUpper = ticker.toUpperCase();
    const price = parseFloat(currentPrice);
    const level = evidenceLevel || calculateEvidenceLevel(req);
    const fca = fcaStatus || 'not_detected';
    const docContext = buildDocumentContext(documents);

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
      const fallbackHtml = generateFallback(tickerUpper, price);
      return res.status(200).json({ html: fallbackHtml });
    }

    const GEMINI_MODEL = 'gemini-2.5-flash';
    const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

    const systemPrompt = buildPrompt(tickerUpper, price, { fcaStatus: fca, evidenceLevel: level, documentContext: docContext });

    const payload = {
      contents: [{ parts: [{ text: systemPrompt }] }],
      generationConfig: {
        temperature: 0.3,
        topP: 0.9,
        topK: 30,
        maxOutputTokens: 8192
      }
    };

    const response = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const fallbackHtml = generateFallback(tickerUpper, price);
      return res.status(200).json({ html: fallbackHtml });
    }

    const result = await response.json();
    const candidates = result.candidates || [];

    if (candidates.length > 0) {
      const parts = candidates[0].content?.parts || [];
      if (parts.length > 0 && parts[0].text) {
        let html = parts[0].text;
        html = html.replace(/^```html\s*/i, '').replace(/```\s*$/i, '');

        if (!isCompleteAnalysis(html)) {
          const fallbackHtml = generateFallback(tickerUpper, price);
          return res.status(200).json({ html: fallbackHtml });
        }

        logAnalysis(tickerUpper, price);
        return res.status(200).json({ html });
      }
    }

    const fallbackHtml = generateFallback(tickerUpper, price);
    return res.status(200).json({ html: fallbackHtml });

  } catch (error) {
    try {
      const { ticker, currentPrice } = req.body || {};
      const fallbackHtml = generateFallback(
        (ticker || 'UNKNOWN').toUpperCase(),
        parseFloat(currentPrice) || 100
      );
      return res.status(200).json({ html: fallbackHtml });
    } catch (e) {
      return res.status(500).json({ error: 'Server error: ' + error.message });
    }
  }
}


function isCompleteAnalysis(html) {
  if (!html || html.length < 400) return false;
  const requiredKeywords = ['Data Quality', 'Confidence', 'Invalidation', 'Final Decision', 'Risk Reward', 'Action Plan'];
  const lowerHtml = html.toLowerCase();
  let foundCount = 0;
  for (const kw of requiredKeywords) {
    if (lowerHtml.includes(kw.toLowerCase())) foundCount++;
  }
  return foundCount >= 4;
}


function buildPrompt(ticker, currentPrice, options) {
  var opts = options || {};
  var fcaStatus = opts.fcaStatus || 'not_detected';
  var evidenceLevel = opts.evidenceLevel || 1;
  var documentContext = opts.documentContext || '';

  var fcaSection = buildFCASection(fcaStatus, evidenceLevel);

  var prompt = `Kamu adalah AI Analis Teknikal Saham PROFESIONAL dengan standar EVIDENCE-BASED ANALYSIS yang ketat.

=== EVIDENCE LOCK (WAJIB DIPATUHI 100%) ===
EVIDENCE LOCK ACTIVE: Kamu HANYA boleh menggunakan data berikut sebagai basis analisis:
(a) Harga saat ini: Rp ${currentPrice}
(b) Ticker: ${ticker}

TIDAK ADA data lain yang tersedia. Tidak ada chart, tidak ada news, tidak ada volume, tidak ada orderbook.

=== INPUT QUALITY LEVEL ===
Ini adalah INPUT QUALITY LEVEL 1 (Basic Analysis: Ticker + Harga saja).
- SKOR MAKSIMUM: 55. DILARANG memberi skor di atas 55.
- Rekomendasi yang VALID untuk level ini: WAIT / WATCHLIST / NEED CHART CONFIRMATION
- DILARANG memberikan rekomendasi BUY yang kuat tanpa chart sebagai konfirmasi.

=== ANTI-HALLUCINATION RULES (WAJIB) ===
DILARANG KERAS mengklaim atau menyimpulkan hal berikut TANPA bukti chart:
- Volume spike / volume tinggi / volume rendah
- Demand zone / supply zone yang "teridentifikasi"
- Order block yang "aktif" atau "fresh"
- BOS (Break of Structure) / CHoCH (Change of Character)
- Akumulasi / distribusi
- Higher high / higher low / lower high / lower low
- Liquidity sweep / liquidity grab
- FVG (Fair Value Gap)
- Candle pattern (engulfing, doji, hammer, dll)

Jika ingin menyebut hal di atas, WAJIB tulis: "Belum bisa dikonfirmasi dari data yang ada. Upload chart untuk validasi."

=== SCORE MEANING ===
0-30: AVOID (setup buruk atau data sangat minim)
31-45: WEAK SETUP (ada potensi tapi banyak uncertainty)
46-55: WATCHLIST (menarik tapi butuh konfirmasi chart) - INI MAKSIMUM UNTUK LEVEL 1
56-65: SPECULATIVE (hanya jika ada chart partial)
66-75: BUY ON CONFIRMATION (chart + price tersedia)
76-85: STRONG SETUP (multi-timeframe aligned)
86-90: VERY STRONG (rare, semua data lengkap dan aligned)
91-100: Hampir tidak pernah tercapai

=== STRICT RECOMMENDATION LABELS ===
Gunakan HANYA label berikut:
AVOID | WAIT | WATCHLIST | NEED CHART CONFIRMATION | SPECULATIVE BUY | BUY ON CONFIRMATION | BUY ON PULLBACK | SCALP ONLY | SWING VALID | HOLD | TAKE PROFIT PARTIAL | CUT LOSS / EXIT

Untuk Level 1 (ticker + harga saja), label yang valid: WAIT, WATCHLIST, NEED CHART CONFIRMATION, atau AVOID.

=== FORMAT OUTPUT ===
Output HARUS berupa HTML valid dengan Tailwind CSS classes.
Gunakan tema gelap: bg-[#151a23], border-[#1c2333], text-emerald-400 (positif), text-red-400 (negatif), text-white (netral), text-gray-300 (body), text-gray-400 (secondary), text-gray-500 (muted).
Wrap semua konten dalam <div class="space-y-5">.

=== 15 BAGIAN WAJIB (SEMUA HARUS ADA) ===

1. DATA QUALITY CHECK
   - Tampilkan level input: "Level 1 - Basic (Ticker + Harga)"
   - Data tersedia: Ticker, Harga saat ini
   - Data TIDAK tersedia: Chart, Volume, News, Orderbook, Multi-timeframe
   - Confidence impact: "Analisis terbatas, skor di-cap di 55"

2. CONTEXT SUMMARY
   - Ticker: ${ticker}, Harga: Rp ${currentPrice}
   - Apa yang bisa disimpulkan dari harga saja (price level, apakah penny stock / mid / blue chip berdasarkan harga)
   - Apa yang TIDAK bisa disimpulkan tanpa chart

3. CONFIDENCE BREAKDOWN
   - Technical Score: x/25 (rendah karena tanpa chart)
   - Entry Precision: x/25 (rendah karena tanpa konfirmasi visual)
   - Risk Management: x/25 (estimasi saja)
   - News/Catalyst: x/25 (tidak tersedia)
   - OVERALL: x/55 (cap di 55)

4. MULTI-TIMEFRAME BIAS
   - Weekly: "Tidak tersedia - chart belum di-upload"
   - Daily: "Tidak tersedia - chart belum di-upload"
   - H4: "Tidak tersedia - chart belum di-upload"
   - H1: "Tidak tersedia - chart belum di-upload"
   - Catatan: "Upload chart 1W/1D/4H untuk multi-timeframe analysis"

5. KEY LEVEL VALIDATION
   - Estimasi support/resistance berdasarkan round number terdekat dari Rp ${currentPrice}
   - WAJIB label: "ESTIMASI SAJA - belum divalidasi dari chart"
   - Jangan klaim ini sebagai "confirmed level"

6. ENTRY QUALITY
   - Klasifikasi: LOW CONFIDENCE (tanpa chart)
   - Alasan: tidak ada visual confirmation
   - Saran: tunggu chart untuk konfirmasi entry

7. INVALIDATION FIRST
   - Kapan analisis ini INVALID (misal: jika harga break level tertentu)
   - Estimasi invalidation level (round number di bawah harga)
   - "Validasi lebih akurat membutuhkan chart"

8. RISK REWARD CHECK
   - Estimasi Risk:Reward berdasarkan round number levels
   - Apakah RR layak? (biasanya minimum 1:2)
   - Catatan bahwa ini estimasi tanpa chart

9. FINAL DECISION
   - Label keputusan (WAIT / WATCHLIST / NEED CHART CONFIRMATION)
   - Skor: x/55 (JANGAN lebih dari 55)
   - Alasan singkat 2-3 poin
   - Warna skor: text-yellow-400 (karena pasti di bawah 56)

10. BEST ACTION PLAN
    - Langkah 1: Upload chart (1W/1D/4H) untuk konfirmasi
    - Langkah 2: Cek news/katalis terbaru
    - Langkah 3: Tentukan average price jika sudah hold
    - Langkah 4: Re-analisis setelah data lengkap
    - Jika sudah hold: saran hold/cut berdasarkan harga saja

11. NEWS/CATALYST IMPACT
    - Status: "Tidak ada data news yang tersedia"
    - Impact: "Tidak bisa dinilai"
    - Saran: "Cek berita terbaru sebelum mengambil keputusan"

12. SCENARIO-BASED OUTPUT
    - Best Case: estimasi target (round number di atas harga)
    - Base Case: sideways / consolidation
    - Worst Case: estimasi downside (round number di bawah harga)
    - Semua diberi label "ESTIMASI - butuh chart untuk konfirmasi"

13. POSITION SIZING
    - Rekomendasi alokasi: KECIL (1-3% portfolio) karena confidence rendah
    - Jangan all-in tanpa chart confirmation
    - Scaling plan: tambah posisi setelah chart confirm

14. WHAT COULD GO WRONG
    - Tanpa chart, banyak yang bisa salah
    - List 3-5 risiko utama
    - Kenapa analisis harga saja tidak cukup

15. FINAL NOTE
    - Disclaimer: bukan ajakan beli/jual
    - "Untuk presisi lebih tinggi, upload chart 1W, 1D, dan 4H"
    - "Chart TradingView hanya visual dan bisa delay. Analisis presisi memakai chart yang Anda upload dan harga yang Anda input."
    - DYOR reminder

Pastikan SETIAP bagian ada dan memiliki konten substantif. Output harus jujur tentang keterbatasan data.`;

  // Append FCA section if applicable
  if (fcaSection) {
    prompt += fcaSection;
  }

  // Append document context if available
  if (documentContext) {
    prompt += documentContext;
  }

  // Append anti-hallucination forbidden words
  prompt += FORBIDDEN_WORDS_PROMPT;

  return prompt;
}


function generateFallback(ticker, price) {
  const p = price;
  const supportEst = Math.max(Math.round(p * 0.92), p - 2);
  const resistEst = Math.max(Math.round(p * 1.08), p + 2);
  const invLevel = Math.max(Math.round(p * 0.88), p - 3);
  const bestCase = Math.max(Math.round(p * 1.15), p + 3);
  const worstCase = Math.max(Math.round(p * 0.82), p - 4);
  const score = p > 500 ? 48 : p > 200 ? 45 : p > 100 ? 42 : p > 50 ? 40 : 38;

  // Compute sub-scores that sum to the overall score
  // Without chart: Technical and Entry are low, Risk is moderate, News is 0
  const newsScore = 0;
  const entryScore = Math.min(Math.round(score * 0.18), 25);
  const riskScore = Math.min(Math.round(score * 0.45), 25);
  // Technical absorbs the remainder to ensure exact sum
  const techScore = score - entryScore - riskScore - newsScore;

  return `
<div class="space-y-5">
  <!-- 1. Data Quality Check -->
  <div class="bg-[#151a23] rounded-xl p-5 border border-[#1c2333]">
    <h3 class="text-sm font-semibold text-yellow-400 mb-3">Data Quality Check</h3>
    <div class="space-y-2">
      <p class="text-sm text-gray-300"><span class="text-white font-semibold">Input Level:</span> Level 1 - Basic (Ticker + Harga)</p>
      <p class="text-sm text-gray-300"><span class="text-emerald-400">Tersedia:</span> Ticker (${ticker}), Harga (Rp ${p})</p>
      <p class="text-sm text-gray-300"><span class="text-red-400">Tidak tersedia:</span> Chart, Volume, News, Orderbook, Multi-timeframe</p>
      <p class="text-sm text-gray-300"><span class="text-yellow-400">Impact:</span> Skor di-cap maksimal 55. Analisis bersifat estimasi.</p>
    </div>
  </div>

  <!-- 2. Context Summary -->
  <div class="bg-[#151a23] rounded-xl p-4 border border-[#1c2333]">
    <h3 class="text-sm font-semibold text-emerald-400 mb-2">Context Summary</h3>
    <p class="text-sm text-gray-300">Saham <strong class="text-white">${ticker}</strong> di harga Rp ${p}. ${p > 1000 ? 'Tergolong saham mid-large cap berdasarkan harga.' : p > 200 ? 'Tergolong saham second liner berdasarkan range harga.' : p > 50 ? 'Tergolong saham small cap.' : 'Tergolong saham penny stock / low price.'} Tanpa chart dan data tambahan, analisis sangat terbatas dan hanya bersifat estimasi awal.</p>
  </div>

  <!-- 3. Confidence Breakdown -->
  <div class="bg-[#151a23] rounded-xl p-4 border border-[#1c2333]">
    <h3 class="text-sm font-semibold text-emerald-400 mb-3">Confidence Breakdown</h3>
    <div class="grid grid-cols-2 gap-3">
      <div class="bg-[#0b0e14] rounded-lg p-3 border border-[#1c2333]">
        <p class="text-xs text-gray-500">Technical</p>
        <p class="text-sm font-bold text-red-400">${techScore}/25</p>
      </div>
      <div class="bg-[#0b0e14] rounded-lg p-3 border border-[#1c2333]">
        <p class="text-xs text-gray-500">Entry Precision</p>
        <p class="text-sm font-bold text-red-400">${entryScore}/25</p>
      </div>
      <div class="bg-[#0b0e14] rounded-lg p-3 border border-[#1c2333]">
        <p class="text-xs text-gray-500">Risk Management</p>
        <p class="text-sm font-bold text-yellow-400">${riskScore}/25</p>
      </div>
      <div class="bg-[#0b0e14] rounded-lg p-3 border border-[#1c2333]">
        <p class="text-xs text-gray-500">News/Catalyst</p>
        <p class="text-sm font-bold text-red-400">${newsScore}/25</p>
      </div>
    </div>
    <div class="mt-3 bg-[#0b0e14] rounded-lg p-3 border border-yellow-500/30 text-center">
      <p class="text-xs text-gray-500">OVERALL SCORE</p>
      <p class="text-2xl font-bold text-yellow-400">${score}/55</p>
      <p class="text-xs text-gray-500 mt-1">Cap: 55 (Level 1 - Basic)</p>
    </div>
  </div>

  <!-- 4. Multi-Timeframe Bias -->
  <div class="bg-[#151a23] rounded-xl p-4 border border-[#1c2333]">
    <h3 class="text-sm font-semibold text-emerald-400 mb-3">Multi-Timeframe Bias</h3>
    <div class="space-y-2">
      <p class="text-sm text-gray-500">Weekly: Tidak tersedia - chart belum di-upload</p>
      <p class="text-sm text-gray-500">Daily: Tidak tersedia - chart belum di-upload</p>
      <p class="text-sm text-gray-500">H4: Tidak tersedia - chart belum di-upload</p>
      <p class="text-sm text-gray-500">H1: Tidak tersedia - chart belum di-upload</p>
    </div>
    <p class="text-xs text-yellow-400 mt-3">Upload chart 1W/1D/4H untuk multi-timeframe analysis yang akurat.</p>
  </div>

  <!-- 5. Key Level Validation -->
  <div class="bg-[#151a23] rounded-xl p-4 border border-[#1c2333]">
    <h3 class="text-sm font-semibold text-emerald-400 mb-2">Key Level Validation</h3>
    <div class="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-2 mb-3">
      <p class="text-xs text-yellow-400 font-semibold">ESTIMASI SAJA - belum divalidasi dari chart</p>
    </div>
    <div class="space-y-2">
      <p class="text-sm text-gray-300"><span class="text-white font-semibold">Support estimasi:</span> ~Rp ${supportEst} (round number terdekat)</p>
      <p class="text-sm text-gray-300"><span class="text-white font-semibold">Resistance estimasi:</span> ~Rp ${resistEst} (round number terdekat)</p>
      <p class="text-sm text-gray-300"><span class="text-gray-500">Belum bisa dikonfirmasi dari data yang ada. Upload chart untuk validasi.</span></p>
    </div>
  </div>

  <!-- 6. Entry Quality -->
  <div class="bg-[#151a23] rounded-xl p-4 border border-[#1c2333]">
    <h3 class="text-sm font-semibold text-emerald-400 mb-2">Entry Quality</h3>
    <span class="inline-block px-3 py-1 rounded-lg text-sm font-bold bg-red-500/20 text-red-400 border border-red-500/30">LOW CONFIDENCE</span>
    <p class="text-sm text-gray-300 mt-2">Tanpa chart, tidak ada visual confirmation untuk entry point. Level yang ditampilkan hanya estimasi berdasarkan round number.</p>
  </div>

  <!-- 7. Invalidation First -->
  <div class="bg-[#151a23] rounded-xl p-4 border border-[#1c2333]">
    <h3 class="text-sm font-semibold text-red-400 mb-2">Invalidation First</h3>
    <div class="space-y-2">
      <p class="text-sm text-gray-300"><span class="text-red-400 font-semibold">Invalidation Level:</span> ~Rp ${invLevel} (estimasi)</p>
      <p class="text-sm text-gray-300">Jika harga break di bawah Rp ${invLevel}, analisis estimasi ini tidak valid.</p>
      <p class="text-sm text-gray-500">Validasi lebih akurat membutuhkan chart dengan candle structure yang jelas.</p>
    </div>
  </div>

  <!-- 8. Risk Reward Check -->
  <div class="bg-[#151a23] rounded-xl p-4 border border-[#1c2333]">
    <h3 class="text-sm font-semibold text-emerald-400 mb-2">Risk Reward Check</h3>
    <div class="space-y-2">
      <p class="text-sm text-gray-300"><span class="text-white font-semibold">Estimasi Risk:</span> Rp ${p} ke Rp ${invLevel} = ~${Math.round((p - invLevel)/p * 100)}%</p>
      <p class="text-sm text-gray-300"><span class="text-white font-semibold">Estimasi Reward:</span> Rp ${p} ke Rp ${resistEst} = ~${Math.round((resistEst - p)/p * 100)}%</p>
      <p class="text-sm text-gray-300"><span class="text-yellow-400">Catatan:</span> Ini estimasi tanpa chart. RR aktual bisa sangat berbeda.</p>
    </div>
  </div>

  <!-- 9. Final Decision -->
  <div class="bg-[#151a23] rounded-xl p-5 border border-[#1c2333]">
    <h3 class="text-sm font-semibold text-emerald-400 mb-3">Final Decision</h3>
    <div class="flex items-center gap-4">
      <div class="flex items-center justify-center w-16 h-16 rounded-full bg-yellow-500/20 border-2 border-yellow-500/30">
        <span class="text-2xl font-bold text-yellow-400">${score}</span>
      </div>
      <div>
        <span class="inline-block px-4 py-2 rounded-lg text-sm font-bold bg-yellow-500/20 text-yellow-400 border border-yellow-500/30">NEED CHART CONFIRMATION</span>
        <p class="text-xs text-gray-400 mt-2">Skor ${score}/55 (max 55 untuk Level 1 Basic)</p>
      </div>
    </div>
    <div class="mt-3 space-y-1">
      <p class="text-sm text-gray-300">- Data terlalu minim untuk keputusan trading</p>
      <p class="text-sm text-gray-300">- Butuh chart confirmation untuk validasi level</p>
      <p class="text-sm text-gray-300">- Tanpa news/catalyst, tidak ada edge</p>
    </div>
  </div>

  <!-- 10. Best Action Plan -->
  <div class="bg-[#151a23] rounded-xl p-4 border border-[#1c2333]">
    <h3 class="text-sm font-semibold text-emerald-400 mb-2">Best Action Plan</h3>
    <div class="space-y-2">
      <p class="text-sm text-gray-300"><span class="text-white font-semibold">1.</span> Upload chart (1W/1D/4H) untuk konfirmasi struktur market</p>
      <p class="text-sm text-gray-300"><span class="text-white font-semibold">2.</span> Cek news/katalis terbaru untuk ${ticker}</p>
      <p class="text-sm text-gray-300"><span class="text-white font-semibold">3.</span> Tentukan average price jika sudah hold</p>
      <p class="text-sm text-gray-300"><span class="text-white font-semibold">4.</span> Re-analisis setelah data lengkap untuk skor lebih tinggi</p>
    </div>
  </div>

  <!-- 11. News/Catalyst Impact -->
  <div class="bg-[#151a23] rounded-xl p-4 border border-[#1c2333]">
    <h3 class="text-sm font-semibold text-emerald-400 mb-2">News/Catalyst Impact</h3>
    <div class="space-y-2">
      <p class="text-sm text-gray-300"><span class="text-white font-semibold">Status:</span> Tidak ada data news yang tersedia</p>
      <p class="text-sm text-gray-300"><span class="text-white font-semibold">Impact:</span> Tidak bisa dinilai</p>
      <p class="text-sm text-gray-300"><span class="text-yellow-400">Saran:</span> Cek berita terbaru ${ticker} sebelum mengambil keputusan apapun</p>
    </div>
  </div>

  <!-- 12. Scenario-Based Output -->
  <div class="bg-[#151a23] rounded-xl p-4 border border-[#1c2333]">
    <h3 class="text-sm font-semibold text-emerald-400 mb-3">Scenario-Based Output</h3>
    <div class="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-2 mb-3">
      <p class="text-xs text-yellow-400">ESTIMASI - butuh chart untuk konfirmasi</p>
    </div>
    <div class="grid grid-cols-3 gap-3">
      <div class="bg-[#0b0e14] rounded-lg p-3 border border-[#1c2333] text-center">
        <p class="text-xs text-gray-500 mb-1">Best Case</p>
        <p class="text-lg font-bold text-emerald-400">Rp ${bestCase}</p>
        <p class="text-xs text-gray-500 mt-1">+${Math.round((bestCase/p - 1)*100)}%</p>
      </div>
      <div class="bg-[#0b0e14] rounded-lg p-3 border border-[#1c2333] text-center">
        <p class="text-xs text-gray-500 mb-1">Base Case</p>
        <p class="text-lg font-bold text-yellow-400">Rp ${p}</p>
        <p class="text-xs text-gray-500 mt-1">Sideways</p>
      </div>
      <div class="bg-[#0b0e14] rounded-lg p-3 border border-[#1c2333] text-center">
        <p class="text-xs text-gray-500 mb-1">Worst Case</p>
        <p class="text-lg font-bold text-red-400">Rp ${worstCase}</p>
        <p class="text-xs text-gray-500 mt-1">${Math.round((worstCase/p - 1)*100)}%</p>
      </div>
    </div>
  </div>

  <!-- 13. Position Sizing -->
  <div class="bg-[#151a23] rounded-xl p-4 border border-[#1c2333]">
    <h3 class="text-sm font-semibold text-emerald-400 mb-2">Position Sizing</h3>
    <div class="space-y-2">
      <p class="text-sm text-gray-300"><span class="text-white font-semibold">Rekomendasi alokasi:</span> <span class="text-yellow-400">KECIL (1-3% portfolio)</span></p>
      <p class="text-sm text-gray-300">Confidence rendah, jangan all-in tanpa chart confirmation.</p>
      <p class="text-sm text-gray-300"><span class="text-white font-semibold">Scaling plan:</span> Tambah posisi hanya setelah chart mengkonfirmasi setup valid.</p>
    </div>
  </div>

  <!-- 14. What Could Go Wrong -->
  <div class="bg-[#151a23] rounded-xl p-4 border border-[#1c2333]">
    <h3 class="text-sm font-semibold text-red-400 mb-2">What Could Go Wrong</h3>
    <div class="space-y-2">
      <p class="text-sm text-gray-300">- Tanpa chart, trend sebenarnya bisa bearish (kita tidak tahu)</p>
      <p class="text-sm text-gray-300">- Level support/resistance hanya estimasi, bisa meleset jauh</p>
      <p class="text-sm text-gray-300">- Ada news negatif yang belum terdeteksi</p>
      <p class="text-sm text-gray-300">- Volume bisa sangat tipis (saham tidak likuid)</p>
      <p class="text-sm text-gray-300">- Analisis harga saja TIDAK CUKUP untuk keputusan trading</p>
    </div>
  </div>

  <!-- 15. Final Note -->
  <div class="bg-[#151a23] rounded-xl p-4 border border-[#1c2333]">
    <h3 class="text-sm font-semibold text-gray-400 mb-2">Final Note</h3>
    <div class="space-y-2">
      <p class="text-xs text-gray-500">Disclaimer: Analisis ini dibuat oleh AI dengan data SANGAT TERBATAS (hanya ticker + harga) dan BUKAN merupakan ajakan atau rekomendasi untuk membeli atau menjual saham.</p>
      <p class="text-xs text-yellow-400">Untuk presisi lebih tinggi, upload chart 1W, 1D, dan 4H serta sertakan news/katalis terbaru.</p>
      <p class="text-xs text-gray-500">Chart TradingView hanya visual dan bisa delay. Analisis presisi memakai chart yang Anda upload dan harga yang Anda input.</p>
      <p class="text-xs text-gray-500">DYOR - Do Your Own Research. Keputusan investasi sepenuhnya tanggung jawab Anda.</p>
    </div>
  </div>
</div>`;
}


async function logAnalysis(ticker, price) {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SUPABASE_URL || !SUPABASE_KEY) return;

    await fetch(`${SUPABASE_URL}/rest/v1/ai_analysis_logs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      },
      body: JSON.stringify({
        ticker,
        current_price: price,
        timestamp: new Date().toISOString()
      })
    });
  } catch (e) { /* silent */ }
}


// === CHART UPLOAD HANDLER ===
const CHART_SYSTEM_PROMPT = `Kamu adalah AI Analis Teknikal Saham PROFESIONAL dengan standar EVIDENCE-BASED ANALYSIS yang ketat.

=== EVIDENCE LOCK (WAJIB DIPATUHI 100%) ===
EVIDENCE LOCK ACTIVE: Kamu HANYA boleh mendeskripsikan dan menganalisis apa yang TERLIHAT di chart.
- Hanya gunakan informasi yang VISIBLE di gambar
- Jika sesuatu tidak terlihat jelas, katakan "tidak terlihat jelas di chart ini"
- DILARANG mengarang data yang tidak ada di chart

=== INPUT QUALITY LEVEL ===
Ini adalah INPUT QUALITY LEVEL 2 (Single Chart Analysis).
- SKOR MAKSIMUM: 70. DILARANG memberi skor di atas 70.
- Kamu HARUS mengidentifikasi timeframe yang ditampilkan di chart
- Kamu HARUS menyebutkan timeframe yang TIDAK tersedia (yang belum di-upload)
- Untuk skor lebih tinggi, user perlu upload chart multi-timeframe (1W/1D/4H)

=== ANTI-HALLUCINATION RULES ===
DILARANG mengklaim hal yang TIDAK terlihat di chart:
- Jangan sebut volume jika volume bar tidak terlihat
- Jangan sebut indikator yang tidak ada di chart
- Jangan klaim pattern yang ambiguous
- Jika ragu, tulis: "Belum bisa dikonfirmasi dari chart ini"
- Semua angka Entry/SL/TP HARUS sesuai skala harga yang TERLIHAT di chart

=== INSTRUKSI MEMBACA CHART ===
1. Baca harga terakhir/current price dari sumbu Y-axis (kanan)
2. Identifikasi ticker/nama saham dari judul chart jika terlihat
3. Identifikasi timeframe yang ditampilkan
4. Identifikasi trend dari candle structure yang TERLIHAT
5. Identifikasi area support/resistance yang VISIBLE
6. Jika indikator SMC terlihat (BOS, CHoCH, OB), baca label yang ada
7. Jika harga tidak terbaca jelas, estimasi dan tulis "estimasi dari chart"

=== SCORE MEANING ===
0-30: AVOID
31-45: WEAK SETUP
46-55: WATCHLIST
56-65: SPECULATIVE (single chart tanpa konfirmasi)
66-70: BUY ON CONFIRMATION (chart jelas, setup valid) - INI MAKSIMUM LEVEL 2
71-85: Butuh multi-timeframe (tidak tersedia di level ini)
86-100: Hampir tidak tercapai

=== STRICT RECOMMENDATION LABELS ===
AVOID | WAIT | WATCHLIST | NEED CHART CONFIRMATION | SPECULATIVE BUY | BUY ON CONFIRMATION | BUY ON PULLBACK | SCALP ONLY | SWING VALID | HOLD | TAKE PROFIT PARTIAL | CUT LOSS / EXIT

=== FORMAT OUTPUT ===
Output HARUS berupa HTML valid dengan Tailwind CSS classes.
Gunakan tema gelap: bg-[#151a23], border-[#1c2333], text-emerald-400 (positif), text-red-400 (negatif), text-white (netral), text-gray-300 (body), text-gray-400 (secondary), text-gray-500 (muted).
Wrap semua konten dalam <div class="space-y-5">.

=== 15 BAGIAN WAJIB ===

1. DATA QUALITY CHECK
   - Level input: "Level 2 - Single Chart"
   - Timeframe yang terdeteksi di chart
   - Data tersedia vs tidak tersedia
   - Timeframe yang MISSING (belum di-upload)

2. CONTEXT SUMMARY
   - Ticker (jika terlihat), Harga terakhir dari chart
   - Ringkasan apa yang terlihat di chart
   - Apa yang masih kurang untuk analisis lengkap

3. CONFIDENCE BREAKDOWN
   - Technical Score: x/25 (dari chart yang terlihat)
   - Entry Precision: x/25
   - Risk Management: x/25
   - News/Catalyst: x/25 (biasanya 0 kecuali ada info)
   - OVERALL: x/70 (cap di 70)

4. MULTI-TIMEFRAME BIAS
   - Timeframe yang TERLIHAT di chart: analisis bias-nya
   - Timeframe lain: "Tidak tersedia - belum di-upload"
   - Saran upload timeframe tambahan

5. KEY LEVEL VALIDATION
   - Support/Resistance yang TERLIHAT di chart
   - Order Block / Demand Zone / Supply Zone jika visible
   - Label mana yang confirmed vs estimasi

6. ENTRY QUALITY
   - Klasifikasi berdasarkan apa yang terlihat di chart
   - Apakah ada konfirmasi visual?
   - Entry point spesifik dari chart

7. INVALIDATION FIRST
   - Level invalidasi dari chart (swing low/high terlihat)
   - Kapan setup ini gagal
   - Action jika invalidasi terjadi

8. RISK REWARD CHECK
   - Entry/SL/TP berdasarkan chart yang terlihat
   - Risk:Reward ratio
   - Apakah layak? (minimum 1:2)

9. FINAL DECISION
   - Label keputusan
   - Skor x/70 (JANGAN lebih dari 70)
   - Alasan berdasarkan EVIDENCE dari chart

10. BEST ACTION PLAN
    - Trading plan spesifik berdasarkan chart
    - Entry, SL, TP yang jelas
    - Saran upload timeframe tambahan untuk presisi lebih tinggi

11. NEWS/CATALYST IMPACT
    - Biasanya tidak tersedia dari chart saja
    - Saran cek news

12. SCENARIO-BASED OUTPUT
    - Best Case: target dari resistance/supply zone terlihat
    - Base Case: sideways dalam range
    - Worst Case: break support terlihat

13. POSITION SIZING
    - Rekomendasi alokasi berdasarkan confidence level
    - Scaling plan

14. WHAT COULD GO WRONG
    - Risiko dari setup yang terlihat
    - Timeframe yang belum dikonfirmasi
    - Gap analysis

15. FINAL NOTE
    - Disclaimer
    - Saran upload chart tambahan (1W/1D/4H) untuk skor lebih tinggi
    - "Chart TradingView hanya visual dan bisa delay. Analisis presisi memakai chart yang Anda upload dan harga yang Anda input."
    - DYOR

PENTING: Semua angka HARUS dari chart yang terlihat. Jangan mengarang angka.`;

async function handleChartUpload(req, res, imageData, mimeType) {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  const { timeframe, ticker, currentPrice, images, documents, fcaStatus, evidenceLevel } = req.body || {};

  // Sanitize inputs to prevent prompt injection
  const safeTicker = ticker ? String(ticker).replace(/[^A-Za-z]/g, '').slice(0, 10).toUpperCase() : null;
  const safePrice = currentPrice ? String(currentPrice).replace(/[^0-9.]/g, '').slice(0, 15) : null;
  const safeTimeframe = timeframe ? String(timeframe).replace(/[^A-Za-z0-9]/g, '').slice(0, 5) : null;

  if (!GEMINI_API_KEY) {
    return res.status(200).json({ html: '<div class="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-6 text-center"><p class="text-yellow-400 font-semibold">Gemini API belum dikonfigurasi.</p><p class="text-yellow-300/70 text-sm mt-2">Hubungi admin untuk mengaktifkan fitur analisis chart.</p></div>' });
  }

  // Determine if multi-image or single image
  const hasMultiImages = images && images.length > 0;
  const imageCount = hasMultiImages ? images.length : (imageData ? 1 : 0);
  const hasDocuments = documents && documents.length > 0 && documents.some(function(d) { return d.text && d.text.length > 0; });
  const level = evidenceLevel || (imageCount >= 2 ? (hasDocuments ? 4 : 3) : 2);
  const fca = fcaStatus || 'not_detected';

  // Determine score cap based on evidence level
  var scoreCap;
  if (imageCount === 1 && !hasDocuments) scoreCap = 70;
  else if (imageCount >= 2 && !hasDocuments) scoreCap = 80;
  else if (imageCount >= 2 && hasDocuments) scoreCap = 90;
  else scoreCap = 70;

  // Build enhanced prompt with additional context
  var chartPrompt = CHART_SYSTEM_PROMPT;

  // Add evidence level awareness
  var levelLabel;
  if (imageCount === 1) levelLabel = 'Level 2 - Single Chart. SKOR MAKSIMUM: 70';
  else if (imageCount >= 2 && !hasDocuments) levelLabel = 'Level 3 - Multi-Timeframe. SKOR MAKSIMUM: 80';
  else if (imageCount >= 2 && hasDocuments) levelLabel = 'Level 4 - Comprehensive. SKOR MAKSIMUM: 90';
  else levelLabel = 'Level 2 - Single Chart. SKOR MAKSIMUM: 70';

  chartPrompt += '\n\n=== EVIDENCE LEVEL ===\n' + levelLabel + '\nSKOR MAKSIMUM ABSOLUT: ' + scoreCap + '\nDILARANG memberi skor di atas ' + scoreCap + '.\n';

  // Add multi-image context
  if (hasMultiImages && imageCount > 1) {
    chartPrompt += '\n=== MULTI-CHART ANALYSIS ===\n';
    chartPrompt += 'User mengirim ' + imageCount + ' chart:\n';
    images.forEach(function(img, i) {
      var tf = img.timeframe ? String(img.timeframe).replace(/[^A-Za-z0-9]/g, '').slice(0, 10) : 'tidak diketahui';
      chartPrompt += '- Chart ' + (i + 1) + ': [' + tf + ']' + (img.filename ? ' (' + img.filename + ')' : '') + '\n';
    });
    chartPrompt += '\nAnalisis SETIAP chart yang terlihat. Identifikasi timeframe masing-masing.\n';
    chartPrompt += 'Sintesis analisis multi-timeframe. JANGAN fabrikasi data untuk timeframe yang TIDAK terlihat.\n';
  }

  if (safeTicker || safePrice || safeTimeframe) {
    chartPrompt += '\n\n=== KONTEKS TAMBAHAN DARI USER ===\n';
    if (safeTicker) chartPrompt += '- Ticker: ' + safeTicker + '\n';
    if (safePrice) chartPrompt += '- Harga sekarang: Rp ' + safePrice + '\n';
    if (safeTimeframe) chartPrompt += '- Timeframe chart: ' + safeTimeframe + '\n';
    chartPrompt += 'Gunakan informasi ini untuk memperkuat analisis chart.';
  }

  // Add FCA section if applicable
  var fcaSection = buildFCASection(fca, level);
  if (fcaSection) {
    chartPrompt += fcaSection;
  }

  // Add document context if available
  var docContext = buildDocumentContext(documents);
  if (docContext) {
    chartPrompt += docContext;
  }

  // Add anti-hallucination forbidden words
  chartPrompt += FORBIDDEN_WORDS_PROMPT;

  const GEMINI_MODEL = 'gemini-2.5-flash';
  const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  // Build payload - multi-image or single image
  var parts = [{ text: chartPrompt }];

  if (hasMultiImages) {
    images.forEach(function(img) {
      var base64 = img.data || img.base64Data || '';
      if (base64.includes(',')) base64 = base64.split(',')[1];
      if (base64) {
        parts.push({
          inline_data: { mime_type: img.mimeType || 'image/png', data: base64 }
        });
      }
    });
  } else if (imageData) {
    // Single image backward compatibility
    var base64Data = imageData;
    if (base64Data.includes(',')) {
      base64Data = base64Data.split(',')[1];
    }
    parts.push({
      inline_data: { mime_type: mimeType || 'image/png', data: base64Data }
    });
  }

  const payload = {
    contents: [{ parts: parts }],
    generationConfig: {
      temperature: 0.35,
      topP: 0.95,
      topK: 40,
      maxOutputTokens: 8192
    }
  };

  const response = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    return res.status(200).json({ html: '<div class="bg-red-500/10 border border-red-500/30 rounded-xl p-6 text-center"><p class="text-red-400 font-semibold">Gemini API error.</p><p class="text-red-300/70 text-sm mt-2">Coba lagi dalam beberapa saat.</p></div>' });
  }

  const result = await response.json();
  const candidates = result.candidates || [];

  if (candidates.length > 0) {
    const cparts = candidates[0].content?.parts || [];
    if (cparts.length > 0 && cparts[0].text) {
      let html = cparts[0].text;
      html = html.replace(/^```html\s*/i, '').replace(/```\s*$/i, '');

      if (isCompleteAnalysis(html)) {
        logAnalysis(safeTicker || 'CHART_UPLOAD', 0);
        return res.status(200).json({ html });
      }
    }
  }

  return res.status(200).json({ html: '<div class="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-6 text-center space-y-3"><p class="text-yellow-400 font-semibold text-base">Analisis chart belum lengkap</p><p class="text-yellow-300/70 text-sm">AI tidak dapat menghasilkan analisis yang lengkap dari screenshot ini.</p><div class="text-left bg-[#0b0e14] rounded-lg p-4 border border-yellow-500/20 mt-4"><p class="text-xs text-gray-300 mb-2 font-semibold">Saran:</p><ul class="text-xs text-gray-400 space-y-1 list-disc list-inside"><li>Pastikan chart menampilkan candle dengan jelas</li><li>Pastikan sumbu harga (kanan) terlihat jelas</li><li>Gunakan timeframe Daily atau H4 untuk hasil terbaik</li><li>Atau gunakan mode Nama Saham dengan mengisi ticker dan harga</li></ul></div></div>' });
}


// === CHAT MODE HANDLER ===
async function handleChatMode(req, res, message) {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

  if (!GEMINI_API_KEY) {
    return res.status(200).json({ html: '<p class="text-sm text-yellow-400">Gemini API belum dikonfigurasi. Hubungi admin.</p>' });
  }

  const GEMINI_MODEL = 'gemini-2.5-flash';
  const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const chatSystemPrompt = `Kamu adalah Auto-Cuan AI, asisten saham Indonesia yang paham Smart Money Concepts (SMC), analisis teknikal, dan pasar saham IDX/BEI.

GAYA BAHASA:
- Pakai Bahasa Indonesia yang natural, santai, tapi tetap profesional.
- JANGAN kaku atau terlalu formal. Jangan bilang "Sebagai Auto-Cuan AI..." berulang-ulang.
- Boleh pakai tone santai seperti ngobrol sama teman yang ngerti saham.
- Jawab to the point, jangan bertele-tele.
- Jangan over-answer. Kalau ditanya singkat, jawab singkat.
- Disclaimer cukup 1 kalimat pendek di akhir kalau perlu, jangan panjang-panjang.

ATURAN KONTEN:
- Kalau user tanya soal saham tertentu TANPA harga, kasih gambaran singkat dan sarankan kirim harga biar bisa analisis lengkap.
- Kalau user tanya konsep trading (support, resistance, SMC, order block, FVG, dll), jelaskan dengan ringkas dan contoh sederhana.
- JANGAN kasih trading plan lengkap dengan tabel di chat mode. Cukup penjelasan dan saran.
- Kalau ada info [Info: TICKER = Nama Perusahaan] di pesan, gunakan info itu untuk menyebut nama perusahaan.

ATURAN ANALISIS PRESISI:
- Jika user meminta "analisis presisi", "analisis lengkap", "full analysis", atau sejenisnya, berikan template berikut:
  "Untuk analisis presisi maksimal, saya butuh data berikut:
  1. Harga saat ini (contoh: BBCA 9250)
  2. Chart Weekly (1W) - screenshot dari TradingView/app broker
  3. Chart Daily (1D) - screenshot
  4. Chart 4 Jam (4H) - screenshot
  5. News/katalis terbaru (jika ada)
  6. Average price kamu (jika sudah hold)

  Semakin lengkap data, semakin tinggi presisi analisis (skor bisa sampai 85+). Tanpa chart, skor maksimal hanya 55."

- Catatan tentang TradingView: "Chart TradingView hanya visual dan bisa delay. Analisis presisi memakai chart yang Anda upload dan harga yang Anda input."
- Jika user belum upload chart, ingatkan bahwa untuk presisi tertinggi mereka perlu upload chart 1W/1D/4H.

FORMAT OUTPUT:
- HTML sederhana: <p>, <strong>, <ul>, <li> saja.
- Class: text-sm text-gray-300 untuk paragraf, text-emerald-400 untuk keyword penting, text-white untuk emphasis.
- Jangan pakai heading besar. Boleh <strong>.
- Maks 3-6 paragraf. Ringkas.

CONTOH GAYA JAWABAN YANG BAGUS:
- "BBCA itu Bank Central Asia. Saham big bank, likuid, biasanya jadi pilihan aman. Kalau mau analisis lengkap, kirim harga sekarangnya ya, contoh: BBCA 9250."
- "Order block itu zona di mana smart money (institusi besar) melakukan akumulasi atau distribusi. Biasanya muncul sebelum pergerakan besar."
- "Kalau mau presisi tinggi, upload chart 1W + 1D + 4H. Tanpa chart, skor analisis maximal cuma 55."

Pertanyaan user: ${message}`;

  const payload = {
    contents: [{ parts: [{ text: chatSystemPrompt }] }],
    generationConfig: {
      temperature: 0.7,
      topP: 0.9,
      topK: 40,
      maxOutputTokens: 2048
    }
  };

  try {
    const response = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      return res.status(200).json({ html: '<p class="text-sm text-red-400">Maaf, AI sedang tidak tersedia. Coba lagi nanti.</p>' });
    }

    const result = await response.json();
    const candidates = result.candidates || [];

    if (candidates.length > 0) {
      const parts = candidates[0].content?.parts || [];
      if (parts.length > 0 && parts[0].text) {
        let html = parts[0].text;
        html = html.replace(/^```html\s*/i, '').replace(/```\s*$/i, '');
        return res.status(200).json({ html });
      }
    }

    return res.status(200).json({ html: '<p class="text-sm text-gray-400">Maaf, saya tidak bisa menjawab pertanyaan itu saat ini. Coba tanya dengan cara lain.</p>' });
  } catch (e) {
    console.error('chat mode error:', e);
    return res.status(200).json({ html: '<p class="text-sm text-red-400">Terjadi kesalahan. Coba lagi.</p>' });
  }
}
