/**
 * Auto-Cuan AI Analysis - Vercel Serverless Function
 * Uses Gemini 2.5 Flash for chart/ticker analysis
 * Returns raw HTML string with Content-Type: text/html
 */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

const IMAGE_PROMPT = `Anda adalah AI Analis Teknikal Saham Profesional khusus Smart Money Concepts (SMC).

Analisis screenshot chart ini secara mendalam dan akurat berdasarkan visual gambar.

ATURAN:
1. Baca harga terakhir dari sumbu kanan (axis Y) gambar.
2. Jika indikator LuxAlgo/SMC terlihat (BOS, CHoCH, Order Block, Supply/Demand, Weak Low, Strong High), analisis labelnya.
3. Jika LuxAlgo TIDAK terlihat, jangan klaim "LuxAlgo mendeteksi". Gunakan bahasa "Simulasi SMC Auto-Cuan".
4. JANGAN mengarang harga di luar skala yang terlihat di chart.
5. Jika saham penny stock (harga < Rp 100), semua kalkulasi harus dalam satuan puluhan rupiah. Jangan output ribuan untuk saham di bawah Rp 100.

FORMAT OUTPUT (HTML valid, styling Tailwind, warna terang untuk dark bg):

1. Price Target Prediction card
2. Action Badge (pilih salah satu):
   - HAKA (hijau)
   - LAYAK MASUK (biru)
   - WAIT AND SEE (kuning)
   - JUAL / CUT LOSS (merah)
3. Market Summary singkat (Bullish/Bearish/Sideways + penjelasan)
4. Trading Plan table (3 opsi):
   - Opsi 1 Agresif: Entry = last price, SL = 5% bawah, TP = 11% atas
   - Opsi 2 Konservatif: Entry = 3% bawah last price, SL = 5% bawah entry, TP = 8% atas entry
   - Opsi 3 Scalping: Entry = last price, SL = 2% bawah, TP = 2% atas
5. Auto-Cuan SMC Overlay simulation

Tabel harus di dalam:
<div class="w-full overflow-x-auto rounded-xl border border-gray-800 bg-[#131722]">
<table class="min-w-[720px] w-full text-xs">

Gunakan Rp dan format angka Indonesia. Semua harga harus konsisten dengan skala chart.`;

const TICKER_PROMPT = `Anda adalah AI Analis Teknikal Saham Profesional khusus Smart Money Concepts (SMC).

Analisis saham dengan kode ticker yang diberikan. Buat analisis teknikal lengkap.

ATURAN:
1. JANGAN klaim "LuxAlgo mendeteksi" karena tidak ada screenshot.
2. Gunakan bahasa "Simulasi SMC Auto-Cuan" untuk overlay.
3. Jika saham penny stock (harga < Rp 100), semua kalkulasi harus dalam satuan puluhan rupiah.
4. Gunakan Math.round style pembulatan.

FORMAT OUTPUT (HTML valid, styling Tailwind, warna terang untuk dark bg):

1. Price Target Prediction card
2. Action Badge (pilih salah satu):
   - HAKA (hijau)
   - LAYAK MASUK (biru)
   - WAIT AND SEE (kuning)
   - JUAL / CUT LOSS (merah)
3. Market Summary (Bullish/Bearish/Sideways + penjelasan teknikal)
4. Trading Plan table (3 opsi):
   - Opsi 1 Agresif: Entry = estimated last price, SL = 5% bawah, TP = 11% atas
   - Opsi 2 Konservatif: Entry = 3% bawah last price, SL = 5% bawah entry, TP = 8% atas entry
   - Opsi 3 Scalping: Entry = last price, SL = 2% bawah, TP = 2% atas
5. Simulasi SMC Auto-Cuan Overlay

Tabel harus di dalam:
<div class="w-full overflow-x-auto rounded-xl border border-gray-800 bg-[#131722]">
<table class="min-w-[720px] w-full text-xs">

Gunakan Rp dan format angka Indonesia.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Content-Type', 'text/html');
    return res.status(405).send('<p class="text-red-400">Method not allowed</p>');
  }

  if (!GEMINI_API_KEY) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(500).send('<p class="text-red-400">API key not configured</p>');
  }

  try {
    const { image, mimeType, ticker } = req.body;

    let parts = [];

    if (image) {
      // Image upload mode
      let imageData = image;
      if (imageData.includes(',')) {
        imageData = imageData.split(',')[1];
      }
      parts = [
        { text: IMAGE_PROMPT },
        { inline_data: { mime_type: mimeType || 'image/png', data: imageData } }
      ];
    } else if (ticker) {
      // Ticker text mode
      parts = [
        { text: `${TICKER_PROMPT}\n\nAnalisis saham: ${ticker.toUpperCase()}` }
      ];
    } else {
      res.setHeader('Content-Type', 'text/html');
      return res.status(400).send('<p class="text-red-400">No image or ticker provided</p>');
    }

    const payload = {
      contents: [{ parts }],
      generationConfig: {
        temperature: 0.25,
        maxOutputTokens: 2048
      }
    };

    const response = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (response.status === 429) {
      res.setHeader('Content-Type', 'text/html');
      return res.status(429).send(`
        <div class="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-5 text-center">
          <p class="text-yellow-400 font-semibold text-sm">⚠️ Kuota AI sedang habis</p>
          <p class="text-xs text-gray-400 mt-2">Limit request Gemini tercapai. Coba lagi dalam beberapa menit.</p>
          <p class="text-xs text-gray-500 mt-1">Chart TradingView tetap bisa digunakan untuk analisis manual.</p>
        </div>
      `);
    }

    if (!response.ok) {
      const errText = await response.text();
      res.setHeader('Content-Type', 'text/html');
      return res.status(response.status).send(`<p class="text-red-400">Gemini API error: ${response.status}</p>`);
    }

    const result = await response.json();
    const candidates = result.candidates || [];
    let html = '';

    if (candidates.length > 0) {
      const content = candidates[0].content || {};
      const respParts = content.parts || [];
      if (respParts.length > 0) {
        html = respParts[0].text || '';
      }
    }

    // Clean markdown code fences if present
    html = html.replace(/^```html\s*/i, '').replace(/```\s*$/i, '').trim();

    if (!html) {
      res.setHeader('Content-Type', 'text/html');
      return res.status(500).send('<p class="text-red-400">No analysis generated</p>');
    }

    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send(html);

  } catch (error) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(500).send(`<p class="text-red-400">Server error: ${error.message}</p>`);
  }
}
