'use strict';

const insiderNetworkService = require('../../lib/insider-network-service');

module.exports = async function handler(req, res) {
  try {
    const query = (req.query && (req.query.query || req.query.name || req.query.q)) || '';
    const ticker = (req.query && req.query.ticker) || '';
    const graph = insiderNetworkService.buildInsiderNetworkGraph({
      name: query,
      ticker: ticker
    });
    return res.status(200).json(Object.assign({ success: true }, graph));
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message || String(err) });
  }
};
