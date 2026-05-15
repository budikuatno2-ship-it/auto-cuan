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
        entry = round(base * entry_mult)
        sl = round(entry * sl_mult)
        tp = round(entry * tp_mult)
        if sl == entry:
            sl = entry - 1
        if tp == entry:
            tp = entry + 1
        rr = round((tp - entry) / max(entry - sl, 1e-9), 2)
        return {'entry': int(entry), 'sl': int(sl), 'tp': int(tp), 'rr': rr}

    agresif = plan(1.00, 0.95, 1.11)
    konservatif = plan(0.97, 0.95, 1.08)
    scalping = plan(1.00, 0.98, 1.02)
    # Force scalping to a clean 1:1 RR per spec.
    scalping['rr'] = 1.0

    target = int(round(base * 1.22))
    support = int(round(base * 0.92))
    resistance = int(round(base * 1.15))

    return {
        'base': int(round(base)),
        'target': target,
        'support': support,
        'resistance': resistance,
        'agresif': agresif,
        'konservatif': konservatif,
        'scalping': scalping,
    }


def render_price_plan_html(ticker, mode, plan):
    """Render the deterministic plan as Tailwind HTML the frontend renders directly."""
    rp = lambda n: f"Rp {n:,}".replace(',', '.')
    header_label = ticker or 'Saham'
    return f"""
<div class="space-y-4">
  <div class="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4">
    <p class="text-xs uppercase tracking-wider text-emerald-400 font-semibold">Base Price Terkunci</p>
    <p class="text-2xl font-bold text-white mt-1">{header_label} &middot; {rp(plan['base'])}</p>
    <p class="text-xs text-gray-400 mt-1">Mode: {mode or 'AI / Nama Saham'} &bull; Target swing &asymp; {rp(plan['target'])} &bull; Support {rp(plan['support'])} &bull; Resistance {rp(plan['resistance'])}</p>
  </div>

  <div class="overflow-x-auto rounded-xl border border-dark-600/60">
    <table class="min-w-full text-sm">
      <thead class="bg-dark-700/60 text-gray-300">
        <tr>
          <th class="px-4 py-3 text-left font-semibold">Plan</th>
          <th class="px-4 py-3 text-right font-semibold">Entry</th>
          <th class="px-4 py-3 text-right font-semibold text-red-400">SL</th>
          <th class="px-4 py-3 text-right font-semibold text-emerald-400">TP</th>
          <th class="px-4 py-3 text-right font-semibold">RR</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-dark-600/50 text-white">
        <tr class="bg-emerald-500/5">
          <td class="px-4 py-3 font-semibold text-emerald-400">Agresif <span class="text-xs text-gray-500">(pilihan utama)</span></td>
          <td class="px-4 py-3 text-right font-mono">{rp(plan['agresif']['entry'])}</td>
          <td class="px-4 py-3 text-right font-mono text-red-400">{rp(plan['agresif']['sl'])}</td>
          <td class="px-4 py-3 text-right font-mono text-emerald-400">{rp(plan['agresif']['tp'])}</td>
          <td class="px-4 py-3 text-right font-mono">1 : {plan['agresif']['rr']}</td>
        </tr>
        <tr>
          <td class="px-4 py-3 font-semibold">Konservatif</td>
          <td class="px-4 py-3 text-right font-mono">{rp(plan['konservatif']['entry'])}</td>
          <td class="px-4 py-3 text-right font-mono text-red-400">{rp(plan['konservatif']['sl'])}</td>
          <td class="px-4 py-3 text-right font-mono text-emerald-400">{rp(plan['konservatif']['tp'])}</td>
          <td class="px-4 py-3 text-right font-mono">1 : {plan['konservatif']['rr']}</td>
        </tr>
        <tr>
          <td class="px-4 py-3 font-semibold">Scalping</td>
          <td class="px-4 py-3 text-right font-mono">{rp(plan['scalping']['entry'])}</td>
          <td class="px-4 py-3 text-right font-mono text-red-400">{rp(plan['scalping']['sl'])}</td>
          <td class="px-4 py-3 text-right font-mono text-emerald-400">{rp(plan['scalping']['tp'])}</td>
          <td class="px-4 py-3 text-right font-mono">1 : 1.0</td>
        </tr>
      </tbody>
    </table>
  </div>
  <p class="text-xs text-gray-500">Angka di atas dihitung deterministik dari Harga Sekarang yang Anda input, bukan dari estimasi AI. Narasi market structure di bawah dihasilkan oleh AI sebagai konteks tambahan.</p>
</div>
"""


@app.route('/')
def serve_index():
    """Serve the frontend."""
    return send_from_directory('.', 'index.html')


@app.route('/api/analyze', methods=['POST'])
def analyze_chart():
    """
    Secure POST endpoint. Two flows:

      1) Chart image flow (existing): { image, mimeType, ticker?, currentPrice?, mode? }
         -> Forwards image to Gemini for SMC narrative.
         -> If currentPrice is provided, deterministic Entry/SL/TP table is
            prepended so AI hallucinations on absolute price never leak through.

      2) Ticker / Nama Saham flow: { ticker, currentPrice, mode } (no image)
         -> Returns deterministic Entry/SL/TP table anchored to currentPrice,
            and asks Gemini for a short Indonesian SMC narrative for that ticker.
    """
    try:
        data = request.get_json() or {}

        raw_ticker = data.get('ticker', '')
        ticker = normalize_ticker(raw_ticker)

        # currentPrice is the absolute base price. Anything else (AI guesses,
        # stale chart axis reads, etc.) must NOT override it.
        current_price_raw = data.get('currentPrice', None)
        try:
            current_price = float(current_price_raw) if current_price_raw not in (None, '', 'null') else None
        except (TypeError, ValueError):
            current_price = None

        mode = (data.get('mode') or '').strip() or None
        image_data = data.get('image')

        # Validate: must have at least one of image or (ticker + currentPrice).
        if not image_data and not (ticker and current_price):
            return jsonify({
                'error': 'Kirim minimal salah satu: gambar chart, atau ticker + Harga Sekarang.'
            }), 400

        # Build the deterministic price plan if we have a base price.
        price_plan = build_price_plan(current_price) if current_price else None
        deterministic_html = render_price_plan_html(ticker, mode, price_plan) if price_plan else ''

        # Result summary string (ready for Supabase logging when wired up).
        if price_plan:
            result_summary = f"{ticker or 'N/A'} | Base Price Rp {price_plan['base']} | Mode {mode or 'AI'}"
        else:
            result_summary = f"{ticker or 'N/A'} | Mode {mode or 'AI'}"

        # --- Build Gemini request based on which flow we're in ---
        if image_data:
            # Strip data URI prefix if present.
            if ',' in image_data:
                image_data = image_data.split(',')[1]

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
                {"inline_data": {"mime_type": mime_type, "data": image_data}},
            ]
        else:
            # Pure ticker / Nama Saham flow.
            text_prompt = (
                "Anda adalah AI Analis Saham Indonesia (Smart Money Concepts). "
                f"Ticker: {ticker}. Harga Sekarang (BASE PRICE ABSOLUT): Rp {price_plan['base']}. "
                f"Mode: {mode or 'AI'}.\n\n"
                "Berikan narasi singkat (maks 5 paragraf, Bahasa Indonesia) tentang: "
                "1) kondisi pasar (Bullish/Bearish/Sideways) berdasarkan SMC, "
                "2) area liquidity & order block kunci di sekitar base price, "
                "3) skenario CHoCH/BOS yang paling mungkin, "
                "4) faktor risiko utama.\n\n"
                f"DILARANG mengeluarkan angka Entry/SL/TP/Target/Support/Resistance di luar skala Rp {price_plan['base']}. "
                f"Jika base price < 100, JANGAN PERNAH menyebut ribuan. "
                "JANGAN buat tabel trading plan sendiri \u2014 tabel sudah dihitung deterministik di luar AI. "
                "Output HTML Tailwind valid, warna terang di background gelap."
            )
            parts = [{"text": text_prompt}]

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
            timeout=120,
        )

        if response.status_code != 200:
            error_detail = response.json() if response.content else {}
            return jsonify({
                'error': f'Gemini API error ({response.status_code})',
                'detail': error_detail,
                'ticker': ticker,
                'resultSummary': result_summary,
            }), response.status_code

        result = response.json()
        analysis_html = ''
        candidates = result.get('candidates', [])
        if candidates:
            content = candidates[0].get('content', {})
            cparts = content.get('parts', [])
            if cparts:
                analysis_html = cparts[0].get('text', '') or ''

        # Strip ```html ... ``` fences if Gemini wraps its output.
        if analysis_html:
            analysis_html = analysis_html.strip()
            if analysis_html.startswith('```'):
                # remove first fence line
                analysis_html = analysis_html.split('\n', 1)[1] if '\n' in analysis_html else ''
                if analysis_html.endswith('```'):
                    analysis_html = analysis_html[:-3]
                analysis_html = analysis_html.strip()

        # Deterministic plan ALWAYS goes first, AI narrative below.
        final_html = (deterministic_html + '\n' + analysis_html) if deterministic_html else analysis_html

        if not final_html:
            return jsonify({
                'error': 'No analysis generated by the model.',
                'ticker': ticker,
                'resultSummary': result_summary,
            }), 500

        return jsonify({
            'html': final_html,
            'ticker': ticker,
            'currentPrice': price_plan['base'] if price_plan else None,
            'plan': price_plan,
            'resultSummary': result_summary,
        })

    except requests.exceptions.Timeout:
        return jsonify({'error': 'Request to Gemini API timed out. Please try again.'}), 504
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


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    print(f"\n{'='*50}")
    print(f"  Auto-Cuan AI Chart Reader")
    print(f"  Running on http://localhost:{port}")
    print(f"  Gemini Model: {GEMINI_MODEL}")
    print(f"  API Key: {'*' * 20}...{GEMINI_API_KEY[-4:]}")
    print(f"{'='*50}\n")
    app.run(host='0.0.0.0', port=port, debug=True)
