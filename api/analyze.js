/**
 * Auto-Cuan: Vercel Serverless Function — Chart Analysis + Broker Summary
 * Returns structured JSON with two HTML table strings: trading_table & broker_table.
 * API key is read ONLY from process.env.GEMINI_API_KEY.
 */

export const config = {
  maxDuration: 120,
};

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const SYSTEM_PROMPT = `Anda adalah AI Analis Teknikal Saham dan Pakar Bandarmologi IDX. Tugas Anda adalah membedah gambar chart yang diunggah.

INSTRUKSI WAJIB:
1. Ambil data harga terakhir di sumbu kanan chart (misal kisaran Rp 2.400 - Rp 2.500 sesuai teks gambar). Gunakan angka NYATA yang terlihat di chart.
2. Pada key "trading_table", isi dengan HTML tabel lengkap berisi 3 Opsi Trading Plan (Agresif, Konservatif, Scalping) mencakup kolom: Opsi, Deskripsi, Entry, Stop Loss (SL), Take Profit (TP), dan Risk:Reward (RR). Jangan biarkan ada kolom kosong!
3. Pada key "broker_table", jalankan fungsi pencarian internal bandarmologi Anda untuk emiten tersebut. Buat HTML tabel berisi data multi-timeframe untuk periode: Hari Ini, 3 Hari, 7 Hari, 1 Bulan, dan 3 Bulan. Kolomnya wajib berisi: Periode, Status Aliran (Top Akumulasi / Akumulasi Kecil / Netral / Distribusi), Top Buyer, Top Seller, dan Avg Price.

FORMAT OUTPUT WAJIB:
Anda HARUS mengembalikan HANYA sebuah JSON object valid (tanpa markdown, tanpa code fence, tanpa teks tambahan di luar JSON) dengan struktur persis seperti ini:
{
  "ticker": "KODE_SAHAM",
  "condition": "Bullish/Bearish/Sideways",
  "summary": "Paragraf analisis teknikal dalam Bahasa Indonesia...",
  "trading_table": "<table>...HTML tabel trading plan lengkap dengan Tailwind CSS...</table>",
  "broker_table": "<table>...HTML tabel broker summary lengkap dengan Tailwind CSS...</table>"
}

ATURAN STYLING TABEL HTML:
- Setiap <table> gunakan class: "w-full border-collapse text-sm"
- <thead> gunakan: <tr class="border-b-2 border-emerald-500/30"><th class="py-3 px-4 text-left text-xs font-semibold uppercase tracking-wider text-gray-400 bg-[#151a23]">
- <tbody> gunakan: <tr class="border-b border-[#1c2333] hover:bg-[#151a23]/50"><td class="py-3 px-4 text-sm text-gray-200">
- Untuk angka bullish/profit gunakan class: "text-emerald-400 font-semibold"
- Untuk angka bearish/loss gunakan class: "text-red-400 font-semibold"
- Untuk status netral gunakan class: "text-yellow-400"
- SEMUA sel WAJIB terisi. Tidak boleh kosong, N/A, atau placeholder dash.

PENTING: Output Anda HARUS berupa JSON murni. Jangan tambahkan penjelasan, markdown code fence, atau teks apapun di luar JSON object.`;

export default async function handler(req, res) {
  // CORS preflight
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
      error: 'GEMINI_API_KEY belum dikonfigurasi di server. Tambahkan di Vercel Environment Variables.',
    });
  }

  try {
    const { image, mimeType } = req.body || {};

    if (!image) {
      return res.status(400).json({ error: 'Tidak ada data gambar yang dikirim.' });
    }

    // Strip data URI prefix
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
        temperature: 0.3,
        topP: 0.85,
        topK: 32,
        maxOutputTokens: 12000,
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
      console.error('Gemini API error:', geminiRes.status, errBody);
      return res.status(geminiRes.status).json({
        error: `Gemini API error (${geminiRes.status}): ${errBody?.error?.message || 'Unknown'}`,
      });
    }

    const result = await geminiRes.json();

    // Safety filter check
    const blockReason = result.promptFeedback?.blockReason;
    if (blockReason) {
      return res.status(400).json({
        error: `Konten diblokir oleh safety filter: ${blockReason}. Coba gambar chart lain.`,
      });
    }

    const candidates = result.candidates || [];
    if (candidates.length === 0) {
      return res.status(500).json({ error: 'Model tidak menghasilkan output. Coba lagi.' });
    }

    const parts = candidates[0]?.content?.parts || [];
    if (parts.length === 0) {
      return res.status(500).json({ error: 'Respons model kosong. Coba lagi.' });
    }

    let rawText = parts[0].text || '';

    // Strip markdown code fences if accidentally included
    rawText = rawText.replace(/^```json?\s*\n?/i, '');
    rawText = rawText.replace(/\n?```\s*$/i, '');
    rawText = rawText.trim();

    // Parse the JSON response
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (parseErr) {
      console.error('JSON parse error:', parseErr.message, 'Raw:', rawText.slice(0, 200));
      // If JSON parsing fails, try to extract JSON from the text
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          parsed = JSON.parse(jsonMatch[0]);
        } catch {
          return res.status(500).json({
            error: 'Model gagal mengembalikan format JSON valid. Coba lagi.',
            raw: rawText.slice(0, 500),
          });
        }
      } else {
        return res.status(500).json({
          error: 'Model gagal mengembalikan format JSON valid. Coba lagi.',
          raw: rawText.slice(0, 500),
        });
      }
    }

    // Validate required keys
    const response = {
      ticker: parsed.ticker || 'N/A',
      condition: parsed.condition || 'Tidak Teridentifikasi',
      summary: parsed.summary || '',
      trading_table: parsed.trading_table || '',
      broker_table: parsed.broker_table || '',
    };

    return res.status(200).json(response);
  } catch (error) {
    console.error('analyze error:', error);
    return res.status(500).json({ error: `Server error: ${error.message}` });
  }
}
