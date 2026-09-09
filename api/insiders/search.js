'use strict';

const insiderNetworkService = require('../../lib/insider-network-service');

module.exports = async function handler(req, res) {
  try {
    const query = (req.query && (req.query.query || req.query.name || req.query.q)) || '';
    const limit = (req.query && Number(req.query.limit)) || 10;
    const results = insiderNetworkService.searchInsiders(query, { limit });
    return res.status(200).json({ success: true, results });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message || String(err) });
  }
};
