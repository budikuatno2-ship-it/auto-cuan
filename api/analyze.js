'use strict';

const handleContextAI = require('../lib/context-ai-router-v5');
const legacyAnalyze = require('../lib/analyze-legacy');

function styleInstruction(source) {
  const focus = source === 'stock_analysis_followup'
    ? 'Fokus pada ticker dan snapshot analisis yang terbuka.'
    : 'Fokus pada posisi, alokasi, risiko, dan rencana yang tersimpan.';
  return [
    'Aturan jawaban wajib:',
    'gunakan bahasa Indonesia yang tenang, profesional, alami, dan ringkas; gunakan kata "kamu".',
    'Jangan gunakan bestie, lo, lu, gue, bahasa influencer, analogi dramatis, atau kalimat menakut-nakuti.',
    'Jawab langsung pada 1-2 kalimat pertama. Pertanyaan sederhana 80-180 kata; ringkasan 180-350 kata.',
    'Maksimal tiga bagian dan lima bullet. Jangan mengulang pertanyaan, kesimpulan, atau seluruh data.',
    'Jangan keluarkan --- atau heading kosong; hindari tabel Markdown.',
    'Bedakan data tersimpan dari harga real-time. Jangan mengarang angka, level, indikator, berita, atau kepastian harga.',
    'Beri satu langkah praktis, lalu berhenti.',
    focus
  ].join(' ');
}

function withResponseStyle(req) {
  const body = req && req.body && typeof req.body === 'object' ? req.body : {};
  const history = Array.isArray(body.history) ? body.history.slice(-3) : [];
  history.push({ role: 'user', content: styleInstruction(body.source) });
  req.body = Object.assign({}, body, { history });
  return req;
}

module.exports = async function handler(req, res) {
  const source = req && req.method === 'POST' && req.body && req.body.source;
  if (source === 'portfolio_chat' || source === 'stock_analysis_followup') {
    return handleContextAI(withResponseStyle(req), res);
  }
  return legacyAnalyze(req, res);
};
