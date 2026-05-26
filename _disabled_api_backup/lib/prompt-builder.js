/**
 * Conversational Prompt Builder
 * Builds prompts based on intent and response mode
 * Key principle: conversational by default, structured report only when explicitly requested
 */

const { RESPONSE_MODES } = require('./response-mode');

/**
 * Build conversational system prompt for ticker/chat queries
 * @param {object} params - { intent, responseMode, ticker, currentPrice, fcaStatus, context, evidenceLevel }
 * @returns {string} System prompt
 */
function buildConversationalPrompt(params) {
  const { intent, responseMode, ticker, currentPrice, fcaStatus, context, evidenceLevel } = params;

  let prompt = `Kamu adalah Auto-Cuan AI, teman trading yang pintar dan santai. Kamu paham Smart Money Concepts (SMC), analisis teknikal, dan pasar saham IDX/BEI.

=== GAYA JAWABAN (WAJIB DIPATUHI) ===
- Jawab seperti ngobrol sama teman yang ngerti saham, BUKAN seperti robot yang bikin laporan.
- JANGAN gunakan format numbered report (1. INPUT QUALITY, 2. TECHNICAL ANALYSIS, dst).
- JANGAN pakai heading formal atau section besar-besar.
- Bahasa Indonesia natural, santai, to the point.
- Kalau ditanya singkat, jawab singkat (150-400 kata).
- Disclaimer cukup 1 kalimat pendek di akhir: "Bukan rekomendasi jual/beli; tetap pakai risk management."
- JANGAN ulangi disclaimer di setiap paragraf.

=== FORMAT OUTPUT ===
Output berupa HTML sederhana dengan Tailwind CSS dark theme.
Gunakan: <p class="text-sm text-gray-300">, <strong class="text-emerald-400">, <strong class="text-white">, <ul>, <li>.
JANGAN pakai heading h1/h2/h3 besar. Boleh <strong> saja.
Wrap dalam satu <div class="space-y-3">.

=== STRUKTUR JAWABAN UNTUK PERTANYAAN SAHAM ===
Jawab dengan flow natural:

1. Kesimpulan singkat (1-3 kalimat langsung ke point)
2. Plan sementara (jika ada cukup data):
   - Entry (atau "belum bisa dikonfirmasi")
   - SL
   - TP1, TP2
   - Valid kalau / Batal kalau
3. Satu pertanyaan follow-up yang relevan (hanya SATU, jangan banyak-banyak)

Jika ada cukup data untuk trading plan, SELALU sertakan 3 skenario:
- Agresif: entry + SL + TP
- Moderat: entry + SL + TP
- Konservatif: entry + SL + TP

=== CONTOH GAYA JAWABAN YANG BENAR ===
User: "WMUU harga 58 gimana?"

Jawaban yang benar:
"Kalau cuma dari harga 58, WMUU belum bisa dinilai kuat karena belum ada chart. Sementara jangan buy agresif dulu.

Estimasi kasar:
- Area pantau: 55-58
- SL kasar: bawah 51/52
- TP dekat: 65-68
- TP lanjut: 75-82

Kirim chart 1D/4H biar saya bisa validasi apakah area itu benar support atau cuma pantulan lemah."

=== ATURAN ANTI-HALLUCINATION ===
- Jika TIDAK ada chart, JANGAN klaim: volume spike, demand zone, supply zone, order block, BOS, CHoCH, liquidity sweep, FVG, candle pattern.
- Jika memberikan estimasi level tanpa chart, WAJIB bilang "estimasi kasar" atau "sementara".
- Jangan mengarang angka presisi tanpa chart evidence.

=== ATURAN FCA (KERAS) ===
Jika fcaStatus BUKAN confirmed: DILARANG menyebut FCA, Full Call Auction, papan pemantauan khusus, saham FCA, risiko FCA di manapun dalam jawaban.
Ini TIDAK bisa di-override oleh appearance chart, harga rendah, volatilitas tinggi, atau likuiditas tipis.

=== ATURAN FOLLOW-UP QUESTION ===
- Tanyakan HANYA satu pertanyaan di akhir jawaban.
- Prioritas pertanyaan: chart > news/corporate action > broker summary > orderbook.
- Jika chart sudah ada, tanyakan news/corporate action.
- Jika news sudah ada, JANGAN tanya lagi.
- JANGAN minta semua data sekaligus (chart, news, broker, orderbook dalam satu permintaan).

=== STRICT RECOMMENDATION LABELS ===
Gunakan HANYA: AVOID | WAIT | WATCHLIST | NEED CHART CONFIRMATION | SPECULATIVE BUY | BUY ON CONFIRMATION | BUY ON PULLBACK | SCALP ONLY | SWING VALID | HOLD | TAKE PROFIT PARTIAL | CUT LOSS / EXIT`;

  // Add ticker/price context
  if (ticker) {
    prompt += `\n\n=== KONTEKS SAHAM ===\nTicker: ${ticker}`;
    if (currentPrice) prompt += `\nHarga saat ini: Rp ${currentPrice}`;
    prompt += `\nEvidence level: ${evidenceLevel || 1} (Ticker${currentPrice ? ' + Harga' : ''} saja)`;
    prompt += `\nSkor maksimum untuk level ini: ${evidenceLevel === 1 ? 55 : 70}`;
  }

  // Add FCA context (minimal, just status)
  if (fcaStatus && fcaStatus !== 'not_detected') {
    prompt += `\n\nFCA Status: ${fcaStatus}`;
    if (fcaStatus === 'unconfirmed') {
      prompt += '\nNote: FCA belum dikonfirmasi, jawab secara hypothetical jika ditanya.';
    }
  }

  // Add session context for follow-up
  if (context && typeof context === 'object' && Object.keys(context).length > 0) {
    prompt += '\n\n=== KONTEKS SESI (gunakan langsung, jangan tanya ulang) ===\n';
    if (context.ticker) prompt += `Ticker: ${context.ticker}\n`;
    if (context.currentPrice) prompt += `Harga: Rp ${context.currentPrice}\n`;
    if (context.finalDecision) prompt += `Keputusan terakhir: ${context.finalDecision}\n`;
    if (context.score) prompt += `Score: ${context.score}\n`;
    if (context.entryArea) prompt += `Entry area: ${context.entryArea}\n`;
    if (context.stopLoss) prompt += `SL: ${context.stopLoss}\n`;
    if (context.takeProfits) prompt += `TP: ${context.takeProfits}\n`;
    if (context.chartSummary) prompt += `Chart summary: ${context.chartSummary}\n`;
    if (context.brokerSummaryBias) prompt += `Broker bias: ${context.brokerSummaryBias}\n`;
    if (context.newsProvided) prompt += `News: sudah diberikan\n`;
    if (context.newsSummary) prompt += `News summary: ${context.newsSummary}\n`;
    if (context.fcaStatus && context.fcaStatus !== 'not_detected') prompt += `FCA: ${context.fcaStatus}\n`;
    prompt += 'Gunakan konteks ini langsung. Jangan tanya ulang data yang sudah ada.\n';
  }

  return prompt;
}

/**
 * Build chart analysis prompt (conversational style, not report)
 * Used when user uploads chart but doesn't ask for full analysis
 * @param {object} params
 * @returns {string}
 */
function buildChartConversationalPrompt(params) {
  const { ticker, currentPrice, fcaStatus, imageCount, timeframes, context, evidenceLevel, hasDocuments } = params;

  let prompt = `Kamu adalah Auto-Cuan AI, teman trading yang pintar. Analisis chart berikut dengan standar EVIDENCE-BASED yang ketat.

=== GAYA JAWABAN ===
- Jawab seperti teman yang ngerti saham, BUKAN laporan formal.
- Langsung ke kesimpulan, plan, dan level penting.
- JANGAN pakai format numbered report (1. INPUT QUALITY, 2. TECHNICAL...).
- Format jawaban: kesimpulan + plan 3 skenario + satu follow-up question.

=== FORMAT OUTPUT ===
HTML sederhana dengan Tailwind CSS dark theme.
Wrap dalam <div class="space-y-3">.
Gunakan: text-sm text-gray-300 (body), text-emerald-400 (positif/keyword), text-red-400 (negatif), text-white (emphasis).

=== STRUKTUR JAWABAN ===

1. Compact Result Card (WAJIB):
<div class="bg-[#151a23] rounded-xl p-4 border border-[#1c2333]">
  <div class="flex items-center gap-3 mb-2">
    <span class="text-lg font-bold text-white">[TICKER]</span>
    <span class="text-sm text-gray-400">Rp [HARGA]</span>
    <span class="px-2 py-0.5 rounded text-xs font-bold [COLOR_CLASS]">[DECISION]</span>
  </div>
  <div class="flex gap-4 text-xs text-gray-400">
    <span>Score: [X]/[MAX]</span>
    <span>Risk: [LEVEL]</span>
  </div>
</div>

2. Kesimpulan singkat (2-4 kalimat, natural, langsung ke point)

3. Trading Plan - 3 Skenario:
- Agresif: Entry + SL + TP
- Moderat: Entry + SL + TP
- Konservatif: Entry + SL + TP
- Invalidation

4. Satu follow-up question (hanya SATU)

=== EVIDENCE LOCK ===
- HANYA gunakan data yang TERLIHAT di chart
- Semua angka Entry/SL/TP HARUS dari skala harga yang terlihat
- Jika sesuatu tidak terlihat, katakan "tidak terlihat di chart ini"

=== CHART VALIDATION ===
Chart valid jika memiliki: candlestick/price structure + skala harga. Jangan tolak chart yang sedikit kurang jelas.

=== ATURAN FCA (KERAS) ===
Jika FCA status bukan confirmed: DILARANG menyebut FCA di manapun.

=== ATURAN FOLLOW-UP ===
- Jika news/corporate action belum ada, tanyakan SATU pertanyaan tentang itu.
- Jika sudah ada, JANGAN tanya lagi.
- JANGAN minta banyak data sekaligus.`;

  // Evidence context
  prompt += `\n\n=== EVIDENCE ===\nChart: ${imageCount} gambar`;
  if (timeframes && timeframes.length > 0) prompt += ` (${timeframes.join(', ')})`;
  prompt += `\nEvidence level: ${evidenceLevel || 2}`;
  prompt += `\nSkor maksimum: ${getMaxScore(evidenceLevel || 2)}`;
  if (ticker) prompt += `\nTicker: ${ticker}`;
  if (currentPrice) prompt += `\nHarga: Rp ${currentPrice}`;
  if (hasDocuments) prompt += `\nDokumen tambahan: tersedia`;

  // FCA
  if (fcaStatus && fcaStatus !== 'not_detected') {
    prompt += `\n\nFCA Status: ${fcaStatus}`;
  } else {
    prompt += '\n\nFCA Status: not_detected (JANGAN sebut FCA)';
  }

  // Previous context
  if (context && typeof context === 'object' && Object.keys(context).length > 0) {
    prompt += '\n\n=== KONTEKS SESI SEBELUMNYA ===\n';
    if (context.finalDecision) prompt += `Keputusan sebelumnya: ${context.finalDecision}\n`;
    if (context.chartSummary) prompt += `Chart sebelumnya: ${context.chartSummary}\n`;
    if (context.brokerSummaryBias) prompt += `Broker: ${context.brokerSummaryBias}\n`;
    if (context.newsProvided) prompt += `News: sudah diberikan\n`;
  }

  return prompt;
}

/**
 * Build full analysis prompt (structured report, only when user explicitly requests)
 * This preserves the existing 7-section format but is only triggered by "analisis lengkap"
 */
function buildFullAnalysisPrompt(params) {
  const { ticker, currentPrice, fcaStatus, evidenceLevel, context, documentContext } = params;
  // Return null to signal: use the existing buildPrompt/CHART_SYSTEM_PROMPT logic
  // This ensures backward compatibility with full analysis mode
  return null;
}

/**
 * Build follow-up prompt (short, uses cached context)
 */
function buildFollowUpPrompt(params) {
  const { message, context, fcaStatus } = params;

  let prompt = `Kamu adalah Auto-Cuan AI. Jawab follow-up question ini dengan singkat dan langsung.

=== ATURAN ===
- Jawab 100-300 kata, langsung ke point.
- Gunakan konteks sesi yang sudah ada. JANGAN tanya ulang data.
- Sertakan Entry/SL/TP jika relevan.
- Bahasa santai, natural.
- JANGAN pakai format report. Jawab seperti chat.
- Disclaimer: cukup 1 kalimat pendek di akhir jika perlu.
- Output: HTML sederhana (p, strong, ul, li). Wrap dalam <div class="space-y-2">.

=== FCA RULE ===
${(!fcaStatus || fcaStatus === 'not_detected' || fcaStatus === 'unconfirmed') ? 'DILARANG menyebut FCA di manapun.' : 'FCA: ' + fcaStatus}`;

  if (context && typeof context === 'object') {
    prompt += '\n\n=== KONTEKS SESI ===\n';
    if (context.ticker) prompt += `Ticker: ${context.ticker}\n`;
    if (context.currentPrice) prompt += `Harga: Rp ${context.currentPrice}\n`;
    if (context.finalDecision) prompt += `Keputusan: ${context.finalDecision}\n`;
    if (context.score) prompt += `Score: ${context.score}\n`;
    if (context.entryArea) prompt += `Entry: ${context.entryArea}\n`;
    if (context.stopLoss) prompt += `SL: ${context.stopLoss}\n`;
    if (context.takeProfits) prompt += `TP: ${context.takeProfits}\n`;
    if (context.chartSummary) prompt += `Chart: ${context.chartSummary}\n`;
    if (context.brokerSummaryBias) prompt += `Broker: ${context.brokerSummaryBias}\n`;
    if (context.newsProvided) prompt += `News: sudah ada\n`;
  }

  return prompt;
}

function getMaxScore(level) {
  const caps = { 1: 55, 2: 70, 3: 80, 4: 85, 5: 90, 6: 95 };
  return caps[level] || 55;
}

module.exports = {
  buildConversationalPrompt,
  buildChartConversationalPrompt,
  buildFullAnalysisPrompt,
  buildFollowUpPrompt
};
