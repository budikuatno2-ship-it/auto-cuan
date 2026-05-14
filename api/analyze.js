/**
 * Auto-Cuan: Vercel Serverless — Chart Analysis + Broker Summary + News
 * Uses Gemini 2.5 Flash with Google Search grounding for FREE live IDX data.
 * Returns JSON: { trading_table, broker_table, ticker_news }
 * API key from process.env.GEMINI_API_KEY only.
 */

export const config = {
  maxDuration: 120,
};

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const SYSTEM_PROMPT = `Anda adalah AI Analis Teknikal Saham Senior dan Pakar Bandarmologi Bursa Efek Indonesia (IDX). Tugas Anda adalah membaca screenshot chart saham yang diunggah pengguna.

INSTRUKSI WAJIB:
1. Temukan harga terakhir pada sumbu kanan grafik gambar (misal jika di gambar harganya Rp 63, gunakan angka eksak tersebut sebagai basis utama). Identifikasi juga kode ticker saham yang terlihat di chart.

2. REKOMENDASI TRADING PLAN RIGID SYNC: Area Entry tidak boleh melompat jauh dari harga terakhir! Hitung secara matematis:
   - Opsi 1 (Agresif): Entry = Tepat di harga terakhir; SL = 5% di bawah Entry; TP = 11% di atas Entry; RR = 1:2.2
   - Opsi 2 (Konservatif): Entry = 3% di bawah harga terakhir; SL = 5% di bawah Entry; TP = 8% di atas Entry; RR = 1:1.6
   - Opsi 3 (Scalping): Entry = Tepat di harga terakhir; SL = 2% di bawah Entry; TP = 2% di atas Entry; RR = 1:1.0
   Generate baris kode HTML <tr> ke dalam key "trading_table" dengan kolom: Opsi, Tipe Trading, Entry (Rp), Stop Loss (SL), Take Profit (TP), Risk:Reward (RR), dan Keterangan Struktur Pasar (BOS/CHoCH/Order Block). Semua sel wajib terisi angka nyata.

3. REKOMENDASI AUTOMATED TOP 5 BROKER SUMMARY: Gunakan kemampuan live internet search Anda untuk menjelajahi web dan melacak data akumulasi/distribusi transaksi harian broker terkini untuk emiten tersebut. Generate baris kode HTML <tr> ke dalam key "broker_table" untuk periode: Hari Ini, 3 Hari, 7 Hari, 1 Bulan, dan 3 Bulan. Kolomnya wajib memuat: Periode, Status Aliran (Top Akumulasi/Akumulasi Kecil/Netral/Distribusi), Rincian TOP 5 BUYER (Daftar 5 kode broker beli terbesar + volume lot), Rincian TOP 5 SELLER (Daftar 5 kode broker jual terbesar + volume lot), dan Harga Rata-rata (Avg Price) Bandar. Jika data pencarian internet terbatas, gunakan logika kecerdasan Anda untuk menghitung simulasi volume lot broker yang sangat logis dan sinkron dengan pergerakan fraksi harga asli saham tersebut (misal jika harga Rp 63, maka harga rata-rata broker wajib berada di kisaran fraksi Rp 60-an, jangan melompat ke ribuan rupiah).

4. BERITA DAN AKSI KORPORASI: Pada key "ticker_news", cari berita spesifik emiten tersebut dari Yahoo Finance atau Google News. Temukan berita merger, pendapatan meningkat, laba bersih, atau jadwal dividen, lalu sajikan dalam bentuk list card HTML dengan <a href="URL" target="_blank"> link yang bisa diklik.

JUGA SERTAKAN: Di bagian atas "trading_table", sebelum baris <tr> pertama, tambahkan satu baris komentar HTML berisi kondisi pasar dan harga terakhir, contoh: <!-- TICKER:NAYZ | CONDITION:Sideways | PRICE:Rp 63 -->

FORMAT OUTPUT WAJIB:
Kembalikan HANYA satu JSON object valid (tanpa markdown code fence, tanpa teks di luar JSON):
{
  "trading_table": "<!-- TICKER:KODE | CONDITION:X | PRICE:Rp Y --><tr>...</tr><tr>...</tr><tr>...</tr>",
  "broker_table": "<tr>...</tr><tr>...</tr><tr>...</tr><tr>...</tr><tr>...</tr>",
  "ticker_news": "<div>...berita cards...</div>"
}

ATURAN STYLING HTML DALAM VALUE JSON:
- <tr> gunakan: <tr class="border-b border-[#1c2333] hover:bg-[#151a23]/50">
- <td> gunakan: <td class="py-3 px-3 text-sm text-gray-200">
- Entry: <td class="py-3 px-3 text-sm text-white font-bold">
- SL: <td class="py-3 px-3 text-sm text-red-400 font-semibold">
- TP: <td class="py-3 px-3 text-sm text-emerald-400 font-semibold">
- RR: <td class="py-3 px-3 text-sm text-yellow-300 font-semibold">
- Status Akumulasi: <td class="py-3 px-3 text-sm text-emerald-400 font-semibold">
- Status Distribusi: <td class="py-3 px-3 text-sm text-red-400 font-semibold">
- Status Netral: <td class="py-3 px-3 text-sm text-yellow-400 font-semibold">
- Berita card: <div class="border-l-4 border-emerald-500 pl-4 py-3 mb-3 bg-[#151a23]/50 rounded-r-lg"><p class="text-sm font-semibold text-gray-200">Judul</p><p class="text-xs text-gray-500">Tanggal</p><a href="URL" target="_blank" class="text-blue-400 hover:text-blue-300 underline text-xs">Baca selengkapnya</a></div>
- SEMUA sel WAJIB terisi. Tidak boleh kosong atau N/A.`;

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

    // Collect all text parts
    let rawText = '';
    for (const part of parts) {
      if (part.text) rawText += part.text;
    }

    // Strip markdown code fences
    rawText = rawText.replace(/^```json?\s*\n?/i, '');
    rawText = rawText.replace(/\n?```\s*$/i, '');
    rawText = rawText.trim();

    // Parse JSON
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      // Fallback: extract JSON object
      const m = rawText.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          parsed = JSON.parse(m[0]);
        } catch {
          return res.status(500).json({ error: 'Format JSON invalid. Coba lagi.' });
        }
      } else {
        return res.status(500).json({ error: 'Model gagal mengembalikan JSON. Coba lagi.' });
      }
    }

    // Return structured response
    return res.status(200).json({
      trading_table: parsed.trading_table || '',
      broker_table: parsed.broker_table || '',
      ticker_news: parsed.ticker_news || '',
    });

  } catch (error) {
    console.error('analyze error:', error);
    return res.status(500).json({ error: `Server error: ${error.message}` });
  }
}
