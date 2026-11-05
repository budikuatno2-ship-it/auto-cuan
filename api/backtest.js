'use strict';

const fs = require('fs');
const path = require('path');
const url = require('url');

const BACKTEST_DIR = path.join(__dirname, '..', 'data', 'backtest-per-ticker');

module.exports = async function handleBacktest(req, res) {
  try {
    const parsed = url.parse(req.url, true);
    const rawTicker = (req.query && req.query.ticker) || (parsed.query && parsed.query.ticker) || '';
    const ticker = String(rawTicker).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

    if (!ticker) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Ticker diperlukan.' }));
      return;
    }

    const filePath = path.join(BACKTEST_DIR, ticker + '.json');
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Data backtest ' + ticker + ' tidak ditemukan.' }));
      return;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(content);

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60'
    });
    res.end(JSON.stringify({
      success: true,
      ticker,
      data
    }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
};
