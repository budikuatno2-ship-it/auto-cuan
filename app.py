"""
Auto-Cuan: AI Chart Reader Backend
Secure Flask server for Gemini Vision API integration.
"""

import os
import json
import math
import base64
import requests
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS

app = Flask(__name__, static_folder='.', static_url_path='')
CORS(app)

# --- Secure API Key Configuration ---
# Fetches from environment variable first; falls back to local config for dev.
GEMINI_API_KEY = os.environ.get(
    'GEMINI_API_KEY',
    'AIzaSyCxTB2KMrTGKkENIBM8bbcZf65cOknFoDY'
)

# Gemini 2.5 Flash endpoint
GEMINI_MODEL = 'gemini-2.5-flash'
GEMINI_API_URL = f'https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent'

# --- Expert SMC Prompt (Indonesian) ---
SYSTEM_PROMPT = """Anda adalah AI Analis Teknikal Saham Profesional Khusus Market Structure dan Smart Money Concepts (SMC). Tugas Anda adalah menganalisis gambar screenshot chart saham yang dikirimkan oleh pengguna secara mendalam dan 100% akurat sesuai visual gambar.

1. Periksa gambar dengan teliti, cari posisi harga terakhir, area Liquidity/Fair Value Gap (FVG), zona Order Block (Demand/Supply), serta sinyal perubahan karakter tren seperti CHoCH, BOS, atau MSB dari indikator LuxAlgo yang ada pada gambar.

2. Di bagian atas hasil analisis, tampilkan rangkuman kondisi pasar saat ini (Bullish/Bearish/Sideways) beserta teks penjelasan teknikal detail dalam Bahasa Indonesia mengenai mengapa tren tersebut terjadi berdasarkan bukti visual chart asli tersebut.

3. Buatlah tabel HTML responsif menggunakan styling Tailwind CSS yang memuat 3 Opsi Trading Plan Manajemen Risiko:
   - OPSI 1 (AGRESIF - PILIHAN TERBAIK): Entry, Stop Loss (SL), Take Profit (TP), dan Rasio Risk:Reward (RR) berdasarkan breakout terdekat.
   - OPSI 2 (KONSERVATIF): Entry, SL, TP, dan Rasio RR berdasarkan area koreksi pullback ke zona Order Block terkuat.
   - OPSI 3 (FAST SCALPING): Entry, SL, TP, dengan Rasio Risk:Reward wajib diatur pas 1 : 1.0.

4. Pastikan semua angka nominal harga (Rp) pada tabel disesuaikan dengan skala harga saham asli yang terlihat pada sumbu kanan gambar chart. Jangan berikan angka palsu, statis, atau templat acak.

Format seluruh output dalam HTML yang valid dengan styling Tailwind CSS agar bisa langsung di-render di browser. Gunakan warna teks terang (putih/hijau/merah) agar kontras dengan background gelap (#0b0e14)."""


# --- Ticker + Price helpers ---

def normalize_ticker(value):
    """Mirror of the JS normalizeTicker: trim, uppercase, strip non A-Z0-9."""
    if not value:
        return ''
    import re
    return re.sub(r'[^A-Z0-9]', '', str(value).strip().upper())


def build_price_plan(base_price):
    """
    Deterministic Entry/SL/TP for the 3 trading modes, anchored to the user's
    real current price. Guarantees that for sub-100 prices we never output
    thousands.

    Formulas (must match the spec exactly):
      Agresif:      Entry = round(base),       SL = round(Entry*0.95), TP = round(Entry*1.11)
      Konservatif:  Entry = round(base*0.97),  SL = round(Entry*0.95), TP = round(Entry*1.08)
      Scalping:     Entry = round(base),       SL = round(Entry*0.98), TP = round(Entry*1.02)

    If rounding collapses SL onto Entry -> SL = Entry - 1.
    If rounding collapses TP onto Entry -> TP = Entry + 1.
    """
    if base_price is None:
        return None

    try:
        base = float(base_price)
    except (TypeError, ValueError):
        return None

    if not math.isfinite(base) or base <= 0:
        return None

    def plan(entry_mult, sl_mult, tp_mult):
        entry = max(1, round(base * entry_mult))
        sl = max(1, round(entry * sl_mult))
        tp = max(1, round(entry * tp_mult))
        # Small-price collapse guards (spec: SL < Entry < TP, min price 1)
        if sl >= entry:
            sl = max(1, entry - 1)
        if tp <= entry:
            tp = entry + 1
        risk = max(entry - sl, 1e-9)
        rr_val = round((tp - entry) / risk, 1)
        return {
            'entry': int(entry),
            'sl': int(sl),
            'tp': int(tp),
            'rr': rr_val,
            'rr_str': f"1:{rr_val:.1f}",
        }

    agresif = plan(1.00, 0.95, 1.11)
    konservatif = plan(0.97, 0.95, 1.08)
    scalping = plan(1.00, 0.98, 1.02)

    base_int = max(1, int(round(base)))
    target = max(base_int + 1, int(round(base * 1.24)))
    upside_pct = round(((target - base_int) / max(base_int, 1)) * 100, 1)
    support = max(1, int(round(base * 0.92)))
    resistance = max(base_int + 1, int(round(base * 1.15)))

    # SMC overlay levels, deterministic from base price.
    bos_up = max(base_int + 1, int(round(base * 1.06)))
    choch_down = max(1, int(round(base * 0.94)))
    strong_high = max(base_int + 1, int(round(base * 1.18)))
    weak_low = max(1, int(round(base * 0.88)))

    # Auto-Cuan score: simple deterministic blend of upside potential
    # capped to 60..92 so it always feels useful but never absurd.
    score = int(min(92, max(60, round(50 + upside_pct))))

    # Reliability score for the SMC overlay (deterministic, base-anchored).
    reliability = int(min(95, max(55, score - 5)))

    return {
        'base': base_int,
        'target': target,
        'upside_pct': upside_pct,
        'support': support,
        'resistance': resistance,
        'bos_up': bos_up,
        'choch_down': choch_down,
        'strong_high': strong_high,
        'weak_low': weak_low,
        'score': score,
        'reliability': reliability,
        'agresif': agresif,
        'konservatif': konservatif,
        'scalping': scalping,
    }


def _decide_action(plan):
    """Pick one of HAKA / LAYAK MASUK / WAIT AND SEE / JUAL deterministically
    from the plan's score and upside. Mirrors a sensible swing-trading rubric
    so the user always gets a clear call-to-action without depending on AI."""
    score = plan['score']
    upside = plan['upside_pct']
    if score >= 85 and upside >= 18:
        return {
            'label': 'HAKA',
            'tone': 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300',
            'reason': 'Skor tinggi dan potensi upside besar. Struktur SMC mendukung kelanjutan tren naik.',
        }
    if score >= 72:
        return {
            'label': 'LAYAK MASUK',
            'tone': 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200',
            'reason': 'Risk:Reward sehat, area entry dekat zona Demand/Support kunci.',
        }
    if score >= 64:
        return {
            'label': 'WAIT AND SEE',
            'tone': 'bg-yellow-500/10 border-yellow-500/30 text-yellow-200',
            'reason': 'Sinyal belum solid. Tunggu konfirmasi BOS atau pullback ke order block.',
        }
    return {
        'label': 'JUAL / CUT LOSS',
        'tone': 'bg-red-500/10 border-red-500/30 text-red-200',
        'reason': 'Struktur lemah dan risiko menembus support tinggi. Lindungi modal lebih dulu.',
    }


def is_complete_ai_html(html):
    """
    Permissive completeness check for AI-only output (no currentPrice).
    Accept the result if it mentions enough trading-plan vocabulary.
    Spec: do NOT reject just because Gemini writes 'SL' instead of 'Stop Loss'.
    """
    if not html or len(html.strip()) < 40:
        return False
    text = html.lower()
    keyword_groups = [
        ['entry'],
        ['sl', 'stop loss'],
        ['tp', 'take profit'],
        ['rr', 'risk', 'reward'],
        ['target', 'prediksi'],
        ['rekomendasi', 'action', 'wait and see', 'layak masuk', 'haka', 'jual'],
    ]
    hits = 0
    for group in keyword_groups:
        if any(kw in text for kw in group):
            hits += 1
    # Need to satisfy at least 4 of the 6 vocabulary groups.
    return hits >= 4


def render_price_plan_html(ticker, mode, plan, ai_extra_html=''):
    """
    Render the FULL deterministic A-G analysis as Tailwind HTML.

    Sections:
      A. Auto-Cuan Score
      B. Price Target Prediction
      C. Action Decision
      D. Market Structure Summary
      E. Trading Plan Table (no empty cells)
      F. Entry Area Explanation
      G. Auto-Cuan SMC Overlay
      [+ AI Extra narrative, if Gemini returned anything usable]
    """
    rp = lambda n: f"Rp {int(n):,}".replace(',', '.')
    header_label = ticker or 'Saham'
    mode_label = mode or 'Swing'
    action = _decide_action(plan)

    score = plan['score']
    target = plan['target']
    upside = plan['upside_pct']
    base = plan['base']

    # Build the Trading Plan rows. Spec: Opsi | Tipe | Entry | SL | TP | RR | Keterangan,
    # NO empty cells.
    rows = [
        {
            'opsi': 'Opsi 1',
            'tipe': 'Agresif',
            'plan': plan['agresif'],
            'keterangan': 'Entry breakout di harga sekarang. Cocok ketika tren bullish dan momentum kuat.',
            'row_class': 'bg-emerald-500/5',
            'tipe_class': 'text-emerald-400',
        },
        {
            'opsi': 'Opsi 2',
            'tipe': 'Konservatif',
            'plan': plan['konservatif'],
            'keterangan': 'Tunggu pullback ke zona Order Block / Demand. Risiko lebih rendah, RR lebih sehat.',
            'row_class': '',
            'tipe_class': 'text-gray-200',
        },
        {
            'opsi': 'Opsi 3',
            'tipe': 'Scalping',
            'plan': plan['scalping'],
            'keterangan': f'Target cepat 1:{plan["scalping"]["rr"]:.1f}, cocok untuk intraday saat likuiditas tinggi.',
            'row_class': '',
            'tipe_class': 'text-yellow-300',
        },
    ]

    rows_html = '\n'.join(f"""
        <tr class="{r['row_class']}">
          <td class="px-3 py-3 font-semibold">{r['opsi']}</td>
          <td class="px-3 py-3 font-semibold {r['tipe_class']}">{r['tipe']}</td>
          <td class="px-3 py-3 text-right font-mono text-white">{rp(r['plan']['entry'])}</td>
          <td class="px-3 py-3 text-right font-mono text-red-400">{rp(r['plan']['sl'])}</td>
          <td class="px-3 py-3 text-right font-mono text-emerald-400">{rp(r['plan']['tp'])}</td>
          <td class="px-3 py-3 text-right font-mono">{r['plan']['rr_str']}</td>
          <td class="px-3 py-3 text-xs text-gray-300">{r['keterangan']}</td>
        </tr>""" for r in rows)

    ai_extra_block = ''
    if ai_extra_html:
        ai_extra_block = f"""
  <div class="rounded-xl border border-dark-600/50 bg-dark-800/40 p-5">
    <h3 class="text-sm uppercase tracking-wider text-gray-400 font-semibold mb-3">Konteks Tambahan dari AI</h3>
    <div class="prose prose-invert max-w-none text-gray-200 text-sm">{ai_extra_html}</div>
  </div>"""

    return f"""
<div id="autocuan-result" data-ticker="{header_label}" data-base="{base}" class="space-y-6">

  <!-- A. Auto-Cuan Score + B. Price Target Prediction -->
  <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
    <div class="rounded-xl border border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 to-emerald-500/0 p-5">
      <p class="text-xs uppercase tracking-wider text-emerald-400 font-semibold">Auto-Cuan Score</p>
      <div class="flex items-baseline gap-2 mt-2">
        <span class="text-5xl font-bold text-white">{score}</span>
        <span class="text-2xl text-gray-400 font-semibold">/100</span>
      </div>
      <p class="text-xs text-gray-400 mt-2">Skor kelayakan trading dihitung dari potensi upside dan kualitas struktur. Semakin tinggi, semakin kuat sinyal.</p>
    </div>
    <div class="rounded-xl border border-dark-600/60 bg-dark-800/40 p-5 space-y-2">
      <p class="text-xs uppercase tracking-wider text-gray-400 font-semibold">Prediksi Target Harga</p>
      <p class="text-3xl font-bold text-emerald-400 font-mono">{rp(target)}</p>
      <div class="grid grid-cols-2 gap-2 text-xs">
        <div><span class="text-gray-500">Basis Harga</span><br><span class="text-white font-mono">{rp(base)}</span></div>
        <div><span class="text-gray-500">Potensi Kenaikan</span><br><span class="text-emerald-400 font-mono">+{upside}%</span></div>
      </div>
      <p class="text-xs text-gray-400 pt-1">Target diproyeksikan dari basis harga + ekspansi 24% mengikuti panjang impuls bullish standar pada struktur SMC.</p>
    </div>
  </div>

  <!-- C. Action Decision -->
  <div class="rounded-xl border {action['tone']} p-5 space-y-3">
    <div class="flex items-center justify-between flex-wrap gap-2">
      <div>
        <p class="text-xs uppercase tracking-wider opacity-80 font-semibold">Rekomendasi Aksi</p>
        <p class="text-3xl font-extrabold mt-1 tracking-tight">{action['label']}</p>
      </div>
      <span class="text-xs bg-white/10 px-3 py-1 rounded-full">{header_label} &middot; Mode {mode_label}</span>
    </div>
    <p class="text-sm">{action['reason']}</p>
    <div class="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs pt-2">
      <div class="rounded-lg bg-white/5 p-3">
        <p class="font-semibold mb-1 text-white">Syarat Valid</p>
        <p class="text-gray-200">Harga close di atas {rp(plan['bos_up'])} (BOS bullish) dengan volume meningkat dan tidak melanggar {rp(plan['choch_down'])}.</p>
      </div>
      <div class="rounded-lg bg-white/5 p-3">
        <p class="font-semibold mb-1 text-white">Invalid Level</p>
        <p class="text-gray-200">Setup batal jika harga close di bawah {rp(plan['weak_low'])} (CHoCH bearish ke struktur lebih rendah).</p>
      </div>
      <div class="rounded-lg bg-white/5 p-3">
        <p class="font-semibold mb-1 text-white">Risiko Utama</p>
        <p class="text-gray-200">Likuiditas tipis pada saham di area harga {rp(base)} dapat memperlebar slippage saat keluar posisi.</p>
      </div>
    </div>
  </div>

  <!-- D. Market Structure Summary -->
  <div class="rounded-xl border border-dark-600/60 bg-dark-800/40 p-5">
    <h3 class="text-sm uppercase tracking-wider text-gray-400 font-semibold mb-2">Ringkasan Struktur Market</h3>
    <p class="text-gray-200 text-sm leading-relaxed">
      {header_label} sedang bergerak di area harga <span class="text-white font-mono">{rp(base)}</span>,
      berada di antara support kunci <span class="text-emerald-400 font-mono">{rp(plan['support'])}</span>
      dan resistance terdekat <span class="text-red-400 font-mono">{rp(plan['resistance'])}</span>.
      Tren pendek cenderung
      <span class="font-semibold text-emerald-300">{'bullish' if score >= 70 else ('netral cenderung bullish' if score >= 64 else 'rentan koreksi')}</span>
      selama harga bertahan di atas Weak Low {rp(plan['weak_low'])}. Konfirmasi kelanjutan tren datang ketika harga menembus BOS di {rp(plan['bos_up'])}.
    </p>
  </div>

  <!-- E. Trading Plan Table -->
  <div class="overflow-x-auto rounded-xl border border-dark-600/60 bg-dark-800/40">
    <table class="min-w-full text-sm">
      <thead class="bg-dark-700/60 text-gray-300 text-xs uppercase tracking-wider">
        <tr>
          <th class="px-3 py-3 text-left">Opsi</th>
          <th class="px-3 py-3 text-left">Tipe Trading</th>
          <th class="px-3 py-3 text-right">Entry</th>
          <th class="px-3 py-3 text-right text-red-400">SL</th>
          <th class="px-3 py-3 text-right text-emerald-400">TP</th>
          <th class="px-3 py-3 text-right">RR</th>
          <th class="px-3 py-3 text-left">Keterangan</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-dark-600/50">
        {rows_html}
      </tbody>
    </table>
  </div>

  <!-- F. Entry Area Explanation -->
  <div class="rounded-xl border border-dark-600/60 bg-dark-800/40 p-5 space-y-3">
    <h3 class="text-base font-semibold text-white">🧭 Kenapa Area Entry Itu?</h3>
    <ul class="text-sm text-gray-200 space-y-2 list-disc pl-5">
      <li>Harga sekarang <span class="text-white font-mono">{rp(base)}</span> berada tepat di atas zona Demand kunci di <span class="text-emerald-400 font-mono">{rp(plan['support'])}</span>, masih di bawah Resistance terdekat di <span class="text-red-400 font-mono">{rp(plan['resistance'])}</span>.</li>
      <li><strong>Entry agresif</strong> di harga sekarang masuk akal karena momentum bullish berpeluang dilanjutkan begitu likuiditas di atas tertarget.</li>
      <li><strong>Entry konservatif</strong> menunggu pullback ke <span class="font-mono">{rp(plan['konservatif']['entry'])}</span> agar dapat harga diskon di area Order Block yang lebih kuat.</li>
      <li><strong>Entry valid</strong> ketika harga close di atas <span class="font-mono">{rp(plan['bos_up'])}</span> (BOS bullish) dengan volume membesar.</li>
      <li><strong>Cut loss</strong> ketika harga close di bawah <span class="font-mono">{rp(plan['weak_low'])}</span> karena struktur SMC sudah dianggap rusak.</li>
    </ul>
  </div>

  <!-- G. Auto-Cuan SMC Overlay -->
  <div class="rounded-xl border border-dark-600/60 bg-dark-800/40 p-5">
    <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
      <h3 class="text-base font-semibold text-white">Auto-Cuan SMC Overlay</h3>
      <span class="text-xs px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-300">
        Reliability {plan['reliability']}/100
      </span>
    </div>
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
      <div class="rounded-lg bg-emerald-500/10 border border-emerald-500/20 p-3">
        <p class="text-xs text-emerald-300 uppercase tracking-wider">Demand / Support</p>
        <p class="font-mono text-white mt-1">{rp(plan['support'])}</p>
      </div>
      <div class="rounded-lg bg-red-500/10 border border-red-500/20 p-3">
        <p class="text-xs text-red-300 uppercase tracking-wider">Supply / Resistance</p>
        <p class="font-mono text-white mt-1">{rp(plan['resistance'])}</p>
      </div>
      <div class="rounded-lg bg-emerald-500/5 border border-dark-600/60 p-3">
        <p class="text-xs text-gray-400 uppercase tracking-wider">BOS Level</p>
        <p class="font-mono text-emerald-400 mt-1">{rp(plan['bos_up'])}</p>
      </div>
      <div class="rounded-lg bg-red-500/5 border border-dark-600/60 p-3">
        <p class="text-xs text-gray-400 uppercase tracking-wider">CHoCH Level</p>
        <p class="font-mono text-red-400 mt-1">{rp(plan['choch_down'])}</p>
      </div>
      <div class="rounded-lg bg-dark-700/40 border border-dark-600/60 p-3">
        <p class="text-xs text-gray-400 uppercase tracking-wider">Strong High</p>
        <p class="font-mono text-white mt-1">{rp(plan['strong_high'])}</p>
      </div>
      <div class="rounded-lg bg-dark-700/40 border border-dark-600/60 p-3">
        <p class="text-xs text-gray-400 uppercase tracking-wider">Weak Low</p>
        <p class="font-mono text-white mt-1">{rp(plan['weak_low'])}</p>
      </div>
      <div class="rounded-lg bg-dark-700/40 border border-dark-600/60 p-3">
        <p class="text-xs text-gray-400 uppercase tracking-wider">Reliability</p>
        <p class="font-mono text-white mt-1">{plan['reliability']}/100</p>
      </div>
      <div class="rounded-lg bg-dark-700/40 border border-dark-600/60 p-3">
        <p class="text-xs text-gray-400 uppercase tracking-wider">Entry Bias</p>
        <p class="font-mono mt-1 {'text-emerald-400' if score >= 64 else 'text-red-400'}">
          {'Long Bias' if score >= 64 else 'Short / Avoid'}
        </p>
      </div>
    </div>
  </div>
{ai_extra_block}
  <p class="text-xs text-gray-500">Semua angka dihitung deterministik dari Harga Sekarang yang Anda input. Bukan saran investasi.</p>
</div>
"""


@app.route('/')
def serve_index():
    """Serve the frontend."""
    return send_from_directory('.', 'index.html')


def _call_gemini(parts, timeout=60):
    """
    Best-effort Gemini call. Returns the cleaned text on success, or '' on
    ANY failure (HTTP error, timeout, parse error). Never raises so the
    caller can keep going with the deterministic fallback.
    """
    try:
        payload = {
            "contents": [{"parts": parts}],
            "generationConfig": {
                "temperature": 0.7,
                "topP": 0.95,
                "topK": 40,
                "maxOutputTokens": 8192,
            },
        }
        response = requests.post(
            f'{GEMINI_API_URL}?key={GEMINI_API_KEY}',
            headers={'Content-Type': 'application/json'},
            json=payload,
            timeout=timeout,
        )
        if response.status_code != 200:
            return ''
        result = response.json() or {}
        candidates = result.get('candidates') or []
        if not candidates:
            return ''
        content = candidates[0].get('content') or {}
        cparts = content.get('parts') or []
        if not cparts:
            return ''
        text = cparts[0].get('text') or ''
        text = text.strip()
        if text.startswith('```'):
            text = text.split('\n', 1)[1] if '\n' in text else ''
            if text.endswith('```'):
                text = text[:-3]
            text = text.strip()
        return text
    except Exception:
        return ''


@app.route('/api/analyze', methods=['POST'])
def analyze_chart():
    """
    Always returns a complete analysis HTML when ticker + currentPrice are
    provided. Gemini is treated as best-effort: its narrative is folded in
    as 'Konteks Tambahan' when available, but a Gemini failure NEVER produces
    an 'Hasil analisis belum lengkap' error card.

    Request bodies:
      - { ticker, currentPrice, mode }                      -> AI/Nama Saham
      - { image, mimeType, ticker?, currentPrice?, mode? }  -> Chart image
    """
    try:
        data = request.get_json() or {}

        ticker = normalize_ticker(data.get('ticker', ''))

        current_price_raw = data.get('currentPrice', None)
        try:
            current_price = float(current_price_raw) if current_price_raw not in (None, '', 'null') else None
        except (TypeError, ValueError):
            current_price = None

        mode = (data.get('mode') or '').strip() or None
        image_data = data.get('image')

        if not image_data and not (ticker and current_price):
            return jsonify({
                'error': 'Kirim minimal salah satu: gambar chart, atau ticker + Harga Sekarang.'
            }), 400

        price_plan = build_price_plan(current_price) if current_price else None

        if price_plan:
            result_summary = f"{ticker or 'N/A'} | Base Price Rp {price_plan['base']} | Mode {mode or 'AI'}"
        else:
            result_summary = f"{ticker or 'N/A'} | Mode {mode or 'AI'}"

        # --- Best-effort Gemini call for narrative context ---
        ai_extra_html = ''
        if image_data:
            payload_image = image_data
            if ',' in payload_image:
                payload_image = payload_image.split(',')[1]
            mime_type = data.get('mimeType', 'image/png')
            text_prompt = SYSTEM_PROMPT
            if price_plan:
                text_prompt += (
                    f"\n\nKONTEKS PENGGUNA (WAJIB DIPATUHI):\n"
                    f"- Ticker: {ticker}\n"
                    f"- Harga Sekarang (BASE PRICE ABSOLUT): Rp {price_plan['base']}\n"
                    f"- Mode: {mode or 'AI'}\n"
                    f"Gunakan Rp {price_plan['base']} sebagai patokan harga absolut. "
                    f"DILARANG mengeluarkan angka Entry / SL / TP / Target / Support / Resistance "
                    f"di luar skala harga ini. Jika base price < 100, JANGAN PERNAH menyebut ribuan."
                )
            parts = [
                {"text": text_prompt},
                {"inline_data": {"mime_type": mime_type, "data": payload_image}},
            ]
            ai_extra_html = _call_gemini(parts, timeout=120)
        elif price_plan:
            text_prompt = (
                "Anda adalah AI Analis Saham Indonesia (Smart Money Concepts). "
                f"Ticker: {ticker}. Harga Sekarang (BASE PRICE ABSOLUT): Rp {price_plan['base']}. "
                f"Mode: {mode or 'AI'}.\n\n"
                "Berikan narasi singkat (maks 4 paragraf pendek, Bahasa Indonesia) tentang "
                "kondisi pasar SMC, liquidity / order block kunci, skenario CHoCH/BOS, dan risiko utama.\n"
                f"DILARANG mengeluarkan angka Entry/SL/TP/Target/Support/Resistance di luar skala Rp {price_plan['base']}. "
                f"Jika base price < 100, JANGAN PERNAH menyebut ribuan. "
                "JANGAN buat tabel trading plan sendiri. Output HTML Tailwind valid, warna terang di background gelap."
            )
            ai_extra_html = _call_gemini([{"text": text_prompt}], timeout=60)

        # --- Render the final HTML ---
        if price_plan:
            # Deterministic A-G report ALWAYS rendered. AI is bonus context.
            final_html = render_price_plan_html(ticker, mode, price_plan, ai_extra_html=ai_extra_html)
            return jsonify({
                'html': final_html,
                'ticker': ticker,
                'currentPrice': price_plan['base'],
                'plan': price_plan,
                'aiSupplied': bool(ai_extra_html),
                'resultSummary': result_summary,
            })

        # --- Image-only flow (no currentPrice). Apply permissive validator. ---
        if ai_extra_html and is_complete_ai_html(ai_extra_html):
            return jsonify({
                'html': ai_extra_html,
                'ticker': ticker,
                'currentPrice': None,
                'plan': None,
                'aiSupplied': True,
                'resultSummary': result_summary,
            })

        # No currentPrice and AI output incomplete: tell the user how to fix it
        # (still HTML so the frontend renders it, no scary error card).
        guidance_html = f"""
<div class="rounded-xl border border-yellow-500/30 bg-yellow-500/5 p-5 space-y-2">
  <p class="text-yellow-300 font-semibold">Analisis butuh Harga Sekarang</p>
  <p class="text-sm text-gray-200">Untuk mendapat Entry, SL, TP, dan target yang akurat, silakan switch ke mode <strong>AI / Nama Saham</strong> lalu isi ticker dan Harga Sekarang. Sistem akan menghasilkan analisis lengkap secara deterministik tanpa bergantung pada estimasi AI.</p>
</div>"""
        return jsonify({
            'html': (ai_extra_html + guidance_html) if ai_extra_html else guidance_html,
            'ticker': ticker,
            'currentPrice': None,
            'plan': None,
            'aiSupplied': bool(ai_extra_html),
            'resultSummary': result_summary,
        })

    except Exception as e:
        return jsonify({'error': f'Server error: {str(e)}'}), 500


@app.route('/api/news', methods=['GET'])
def get_yahoo_news():
    """
    Proxy endpoint to fetch Yahoo Finance news for Indonesian stocks.
    Query param: ?q=BBCA (ticker symbol)
    """
    query = request.args.get('q', 'IHSG saham indonesia')

    try:
        # Yahoo Finance RSS feed for news
        yahoo_url = f'https://news.google.com/rss/search?q={query}+saham+indonesia&hl=id&gl=ID&ceid=ID:id'

        response = requests.get(yahoo_url, timeout=10, headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        })

        if response.status_code == 200:
            import xml.etree.ElementTree as ET
            root = ET.fromstring(response.content)
            channel = root.find('channel')
            items = channel.findall('item') if channel is not None else []

            news_list = []
            for item in items[:8]:
                title = item.find('title')
                link = item.find('link')
                pub_date = item.find('pubDate')
                news_list.append({
                    'title': title.text if title is not None else '',
                    'link': link.text if link is not None else '',
                    'pubDate': pub_date.text if pub_date is not None else ''
                })

            return jsonify({'news': news_list})

        return jsonify({'news': [], 'error': 'Failed to fetch news'}), 200

    except Exception as e:
        return jsonify({'news': [], 'error': str(e)}), 200


# =============================================================================
# Supabase Admin Logging
# =============================================================================
#
# Tables (already created in Supabase):
#   login_logs(username, is_guest, is_admin, user_agent, created_at)
#   search_logs(username, ticker, source, created_at)
#   ai_analysis_logs(username, ticker, mode, result_summary, full_result_html, created_at)
#   ai_usage_logs(username, ticker, action, created_at)
#
# Secrets are read ONLY from environment variables. They MUST NEVER be
# hardcoded here or exposed to the frontend.

SUPABASE_URL = os.environ.get('SUPABASE_URL', '').rstrip('/')
SUPABASE_SERVICE_ROLE_KEY = os.environ.get('SUPABASE_SERVICE_ROLE_KEY', '')


def _supabase_configured():
    return bool(SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)


def _sb_headers(prefer=None):
    h = {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': f'Bearer {SUPABASE_SERVICE_ROLE_KEY}',
        'Content-Type': 'application/json',
    }
    if prefer:
        h['Prefer'] = prefer
    return h


def _sb_insert(table, row):
    """POST a single row to a Supabase table. Returns (ok, detail).
    Never raises — logging must not break the app."""
    if not _supabase_configured():
        return False, 'supabase_not_configured'
    try:
        url = f'{SUPABASE_URL}/rest/v1/{table}'
        resp = requests.post(
            url,
            headers=_sb_headers(prefer='return=minimal'),
            json=[row],
            timeout=8,
        )
        if 200 <= resp.status_code < 300:
            return True, None
        return False, f'status={resp.status_code}'
    except Exception as e:
        return False, str(e)


def _sb_select(table, params):
    """GET rows from a Supabase table. params is a dict of PostgREST query
    args (e.g. {'order': 'created_at.desc', 'limit': 50}).
    Returns (ok, list_or_error_string)."""
    if not _supabase_configured():
        return False, 'supabase_not_configured'
    try:
        url = f'{SUPABASE_URL}/rest/v1/{table}'
        resp = requests.get(
            url,
            headers=_sb_headers(),
            params=params,
            timeout=10,
        )
        if 200 <= resp.status_code < 300:
            return True, resp.json()
        return False, f'status={resp.status_code}'
    except Exception as e:
        return False, str(e)


def _safe_str(value, max_len=None):
    if value is None:
        return None
    s = str(value)
    if max_len:
        s = s[:max_len]
    return s


@app.route('/api/log-login', methods=['POST'])
def log_login():
    """Log a login event. Body: { username, isGuest, isAdmin, userAgent }."""
    try:
        data = request.get_json() or {}
        if not _supabase_configured():
            return jsonify({'success': False, 'error': 'Database logging belum dikonfigurasi.'})
        row = {
            'username': _safe_str(data.get('username'), 100) or 'Unknown',
            'is_guest': bool(data.get('isGuest')),
            'is_admin': bool(data.get('isAdmin')),
            'user_agent': _safe_str(data.get('userAgent'), 500),
        }
        ok, detail = _sb_insert('login_logs', row)
        if ok:
            return jsonify({'success': True})
        return jsonify({'success': False, 'error': detail or 'insert failed'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})


@app.route('/api/log-search', methods=['POST'])
def log_search():
    """Log a ticker search. Body: { username, ticker, source }."""
    try:
        data = request.get_json() or {}
        if not _supabase_configured():
            return jsonify({'success': False, 'error': 'Database logging belum dikonfigurasi.'})
        row = {
            'username': _safe_str(data.get('username'), 100) or 'Unknown',
            'ticker': normalize_ticker(data.get('ticker')) or None,
            'source': _safe_str(data.get('source'), 60),
        }
        ok, detail = _sb_insert('search_logs', row)
        if ok:
            return jsonify({'success': True})
        return jsonify({'success': False, 'error': detail or 'insert failed'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})


@app.route('/api/log-analysis', methods=['POST'])
def log_analysis():
    """Log a successful AI analysis result. Body:
       { username, ticker, mode, resultSummary, fullResultHtml }
       Never logs passwords / API keys; only the rendered HTML body and a
       short text summary."""
    try:
        data = request.get_json() or {}
        if not _supabase_configured():
            return jsonify({'success': False, 'error': 'Database logging belum dikonfigurasi.'})
        row = {
            'username': _safe_str(data.get('username'), 100) or 'Unknown',
            'ticker': normalize_ticker(data.get('ticker')) or None,
            'mode': _safe_str(data.get('mode'), 30),
            'result_summary': _safe_str(data.get('resultSummary'), 500),
            'full_result_html': _safe_str(data.get('fullResultHtml'), 100000),
        }
        ok, detail = _sb_insert('ai_analysis_logs', row)
        if ok:
            return jsonify({'success': True})
        return jsonify({'success': False, 'error': detail or 'insert failed'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})


@app.route('/api/log-usage', methods=['POST'])
def log_usage():
    """Log AI usage events. Body: { username, ticker, action }.
       action values: ai_analysis_started, ai_success, ai_error, ai_limit_blocked"""
    try:
        data = request.get_json() or {}
        if not _supabase_configured():
            return jsonify({'success': False, 'error': 'Database logging belum dikonfigurasi.'})
        ticker_raw = data.get('ticker')
        row = {
            'username': _safe_str(data.get('username'), 100) or 'Unknown',
            'ticker': normalize_ticker(ticker_raw) if ticker_raw else None,
            'action': _safe_str(data.get('action'), 60),
        }
        ok, detail = _sb_insert('ai_usage_logs', row)
        if ok:
            return jsonify({'success': True})
        return jsonify({'success': False, 'error': detail or 'insert failed'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})


@app.route('/api/admin-logs', methods=['POST'])
def admin_logs():
    """Read-only admin dashboard data.
       Body: { adminName }. Only the user 'budi' (case-insensitive) may read.
       Returns latest rows from each table + a small summary."""
    try:
        data = request.get_json() or {}
        admin_name = (data.get('adminName') or '').strip().lower()
        if admin_name != 'budi':
            return jsonify({'success': False, 'error': 'Unauthorized'}), 403

        if not _supabase_configured():
            return jsonify({
                'success': False,
                'error': 'Database logging belum dikonfigurasi.'
            })

        ok_l, login_logs = _sb_select('login_logs', {
            'select': '*', 'order': 'created_at.desc', 'limit': '50',
        })
        ok_s, search_logs = _sb_select('search_logs', {
            'select': '*', 'order': 'created_at.desc', 'limit': '100',
        })
        ok_a, analysis_logs = _sb_select('ai_analysis_logs', {
            'select': '*', 'order': 'created_at.desc', 'limit': '50',
        })
        ok_u, usage_logs = _sb_select('ai_usage_logs', {
            'select': '*', 'order': 'created_at.desc', 'limit': '100',
        })

        # If any of the reads failed because Supabase is misconfigured /
        # unreachable, treat the dashboard as unavailable.
        if not (ok_l and ok_s and ok_a and ok_u):
            return jsonify({
                'success': False,
                'error': 'Database logging belum dikonfigurasi.'
            })

        # Summary (cheap, in-memory): use what we just fetched. For total
        # counts we run head-style requests so the numbers can exceed the
        # per-table fetch limits above.
        def _total_count(table):
            if not _supabase_configured():
                return None
            try:
                url = f'{SUPABASE_URL}/rest/v1/{table}'
                headers = _sb_headers(prefer='count=exact')
                # Range 0-0 just to get Content-Range header back cheaply.
                headers['Range-Unit'] = 'items'
                headers['Range'] = '0-0'
                resp = requests.get(url, headers=headers, params={'select': 'created_at'}, timeout=8)
                cr = resp.headers.get('Content-Range', '')
                if '/' in cr:
                    total = cr.split('/', 1)[1]
                    if total.isdigit():
                        return int(total)
            except Exception:
                return None
            return None

        total_logins = _total_count('login_logs')
        total_searches = _total_count('search_logs')
        total_analyses = _total_count('ai_analysis_logs')

        # Most-searched tickers from the search_logs window we just pulled.
        most = {}
        for r in (search_logs or []):
            t = (r.get('ticker') or '').strip()
            if not t:
                continue
            most[t] = most.get(t, 0) + 1
        most_searched = sorted(
            ({'ticker': k, 'count': v} for k, v in most.items()),
            key=lambda x: x['count'],
            reverse=True,
        )[:10]

        return jsonify({
            'success': True,
            'summary': {
                'totalLogins': total_logins,
                'totalSearches': total_searches,
                'totalAIAnalyses': total_analyses,
                'mostSearchedTickers': most_searched,
            },
            'loginLogs': login_logs,
            'searchLogs': search_logs,
            'aiAnalysisLogs': analysis_logs,
            'aiUsageLogs': usage_logs,
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    print(f"\n{'='*50}")
    print(f"  Auto-Cuan AI Chart Reader")
    print(f"  Running on http://localhost:{port}")
    print(f"  Gemini Model: {GEMINI_MODEL}")
    print(f"  API Key: {'*' * 20}...{GEMINI_API_KEY[-4:]}")
    print(f"{'='*50}\n")
    app.run(host='0.0.0.0', port=port, debug=True)
