/**
 * Auto-Cuan Analyze API — Minimal real implementation
 * Single file, no local lib deps, deployment-safe.
 */

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.body || {};
    const { ticker, currentPrice, source, chatMessage, image, images } = body;

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
      return res.status(200).json({
        html: '<p class="text-sm text-yellow-400">Gemini API belum dikonfigurasi. Hubungi admin.</p>'
      });
    }

    // Image upload — placeholder response for now
    if (source === 'chart_upload' && (image || (images && images.length > 0))) {
      return res.status(200).json({
        html: '<p class="text-sm text-gray-300">Gambar diterima, tetapi analisis visual lanjutan sedang dipulihkan bertahap.</p>'
      });
    }

    // Determine FCA status from user message or body
    var fcaConfirmed = isFCAConfirmed(body.fcaStatus, chatMessage || '');

    // Chat mode
    if (source === 'chat_mode' && chatMessage) {
      var prompt = 'Kamu Auto-Cuan AI, teman trading santai. Jawab singkat dalam HTML (p, strong, ul, li). Bahasa Indonesia. Jangan format report.' +
        (fcaConfirmed ? '' : ' JANGAN sebut FCA/Full Call Auction.');
      var html = await callGemini(GEMINI_API_KEY, prompt, chatMessage);
      if (!html) return res.status(200).json({ html: '<p class="text-sm text-red-400">AI tidak tersedia saat ini.</p>' });
      return res.status(200).json({ html: sanitizeOutput(html, fcaConfirmed) });
    }

    // Ticker mode
    if (ticker && currentPrice) {
      var tPrompt = 'Kamu Auto-Cuan AI. User tanya ' + String(ticker).toUpperCase() + ' harga Rp ' + currentPrice + '. Jawab singkat: estimasi support/resistance, saran upload chart. HTML (p, strong).' +
        (fcaConfirmed ? '' : ' JANGAN sebut FCA/Full Call Auction.');
      var tHtml = await callGemini(GEMINI_API_KEY, tPrompt, '');
      if (!tHtml) {
        return res.status(200).json({ html: '<p class="text-sm text-gray-300"><strong>' + String(ticker).toUpperCase() + '</strong> Rp ' + currentPrice + ' — Upload chart 1W/1D/4H untuk analisis lengkap.</p>' });
      }
      return res.status(200).json({ html: sanitizeOutput(tHtml, fcaConfirmed) });
    }

    return res.status(400).json({ error: 'Kirim ticker+harga atau gunakan mode chat/upload.' });

  } catch (err) {
    console.error('analyze error:', err);
    return res.status(200).json({ html: '<p class="text-sm text-red-400">Terjadi kesalahan. Coba lagi.</p>' });
  }
};

async function callGemini(apiKey, systemPrompt, userMessage) {
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + apiKey;
  var payload = {
    contents: [{ parts: [{ text: systemPrompt + '\n\nUser: ' + userMessage }] }],
    generationConfig: { temperature: 0.6, topP: 0.9, maxOutputTokens: 1024 }
  };

  var response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) return null;
  var result = await response.json();
  var candidates = result.candidates || [];
  if (candidates.length > 0 && candidates[0].content && candidates[0].content.parts && candidates[0].content.parts[0]) {
    var text = candidates[0].content.parts[0].text || '';
    return text.replace(/^```html\s*/i, '').replace(/```\s*$/i, '');
  }
  return null;
}

// === OUTPUT SANITIZER ===
function sanitizeOutput(html, fcaConfirmed) {
  if (!html) return html;
  var output = html;

  // A. FCA Guard — remove all FCA content if not confirmed
  if (!fcaConfirmed) {
    // Remove HTML elements containing FCA terms
    output = output.replace(/<(?:p|li|span|strong|div|h[1-6])[^>]*>[^<]*(?:FCA|Full\s*Call\s*Auction|papan\s*pemantauan\s*khusus|saham\s*FCA|risiko\s*FCA|FCA\s*score\s*cap|Position\s*Sizing\s*FCA|PERINGATAN\s*FCA)[^<]*<\/(?:p|li|span|strong|div|h[1-6])>/gi, '');
    // Remove remaining inline FCA text
    output = output.replace(/(?:Status\s+FCA\s*:\s*[^<.]*\.?)/gi, '');
  }

  // B. Remove report-style headers (always, since we default to conversational)
  output = output.replace(/\d+\.\s*INPUT QUALITY[^<]*/gi, '');
  output = output.replace(/\d+\.\s*TECHNICAL ANALYSIS[^<]*/gi, '');
  output = output.replace(/\d+\.\s*RISK MANAGEMENT[^<]*/gi, '');
  output = output.replace(/\d+\.\s*SCORE\s*&?\s*DECISION[^<]*/gi, '');
  output = output.replace(/\d+\.\s*WHAT COULD GO WRONG[^<]*/gi, '');
  output = output.replace(/\d+\.\s*ACTION PLAN[^<]*/gi, '');
  output = output.replace(/INPUT QUALITY\s*&?\s*EVIDENCE SUMMARY[^<]*/gi, '');

  // C. Remove empty paragraphs left over
  output = output.replace(/<p[^>]*>\s*<\/p>/gi, '');

  return output;
}

// === FCA STATUS CHECK ===
function isFCAConfirmed(bodyFcaStatus, message) {
  // Confirmed by system (from frontend FCA mapping or previous confirmation)
  if (bodyFcaStatus === 'confirmed_by_mapping' ||
      bodyFcaStatus === 'confirmed_by_user' ||
      bodyFcaStatus === 'confirmed_by_uploaded_evidence') {
    return true;
  }
  // Confirmed by user explicitly mentioning FCA in message
  if (message && /\b(?:FCA|full\s*call\s*auction|papan\s*pemantauan\s*khusus|saham\s*ini\s*FCA|masuk\s*FCA)\b/i.test(message)) {
    return true;
  }
  return false;
}
