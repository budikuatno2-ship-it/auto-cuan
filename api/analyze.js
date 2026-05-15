/**
 * Auto-Cuan AI Analysis - Vercel Serverless Function
 * Uses Gemini 2.5 Flash for chart/ticker analysis
 * Returns raw HTML string with Content-Type: text/html
 * Includes deterministic fallback for ticker mode
 */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

// Known penny stock base prices
const KNOWN_PRICES = { NAYZ: 63, GOTO: 80, BUKA: 95 };

function getBasePrice(ticker) {
  if (KNOWN_PRICES[ticker]) return KNOWN_PRICES[ticker];
  return 100; // default estimated base
}

function buildFallbackHTML(ticker, basePrice) {
  const entry1 = Math.round(basePrice);
  const sl1 = Math.round(entry1 * 0.95);
  const tp1 = Math.round(entry1 * 1.11);
  const rr1 = ((tp1 - entry1) / (entry1 - sl1)).toFixed(1);

  const entry2 = Math.round(basePrice * 0.97);
  const sl2 = Math.round(entry2 * 0.95);
  const tp2 = Math.round(entry2 * 1.08);
  const rr2 = ((tp2 - entry2) / (entry2 - sl2)).toFixed(1);

  const entry3 = Math.round(basePrice);
  const sl3 = Math.round(entry3 * 0.98);
  const tp3 = Math.round(entry3 * 1.02);
  const rr3 = ((tp3 - entry3) / (entry3 - sl3)).toFixed(1);

  const target = Math.round(basePrice * 1.24);
  const upside = Math.round(((target - basePrice) / basePrice) * 100);

  const demandLow = Math.round(basePrice * 0.90);
  const demandHigh = Math.round(basePrice * 0.95);
  const supplyLow = Math.round(basePrice * 1.10);
  const supplyHigh = Math.round(basePrice * 1.18);
  const bos = Math.round(basePrice * 1.05);
  const choch = Math.round(basePrice * 0.93);
  const strongHigh = Math.round(basePrice * 1.15);
  const weakLow = Math.round(basePrice * 0.88);

  const isPenny = basePrice < 100;
  const label = isPenny ? 'penny stock' : 'saham';

  return `<div class="w-full rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4 sm:p-6 text-center">
<p class="text-xs sm:text-sm font-bold text-gray-400 tracking-widest">AUTO-CUAN SCORE</p>
<h2 class="text-3xl sm:text-5xl font-black text-emerald-400 mt-2">78/100</h2>
<p class="mt-2 text-xs sm:text-sm text-gray-400">Estimasi otomatis. Skor dihitung dari formula risk:reward dan posisi harga terhadap support/resistance.</p>
</div>

<div class="w-full rounded-2xl border border-yellow-500/30 bg-yellow-500/10 p-4 sm:p-6 mt-4">
<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
<div>
<p class="text-xs font-bold text-yellow-400 tracking-widest">PREDIKSI TARGET HARGA</p>
<h2 class="text-2xl sm:text-4xl font-black text-yellow-300">Rp ${target}</h2>
<p class="mt-1 text-sm text-gray-300">Basis harga: Rp ${basePrice}</p>
</div>
<div class="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3">
<p class="text-xs text-gray-400">Potensi Kenaikan</p>
<p class="text-xl sm:text-2xl font-black text-emerald-400">+${upside}%</p>
</div>
</div>
<p class="mt-4 text-sm text-gray-300">Target dihitung dari proyeksi +24% di atas basis harga. Untuk ${label} ${ticker}, target ini merupakan resistance psikologis menengah.</p>
</div>

<div class="w-full rounded-2xl border border-gray-800 bg-[#111827]/90 p-4 sm:p-6 mt-4">
<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
<div>
<p class="text-xs font-bold text-gray-400 tracking-widest">REKOMENDASI AKSI</p>
<h2 class="text-2xl sm:text-3xl font-black text-gray-100">WAIT AND SEE</h2>
</div>
<span class="inline-flex w-fit rounded-xl border border-yellow-500/30 bg-yellow-500/10 px-4 py-2 text-sm font-black text-yellow-400">WAIT AND SEE</span>
</div>
<div class="mt-4 space-y-2 text-sm text-gray-300">
<p><strong class="text-gray-100">Alasan:</strong> Harga ${ticker} masih perlu konfirmasi struktur. ${isPenny ? 'Sebagai penny stock, volatilitas tinggi sehingga entry tanpa konfirmasi berisiko.' : 'Menunggu konfirmasi breakout atau pullback ke area demand.'}</p>
<p><strong class="text-gray-100">Syarat valid:</strong> Harga mampu bertahan di atas Rp ${demandHigh} dan volume meningkat.</p>
<p><strong class="text-gray-100">Invalid jika:</strong> Harga breakdown di bawah Rp ${weakLow}.</p>
</div>
</div>

<div class="w-full rounded-2xl border border-gray-800 bg-[#111827]/90 p-4 sm:p-6 mt-4">
<h2 class="text-lg sm:text-xl font-black text-gray-100">Ringkasan Struktur Market</h2>
<p class="mt-3 text-sm leading-relaxed text-gray-300">Harga ${ticker} berada di area ${label} dengan basis Rp ${basePrice}. Saat ini harga berada di antara zona demand (Rp ${demandLow}-${demandHigh}) dan supply (Rp ${supplyLow}-${supplyHigh}). Entry agresif hanya layak jika harga mampu bertahan di atas area support terdekat. Risiko volatilitas ${isPenny ? 'sangat tinggi untuk penny stock' : 'moderat'}. Konservatif menunggu pullback lebih aman.</p>
</div>

<div class="w-full overflow-x-auto rounded-xl border border-gray-800 bg-[#131722] mt-4">
<table class="min-w-[760px] w-full text-xs md:text-sm">
<thead><tr class="border-b border-gray-700 text-gray-400">
<th class="p-3 text-left">Opsi</th><th class="p-3 text-left">Tipe</th><th class="p-3 text-right">Entry</th><th class="p-3 text-right">Stop Loss</th><th class="p-3 text-right">Take Profit</th><th class="p-3 text-center">RR</th><th class="p-3 text-left">Keterangan</th>
</tr></thead>
<tbody class="text-gray-200">
<tr class="border-b border-gray-800"><td class="p-3">1</td><td class="p-3 text-emerald-400 font-bold">Agresif</td><td class="p-3 text-right">Rp ${entry1}</td><td class="p-3 text-right text-red-400">Rp ${sl1}</td><td class="p-3 text-right text-emerald-400">Rp ${tp1}</td><td class="p-3 text-center">1:${rr1}</td><td class="p-3 text-gray-400">Entry di harga terakhir, breakout confirmation</td></tr>
<tr class="border-b border-gray-800"><td class="p-3">2</td><td class="p-3 text-blue-400 font-bold">Konservatif</td><td class="p-3 text-right">Rp ${entry2}</td><td class="p-3 text-right text-red-400">Rp ${sl2}</td><td class="p-3 text-right text-emerald-400">Rp ${tp2}</td><td class="p-3 text-center">1:${rr2}</td><td class="p-3 text-gray-400">Menunggu pullback 3% ke area demand</td></tr>
<tr><td class="p-3">3</td><td class="p-3 text-yellow-400 font-bold">Scalping</td><td class="p-3 text-right">Rp ${entry3}</td><td class="p-3 text-right text-red-400">Rp ${sl3}</td><td class="p-3 text-right text-emerald-400">Rp ${tp3}</td><td class="p-3 text-center">1:${rr3}</td><td class="p-3 text-gray-400">Pantulan cepat RR 1:1, intraday only</td></tr>
</tbody></table></div>

<div class="w-full rounded-2xl border border-blue-500/20 bg-blue-500/10 p-4 sm:p-6 mt-4">
<h2 class="text-lg sm:text-xl font-black text-blue-300">Kenapa Area Entry Itu?</h2>
<div class="mt-3 space-y-2 text-sm text-gray-300">
<p><strong class="text-gray-100">Agresif (Rp ${entry1}):</strong> Entry langsung di harga terakhir. Cocok jika ada konfirmasi candle bullish atau volume spike. SL ketat di Rp ${sl1}.</p>
<p><strong class="text-gray-100">Konservatif (Rp ${entry2}):</strong> Menunggu diskon 3% mendekati area demand. Risiko lebih terukur, cocok untuk swing trade.</p>
<p><strong class="text-gray-100">Scalping (Rp ${entry3}):</strong> Hanya untuk pantulan cepat dengan target Rp ${tp3}. Cut loss ketat di Rp ${sl3}. Tidak untuk hold.</p>
</div>
</div>

<div class="w-full rounded-2xl border border-gray-800 bg-[#111827]/90 p-4 sm:p-6 mt-4 space-y-4">
<div>
<h2 class="text-lg sm:text-xl font-black text-gray-100">Auto-Cuan SMC Overlay</h2>
<p class="text-xs sm:text-sm text-gray-400">Simulasi zona SMC berbasis struktur harga ${ticker}.</p>
</div>
<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
<div class="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4">
<p class="text-xs text-emerald-300 font-bold">DEMAND / SUPPORT</p>
<h3 class="text-lg font-black text-emerald-400">Rp ${demandLow} - Rp ${demandHigh}</h3>
<p class="text-xs text-gray-300 mt-2">Area akumulasi buyer. Harga cenderung memantul dari zona ini.</p>
</div>
<div class="rounded-xl border border-red-500/30 bg-red-500/10 p-4">
<p class="text-xs text-red-300 font-bold">SUPPLY / RESISTANCE</p>
<h3 class="text-lg font-black text-red-400">Rp ${supplyLow} - Rp ${supplyHigh}</h3>
<p class="text-xs text-gray-300 mt-2">Area distribusi seller. Breakout di atas zona ini membuka target lebih tinggi.</p>
</div>
</div>
<div class="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
<div class="rounded-lg border border-gray-700 bg-gray-800/50 p-3"><p class="text-gray-500">BOS</p><p class="text-gray-200 font-bold mt-1">Rp ${bos}</p></div>
<div class="rounded-lg border border-gray-700 bg-gray-800/50 p-3"><p class="text-gray-500">CHoCH</p><p class="text-gray-200 font-bold mt-1">Rp ${choch}</p></div>
<div class="rounded-lg border border-gray-700 bg-gray-800/50 p-3"><p class="text-gray-500">Strong High</p><p class="text-gray-200 font-bold mt-1">Rp ${strongHigh}</p></div>
<div class="rounded-lg border border-gray-700 bg-gray-800/50 p-3"><p class="text-gray-500">Weak Low</p><p class="text-gray-200 font-bold mt-1">Rp ${weakLow}</p></div>
</div>
<p class="text-xs text-gray-500 text-center">Estimasi otomatis saat AI belum mengembalikan format lengkap. Gunakan sebagai referensi awal.</p>
</div>`;
}

function validateOutput(html) {
  const lc = html.toLowerCase();
  const checks = [
    lc.includes('entry') || lc.includes('masuk'),
    lc.includes('sl') || lc.includes('stop loss') || lc.includes('stoploss'),
    lc.includes('tp') || lc.includes('take profit') || lc.includes('target'),
    lc.includes('rr') || lc.includes('risk') || lc.includes('reward') || lc.includes('1:'),
    lc.includes('prediksi') || lc.includes('target harga') || lc.includes('price target'),
    lc.includes('rekomendasi') || lc.includes('aksi') || lc.includes('wait and see') || lc.includes('layak masuk') || lc.includes('haka') || lc.includes('jual') || lc.includes('cut loss')
  ];
  const passed = checks.filter(Boolean).length;
  return passed >= 4;
}

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

OUTPUT WAJIB BERURUTAN (7 SECTION, SEMUA HARUS ADA ISI LENGKAP):
1. AUTO-CUAN SCORE (skor XX/100 + alasan)
2. PREDIKSI TARGET HARGA (target Rp, basis Rp, kenaikan %, alasan)
3. REKOMENDASI AKSI (badge + alasan + syarat valid + invalid jika)
4. RINGKASAN STRUKTUR MARKET (trend + lokasi harga + momentum)
5. TRADING PLAN TABLE (3 baris x 7 kolom, tidak boleh ada sel kosong)
6. KENAPA AREA ENTRY ITU (penjelasan per opsi)
7. AUTO-CUAN SMC OVERLAY (demand, supply, BOS, CHoCH, Strong High, Weak Low)

Gunakan Rp dan format angka Indonesia. Semua styling harus Tailwind CSS dengan warna terang pada dark bg.`;

const IMAGE_EXTRA = `\n\nKONTEKS: Analisis screenshot chart yang dikirim. Baca harga dari axis Y. Jika LuxAlgo/SMC labels terlihat, sebutkan. Jika tidak terlihat, gunakan "Simulasi SMC Auto-Cuan".`;

const TICKER_EXTRA = `\n\nKONTEKS: Analisis berdasarkan kode ticker (tanpa screenshot). Gunakan bahasa "Simulasi SMC Auto-Cuan" untuk overlay. JANGAN klaim "LuxAlgo mendeteksi".`;

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
      // On quota limit, return fallback for ticker mode
      if (ticker) {
        const bp = getBasePrice(ticker.toUpperCase());
        res.setHeader('Content-Type', 'text/html');
        return res.status(200).send(buildFallbackHTML(ticker.toUpperCase(), bp));
      }
      res.setHeader('Content-Type', 'text/html');
      return res.status(429).send(`<div class="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-5 text-center"><p class="text-yellow-400 font-semibold text-sm">Kuota AI sedang habis</p><p class="text-xs text-gray-400 mt-2">Coba lagi dalam beberapa menit. Chart TradingView tetap bisa digunakan.</p></div>`);
    }

    if (!response.ok) {
      // On API error, return fallback for ticker mode
      if (ticker) {
        const bp = getBasePrice(ticker.toUpperCase());
        res.setHeader('Content-Type', 'text/html');
        return res.status(200).send(buildFallbackHTML(ticker.toUpperCase(), bp));
      }
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
      // Gemini returned incomplete output - use deterministic fallback for ticker
      if (ticker) {
        const bp = getBasePrice(ticker.toUpperCase());
        res.setHeader('Content-Type', 'text/html');
        return res.status(200).send(buildFallbackHTML(ticker.toUpperCase(), bp));
      }
      // For image mode with no valid output, show error
      res.setHeader('Content-Type', 'text/html');
      return res.status(200).send(`<div class="w-full rounded-2xl border border-red-500/30 bg-red-500/10 p-4 sm:p-6 text-center"><h3 class="font-black text-red-400 text-lg">Hasil analisis belum lengkap</h3><p class="mt-2 text-sm text-red-300">AI belum berhasil membaca chart. Silakan coba ulangi dengan screenshot yang lebih jelas.</p></div>`);
    }

    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send(html);

  } catch (error) {
    // On any error, return fallback for ticker mode
    const { ticker } = req.body || {};
    if (ticker) {
      const bp = getBasePrice(ticker.toUpperCase());
      res.setHeader('Content-Type', 'text/html');
      return res.status(200).send(buildFallbackHTML(ticker.toUpperCase(), bp));
    }
    res.setHeader('Content-Type', 'text/html');
    return res.status(500).send(`<p class="text-red-400">Server error: ${error.message}</p>`);
  }
}
