/**
 * Auto-Cuan: Vercel Serverless — Final Version
 * Gemini 2.5 Flash, NO Google Search grounding, NO news, NO broker summary.
 * Supports dual input: image chart OR ticker text.
 * Returns raw HTML string (Price Target + Action Badge + Trading Plan Table).
 * API key from process.env.GEMINI_API_KEY only.
 */

export const config = { maxDuration: 90 };

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const SYSTEM_PROMPT = `Anda adalah AI Analis Teknikal Saham Senior khusus Smart Money Concepts (SMC) untuk Bursa Efek Indonesia (IDX).

ATURAN SINKRONISASI HARGA (WAJIB):
- Jika gambar chart diunggah: baca harga terakhir (Last Price) dari sumbu kanan chart secara eksak.
- Jika hanya kode ticker diberikan tanpa gambar: gunakan estimasi logis dari pengetahuan Anda tentang harga saham tersebut di IDX.
- Jika saham gocap/penny stock (misal NAYZ ~Rp 63): SEMUA angka Entry/SL/TP WAJIB di fraksi puluhan rupiah. Contoh: Entry=63, SL=60, TP=70. JANGAN PERNAH tampilkan ribuan untuk saham di bawah Rp 100.
- Jika saham blue chip (misal BBRI ~Rp 4.850): gunakan ribuan yang sesuai.
- Bulatkan SEMUA angka harga ke bilangan bulat (tanpa desimal).

TUGAS:
1. Identifikasi kode ticker dan harga terakhir.
2. Tentukan kondisi pasar (Bullish/Bearish/Sideways).
3. Pilih SATU Action Badge berdasarkan struktur pasar:
   - HAKA (HAJAR KANAN): tren sangat bullish + BOS/Breakout jelas
   - LAYAK MASUK (BUY): harga di zona Order Block/Demand kuat saat pullback
   - WAIT AND SEE: sideways/konsolidasi tanpa konfirmasi arah
   - JUAL / CUT LOSS: break di bawah support kunci / CHoCH bearish

4. PREDIKSI TARGET HARGA MAKSIMAL:
   Hitung satu angka target harga realistis (Resistance Kuat jangka menengah). Hitung persentase potensi kenaikan dari harga terakhir. Target harus proporsional (penny Rp 63 -> target Rp 75-85, blue chip Rp 4850 -> target Rp 5200-5500).

5. Hitung 3 Opsi Trading Plan dari harga terakhir:
   - Opsi 1 (Agresif): Entry=harga terakhir; SL=5% bawah Entry; TP=11% atas Entry; RR=1:2.2
   - Opsi 2 (Konservatif): Entry=3% bawah harga terakhir; SL=5% bawah Entry; TP=8% atas Entry; RR=1:1.6
   - Opsi 3 (Scalping): Entry=harga terakhir; SL=2% bawah Entry; TP=2% atas Entry; RR=1:1.0

OUTPUT (HTML mentah, TANPA markdown code fence, TANPA teks di luar HTML):

BAGIAN 1 - PRICE TARGET CARD:
<div class="bg-yellow-500/10 border border-yellow-500/30 text-yellow-400 p-4 rounded-xl font-bold flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
  <div>
    <p class="text-[10px] uppercase tracking-wider text-yellow-400/70 font-semibold">Prediksi Target Harga</p>
    <p class="text-xl sm:text-2xl font-black text-yellow-300">Rp [TARGET]</p>
  </div>
  <div class="sm:text-right">
    <p class="text-[10px] uppercase tracking-wider text-yellow-400/70 font-semibold">Potensi Kenaikan</p>
    <p class="text-lg sm:text-xl font-black text-emerald-400">+[X]%</p>
  </div>
</div>

BAGIAN 2 - ACTION BADGE + INFO:
<div class="flex flex-wrap items-center gap-2 mt-4">
  [PILIH SATU BADGE:]
  HAKA: <span class="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-emerald-500/20 border-2 border-emerald-400 text-emerald-300 text-xs font-black uppercase animate-pulse">🚀 HAKA</span>
  BUY: <span class="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-green-500/20 border-2 border-green-400 text-green-300 text-xs font-black uppercase">✅ LAYAK MASUK</span>
  WAIT: <span class="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-yellow-500/20 border-2 border-yellow-400 text-yellow-300 text-xs font-black uppercase">⏸️ WAIT AND SEE</span>
  JUAL: <span class="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-red-500/20 border-2 border-red-400 text-red-300 text-xs font-black uppercase animate-pulse">🛑 JUAL / CUT LOSS</span>

  <span class="px-2 py-1 rounded-lg bg-gray-800 text-gray-200 text-xs font-bold">[TICKER]</span>
  <span class="px-2 py-1 rounded-lg bg-gray-800 text-emerald-300 text-xs font-bold">Rp [HARGA]</span>
</div>

BAGIAN 3 - PARAGRAF ANALISIS:
<p class="text-xs sm:text-sm text-gray-300 leading-relaxed mt-3 mb-4">Analisis teknikal singkat 2-3 kalimat dalam Bahasa Indonesia menjelaskan mengapa badge tersebut dipilih...</p>

BAGIAN 4 - TRADING PLAN TABLE:
<div class="w-full overflow-x-auto block border border-gray-800 rounded-xl my-4 bg-[#131722]">
<table class="min-w-[760px] w-full text-xs md:text-sm">
<thead><tr class="border-b-2 border-emerald-500/20">
<th class="px-3 py-3 text-left text-[10px] font-semibold uppercase text-gray-400 bg-[#131722]">Opsi</th>
<th class="px-3 py-3 text-left text-[10px] font-semibold uppercase text-gray-400 bg-[#131722]">Tipe</th>
<th class="px-3 py-3 text-left text-[10px] font-semibold uppercase text-gray-400 bg-[#131722]">Entry</th>
<th class="px-3 py-3 text-left text-[10px] font-semibold uppercase text-gray-400 bg-[#131722]">SL</th>
<th class="px-3 py-3 text-left text-[10px] font-semibold uppercase text-gray-400 bg-[#131722]">TP</th>
<th class="px-3 py-3 text-left text-[10px] font-semibold uppercase text-gray-400 bg-[#131722]">RR</th>
<th class="px-3 py-3 text-left text-[10px] font-semibold uppercase text-gray-400 bg-[#131722]">Keterangan</th>
</tr></thead>
<tbody>
<tr class="border-b border-gray-800"><td class="px-3 py-3 text-gray-300 whitespace-nowrap">1</td><td class="px-3 py-3 text-gray-300 whitespace-nowrap">Agresif</td><td class="px-3 py-3 text-white font-bold whitespace-nowrap">Rp [X]</td><td class="px-3 py-3 text-red-400 font-semibold whitespace-nowrap">Rp [X]</td><td class="px-3 py-3 text-emerald-400 font-semibold whitespace-nowrap">Rp [X]</td><td class="px-3 py-3 text-yellow-300 font-semibold whitespace-nowrap">1:2.2</td><td class="px-3 py-3 text-gray-300 whitespace-normal min-w-[220px]">[Keterangan struktur pasar]</td></tr>
<tr class="border-b border-gray-800"><td>...</td>...</tr>
<tr class="border-b border-gray-800"><td>...</td>...</tr>
</tbody></table></div>

SEMUA sel tabel WAJIB terisi. Tidak boleh kosong.
JANGAN tulis markdown. JANGAN bungkus code fence. LANGSUNG tulis HTML mentah.`;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY belum dikonfigurasi. Tambahkan di Vercel Environment Variables.' });

  try {
    const { image, mimeType, ticker } = req.body || {};
    const parts = [{ text: SYSTEM_PROMPT }];

    if (image) {
      let imageData = image;
      if (imageData.includes(',')) imageData = imageData.split(',')[1];
      parts.push({ inline_data: { mime_type: mimeType || 'image/png', data: imageData } });
    } else if (ticker) {
      parts.push({ text: `Analisis saham dengan kode ticker: ${ticker.toUpperCase()}. Gunakan pengetahuan Anda tentang harga terakhir saham ini di IDX. Buat analisis lengkap termasuk prediksi target harga dan trading plan.` });
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
      if (geminiRes.status === 429) return res.status(429).json({ error: 'Kuota API habis. Tunggu beberapa menit lalu coba lagi.' });
      return res.status(geminiRes.status).json({ error: `Gemini error (${geminiRes.status}): ${errBody?.error?.message || 'Unknown'}` });
    }

    const result = await geminiRes.json();
    if (result.promptFeedback?.blockReason) return res.status(400).json({ error: `Safety filter: ${result.promptFeedback.blockReason}` });

    const candidates = result.candidates || [];
    if (!candidates.length) return res.status(500).json({ error: 'Tidak ada output dari model.' });

    let html = '';
    for (const part of (candidates[0]?.content?.parts || [])) {
      if (part.text) html += part.text;
    }
    html = html.replace(/^```html?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

    if (!html) return res.status(500).json({ error: 'Respons kosong dari model.' });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  } catch (error) {
    console.error('analyze error:', error);
    return res.status(500).json({ error: `Server error: ${error.message}` });
  }
}
