/**
 * Auto-Cuan: Vercel Serverless Function — Chart Analysis
 * Returns structured JSON with trading plan table rows.
 * API key is read ONLY from process.env.GEMINI_API_KEY.
 */

export const config = {
  maxDuration: 120,
};

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const SYSTEM_PROMPT = `Anda adalah AI Analis Teknikal Saham Profesional khusus Smart Money Concepts (SMC). Tugas Anda adalah membaca gambar screenshot chart saham yang diunggah pengguna dengan sangat teliti.

INSTRUKSI WAJIB:
1. Identifikasi kode ticker/emiten saham yang terlihat di chart (misal: BBRI, BBCA, NAYZ, ANTM, dll). Jika tidak terlihat jelas, tulis "UNKNOWN".
2. Ambil data harga terakhir (Last Price) dari sumbu kanan chart. Gunakan angka NYATA yang terlihat di gambar, bukan angka karangan.
3. Analisis zona indikator Smart Money Concepts / LuxAlgo yang terlihat di gambar (Support/Demand, Resistance/Supply, BOS, CHoCH, FVG, Order Block).
4. Tentukan kondisi pasar saat ini: Bullish, Bearish, atau Sideways.
5. Buat analisis teknikal singkat dalam Bahasa Indonesia yang menjelaskan mengapa kondisi tersebut terjadi berdasarkan bukti visual chart.
6. Hitung 3 Opsi Trading Plan dengan 6 kolom: Opsi, Deskripsi, Entry (Rp), Stop Loss (Rp), Take Profit (Rp), Risk:Reward.
   - OPSI 1: AGRESIF — entry pada breakout terdekat
   - OPSI 2: KONSERVATIF — entry pada pullback ke Order Block/Demand terkuat
   - OPSI 3: FAST SCALPING — Risk:Reward wajib tepat 1:1.0

FORMAT OUTPUT WAJIB (JSON):
Kembalikan HANYA JSON object valid ini, tanpa markdown code fence, tanpa teks tambahan di luar JSON:
{
  "ticker": "KODE_SAHAM",
  "condition": "Bullish/Bearish/Sideways",
  "last_price": "Rp XXXX",
  "summary": "Paragraf analisis teknikal dalam Bahasa Indonesia...",
  "trading_rows": [
    {
      "opsi": "1",
      "deskripsi": "Agresif — Breakout Entry",
      "entry": "Rp XXXX",
      "stop_loss": "Rp XXXX",
      "take_profit": "Rp XXXX",
      "risk_reward": "1:2.5"
    },
    {
      "opsi": "2",
      "deskripsi": "Konservatif — Pullback ke Order Block",
      "entry": "Rp XXXX",
      "stop_loss": "Rp XXXX",
      "take_profit": "Rp XXXX",
      "risk_reward": "1:3.0"
    },
    {
      "opsi": "3",
      "deskripsi": "Fast Scalping — Quick In & Out",
      "entry": "Rp XXXX",
      "stop_loss": "Rp XXXX",
      "take_profit": "Rp XXXX",
      "risk_reward": "1:1.0"
    }
  ]
}

ATURAN KETAT:
- Semua field "entry", "stop_loss", "take_profit" WAJIB berisi angka harga nyata dari chart. TIDAK BOLEH kosong, "N/A", atau placeholder.
- Field "risk_reward" untuk OPSI 3 WAJIB bernilai "1:1.0".
- Output HARUS berupa JSON murni saja.`;

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
        maxOutputTokens: 8192,
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

    // Strip markdown code fences if present
    rawText = rawText.replace(/^```json?\s*\n?/i, '');
    rawText = rawText.replace(/\n?```\s*$/i, '');
    rawText = rawText.trim();

    // Parse JSON
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (parseErr) {
      // Fallback: extract JSON object from text
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          parsed = JSON.parse(jsonMatch[0]);
        } catch {
          return res.status(500).json({
            error: 'Model gagal mengembalikan format JSON valid. Coba lagi.',
          });
        }
      } else {
        return res.status(500).json({
          error: 'Model gagal mengembalikan format JSON valid. Coba lagi.',
        });
      }
    }

    // Build response with validated structure
    const trading_rows = Array.isArray(parsed.trading_rows) ? parsed.trading_rows : [];

    const response = {
      ticker: parsed.ticker || 'UNKNOWN',
      condition: parsed.condition || 'Tidak Teridentifikasi',
      last_price: parsed.last_price || '-',
      summary: parsed.summary || '',
      trading_rows: trading_rows.map((row, i) => ({
        opsi: row.opsi || String(i + 1),
        deskripsi: row.deskripsi || '-',
        entry: row.entry || '-',
        stop_loss: row.stop_loss || '-',
        take_profit: row.take_profit || '-',
        risk_reward: row.risk_reward || '-',
      })),
    };

    return res.status(200).json(response);
  } catch (error) {
    console.error('analyze error:', error);
    return res.status(500).json({ error: `Server error: ${error.message}` });
  }
}
