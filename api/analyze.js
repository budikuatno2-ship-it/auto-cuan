/**
 * Auto-Cuan: Vercel Serverless Function — Chart Analysis
 * Securely proxies chart image to Google Gemini 2.5 Flash API.
 * API key is read ONLY from process.env.GEMINI_API_KEY (never exposed to client).
 * No client-side Gemini calls — all traffic is server-to-server.
 */

export const config = {
  maxDuration: 120,
};

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Strict Indonesian SMC prompt — forces the model to fill every table cell
const SYSTEM_PROMPT = `Anda adalah AI Analis Teknikal Saham Profesional. Tugas Anda adalah membaca gambar chart saham yang diunggah pengguna dengan sangat teliti.

1. Cari harga penutupan terakhir (Last Price) yang tertera di sumbu kanan chart (misalnya jika harga berada di kisaran 63 atau Rp 63).

2. Analisis zona indikator Smart Money Concepts / LuxAlgo yang terlihat di gambar (seperti area Support/Demand, Resistance/Supply, garis BOS, dan CHoCH).

3. Tentukan area Entry Terdekat yang valid sesuai dengan zona indikator tersebut. Jangan mengarang angka template statis.

4. Hitung dan tampilkan 3 Opsi Trading Plan (Agresif, Konservatif, Scalping) secara lengkap dan otomatis ke dalam kolom HTML tabel (Entry, Stop Loss, Take Profit, dan Rasio Risk:Reward). Seluruh kolom dalam tabel tidak boleh ada yang kosong.

ATURAN WAJIB OUTPUT:
- Format output HARUS berupa HTML valid dengan Tailwind CSS styling, TANPA markdown code fence.
- Di bagian atas, tulis rangkuman kondisi pasar (Bullish/Bearish/Sideways) dengan penjelasan teknikal dalam Bahasa Indonesia.
- Buat tabel HTML menggunakan tag <table> dengan class Tailwind CSS berikut:
  <table class="w-full border-collapse text-sm mt-4">
    <thead> dengan background bg-dark-700 dan text warna putih
    <tbody> dengan border-b border-dark-600
- Kolom tabel WAJIB: Opsi | Tipe | Entry (Rp) | Stop Loss (Rp) | Take Profit (Rp) | Risk:Reward
- Baris 1: OPSI 1 — AGRESIF (entry breakout terdekat)
- Baris 2: OPSI 2 — KONSERVATIF (entry pullback ke Order Block terkuat)
- Baris 3: OPSI 3 — FAST SCALPING (Risk:Reward wajib tepat 1:1.0)
- SEMUA sel harus terisi angka harga nyata dari chart. Tidak boleh kosong, N/A, atau placeholder.
- Gunakan warna teks: putih untuk teks umum, hijau (#10b981) untuk bullish/profit, merah (#ef4444) untuk bearish/loss.
- Background harus transparan agar cocok dengan latar gelap (#0b0e14).
- JANGAN gunakan markdown code fences (\`\`\`). Langsung tulis HTML mentah.`;

export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Validate API key is configured
  if (!GEMINI_API_KEY) {
    return res.status(500).json({
      error: 'GEMINI_API_KEY is not configured on the server. Please set it in Vercel Environment Variables.',
    });
  }

  try {
    const { image, mimeType } = req.body || {};

    if (!image) {
      return res.status(400).json({ error: 'No image data provided.' });
    }

    // Strip data URI prefix if present (e.g. "data:image/png;base64,...")
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
        maxOutputTokens: 8192,
      },
    };

    // Call Gemini API — key stays 100% server-side, no CORS issues
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

    // Extract generated HTML text from response
    const candidates = result.candidates || [];
    if (candidates.length > 0) {
      const parts = candidates[0]?.content?.parts || [];
      if (parts.length > 0) {
        let html = parts[0].text || '';

        // Strip any accidental markdown code fences the model might include
        html = html.replace(/^```html?\s*\n?/i, '');
        html = html.replace(/\n?```\s*$/i, '');
        html = html.trim();

        if (html.length === 0) {
          return res.status(500).json({ error: 'Model returned empty response.' });
        }

        return res.status(200).json({ html });
      }
    }

    // Check for blocked/filtered content
    const blockReason = result.promptFeedback?.blockReason;
    if (blockReason) {
      return res.status(400).json({
        error: `Content blocked by safety filter: ${blockReason}. Please try a different chart image.`,
      });
    }

    return res.status(500).json({ error: 'No analysis generated by the model. Please try again.' });
  } catch (error) {
    console.error('analyze error:', error);
    return res.status(500).json({ error: `Server error: ${error.message}` });
  }
}
