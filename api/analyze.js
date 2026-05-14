export const config = { maxDuration: 60 };

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const PROMPT = `Anda adalah AI Analis Teknikal Saham IDX khusus Smart Money Concepts. Anda memberikan analisis teknikal LENGKAP baik dari gambar chart maupun dari kode ticker.

ATURAN HARGA:
- Jika gambar chart diunggah: baca harga terakhir dari sumbu kanan chart secara eksak.
- Jika hanya kode ticker diberikan (tanpa gambar): estimasi harga logis dari pengetahuan Anda tentang harga terkini saham tersebut di IDX. Ini tetap analisis LENGKAP, bukan analisis ringan.
- Saham penny (misal NAYZ ~Rp63): SEMUA angka WAJIB di puluhan rupiah. JANGAN tampilkan ribuan.
- Saham blue chip (misal BBRI ~Rp4850): gunakan ribuan sesuai.
- Bulatkan semua angka ke bilangan bulat.

ATURAN KHUSUS MENGENAI INDIKATOR:
- Jika GAMBAR diunggah dan label LuxAlgo terlihat (BOS, CHoCH, OB, Demand, Supply, Reliability): Anda BOLEH menyebut "LuxAlgo mendeteksi..." karena Anda membaca langsung dari screenshot.
- Jika hanya KODE TICKER diberikan (tanpa gambar): JANGAN klaim LuxAlgo mendeteksi apapun. Gunakan frasa "Simulasi SMC Auto-Cuan" atau "Estimasi zona SMC berdasarkan struktur harga". Ini adalah simulasi kecerdasan buatan, bukan pembacaan indikator resmi.

TUGAS:
1. Identifikasi ticker dan harga terakhir.
2. Pilih SATU badge: HAKA / LAYAK MASUK / WAIT AND SEE / JUAL CUT LOSS.
3. Hitung target harga realistis (resistance kuat jangka menengah) + persentase kenaikan.
4. Hitung 3 opsi trading plan:
   - Agresif: Entry=harga terakhir, SL=5% bawah, TP=11% atas, RR=1:2.2
   - Konservatif: Entry=3% bawah harga, SL=5% bawah Entry, TP=8% atas Entry, RR=1:1.6
   - Scalping: Entry=harga terakhir, SL=2% bawah, TP=2% atas, RR=1:1.0
5. Buat Auto-Cuan SMC Overlay: identifikasi Supply/Resistance zone, Demand/Support zone, BOS level, CHoCH level, Strong High, Weak Low, dan Reliability Score (0-100%).

OUTPUT HTML (tanpa markdown fence, langsung tulis HTML mentah):

BAGIAN 1 - PRICE TARGET:
<div class="bg-yellow-500/10 border border-yellow-500/30 text-yellow-400 p-4 rounded-xl font-bold flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2"><div><p class="text-[10px] uppercase tracking-wider text-yellow-400/70 font-semibold">Prediksi Target Harga</p><p class="text-xl sm:text-2xl font-black text-yellow-300">Rp [TARGET]</p></div><div class="sm:text-right"><p class="text-[10px] uppercase tracking-wider text-yellow-400/70 font-semibold">Potensi Kenaikan</p><p class="text-lg sm:text-xl font-black text-emerald-400">+[X]%</p></div></div>

BAGIAN 2 - ACTION BADGE:
<div class="flex flex-wrap items-center gap-2 mt-4">
[pilih satu badge:]
HAKA: <span class="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-emerald-500/20 border-2 border-emerald-400 text-emerald-300 text-xs font-black uppercase animate-pulse">🚀 HAKA</span>
BUY: <span class="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-green-500/20 border-2 border-green-400 text-green-300 text-xs font-black uppercase">✅ LAYAK MASUK</span>
WAIT: <span class="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-yellow-500/20 border-2 border-yellow-400 text-yellow-300 text-xs font-black uppercase">⏸️ WAIT AND SEE</span>
JUAL: <span class="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-red-500/20 border-2 border-red-400 text-red-300 text-xs font-black uppercase animate-pulse">🛑 JUAL / CUT LOSS</span>
<span class="px-2 py-1 rounded-lg bg-gray-800 text-gray-200 text-xs font-bold">[TICKER]</span>
<span class="px-2 py-1 rounded-lg bg-gray-800 text-emerald-300 text-xs font-bold">Rp [HARGA]</span>
</div>

BAGIAN 3 - ANALISIS:
<p class="text-xs sm:text-sm text-gray-300 leading-relaxed mt-3 mb-4">[Analisis teknikal 2-3 kalimat Bahasa Indonesia]</p>

BAGIAN 4 - TRADING PLAN TABLE:
<div class="w-full overflow-x-auto block border border-gray-800 rounded-xl my-4 bg-[#131722]"><table class="min-w-[760px] w-full text-xs md:text-sm"><thead><tr class="border-b-2 border-emerald-500/20"><th class="px-3 py-3 text-left text-[10px] font-semibold uppercase text-gray-400 bg-[#131722]">Opsi</th><th class="px-3 py-3 text-left text-[10px] font-semibold uppercase text-gray-400 bg-[#131722]">Tipe</th><th class="px-3 py-3 text-left text-[10px] font-semibold uppercase text-gray-400 bg-[#131722]">Entry</th><th class="px-3 py-3 text-left text-[10px] font-semibold uppercase text-gray-400 bg-[#131722]">SL</th><th class="px-3 py-3 text-left text-[10px] font-semibold uppercase text-gray-400 bg-[#131722]">TP</th><th class="px-3 py-3 text-left text-[10px] font-semibold uppercase text-gray-400 bg-[#131722]">RR</th><th class="px-3 py-3 text-left text-[10px] font-semibold uppercase text-gray-400 bg-[#131722]">Keterangan</th></tr></thead><tbody>
[3 baris <tr> dengan format: <tr class="border-b border-gray-800"><td class="px-3 py-3 text-gray-300 whitespace-nowrap">...</td><td class="px-3 py-3 text-gray-300 whitespace-nowrap">...</td><td class="px-3 py-3 text-white font-bold whitespace-nowrap">Rp X</td><td class="px-3 py-3 text-red-400 font-semibold whitespace-nowrap">Rp X</td><td class="px-3 py-3 text-emerald-400 font-semibold whitespace-nowrap">Rp X</td><td class="px-3 py-3 text-yellow-300 font-semibold whitespace-nowrap">1:X</td><td class="px-3 py-3 text-gray-300 whitespace-normal min-w-[220px]">keterangan</td></tr>]
</tbody></table></div>

BAGIAN 5 - AUTO-CUAN SMC OVERLAY:
<div class="w-full bg-[#111827]/80 border border-gray-800 rounded-2xl p-4 sm:p-6 shadow-xl space-y-4 mt-6">
<div><h2 class="text-lg sm:text-xl font-black text-gray-100">🧠 Auto-Cuan SMC Overlay</h2><p class="text-xs sm:text-sm text-gray-400">Simulasi zona SMC berbasis struktur harga, bukan indikator resmi LuxAlgo.</p></div>
<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
<div class="rounded-xl border border-red-500/30 bg-red-500/10 p-4"><p class="text-xs text-red-300 font-bold">SUPPLY / RESISTANCE</p><h3 class="text-lg font-black text-red-400">Rp [LOW] - Rp [HIGH]</h3><p class="text-xs text-gray-300 mt-2">Area potensi reject dan distribusi.</p></div>
<div class="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4"><p class="text-xs text-emerald-300 font-bold">DEMAND / SUPPORT</p><h3 class="text-lg font-black text-emerald-400">Rp [LOW] - Rp [HIGH]</h3><p class="text-xs text-gray-300 mt-2">Area potensi pantulan dan akumulasi.</p></div>
</div>
<div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
<div class="rounded-xl border border-emerald-500/20 bg-[#0b0e14] p-3"><p class="text-[10px] text-gray-400">BOS Level</p><p class="text-sm font-black text-emerald-400">Rp [X]</p></div>
<div class="rounded-xl border border-yellow-500/20 bg-[#0b0e14] p-3"><p class="text-[10px] text-gray-400">CHoCH Level</p><p class="text-sm font-black text-yellow-400">Rp [X]</p></div>
<div class="rounded-xl border border-red-500/20 bg-[#0b0e14] p-3"><p class="text-[10px] text-gray-400">Strong High</p><p class="text-sm font-black text-red-400">Rp [X]</p></div>
<div class="rounded-xl border border-blue-500/20 bg-[#0b0e14] p-3"><p class="text-[10px] text-gray-400">Weak Low</p><p class="text-sm font-black text-blue-400">Rp [X]</p></div>
</div>
<div class="rounded-xl border border-gray-700 bg-[#0b0e14] p-4"><div class="flex items-center justify-between gap-3"><span class="text-xs text-gray-400">Reliability Score</span><span class="text-sm font-black text-emerald-400">[XX]%</span></div><div class="mt-2 h-2 rounded-full bg-gray-800 overflow-hidden"><div class="h-full rounded-full bg-emerald-500" style="width:[XX]%"></div></div></div>
</div>

Semua sel dan angka WAJIB terisi. JANGAN tulis markdown. LANGSUNG HTML mentah.`;

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
      parts.push({ text: `Analisis LENGKAP saham IDX kode: ${ticker.toUpperCase()}. Buat analisis teknikal penuh termasuk prediksi target harga, trading plan, dan simulasi zona SMC Auto-Cuan (Supply/Demand/BOS/CHoCH/Strong High/Weak Low/Reliability Score). Ingat: ini mode ticker tanpa gambar, jadi JANGAN klaim LuxAlgo mendeteksi apapun — gunakan frasa "Simulasi SMC Auto-Cuan".` });
    } else {
      return res.status(400).json({ error: 'Kirim gambar chart atau kode ticker.' });
    }

    const payload = {
      contents: [{ parts }],
      generationConfig: { temperature: 0.25, maxOutputTokens: 3072 },
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
