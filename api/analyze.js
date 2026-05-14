export const config = { maxDuration: 60 };

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const PROMPT = `Anda adalah AI Analis Teknikal Saham IDX khusus Smart Money Concepts.

ATURAN HARGA:
- Baca harga terakhir dari sumbu kanan chart (jika gambar diunggah).
- Jika hanya kode ticker diberikan, estimasi harga logis dari pengetahuan Anda.
- Saham penny (misal NAYZ ~Rp63): SEMUA angka WAJIB di puluhan rupiah. Entry=63, SL=60, TP=70. JANGAN tampilkan ribuan.
- Saham blue chip (misal BBRI ~Rp4850): gunakan ribuan sesuai.
- Bulatkan semua angka ke bilangan bulat.

TUGAS:
1. Identifikasi ticker dan harga terakhir.
2. Pilih SATU badge: HAKA / LAYAK MASUK / WAIT AND SEE / JUAL CUT LOSS.
3. Hitung target harga realistis (resistance kuat jangka menengah) + persentase kenaikan.
4. Hitung 3 opsi trading plan:
   - Agresif: Entry=harga terakhir, SL=5% bawah, TP=11% atas, RR=1:2.2
   - Konservatif: Entry=3% bawah harga, SL=5% bawah Entry, TP=8% atas Entry, RR=1:1.6
   - Scalping: Entry=harga terakhir, SL=2% bawah, TP=2% atas, RR=1:1.0

OUTPUT HTML (tanpa markdown fence, langsung HTML):

<div class="bg-yellow-500/10 border border-yellow-500/30 text-yellow-400 p-4 rounded-xl font-bold flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2"><div><p class="text-[10px] uppercase tracking-wider text-yellow-400/70 font-semibold">Prediksi Target Harga</p><p class="text-xl sm:text-2xl font-black text-yellow-300">Rp [TARGET]</p></div><div class="sm:text-right"><p class="text-[10px] uppercase tracking-wider text-yellow-400/70 font-semibold">Potensi Kenaikan</p><p class="text-lg sm:text-xl font-black text-emerald-400">+[X]%</p></div></div>

<div class="flex flex-wrap items-center gap-2 mt-4">
[BADGE - pilih satu:]
HAKA: <span class="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-emerald-500/20 border-2 border-emerald-400 text-emerald-300 text-xs font-black uppercase animate-pulse">🚀 HAKA</span>
BUY: <span class="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-green-500/20 border-2 border-green-400 text-green-300 text-xs font-black uppercase">✅ LAYAK MASUK</span>
WAIT: <span class="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-yellow-500/20 border-2 border-yellow-400 text-yellow-300 text-xs font-black uppercase">⏸️ WAIT AND SEE</span>
JUAL: <span class="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-red-500/20 border-2 border-red-400 text-red-300 text-xs font-black uppercase animate-pulse">🛑 JUAL / CUT LOSS</span>
<span class="px-2 py-1 rounded-lg bg-gray-800 text-gray-200 text-xs font-bold">[TICKER]</span>
<span class="px-2 py-1 rounded-lg bg-gray-800 text-emerald-300 text-xs font-bold">Rp [HARGA]</span>
</div>

<p class="text-xs sm:text-sm text-gray-300 leading-relaxed mt-3 mb-4">[Analisis 2-3 kalimat Bahasa Indonesia]</p>

<div class="w-full overflow-x-auto block border border-gray-800 rounded-xl my-4 bg-[#131722]"><table class="min-w-[760px] w-full text-xs md:text-sm"><thead><tr class="border-b-2 border-emerald-500/20"><th class="px-3 py-3 text-left text-[10px] font-semibold uppercase text-gray-400 bg-[#131722]">Opsi</th><th class="px-3 py-3 text-left text-[10px] font-semibold uppercase text-gray-400 bg-[#131722]">Tipe</th><th class="px-3 py-3 text-left text-[10px] font-semibold uppercase text-gray-400 bg-[#131722]">Entry</th><th class="px-3 py-3 text-left text-[10px] font-semibold uppercase text-gray-400 bg-[#131722]">SL</th><th class="px-3 py-3 text-left text-[10px] font-semibold uppercase text-gray-400 bg-[#131722]">TP</th><th class="px-3 py-3 text-left text-[10px] font-semibold uppercase text-gray-400 bg-[#131722]">RR</th><th class="px-3 py-3 text-left text-[10px] font-semibold uppercase text-gray-400 bg-[#131722]">Keterangan</th></tr></thead><tbody>
<tr class="border-b border-gray-800"><td class="px-3 py-3 text-gray-300 whitespace-nowrap">1</td><td class="px-3 py-3 text-gray-300 whitespace-nowrap">Agresif</td><td class="px-3 py-3 text-white font-bold whitespace-nowrap">Rp [X]</td><td class="px-3 py-3 text-red-400 font-semibold whitespace-nowrap">Rp [X]</td><td class="px-3 py-3 text-emerald-400 font-semibold whitespace-nowrap">Rp [X]</td><td class="px-3 py-3 text-yellow-300 font-semibold whitespace-nowrap">1:2.2</td><td class="px-3 py-3 text-gray-300 whitespace-normal min-w-[220px]">[keterangan]</td></tr>
[baris 2 dan 3 sama formatnya]
</tbody></table></div>

Semua sel WAJIB terisi. JANGAN tulis markdown. LANGSUNG HTML.`;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY belum dikonfigurasi di Vercel Environment Variables.' });

  try {
    const { image, mimeType, ticker } = req.body || {};
    const parts = [{ text: PROMPT }];

    if (image) {
      let data = image;
      if (data.includes(',')) data = data.split(',')[1];
      parts.push({ inline_data: { mime_type: mimeType || 'image/png', data } });
    } else if (ticker) {
      parts.push({ text: `Analisis saham IDX kode: ${ticker.toUpperCase()}. Buat trading plan lengkap.` });
    } else {
      return res.status(400).json({ error: 'Kirim gambar chart atau kode ticker.' });
    }

    const payload = {
      contents: [{ parts }],
      generationConfig: { temperature: 0.25, maxOutputTokens: 2048 },
    };

    const r = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      if (r.status === 429) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(200).send('<div class="w-full bg-red-500/10 border border-red-500/30 text-red-300 p-4 rounded-xl"><h3 class="font-black text-red-400">Kuota AI sedang habis</h3><p class="text-sm mt-2">Batas penggunaan Gemini API sementara tercapai. Coba lagi beberapa menit atau gunakan mode Nama Saham untuk melihat chart TradingView tanpa analisis AI.</p></div>');
      }
      return res.status(r.status).json({ error: `Gemini error (${r.status}): ${e?.error?.message || 'Unknown'}` });
    }

    const result = await r.json();
    if (result.promptFeedback?.blockReason) return res.status(400).json({ error: `Safety: ${result.promptFeedback.blockReason}` });

    const candidates = result.candidates || [];
    if (!candidates.length) return res.status(500).json({ error: 'Tidak ada output.' });

    let html = '';
    for (const p of (candidates[0]?.content?.parts || [])) { if (p.text) html += p.text; }
    html = html.replace(/^```html?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    if (!html) return res.status(500).json({ error: 'Respons kosong.' });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  } catch (err) {
    console.error('analyze:', err);
    return res.status(500).json({ error: `Server: ${err.message}` });
  }
}
