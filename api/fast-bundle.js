'use strict';
/**
 * V3-F11 Fast-Bundle API — GET /api/fast-bundle?ticker=BBCA | ?tickers=BBCA,BBRI,BRPT,BULL
 * Menyajikan bundle prebuild + RAM cache sehingga warm <15ms.
 */
const fastBundle = require('../lib/fast-bundle');

function normList(v) {
  return String(v || '').split(',').map((s) => fastBundle.normTicker(s)).filter(Boolean).slice(0, 20);
}

module.exports = async function handler(req, res) {
  try {
    const q = (req && req.query) || {};
    let tickers = normList(q.tickers || q.ticker);
    if (!tickers.length) tickers = ['BBCA'];
    // Batasi agar respons tetap instan.
    tickers = tickers.slice(0, 10);
    const t0 = Date.now();
    const bundles = fastBundle.getBundles(tickers);
    const ms = Date.now() - t0;
    const payload = {
      success: true,
      version: fastBundle.VERSION,
      count: tickers.length,
      tickers,
      ms,
      cache: fastBundle.stats(),
      bundles
    };
    if (res && typeof res.setHeader === 'function') {
      res.setHeader('Cache-Control', 'public, max-age=30');
    }
    if (res && typeof res.status === 'function') return res.status(200).json(payload);
    return payload;
  } catch (err) {
    if (res && typeof res.status === 'function') {
      return res.status(400).json({ success: false, error: String((err && err.message) || err).slice(0, 200) });
    }
    throw err;
  }
};
