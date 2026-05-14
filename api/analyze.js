/**
 * Auto-Cuan: Vercel Serverless — Chart Analysis + Broker Summary + News
 * Uses Gemini 2.5 Flash with Google Search grounding for live IDX data.
 * API key from process.env.GEMINI_API_KEY only.
 */

export const config = {
  maxDuration: 120,
};

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const SYSTEM_PROMPT = `Anda adalah AI Analis Teknikal Saham Senior dan Pakar Bandarmologi Bursa Efek Indonesia (IDX). Tugas Anda adalah membaca screenshot chart saham yang diunggah pengguna dengan akurasi 100% dan bebas dari error template statis acak.

KEWAJIBAN ANALISIS 1 (RIGID TRADING PLAN SYNC):
1. Cari harga penutupan terakhir (Last Price) yang tertera nyata pada sumbu kanan grafik gambar (misal jika di gambar harganya Rp 63 atau Rp 2.450, gunakan angka eksak tersebut sebagai basis utama).
2. REKOMENDASI ENTRY, SL, DAN TP WAJIB LOGIS DAN SINKRON. Area Entry tidak boleh jauh melompat dari harga penutupan terakhir tersebut! Hitung secara matematis:
   - OPSI 1 (Agresif): Entry = Tepat di harga terakhir; SL = 5% di bawah Entry; TP = 11% di atas Entry.
   - OPSI 2 (Konservatif): Entry = 3% di bawah harga terakhir; SL = 5% di bawah Entry; TP = 8% di atas Entry.
   - OPSI 3 (Scalping): Entry = Tepat di harga terakhir; SL = 2% di bawah Entry; TP = 2% di atas Entry.
3. Pada key "trading_table", generate baris kode HTML <tr> untuk 3 opsi tersebut dengan kolom lengkap: Opsi, Tipe Trading, Entry (Rp), Stop Loss (SL), Take Profit (TP), Risk:Reward (RR), dan Keterangan Struktur Pasar (seperti batas BOS/CHoCH/Order Block visual). Jangan biarkan ada kolom kosong!

KEWAJIBAN ANALISIS 2 (AUTOMATED TOP 5 BROKER SUMMARY):
1. Gunakan kemampuan pencarian internet langsung Anda untuk melacak data Broker Summary dan pergerakan akumulasi/distribusi ter-update terkait saham yang sedang dianalisis.
2. Pada key "broker_table", generate baris kode HTML <tr> untuk periode waktu: 'Hari Ini (Today)', '3 Hari', '7 Hari', '1 Bulan', dan '3 Bulan'.
3. Setiap baris periode wajib menampilkan kolom: Periode, Status Aliran (Top Akumulasi / Akumulasi Kecil / Netral / Distribusi), Rincian TOP 5 BUYER (Daftar 5 kode broker beli terbesar beserta total lot/volume), Rincian TOP 5 SELLER (Daftar 5 kode broker jual terbesar beserta total lot/volume), Harga Rata-rata (Avg Price) Bandar, dan INDIKASI BANDARMOLOGI (Penjelasan singkat mengenai kekuatan akumulasi bandar besar atau distribusi ritel). Pastikan isinya logis dan selaras dengan struktur chart.

KEWAJIBAN ANALISIS 3 (YAHOO FINANCE INSIDER NEWS):
1. Pada key "ticker_news", lakukan pencarian berita spesifik emiten tersebut dari Yahoo Finance / Google News.
2. Cari berita paling baru mengenai aksi korporasi nyata, rencana merger, akuisisi, laporan kinerja laba bersih, pendapatan meningkat, atau jadwal pembagian dividen. Generate dalam bentuk list HTML <div> cards dengan <a href> hyperlink langsung yang bisa diklik.

FORMAT OUTPUT WAJIB (JSON):
Kembalikan HANYA JSON object valid berikut (tanpa markdown code fence, tanpa teks di luar JSON):
{
  "ticker": "KODE_SAHAM",
  "condition": "Bullish/Bearish/Sideways",
  "last_price": "Rp XXXX",
  "summary": "Paragraf analisis teknikal singkat dalam Bahasa Indonesia...",
  "trading_table": "<tr>...</tr><tr>...</tr><tr>...</tr>",
  "broker_table": "<tr>...</tr><tr>...</tr><tr>...</tr><tr>...</tr><tr>...</tr>",
  "ticker_news": "<div class='space-y-3'>...berita cards HTML...</div>"
}

ATURAN STYLING HTML DALAM VALUE JSON:
- Untuk <tr> trading_table: <tr class='border-b border-[#1c2333] hover:bg-[#151a23]/50'><td class='py-3 px-3 text-sm text-gray-200'>...</td></tr>
- Untuk angka Entry gunakan class: "text-white font-bold"
- Untuk angka SL gunakan class: "text-red-400 font-semibold"
- Untuk angka TP gunakan class: "text-emerald-400 font-semibold"
- Untuk RR gunakan class: "text-yellow-300 font-semibold"
- Untuk <tr> broker_table: sama dengan format di atas. Status Akumulasi = hijau, Distribusi = merah, Netral = kuning.
- Untuk ticker_news: buat div cards dengan border-left emerald, judul bold, link biru bisa diklik.
- SEMUA sel WAJIB terisi. Tidak boleh kosong, N/A, atau placeholder.`;

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
        temperature: 0.3,
        topP: 0.85,
        topK: 32,
        maxOutputTokens: 16000,
        responseMimeType: 'application/json',
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

    let rawText = parts[0].text || '';
    rawText = rawText.replace(/^```json?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      const m = rawText.match(/\{[\s\S]*\}/);
      if (m) {
        try { parsed = JSON.parse(m[0]); } catch {
          return res.status(500).json({ error: 'JSON parse gagal. Coba lagi.' });
        }
      } else {
        return res.status(500).json({ error: 'Format output invalid. Coba lagi.' });
      }
    }

    return res.status(200).json({
      ticker: parsed.ticker || 'UNKNOWN',
      condition: parsed.condition || '-',
      last_price: parsed.last_price || '-',
      summary: parsed.summary || '',
      trading_table: parsed.trading_table || '',
      broker_table: parsed.broker_table || '',
      ticker_news: parsed.ticker_news || '',
    });
  } catch (error) {
    console.error('analyze error:', error);
    return res.status(500).json({ error: `Server error: ${error.message}` });
  }
}
