/**
 * Auto-Cuan: Vercel Serverless — Chart Analysis + Broker Summary + News
 * Uses Gemini 2.5 Flash with Google Search grounding for live IDX data.
 * Returns raw HTML text (NOT JSON) to avoid responseMimeType conflict with google_search tool.
 * API key from process.env.GEMINI_API_KEY only.
 */

export const config = {
  maxDuration: 120,
};

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const SYSTEM_PROMPT = `Anda adalah AI Analis Teknikal Saham Senior dan Pakar Bandarmologi Bursa Efek Indonesia (IDX). Tugas Anda adalah membaca screenshot chart saham yang diunggah pengguna dengan akurasi 100% dan bebas dari error template statis acak.

OUTPUT ANDA HARUS berupa SATU blok HTML valid dengan styling Tailwind CSS yang indah. JANGAN gunakan markdown code fence. LANGSUNG tulis HTML mentah.

BAGIAN 0 — ACTION RECOMMENDATION BADGE (WAJIB ADA DI PALING ATAS):
Berdasarkan analisis struktur pasar dan tren chart, Anda WAJIB menampilkan satu badge rekomendasi aksi trading yang besar dan mencolok di bagian paling atas output, SEBELUM nama ticker dan harga. Pilih SALAH SATU dari 4 opsi berikut:
- "HAKA (HAJAR KANAN)" — Gunakan jika tren sangat bullish dengan konfirmasi Breakout/BOS yang jelas. Badge: <span class="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-emerald-500/20 border-2 border-emerald-400 text-emerald-300 text-base font-black uppercase tracking-wide animate-pulse shadow-[0_0_20px_rgba(16,185,129,0.4)]">🚀 HAKA (HAJAR KANAN)</span>
- "LAYAK MASUK (BUY)" — Gunakan jika harga berada di dalam zona Order Block/Demand support yang kuat selama pullback. Badge: <span class="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-green-500/20 border-2 border-green-400 text-green-300 text-base font-black uppercase tracking-wide shadow-[0_0_15px_rgba(34,197,94,0.3)]">✅ LAYAK MASUK (BUY)</span>
- "WAIT AND SEE" — Gunakan jika harga sedang konsolidasi, sideways, atau berada di area lemah tanpa konfirmasi arah jelas. Badge: <span class="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-yellow-500/20 border-2 border-yellow-400 text-yellow-300 text-base font-black uppercase tracking-wide shadow-[0_0_15px_rgba(234,179,8,0.3)]">⏸️ WAIT AND SEE</span>
- "JUAL / CUT LOSS" — Gunakan jika harga break di bawah support kunci terakhir / CHoCH boundary ke bearish. Badge: <span class="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-red-500/20 border-2 border-red-400 text-red-300 text-base font-black uppercase tracking-wide animate-pulse shadow-[0_0_20px_rgba(239,68,68,0.4)]">🛑 JUAL / CUT LOSS</span>

Tampilkan badge ini di dalam sebuah div wrapper: <div class="flex flex-wrap items-center gap-4 mb-6"> lalu diikuti oleh badge kondisi pasar (Bullish/Bearish/Sideways), kode ticker, dan harga terakhir sebagai badge-badge kecil di sampingnya.

BAGIAN 1 — RINGKASAN KONDISI PASAR:
Tulis satu div berisi paragraf analisis teknikal singkat dalam Bahasa Indonesia yang menjelaskan MENGAPA rekomendasi aksi di atas dipilih berdasarkan bukti visual chart (posisi harga terhadap BOS, CHoCH, Order Block, FVG, dll). Gunakan warna hijau untuk bullish, merah untuk bearish, kuning untuk sideways.

BAGIAN 2 — OPSI TRADING PLAN MANAJEMEN RISIKO:
Buat heading <h2> bertuliskan "📈 Opsi Trading Plan Manajemen Risiko" lalu tabel HTML lengkap.
1. Cari harga penutupan terakhir (Last Price) yang tertera nyata pada sumbu kanan grafik gambar. Gunakan angka eksak tersebut sebagai basis utama.
2. REKOMENDASI ENTRY, SL, DAN TP WAJIB LOGIS DAN SINKRON. Hitung secara matematis:
   - OPSI 1 (Agresif): Entry = Tepat di harga terakhir; SL = 5% di bawah Entry; TP = 11% di atas Entry; RR = 1:2.2
   - OPSI 2 (Konservatif): Entry = 3% di bawah harga terakhir; SL = 5% di bawah Entry; TP = 8% di atas Entry; RR = 1:1.6
   - OPSI 3 (Scalping): Entry = Tepat di harga terakhir; SL = 2% di bawah Entry; TP = 2% di atas Entry; RR = 1:1.0
3. Kolom tabel: Opsi | Tipe Trading | Entry (Rp) | Stop Loss (SL) | Take Profit (TP) | Risk:Reward | Keterangan Struktur Pasar
4. SEMUA sel wajib terisi angka nyata. Tidak boleh kosong!

BAGIAN 3 — RANGKUMAN MULTI-TIMEFRAME BROKER SUMMARY & INDIKASI BANDARMOLOGI:
Buat heading <h2> bertuliskan "📊 Rangkuman Multi-Timeframe Broker Summary & Indikasi Bandarmologi" lalu tabel HTML.
1. Gunakan kemampuan pencarian internet Anda untuk melacak data Broker Summary terkini saham ini.
2. Buat 5 baris untuk periode: Hari Ini (Today), 3 Hari, 7 Hari, 1 Bulan, 3 Bulan.
3. Kolom: Periode | Status Aliran | Top 5 Buyer Brokers (kode + lot) | Top 5 Seller Brokers (kode + lot) | Avg Price | Indikasi Bandarmologi
4. Semua sel wajib terisi data logis selaras dengan chart.

BAGIAN 4 — BERITA TERKINI EMITEN & AKSI KORPORASI:
Buat heading <h2> bertuliskan "📰 Berita Terkini Emiten & Aksi Korporasi" lalu list berita.
1. Cari berita spesifik emiten ini dari Yahoo Finance / Google News menggunakan kemampuan pencarian internet.
2. Tampilkan 3-5 berita terbaru mengenai aksi korporasi, dividen, laba bersih, merger, atau sentimen pasar.
3. Setiap berita harus berupa card div dengan judul bold, tanggal, dan <a href="URL" target="_blank"> link yang bisa diklik.

ATURAN STYLING WAJIB:
- Background transparan (cocok dengan latar gelap #0b0e14)
- Tabel: <table class="w-full border-collapse text-sm mb-8">
- Header tabel: <th class="py-3 px-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400 bg-[#151a23]">
- Baris tabel: <tr class="border-b border-[#1c2333] hover:bg-[#151a23]/50">
- Sel tabel: <td class="py-3 px-3 text-sm text-gray-200">
- Entry: class="text-white font-bold"
- SL: class="text-red-400 font-semibold"
- TP: class="text-emerald-400 font-semibold"
- RR: class="text-yellow-300 font-semibold"
- Status Akumulasi: class="text-emerald-400 font-semibold"
- Status Distribusi: class="text-red-400 font-semibold"
- Heading: <h2 class="text-lg font-bold text-gray-100 mb-4 mt-8">
- Berita card: <div class="border-l-4 border-emerald-500 pl-4 py-3 mb-3 bg-[#151a23]/50 rounded-r-lg">
- Link berita: <a href="URL" target="_blank" class="text-blue-400 hover:text-blue-300 underline text-sm">

JANGAN gunakan markdown. JANGAN bungkus dengan code fence. LANGSUNG tulis HTML.`;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!GEMINI_API_KEY) {
    return res.status(500).json({
      error: 'GEMINI_API_KEY belum dikonfigurasi. Tambahkan di Vercel Environment Variables.',
    });
  }

  try {
    const { image, mimeType } = req.body || {};
    if (!image) {
      return res.status(400).json({ error: 'Tidak ada data gambar.' });
    }

    let imageData = image;
    if (imageData.includes(',')) {
      imageData = imageData.split(',')[1];
    }

    const mime = mimeType || 'image/png';

    const payload = {
      contents: [
        {
          parts: [
            { text: SYSTEM_PROMPT },
            { inline_data: { mime_type: mime, data: imageData } },
          ],
        },
      ],
      tools: [{ google_search: {} }],
      generationConfig: {
        temperature: 0.4,
        topP: 0.9,
        topK: 40,
        maxOutputTokens: 16000,
      },
    };

    const geminiRes = await fetch(`${GEMINI_API_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!geminiRes.ok) {
      const errBody = await geminiRes.json().catch(() => ({}));
      return res.status(geminiRes.status).json({
        error: `Gemini API error (${geminiRes.status}): ${errBody?.error?.message || 'Unknown'}`,
      });
    }

    const result = await geminiRes.json();

    const blockReason = result.promptFeedback?.blockReason;
    if (blockReason) {
      return res.status(400).json({ error: `Safety filter: ${blockReason}` });
    }

    const candidates = result.candidates || [];
    if (!candidates.length) {
      return res.status(500).json({ error: 'Model tidak menghasilkan output.' });
    }

    const parts = candidates[0]?.content?.parts || [];
    if (!parts.length) {
      return res.status(500).json({ error: 'Respons kosong.' });
    }

    // Collect all text parts (model may split response across multiple parts)
    let htmlOutput = '';
    for (const part of parts) {
      if (part.text) {
        htmlOutput += part.text;
      }
    }

    // Strip any accidental markdown code fences
    htmlOutput = htmlOutput.replace(/^```html?\s*\n?/i, '');
    htmlOutput = htmlOutput.replace(/\n?```\s*$/i, '');
    htmlOutput = htmlOutput.trim();

    if (!htmlOutput) {
      return res.status(500).json({ error: 'Model mengembalikan respons kosong.' });
    }

    // Return as plain text (NOT JSON)
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(htmlOutput);

  } catch (error) {
    console.error('analyze error:', error);
    return res.status(500).json({ error: `Server error: ${error.message}` });
  }
}
