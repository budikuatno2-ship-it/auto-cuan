/**
 * Auto-Cuan: Vercel Serverless — Lightweight Chart/Ticker Analysis
 * Gemini 2.5 Flash — NO Google Search (saves quota, prevents 429).
 * Returns raw HTML string (Action Badge + Price Target + Trading Plan Table).
 * API key from process.env.GEMINI_API_KEY only.
 */

export const config = { maxDuration: 90 };

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const SYSTEM_PROMPT = `Anda adalah AI Analis Teknikal Saham Senior khusus Smart Money Concepts (SMC) untuk Bursa Efek Indonesia (IDX).

ATURAN SINKRONISASI HARGA KRITIS:
- Periksa sumbu harga kanan chart. Jika saham gocap/penny stock (misal NAYZ), harga WAJIB di fraksi puluhan (Rp 63). Entry=63, SL=60, TP=70. JANGAN pernah tampilkan ribuan untuk saham < Rp 100!
- Jika blue chip (misal BBRI Rp 4.850), gunakan ribuan yang sesuai.
- Bulatkan semua angka ke bilangan bulat (tanpa desimal).

TUGAS:
1. Identifikasi ticker dan harga terakhir dari chart/konteks.
2. Tentukan kondisi pasar (Bullish/Bearish/Sideways) dan pilih SATU Action Badge:
   - HAKA (HAJAR KANAN): tren sangat bullish + BOS/Breakout jelas
   - LAYAK MASUK (BUY): harga di zona Order Block/Demand kuat saat pullback
   - WAIT AND SEE: sideways/konsolidasi tanpa konfirmasi
   - JUAL / CUT LOSS: break di bawah support kunci/CHoCH bearish

3. PREDIKSI TARGET HARGA MAKSIMAL:
   Setelah menganalisis chart, hitung satu angka target harga realistis (Resistance Kuat / Target Take Profit Maksimal jangka menengah) yang bisa dicapai saham tersebut. Hitung juga persentase potensi kenaikan dari harga terakhir. Bulatkan ke bilangan bulat. Target harus proporsional dengan harga dasar (penny stock Rp 63 → target sekitar Rp 75-85, blue chip Rp 4850 → target sekitar Rp 5200-5500).

4. Hitung 3 Opsi Trading Plan dari harga terakhir:
   - Opsi 1 (Agresif): Entry=harga terakhir; SL=5% bawah; TP=11% atas; RR=1:2.2
   - Opsi 2 (Konservatif): Entry=3% bawah harga terakhir; SL=5% bawah Entry; TP=8% atas Entry; RR=1:1.6
   - Opsi 3 (Scalping): Entry=harga terakhir; SL=2% bawah; TP=2% atas; RR=1:1.0

OUTPUT FORMAT (HTML mentah, TANPA markdown fence):
Tulis HTML langsung dengan struktur berurutan:

BAGIAN 1 - PRICE TARGET CARD:
<div class="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4 mb-5 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
  <div>
    <p class="text-[10px] uppercase tracking-wider text-yellow-400/70 font-semibold">Prediksi Target Harga</p>
    <p class="text-xl sm:text-2xl font-black text-yellow-300">Rp [TARGET]</p>
  </div>
  <div class="text-right">
    <p class="text-[10px] uppercase tracking-wider text-yellow-400/70 font-semibold">Potensi Kenaikan</p>
    <p class="text-lg sm:text-xl font-black text-emerald-400">+[X]%</p>
  </div>
</div>

BAGIAN 2 - ACTION BADGE + INFO:
Div wrapper berisi Action Badge besar + badge ticker + badge harga terakhir.
- Badge HAKA: <span class="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-emerald-500/20 border-2 border-emerald-400 text-emerald-300 text-xs font-black uppercase animate-pulse">🚀 HAKA</span>
- Badge BUY: <span class="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-green-500/20 border-2 border-green-400 text-green-300 text-xs font-black uppercase">✅ LAYAK MASUK</span>
- Badge WAIT: <span class="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-yellow-500/20 border-2 border-yellow-400 text-yellow-300 text-xs font-black uppercase">⏸️ WAIT</span>
- Badge JUAL: <span class="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-red-500/20 border-2 border-red-400 text-red-300 text-xs font-black uppercase animate-pulse">🛑 JUAL</span>
- Ticker: <span class="px-2 py-1 rounded bg-[#1c2333] text-gray-200 text-xs font-bold">KODE</span>
- Price: <span class="px-2 py-1 rounded bg-[#1c2333] text-emerald-300 text-xs font-bold">Rp X</span>

BAGIAN 3 - PARAGRAF ANALISIS:
<p class="text-xs sm:text-sm text-gray-300 leading-relaxed my-3">Analisis singkat 2-3 kalimat...</p>

BAGIAN 4 - TABEL TRADING PLAN:
<table class="w-full border-collapse text-xs mt-4">
  <thead><tr class="border-b-2 border-emerald-500/20"><th class="py-2 px-2 text-left text-[10px] font-semibold uppercase text-gray-400 bg-[#131722]">...</th>...</tr></thead>
  <tbody>3 baris <tr> dengan kolom: Opsi, Tipe, Entry, SL, TP, RR, Keterangan</tbody>
</table>
- Entry TD: class="py-2 px-2 text-xs text-white font-bold"
- SL TD: class="py-2 px-2 text-xs text-red-400 font-semibold"
- TP TD: class="py-2 px-2 text-xs text-emerald-400 font-semibold"
- RR TD: class="py-2 px-2 text-xs text-yellow-300 font-semibold"
- Default TD: class="py-2 px-2 text-xs text-gray-300"
- TR: class="border-b border-[#1c2333]"

LANGSUNG tulis HTML. JANGAN bungkus code fence.`;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY belum dikonfigurasi.' });

  try {
    const { image, mimeType, ticker } = req.body || {};
    const parts = [{ text: SYSTEM_PROMPT }];

    if (image) {
      let imageData = image;
      if (imageData.includes(',')) imageData = imageData.split(',')[1];
      parts.push({ inline_data: { mime_type: mimeType || 'image/png', data: imageData } });
    } else if (ticker) {
      parts.push({ text: `Analisis saham dengan kode ticker: ${ticker}. Gunakan pengetahuan Anda tentang harga terakhir saham ini di IDX dan buat Trading Plan yang logis termasuk prediksi target harga.` });
    } else {
      return res.status(400).json({ error: 'Kirim gambar chart atau kode ticker.' });
    }

    const payload = {
      contents: [{ parts }],
      generationConfig: { temperature: 0.4, topP: 0.9, topK: 40, maxOutputTokens: 4096 },
    };

    const geminiRes = await fetch(`${GEMINI_API_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!geminiRes.ok) {
      const errBody = await geminiRes.json().catch(() => ({}));
      if (geminiRes.status === 429) return res.status(429).json({ error: 'Kuota API habis. Tunggu beberapa menit.' });
      return res.status(geminiRes.status).json({ error: `Gemini error (${geminiRes.status}): ${errBody?.error?.message || 'Unknown'}` });
    }

    const result = await geminiRes.json();
    if (result.promptFeedback?.blockReason) return res.status(400).json({ error: `Safety filter: ${result.promptFeedback.blockReason}` });

    const candidates = result.candidates || [];
    if (!candidates.length) return res.status(500).json({ error: 'Tidak ada output.' });

    let html = '';
    for (const part of (candidates[0]?.content?.parts || [])) { if (part.text) html += part.text; }
    html = html.replace(/^```html?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

    if (!html) return res.status(500).json({ error: 'Respons kosong.' });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  } catch (error) {
    console.error('analyze error:', error);
    return res.status(500).json({ error: `Server error: ${error.message}` });
  }
}
