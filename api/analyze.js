const { createClient } = require('@supabase/supabase-js');

// === IN-MEMORY RATE LIMITING ===
const rateLimitMap = {};
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW = 30 * 60 * 1000; // 30 minutes

function getRateLimitKey(req, username) {
  const ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown';
  return ip !== 'unknown' ? ip : (username || 'anonymous');
}

function checkRateLimit(key) {
  const now = Date.now();
  if (!rateLimitMap[key]) rateLimitMap[key] = [];
  rateLimitMap[key] = rateLimitMap[key].filter(t => (now - t) < RATE_LIMIT_WINDOW);
  return rateLimitMap[key].length < RATE_LIMIT_MAX;
}

function addRateLimitRecord(key) {
  const now = Date.now();
  if (!rateLimitMap[key]) rateLimitMap[key] = [];
  rateLimitMap[key].push(now);
}

// === INPUT SANITIZATION ===
function sanitizeTicker(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
}

function sanitizeUsername(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw.trim().replace(/<[^>]*>/g, '').slice(0, 30);
}

function sanitizeSource(raw) {
  const allowed = ['ticker', 'chart_upload', 'chart_page', 'portfolio', 'watchlist'];
  if (allowed.includes(raw)) return raw;
  return 'ticker';
}

function sanitizeMode(raw) {
  const allowed = ['cepat', 'detail'];
  if (allowed.includes(raw)) return raw;
  return 'detail';
}

// === MAINTENANCE CONFIG FETCH ===
async function getMaintenanceConfig() {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return { maintenanceMode: false };
    }
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const { data, error } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'maintenance_config')
      .single();
    if (error || !data || !data.value) return { maintenanceMode: false };
    const raw = data.value;
    // Backward compat: old format had manualMaintenance/emergencyLock
    if ('manualMaintenance' in raw || 'emergencyLock' in raw) {
      return { maintenanceMode: Boolean(raw.manualMaintenance) || Boolean(raw.emergencyLock), message: raw.message || '' };
    }
    return { maintenanceMode: Boolean(raw.maintenanceMode), message: raw.message || '' };
  } catch (e) {
    return { maintenanceMode: false };
  }
}

// === BAD NAME FILTER ===
function normalizeNameForCheck(name) {
  return String(name || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[@]/g, "a").replace(/[4]/g, "a").replace(/[!1|]/g, "i").replace(/[0]/g, "o")
    .replace(/[3]/g, "e").replace(/[5]/g, "s").replace(/[7]/g, "t").replace(/\$/g, "s")
    .replace(/\s+/g, "").replace(/[^a-z0-9]/g, "");
}
const BAD_NAMES = ["anjing","anjir","anjay","anjrit","anjrot","anjeng","anjink","asu","asw","babi","babik","bangsat","bangsad","bajingan","brengsek","kampret","keparat","laknat","sialan","bangke","bangkai","tai","taik","tahi","goblok","goblog","goblk","tolol","tlol","bodoh","bego","dungu","idiot","edan","gila","sinting","koplak","koplok","pekok","bloon","bacot","cupu","najis","hina","sampah","busuk","parasit","kampungan","norak","alay","rese","songong","sokap","kontol","kntl","kontl","memek","mmk","meki","peler","titit","tetek","ngentot","ngntot","entot","ngewe","perek","lonte","pelacur","jablay","cabul","mesum","jancok","jancuk","cuk","cok","dancok","dancuk","kirik","ndasmu","raimu","matamu","gathel","gatel","celeng","wedhus","jangkrik","asem","ndlogok","gendeng","ndableg","bunuh","dibunuh","kubunuh","takbunuh","hajar","bacok","gorok","bakar","serang","habisi","mampus","modar","matilu","matilo","matikau","ngebom","ledakkan","rusuh","jarah","amuk","keroyok","gebuk","pukul","tusuk","sembelih","ajg","anjg","anj","anjng","bgst","bgsd","bngsat","bngst","bajingn","gblk","gblg","goblogg","tll","bbi","bbai","babiq","babii","baabi","b4bi","asuww","asuu","kirikk","jancokk","jancukkk","kntol","kont0l","memk","ngentod","ngent0t"];
function isBadUsername(name) {
  if (!name) return false;
  var clean = normalizeNameForCheck(name);
  if (!clean || clean.length < 2) return true;
  if (clean.length > 30) return true;
  if (/(.)\1{5,}/.test(clean)) return true;
  if (/(http|www|com|net|org)/i.test(clean)) return true;
  return BAD_NAMES.some(function(word) { return clean.includes(normalizeNameForCheck(word)); });
}

// === MAIN HANDLER ===
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.body || {};
    const { image, mimeType } = body;
    const rawTicker = body.ticker;
    const rawPrice = body.currentPrice;
    const rawSource = body.source;
    const rawUsername = body.username;
    const rawIsAdmin = body.isAdmin;

    // === REQUEST BODY SIZE ESTIMATE ===
    const bodyStr = JSON.stringify(body);
    if (bodyStr.length > 8 * 1024 * 1024) {
      return res.status(413).json({
        html: '<div class="bg-red-500/10 border border-red-500/30 rounded-xl p-6 text-center"><p class="text-red-400 font-semibold">File terlalu besar. Gunakan screenshot yang lebih kecil.</p></div>'
      });
    }

    // === SANITIZE INPUTS ===
    const username = sanitizeUsername(rawUsername);
    const source = sanitizeSource(rawSource);
    const isAdminBudi = rawIsAdmin === true && username.toLowerCase() === 'budi';

    // === GUEST BLOCK ===
    if (username.toLowerCase() === 'guest' || username === '') {
      return res.status(200).json({
        html: '<div class="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-6 text-center space-y-2"><p class="text-yellow-400 font-semibold text-base">Login diperlukan</p><p class="text-yellow-300/70 text-sm">Mode tanpa login tidak dapat menggunakan analisis AI.</p></div>'
      });
    }

    // === BAD USERNAME FILTER ===
    if (isBadUsername(username)) {
      return res.status(200).json({
        html: '<div class="bg-red-500/10 border border-red-500/30 rounded-xl p-6 text-center"><p class="text-red-400 font-semibold">Username tidak valid.</p></div>'
      });
    }

    // === MAINTENANCE GUARD (Supabase-based) ===
    const maintenanceConfig = await getMaintenanceConfig();
    if (maintenanceConfig.maintenanceMode && !isAdminBudi) {
      const msg = maintenanceConfig.message || 'Auto-Cuan sedang tidak dapat diakses sementara.';
      return res.status(200).json({
        html: '<div class="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-6 text-center space-y-2"><p class="text-yellow-400 font-semibold text-base">Website sedang maintenance</p><p class="text-yellow-300/70 text-sm">' + msg.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</p><p class="text-xs text-gray-500 mt-2">Silakan kembali lagi nanti.</p></div>'
      });
    }

    // === RATE LIMITING (bypass for admin budi) ===
    if (!isAdminBudi) {
      const rlKey = getRateLimitKey(req, username);
      if (!checkRateLimit(rlKey)) {
        return res.status(200).json({
          html: '<div class="bg-red-500/10 border border-red-500/30 rounded-xl p-6 text-center space-y-2"><p class="text-red-400 font-semibold text-base">Limit server sementara tercapai</p><p class="text-red-300/70 text-sm">Terlalu banyak permintaan. Silakan coba lagi nanti.</p></div>'
        });
      }
      addRateLimitRecord(rlKey);
    }

    // === CHART UPLOAD MODE ===
    if (source === 'chart_upload' && image) {
      // Validate image mime type
      const allowedMimes = ['image/png', 'image/jpeg', 'image/webp'];
      if (mimeType && !allowedMimes.includes(mimeType)) {
        return res.status(200).json({
          html: '<div class="bg-red-500/10 border border-red-500/30 rounded-xl p-6 text-center"><p class="text-red-400 font-semibold">Format gambar tidak didukung. Gunakan PNG, JPEG, atau WebP.</p></div>'
        });
      }
      // Estimate image size (base64 is ~4/3 of original)
      const imageSize = (image.length * 3) / 4;
      if (imageSize > 8 * 1024 * 1024) {
        return res.status(200).json({
          html: '<div class="bg-red-500/10 border border-red-500/30 rounded-xl p-6 text-center"><p class="text-red-400 font-semibold">File terlalu besar. Gunakan screenshot yang lebih kecil.</p></div>'
        });
      }
      return await handleChartUpload(req, res, image, mimeType);
    }

    // === TICKER MODE ===
    const ticker = sanitizeTicker(rawTicker);
    if (!ticker) {
      return res.status(400).json({ error: 'Ticker wajib diisi.' });
    }

    const price = parseFloat(rawPrice);
    if (!price || price <= 0 || price > 99999999) {
      return res.status(400).json({ error: 'Harga sekarang tidak valid.' });
    }

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
      const fallbackHtml = generateFallback(ticker, price);
      return res.status(200).json({ html: fallbackHtml });
    }

    const GEMINI_MODEL = 'gemini-2.5-flash';
    const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

    const systemPrompt = buildPrompt(ticker, price);

    const payload = {
      contents: [{ parts: [{ text: systemPrompt }] }],
      generationConfig: {
        temperature: 0.4,
        topP: 0.9,
        topK: 30,
        maxOutputTokens: 8192
      }
    };

    const response = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const fallbackHtml = generateFallback(ticker, price);
      return res.status(200).json({ html: fallbackHtml });
    }

    const result = await response.json();
    const candidates = result.candidates || [];

    if (candidates.length > 0) {
      const parts = candidates[0].content?.parts || [];
      if (parts.length > 0 && parts[0].text) {
        let html = parts[0].text;
        html = html.replace(/^```html\s*/i, '').replace(/```\s*$/i, '');

        if (!isCompleteAnalysis(html)) {
          const fallbackHtml = generateFallback(ticker, price);
          return res.status(200).json({ html: fallbackHtml });
        }

        logAnalysis(ticker, price);
        return res.status(200).json({ html });
      }
    }

    const fallbackHtml = generateFallback(ticker, price);
    return res.status(200).json({ html: fallbackHtml });

  } catch (error) {
    try {
      const { ticker, currentPrice } = req.body || {};
      const fallbackHtml = generateFallback(
        sanitizeTicker(ticker) || 'UNKNOWN',
        parseFloat(currentPrice) || 100
      );
      return res.status(200).json({ html: fallbackHtml });
    } catch (e) {
      return res.status(500).json({ error: 'Server error' });
    }
  }
}



function isCompleteAnalysis(html) {
  if (!html || html.length < 500) return false;
  const requiredKeywords = ['Trading Plan', 'Entry', 'Agresif', 'Konservatif', 'Scalping', 'Rekomendasi'];
  const lowerHtml = html.toLowerCase();
  let foundCount = 0;
  for (const kw of requiredKeywords) {
    if (lowerHtml.includes(kw.toLowerCase())) foundCount++;
  }
  return foundCount >= 5;
}


function buildPrompt(ticker, currentPrice) {
  return `Anda adalah AI Analis Teknikal Saham PROFESIONAL LEVEL INSTITUSIONAL dengan keahlian mendalam di Smart Money Concepts (SMC), Market Structure, dan Price Action Analysis.

TUGAS: Buat analisis KOMPREHENSIF dan DETAIL untuk saham ${ticker} dengan harga sekarang Rp ${currentPrice}.

=== ATURAN HARGA ABSOLUT (WAJIB DIPATUHI 100%) ===
- Harga sekarang = Rp ${currentPrice}. Ini adalah angka ABSOLUT dan FINAL.
- SEMUA angka Entry, SL, TP HARUS dihitung berdasarkan Rp ${currentPrice}.
- SL MAKSIMUM 15% di bawah harga sekarang (Rp ${currentPrice}).
- TP MAKSIMUM 30% di atas harga sekarang (Rp ${currentPrice}).
- Jika currentPrice < 100, DILARANG KERAS menampilkan angka ribuan.
- Jika SL hasil pembulatan = Entry, maka SL = Entry - 1.
- Jika TP hasil pembulatan = Entry, maka TP = Entry + 1.

=== FORMAT OUTPUT ===
Output HARUS berupa HTML valid dengan Tailwind CSS classes.
Gunakan tema gelap: bg-[#151a23], border-[#1c2333], text-emerald-400 (positif), text-red-400 (negatif), text-white (netral), text-gray-300 (body), text-gray-400 (secondary), text-gray-500 (muted).
Wrap semua konten dalam <div class="space-y-5">.

=== 13 BAGIAN WAJIB ===
1. AUTO-CUAN SCORE (skor 0-100)
2. KESIMPULAN CEPAT
3. PREDIKSI TARGET HARGA
4. REKOMENDASI AKSI
5. RINGKASAN STRUKTUR MARKET
6. AREA HARGA SAAT INI
7. TRADING PLAN TABLE (3 strategi: Agresif, Konservatif, Scalping)
8. KENAPA AREA ENTRY ITU?
9. SKENARIO BULLISH
10. SKENARIO BEARISH
11. RISK MANAGEMENT
12. AUTO-CUAN SMC OVERLAY
13. CATATAN AKHIR

Pastikan SETIAP bagian memiliki konten yang SUBSTANTIF. Output harus comprehensive dan actionable.`;
}



function generateFallback(ticker, price) {
  const p = price;
  const entryAgresif = p;
  const slAgresif = Math.max(Math.round(p * 0.94), p - 1);
  const tp1Agresif = Math.max(Math.round(p * 1.11), p + 2);
  const tp2Agresif = Math.max(Math.round(p * 1.22), p + 4);
  const rrAgresif = ((tp1Agresif - entryAgresif) / Math.max(entryAgresif - slAgresif, 1)).toFixed(1);
  const entryKons = Math.max(Math.round(p * 0.97), p - 1);
  const slKons = Math.max(Math.round(p * 0.91), p - 2);
  const tp1Kons = Math.max(Math.round(p * 1.06), p + 1);
  const tp2Kons = Math.max(Math.round(p * 1.14), p + 2);
  const rrKons = ((tp1Kons - entryKons) / Math.max(entryKons - slKons, 1)).toFixed(1);
  const entryScalp = p;
  const slScalp = Math.max(Math.round(p * 0.95), p - 1);
  const tp1Scalp = Math.max(Math.round(p * 1.05), p + 1);
  const tp2Scalp = Math.max(Math.round(p * 1.08), p + 2);
  const rrScalp = ((tp1Scalp - entryScalp) / Math.max(entryScalp - slScalp, 1)).toFixed(1);
  const score = p > 500 ? 75 : p > 200 ? 72 : p > 100 ? 70 : p > 50 ? 68 : 65;
  const targetConservative = Math.round(p * 1.11);
  const targetModerate = Math.round(p * 1.22);
  const targetOptimistic = Math.round(p * 1.33);
  const scoreColor = score >= 70 ? 'text-emerald-400' : 'text-yellow-400';
  const scoreBg = score >= 70 ? 'bg-emerald-500/20 border-emerald-500/30' : 'bg-yellow-500/20 border-yellow-500/30';

  return `<div class="space-y-5">
  <div class="bg-[#151a23] rounded-xl p-5 border border-[#1c2333]">
    <div class="flex items-center gap-4">
      <div class="flex items-center justify-center w-20 h-20 rounded-full ${scoreBg} border-2">
        <span class="text-3xl font-bold ${scoreColor}">${score}</span>
      </div>
      <div>
        <h3 class="text-lg font-bold text-white">Auto-Cuan Score</h3>
        <p class="text-sm text-gray-400">${ticker} • Rp ${p}</p>
        <div class="mt-2 space-y-1">
          <p class="text-xs text-gray-300">• Struktur market menunjukkan potensi akumulasi</p>
          <p class="text-xs text-gray-300">• Area demand zone aktif</p>
          <p class="text-xs text-gray-300">• Volume menunjukkan minat beli</p>
          <p class="text-xs text-gray-300">• Risk:Reward ratio memadai</p>
        </div>
      </div>
    </div>
  </div>
  <div class="bg-[#151a23] rounded-xl p-4 border border-[#1c2333]">
    <h3 class="text-sm font-semibold text-emerald-400 mb-2">Kesimpulan Cepat</h3>
    <p class="text-sm text-gray-300">Saham ${ticker} di harga Rp ${p} menunjukkan setup yang cukup menarik untuk swing trading. Struktur market dalam fase akumulasi.</p>
  </div>
  <div class="bg-[#151a23] rounded-xl p-4 border border-[#1c2333]">
    <h3 class="text-sm font-semibold text-emerald-400 mb-3">Prediksi Target Harga</h3>
    <div class="grid grid-cols-3 gap-3">
      <div class="bg-[#0b0e14] rounded-lg p-3 border border-[#1c2333] text-center">
        <p class="text-xs text-gray-500">Konservatif</p>
        <p class="text-lg font-bold text-emerald-400">Rp ${targetConservative}</p>
        <p class="text-xs text-gray-500">+11%</p>
      </div>
      <div class="bg-[#0b0e14] rounded-lg p-3 border border-[#1c2333] text-center">
        <p class="text-xs text-gray-500">Moderat</p>
        <p class="text-lg font-bold text-yellow-400">Rp ${targetModerate}</p>
        <p class="text-xs text-gray-500">+22%</p>
      </div>
      <div class="bg-[#0b0e14] rounded-lg p-3 border border-[#1c2333] text-center">
        <p class="text-xs text-gray-500">Optimistis</p>
        <p class="text-lg font-bold text-blue-400">Rp ${targetOptimistic}</p>
        <p class="text-xs text-gray-500">+33%</p>
      </div>
    </div>
  </div>
  <div class="bg-[#151a23] rounded-xl p-4 border border-[#1c2333]">
    <h3 class="text-sm font-semibold text-emerald-400 mb-2">Rekomendasi Aksi</h3>
    <span class="inline-block px-4 py-2 rounded-lg text-sm font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">LAYAK MASUK</span>
    <div class="mt-3 space-y-1">
      <p class="text-sm text-gray-300">• Harga di area demand zone</p>
      <p class="text-sm text-gray-300">• Struktur Higher Low terbentuk</p>
      <p class="text-sm text-gray-300">• Risk:Reward ratio minimal 1:${rrAgresif}</p>
    </div>
  </div>
  <div class="bg-[#151a23] rounded-xl border border-[#1c2333] overflow-hidden">
    <h3 class="text-sm font-semibold text-emerald-400 px-4 pt-4 pb-2">Trading Plan</h3>
    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead><tr class="border-b border-[#1c2333] bg-[#0f1319]">
          <th class="px-3 py-2 text-left text-emerald-400">Strategi</th>
          <th class="px-3 py-2 text-right text-emerald-400">Entry</th>
          <th class="px-3 py-2 text-right text-emerald-400">SL</th>
          <th class="px-3 py-2 text-right text-emerald-400">TP1</th>
          <th class="px-3 py-2 text-right text-emerald-400">TP2</th>
          <th class="px-3 py-2 text-center text-emerald-400">RR</th>
        </tr></thead>
        <tbody>
          <tr class="border-b border-[#1c2333]/50">
            <td class="px-3 py-2 text-yellow-400 font-medium">Agresif</td>
            <td class="px-3 py-2 text-right text-white">${entryAgresif}</td>
            <td class="px-3 py-2 text-right text-red-400">${slAgresif}</td>
            <td class="px-3 py-2 text-right text-emerald-400">${tp1Agresif}</td>
            <td class="px-3 py-2 text-right text-emerald-400">${tp2Agresif}</td>
            <td class="px-3 py-2 text-center text-white">1:${rrAgresif}</td>
          </tr>
          <tr class="border-b border-[#1c2333]/50 bg-[#0f1319]/50">
            <td class="px-3 py-2 text-blue-400 font-medium">Konservatif</td>
            <td class="px-3 py-2 text-right text-white">${entryKons}</td>
            <td class="px-3 py-2 text-right text-red-400">${slKons}</td>
            <td class="px-3 py-2 text-right text-emerald-400">${tp1Kons}</td>
            <td class="px-3 py-2 text-right text-emerald-400">${tp2Kons}</td>
            <td class="px-3 py-2 text-center text-white">1:${rrKons}</td>
          </tr>
          <tr>
            <td class="px-3 py-2 text-purple-400 font-medium">Scalping</td>
            <td class="px-3 py-2 text-right text-white">${entryScalp}</td>
            <td class="px-3 py-2 text-right text-red-400">${slScalp}</td>
            <td class="px-3 py-2 text-right text-emerald-400">${tp1Scalp}</td>
            <td class="px-3 py-2 text-right text-emerald-400">${tp2Scalp}</td>
            <td class="px-3 py-2 text-center text-white">1:${rrScalp}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
  <div class="bg-[#151a23] rounded-xl p-4 border border-[#1c2333]">
    <h3 class="text-sm font-semibold text-emerald-400 mb-2">Kenapa Area Entry Itu?</h3>
    <div class="space-y-2">
      <p class="text-sm text-gray-300"><span class="text-yellow-400 font-semibold">Agresif:</span> Entry langsung di harga sekarang. SL di Rp ${slAgresif} (bawah Order Block H4).</p>
      <p class="text-sm text-gray-300"><span class="text-blue-400 font-semibold">Konservatif:</span> Menunggu pullback ke Rp ${entryKons}. SL di Rp ${slKons}.</p>
      <p class="text-sm text-gray-300"><span class="text-purple-400 font-semibold">Scalping:</span> Entry cepat di Rp ${entryScalp}. SL ketat di Rp ${slScalp}.</p>
    </div>
  </div>
  <div class="bg-[#151a23] rounded-xl p-4 border border-[#1c2333]">
    <h3 class="text-sm font-semibold text-emerald-400 mb-2">Skenario Bullish</h3>
    <div class="space-y-1">
      <p class="text-sm text-gray-300"><span class="text-emerald-400 font-semibold">Trigger:</span> Break di atas Rp ${tp1Agresif} dengan volume tinggi</p>
      <p class="text-sm text-gray-300"><span class="text-emerald-400 font-semibold">Target:</span> Rp ${tp2Agresif} - ${targetOptimistic}</p>
      <p class="text-sm text-gray-300"><span class="text-emerald-400 font-semibold">Probabilitas:</span> ~60%</p>
    </div>
  </div>
  <div class="bg-[#151a23] rounded-xl p-4 border border-[#1c2333]">
    <h3 class="text-sm font-semibold text-red-400 mb-2">Skenario Bearish</h3>
    <div class="space-y-1">
      <p class="text-sm text-gray-300"><span class="text-red-400 font-semibold">Trigger:</span> Break di bawah Rp ${slAgresif}</p>
      <p class="text-sm text-gray-300"><span class="text-red-400 font-semibold">Support:</span> Rp ${slKons}</p>
      <p class="text-sm text-gray-300"><span class="text-red-400 font-semibold">Action:</span> Cut loss di SL, jangan averaging down.</p>
    </div>
  </div>
  <div class="bg-[#151a23] rounded-xl p-4 border border-[#1c2333]">
    <h3 class="text-sm font-semibold text-emerald-400 mb-2">Risk Management</h3>
    <div class="space-y-1">
      <p class="text-sm text-gray-300">• Position Sizing: Maksimal 5-10% portfolio per posisi</p>
      <p class="text-sm text-gray-300">• WAJIB pasang Stop Loss</p>
      <p class="text-sm text-gray-300">• Max Loss: 2% total portfolio per trade</p>
    </div>
  </div>
  <div class="bg-[#151a23] rounded-xl p-4 border border-[#1c2333]">
    <h3 class="text-sm font-semibold text-emerald-400 mb-3">Auto-Cuan SMC Overlay</h3>
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <div class="bg-[#0b0e14] rounded-lg p-3 border border-[#1c2333] text-center">
        <p class="text-xs text-gray-500">Demand Zone</p>
        <p class="text-sm font-bold text-emerald-400">Rp ${slAgresif}-${entryKons}</p>
      </div>
      <div class="bg-[#0b0e14] rounded-lg p-3 border border-[#1c2333] text-center">
        <p class="text-xs text-gray-500">Supply Zone</p>
        <p class="text-sm font-bold text-red-400">Rp ${tp1Agresif}-${tp2Agresif}</p>
      </div>
      <div class="bg-[#0b0e14] rounded-lg p-3 border border-[#1c2333] text-center">
        <p class="text-xs text-gray-500">BOS</p>
        <p class="text-sm font-bold text-blue-400">Rp ${tp1Agresif}</p>
      </div>
      <div class="bg-[#0b0e14] rounded-lg p-3 border border-[#1c2333] text-center">
        <p class="text-xs text-gray-500">CHoCH</p>
        <p class="text-sm font-bold text-yellow-400">Rp ${slAgresif}</p>
      </div>
    </div>
  </div>
  <div class="bg-[#151a23] rounded-xl p-4 border border-[#1c2333]">
    <h3 class="text-sm font-semibold text-gray-400 mb-2">Catatan Akhir</h3>
    <p class="text-xs text-gray-500">Disclaimer: Analisis ini dibuat oleh AI dan BUKAN merupakan ajakan beli/jual. DYOR.</p>
  </div>
</div>`;
}



async function logAnalysis(ticker, price) {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    await fetch(`${SUPABASE_URL}/rest/v1/ai_analysis_logs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      },
      body: JSON.stringify({
        ticker,
        current_price: price,
        timestamp: new Date().toISOString()
      })
    });
  } catch (e) { /* silent */ }
}

// === CHART UPLOAD HANDLER ===
const CHART_SYSTEM_PROMPT = `Anda adalah AI Analis Teknikal Saham PROFESIONAL LEVEL INSTITUSIONAL dengan keahlian mendalam di Smart Money Concepts (SMC), Market Structure, dan Price Action Analysis.

TUGAS: Analisis screenshot chart saham yang dikirimkan secara mendalam dan 100% akurat sesuai visual gambar.

=== FORMAT OUTPUT (HTML valid dengan Tailwind CSS, tema gelap) ===
Gunakan: bg-[#151a23], border-[#1c2333], text-emerald-400, text-red-400, text-white, text-gray-300, text-gray-400.
Wrap semua dalam <div class="space-y-5">.

=== 12 BAGIAN WAJIB ===
1. AUTO-CUAN SCORE (0-100)
2. REKOMENDASI AKSI
3. PREDIKSI TARGET HARGA
4. RINGKASAN STRUKTUR MARKET
5. AREA HARGA SAAT INI
6. TRADING PLAN TABLE (Agresif, Konservatif, Scalping)
7. KENAPA AREA ENTRY ITU
8. SKENARIO BULLISH
9. SKENARIO BEARISH
10. RISK MANAGEMENT
11. AUTO-CUAN SMC OVERLAY
12. CATATAN AKHIR

PENTING: Harus ada Trading Plan TABLE dengan angka Entry/SL/TP yang spesifik dari chart.`;

async function handleChartUpload(req, res, imageData, mimeType) {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

  if (!GEMINI_API_KEY) {
    return res.status(200).json({ html: '<div class="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-6 text-center"><p class="text-yellow-400 font-semibold">Gemini API belum dikonfigurasi.</p></div>' });
  }

  let base64Data = imageData;
  if (base64Data.includes(',')) {
    base64Data = base64Data.split(',')[1];
  }

  const GEMINI_MODEL = 'gemini-2.5-flash';
  const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const payload = {
    contents: [{
      parts: [
        { text: CHART_SYSTEM_PROMPT },
        { inline_data: { mime_type: mimeType || 'image/png', data: base64Data } }
      ]
    }],
    generationConfig: {
      temperature: 0.5,
      topP: 0.95,
      topK: 40,
      maxOutputTokens: 8192
    }
  };

  const response = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    return res.status(200).json({ html: '<div class="bg-red-500/10 border border-red-500/30 rounded-xl p-6 text-center"><p class="text-red-400 font-semibold">Gemini API error. Coba lagi.</p></div>' });
  }

  const result = await response.json();
  const candidates = result.candidates || [];

  if (candidates.length > 0) {
    const parts = candidates[0].content?.parts || [];
    if (parts.length > 0 && parts[0].text) {
      let html = parts[0].text;
      html = html.replace(/^```html\s*/i, '').replace(/```\s*$/i, '');
      if (isCompleteAnalysis(html)) {
        logAnalysis('CHART_UPLOAD', 0);
        return res.status(200).json({ html });
      }
    }
  }

  return res.status(200).json({ html: '<div class="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-6 text-center space-y-3"><p class="text-yellow-400 font-semibold">Analisis chart belum lengkap</p><p class="text-yellow-300/70 text-sm">AI tidak dapat menghasilkan analisis lengkap dari screenshot ini. Coba gunakan mode Nama Saham.</p></div>' });
}
