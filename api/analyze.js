/**
 * Auto-Cuan: Vercel Serverless Function — Chart Analysis + Broker Summary
 * Securely proxies chart image to Google Gemini 2.5 Flash API.
 * API key is read ONLY from process.env.GEMINI_API_KEY (never exposed to client).
 */

export const config = {
  maxDuration: 120,
};

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const SYSTEM_PROMPT = `Anda adalah AI Analis Teknikal Saham Profesional dan Pakar Bandarmologi Bursa Efek Indonesia (IDX). Tugas Anda adalah membaca gambar screenshot chart saham yang diunggah pengguna dengan sangat teliti.

KEWAJIBAN ANALISIS 1 (TRADING PLAN):
1. Cari harga penutupan terakhir (Last Price) yang tertera di sumbu kanan chart (misalnya jika harga berada di kisaran 63 atau Rp 63, sesuaikan nilainya dengan angka asli chart).
2. Analisis zona indikator Smart Money Concepts / LuxAlgo yang terlihat di gambar (seperti area Support/Demand, Resistance/Supply, garis BOS, dan CHoCH).
3. Tentukan area Entry Terdekat yang valid sesuai dengan zona indikator tersebut. Jangan mengarang angka template statis acak.
4. Hitung dan tampilkan 3 Opsi Trading Plan (Agresif, Konservatif, Scalping) secara lengkap dan otomatis ke dalam kolom HTML tabel (Entry, Stop Loss, Take Profit, dan Rasio Risk:Reward). Seluruh kolom dalam tabel tidak boleh ada yang kosong.

KEWAJIBAN ANALISIS 2 (AUTOMATED BROKER SUMMARY):
1. Gunakan kemampuan pencarian data internal Anda untuk melacak pergerakan aliran bandar terbaru terkait saham yang sedang dianalisis.
2. Hasilkan analisis Broker Summary multi-timeframe otomatis dan sajikan dalam bentuk tabel HTML sekunder yang indah berjudul '🕵️‍♂️ Rangkuman Multi-Timeframe Broker Summary & Bandarmologi'.
3. Tabel ini WAJIB berisi baris periode waktu: 'Hari Ini (Today)', '3 Hari', '7 Hari', '1 Bulan', dan '3 Bulan'.
4. Setiap baris periode wajib menampilkan kolom: Periode, Status Aliran (Top Akumulasi / Akumulasi Kecil / Netral / Distribusi), Kode Broker Pembeli Terbesar (Top Buyer), Kode Broker Penjual Terbesar (Top Seller), dan Estimasi Harga Rata-rata (Avg Price) Bandar. Pastikan isinya logis dan selaras dengan struktur chart.

ATURAN WAJIB FORMAT OUTPUT:
- Format output HARUS berupa HTML mentah yang valid dengan Tailwind CSS styling. DILARANG menggunakan markdown code fence (\`\`\`).
- Di bagian paling atas, tulis judul saham (jika teridentifikasi) dan rangkuman kondisi pasar (Bullish/Bearish/Sideways) dalam paragraf penjelasan teknikal Bahasa Indonesia.
- TABEL 1: Trading Plan — gunakan <table class="w-full border-collapse text-sm mt-4 mb-8">
  Kolom header: Opsi | Tipe | Entry (Rp) | Stop Loss (Rp) | Take Profit (Rp) | Risk:Reward
  Baris 1: OPSI 1 — AGRESIF (entry breakout terdekat)
  Baris 2: OPSI 2 — KONSERVATIF (entry pullback ke Order Block terkuat)
  Baris 3: OPSI 3 — FAST SCALPING (Risk:Reward wajib tepat 1:1.0)
  SEMUA sel WAJIB terisi angka harga nyata dari chart. Tidak boleh kosong, N/A, atau placeholder.
- TABEL 2: Broker Summary — gunakan <table class="w-full border-collapse text-sm mt-4">
  Kolom header: Periode | Status Aliran | Top Buyer | Top Seller | Avg Price Bandar
  5 baris: Hari Ini, 3 Hari, 7 Hari, 1 Bulan, 3 Bulan. Semua sel wajib terisi.
- Gunakan warna teks: putih (#f1f5f9) untuk teks umum, hijau (#10b981) untuk bullish/profit, merah (#ef4444) untuk bearish/loss, kuning (#fbbf24) untuk netral/caution.
- Header tabel gunakan background #151a23 dengan teks #94a3b8.
- Sel tabel gunakan border-bottom: 1px solid #1c2333 dan padding yang cukup.
- Background keseluruhan HARUS transparan agar cocok dengan latar gelap (#0b0e14).`;

export default async function handler(req, res) {
  // Handle CORS preflight
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
      error: 'GEMINI_API_KEY is not configured on the server. Please add it in Vercel Environment Variables.',
    });
  }

  try {
    const { image, mimeType } = req.body || {};

    if (!image) {
      return res.status(400).json({ error: 'No image data provided.' });
    }

    // Strip data URI prefix if present
    let imageData = image;
    if (imageData.includes(',')) {
      imageData = imageData.split(',')[1];
    }

    const mime = mimeType || 'image/png';

    // Build Gemini API payload
    const payload = {
      contents: [
        {
          parts: [
            { text: SYSTEM_PROMPT },
            {
              inline_data: {
                mime_type: mime,
                data: imageData,
              },
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.4,
        topP: 0.9,
        topK: 32,
        maxOutputTokens: 12000,
      },
    };

    // Call Gemini API — key stays 100% server-side
    const geminiRes = await fetch(`${GEMINI_API_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!geminiRes.ok) {
      const errBody = await geminiRes.json().catch(() => ({}));
      console.error('Gemini API error:', geminiRes.status, errBody);
      return res.status(geminiRes.status).json({
        error: `Gemini API error (${geminiRes.status}): ${errBody?.error?.message || 'Unknown error'}`,
        detail: errBody,
      });
    }

    const result = await geminiRes.json();

    // Check for safety blocks first
    const blockReason = result.promptFeedback?.blockReason;
    if (blockReason) {
      return res.status(400).json({
        error: `Content blocked by safety filter: ${blockReason}. Coba gunakan gambar chart yang berbeda.`,
      });
    }

    // Extract generated HTML text from response
    const candidates = result.candidates || [];
    if (candidates.length > 0) {
      const parts = candidates[0]?.content?.parts || [];
      if (parts.length > 0) {
        let html = parts[0].text || '';

        // Strip any accidental markdown code fences
        html = html.replace(/^```html?\s*\n?/i, '');
        html = html.replace(/\n?```\s*$/i, '');
        html = html.trim();

        if (html.length === 0) {
          return res.status(500).json({ error: 'Model mengembalikan respons kosong. Silakan coba lagi.' });
        }

        return res.status(200).json({ html });
      }
    }

    return res.status(500).json({ error: 'Tidak ada analisis yang dihasilkan. Silakan coba lagi.' });
  } catch (error) {
    console.error('analyze error:', error);
    return res.status(500).json({ error: `Server error: ${error.message}` });
  }
}
