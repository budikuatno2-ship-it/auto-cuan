/**
 * Auto-Cuan AI Analysis - Vercel Serverless Function
 * Uses Gemini 2.5 Flash for chart/ticker analysis
 * Returns raw HTML string with Content-Type: text/html
 */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

const SYSTEM_PROMPT = `Anda adalah AI Analis Teknikal Saham Profesional khusus Smart Money Concepts (SMC).

ATURAN KETAT:
1. Anda WAJIB mengisi SEMUA angka, alasan, dan tabel. Jika bagian kosong, output dianggap GAGAL. Jangan hanya menampilkan judul section tanpa isi.
2. Jika saham penny stock (harga < Rp 100), semua kalkulasi harus dalam satuan puluhan rupiah. JANGAN output ribuan untuk saham di bawah Rp 100.
3. Gunakan Math.round style pembulatan.
4. Output adalah SATU raw HTML string valid dengan styling Tailwind CSS, warna terang untuk dark background (#0b0e14).
5. JANGAN gunakan markdown. JANGAN bungkus dalam code fence. Langsung HTML.

FORMULA HARGA WAJIB:
- Opsi 1 Agresif: Entry = base_price, SL = Math.round(entry * 0.95), TP = Math.round(entry * 1.11)
- Opsi 2 Konservatif: Entry = Math.round(base_price * 0.97), SL = Math.round(entry * 0.95), TP = Math.round(entry * 1.08)
- Opsi 3 Scalping: Entry = base_price, SL = Math.round(entry * 0.98), TP = Math.round(entry * 1.02)
- RR = (TP - Entry) / (Entry - SL), format: 1:X.X

Contoh jika base price = 63:
Agresif: Entry 63, SL 60, TP 70, RR 1:2.3
Konservatif: Entry 61, SL 58, TP 66, RR 1:1.7
Scalping: Entry 63, SL 62, TP 64, RR 1:1.0

OUTPUT WAJIB BERURUTAN (7 SECTION, SEMUA HARUS ADA ISI LENGKAP):

===== SECTION 1: AUTO-CUAN SCORE =====
<div class="w-full rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4 sm:p-6 text-center">
<p class="text-xs sm:text-sm font-bold text-gray-400 tracking-widest">AUTO-CUAN SCORE</p>
<h2 class="text-3xl sm:text-5xl font-black text-emerald-400 mt-2">XX/100</h2>
<p class="mt-2 text-xs sm:text-sm text-gray-400">Alasan singkat skor berdasarkan trend, momentum, RR, posisi harga.</p>
</div>

===== SECTION 2: PREDIKSI TARGET HARGA =====
Harus berisi: target harga angka, basis harga, potensi kenaikan %, dan alasan target.
<div class="w-full rounded-2xl border border-yellow-500/30 bg-yellow-500/10 p-4 sm:p-6 mt-4">
<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
<div>
<p class="text-xs font-bold text-yellow-400 tracking-widest">PREDIKSI TARGET HARGA</p>
<h2 class="text-2xl sm:text-4xl font-black text-yellow-300">Rp XX</h2>
<p class="mt-1 text-sm text-gray-300">Basis harga: Rp XX</p>
</div>
<div class="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3">
<p class="text-xs text-gray-400">Potensi Kenaikan</p>
<p class="text-xl sm:text-2xl font-black text-emerald-400">+XX%</p>
</div>
</div>
<p class="mt-4 text-sm text-gray-300">Alasan target: penjelasan kenapa target ini dipilih.</p>
</div>

===== SECTION 3: REKOMENDASI AKSI =====
Pilih SATU: HAKA / LAYAK MASUK / WAIT AND SEE / JUAL CUT LOSS
Harus berisi: badge, alasan, syarat valid, level invalid.
<div class="w-full rounded-2xl border border-gray-800 bg-[#111827]/90 p-4 sm:p-6 mt-4">
<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
<div>
<p class="text-xs font-bold text-gray-400 tracking-widest">REKOMENDASI AKSI</p>
<h2 class="text-2xl sm:text-3xl font-black text-gray-100">NAMA AKSI</h2>
</div>
<span class="inline-flex w-fit rounded-xl border border-COLOR-500/30 bg-COLOR-500/10 px-4 py-2 text-sm font-black text-COLOR-400">NAMA AKSI</span>
</div>
<div class="mt-4 space-y-2 text-sm text-gray-300">
<p><strong class="text-gray-100">Alasan:</strong> kenapa aksi ini dipilih</p>
<p><strong class="text-gray-100">Syarat valid:</strong> kondisi agar aksi valid</p>
<p><strong class="text-gray-100">Invalid jika:</strong> level harga yang membatalkan</p>
</div>
</div>

===== SECTION 4: RINGKASAN STRUKTUR MARKET =====
Harus jelaskan: trend saat ini, lokasi harga, dekat support/resistance, momentum.
<div class="w-full rounded-2xl border border-gray-800 bg-[#111827]/90 p-4 sm:p-6 mt-4">
<h2 class="text-lg sm:text-xl font-black text-gray-100">Ringkasan Struktur Market</h2>
<p class="mt-3 text-sm leading-relaxed text-gray-300">Penjelasan lengkap tentang trend, posisi harga, area terdekat, dan momentum.</p>
</div>

===== SECTION 5: TRADING PLAN TABLE =====
Tabel 3 baris (Agresif, Konservatif, Scalping) x 7 kolom (Opsi, Tipe, Entry, SL, TP, RR, Keterangan). TIDAK BOLEH ada sel kosong.
<div class="w-full overflow-x-auto rounded-xl border border-gray-800 bg-[#131722] mt-4">
<table class="min-w-[760px] w-full text-xs md:text-sm">
<thead><tr class="border-b border-gray-700 text-gray-400">
<th class="p-3 text-left">Opsi</th><th class="p-3 text-left">Tipe</th><th class="p-3 text-right">Entry</th><th class="p-3 text-right">Stop Loss</th><th class="p-3 text-right">Take Profit</th><th class="p-3 text-center">RR</th><th class="p-3 text-left">Keterangan</th>
</tr></thead>
<tbody class="text-gray-200">
<tr class="border-b border-gray-800"><td class="p-3">1</td><td class="p-3 text-emerald-400 font-bold">Agresif</td><td class="p-3 text-right">Rp XX</td><td class="p-3 text-right text-red-400">Rp XX</td><td class="p-3 text-right text-emerald-400">Rp XX</td><td class="p-3 text-center">1:X.X</td><td class="p-3 text-gray-400">keterangan</td></tr>
<tr class="border-b border-gray-800"><td class="p-3">2</td><td class="p-3 text-blue-400 font-bold">Konservatif</td><td class="p-3 text-right">Rp XX</td><td class="p-3 text-right text-red-400">Rp XX</td><td class="p-3 text-right text-emerald-400">Rp XX</td><td class="p-3 text-center">1:X.X</td><td class="p-3 text-gray-400">keterangan</td></tr>
<tr><td class="p-3">3</td><td class="p-3 text-yellow-400 font-bold">Scalping</td><td class="p-3 text-right">Rp XX</td><td class="p-3 text-right text-red-400">Rp XX</td><td class="p-3 text-right text-emerald-400">Rp XX</td><td class="p-3 text-center">1:1.0</td><td class="p-3 text-gray-400">keterangan</td></tr>
</tbody></table></div>

===== SECTION 6: KENAPA AREA ENTRY ITU =====
Harus jawab: kenapa entry di area itu, harga sekarang di area apa, apa yang ditunggu, cut loss dimana.
<div class="w-full rounded-2xl border border-blue-500/20 bg-blue-500/10 p-4 sm:p-6 mt-4">
<h2 class="text-lg sm:text-xl font-black text-blue-300">Kenapa Area Entry Itu?</h2>
<div class="mt-3 space-y-2 text-sm text-gray-300">
<p>Penjelasan entry agresif...</p>
<p>Penjelasan entry konservatif...</p>
<p>Penjelasan entry scalping...</p>
</div>
</div>

===== SECTION 7: AUTO-CUAN SMC OVERLAY =====
Harus berisi: Demand/Support zone, Supply/Resistance zone, BOS, CHoCH, Strong High, Weak Low.
<div class="w-full rounded-2xl border border-gray-800 bg-[#111827]/90 p-4 sm:p-6 mt-4 space-y-4">
<div>
<h2 class="text-lg sm:text-xl font-black text-gray-100">Auto-Cuan SMC Overlay</h2>
<p class="text-xs sm:text-sm text-gray-400">Simulasi zona SMC berbasis struktur harga.</p>
</div>
<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
<div class="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4">
<p class="text-xs text-emerald-300 font-bold">DEMAND / SUPPORT</p>
<h3 class="text-lg font-black text-emerald-400">Rp XX - Rp XX</h3>
<p class="text-xs text-gray-300 mt-2">Penjelasan zona demand</p>
</div>
<div class="rounded-xl border border-red-500/30 bg-red-500/10 p-4">
<p class="text-xs text-red-300 font-bold">SUPPLY / RESISTANCE</p>
<h3 class="text-lg font-black text-red-400">Rp XX - Rp XX</h3>
<p class="text-xs text-gray-300 mt-2">Penjelasan zona supply</p>
</div>
</div>
<div class="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
<div class="rounded-lg border border-gray-700 bg-gray-800/50 p-3"><p class="text-gray-500">BOS</p><p class="text-gray-200 font-bold mt-1">Rp XX</p></div>
<div class="rounded-lg border border-gray-700 bg-gray-800/50 p-3"><p class="text-gray-500">CHoCH</p><p class="text-gray-200 font-bold mt-1">Rp XX</p></div>
<div class="rounded-lg border border-gray-700 bg-gray-800/50 p-3"><p class="text-gray-500">Strong High</p><p class="text-gray-200 font-bold mt-1">Rp XX</p></div>
<div class="rounded-lg border border-gray-700 bg-gray-800/50 p-3"><p class="text-gray-500">Weak Low</p><p class="text-gray-200 font-bold mt-1">Rp XX</p></div>
</div>
</div>`;

const IMAGE_EXTRA = `\n\nKONTEKS: Analisis screenshot chart yang dikirim. Baca harga dari axis Y. Jika LuxAlgo/SMC labels terlihat, sebutkan. Jika tidak terlihat, gunakan "Simulasi SMC Auto-Cuan".`;

const TICKER_EXTRA = `\n\nKONTEKS: Analisis berdasarkan kode ticker (tanpa screenshot). Gunakan bahasa "Simulasi SMC Auto-Cuan" untuk overlay. JANGAN klaim "LuxAlgo mendeteksi".`;

const FALLBACK_HTML = `<div class="w-full rounded-2xl border border-red-500/30 bg-red-500/10 p-4 sm:p-6 text-center">
<h3 class="font-black text-red-400 text-lg">Hasil analisis belum lengkap</h3>
<p class="mt-2 text-sm text-red-300">AI belum berhasil membuat trading plan lengkap. Silakan coba ulangi analisis.</p>
<p class="mt-1 text-xs text-gray-500">Tip: Coba gunakan mode Detail untuk hasil lebih lengkap.</p>
</div>`;

function validateOutput(html) {
  const required = ['Entry', 'Stop Loss', 'Take Profit', 'Prediksi Target', 'Rekomendasi Aksi'];
  let found = 0;
  for (const keyword of required) {
    if (html.includes(keyword)) found++;
  }
  return found >= 3;
}

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
    const { image, mimeType, ticker, mode } = req.body;
    const isDetail = mode === 'detail';
    const maxTokens = isDetail ? 4096 : 2800;

    let parts = [];

    if (image) {
      let imageData = image;
      if (imageData.includes(',')) {
        imageData = imageData.split(',')[1];
      }
      parts = [
        { text: SYSTEM_PROMPT + IMAGE_EXTRA },
        { inline_data: { mime_type: mimeType || 'image/png', data: imageData } }
      ];
    } else if (ticker) {
      parts = [
        { text: SYSTEM_PROMPT + TICKER_EXTRA + `\n\nAnalisis saham: ${ticker.toUpperCase()}` }
      ];
    } else {
      res.setHeader('Content-Type', 'text/html');
      return res.status(400).send('<p class="text-red-400">No image or ticker provided</p>');
    }

    const payload = {
      contents: [{ parts }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: maxTokens
      }
    };

    const response = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (response.status === 429) {
      res.setHeader('Content-Type', 'text/html');
      return res.status(429).send(`<div class="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-5 text-center"><p class="text-yellow-400 font-semibold text-sm">Kuota AI sedang habis</p><p class="text-xs text-gray-400 mt-2">Coba lagi dalam beberapa menit. Chart TradingView tetap bisa digunakan.</p></div>`);
    }

    if (!response.ok) {
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

    html = html.replace(/^```html\s*/i, '').replace(/```\s*$/i, '').trim();

    if (!html || !validateOutput(html)) {
      res.setHeader('Content-Type', 'text/html');
      return res.status(200).send(FALLBACK_HTML);
    }

    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send(html);

  } catch (error) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(500).send(`<p class="text-red-400">Server error: ${error.message}</p>`);
  }
}
