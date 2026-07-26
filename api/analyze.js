'use strict';

const handleContextAI = require('../lib/context-ai-router-v5');
const legacyAnalyze = require('../lib/analyze-legacy');

module.exports = async function handler(req, res) {
  const source = req && req.method === 'POST' && req.body && req.body.source;
  if (source === 'portfolio_chat' || source === 'stock_analysis_followup') {
    return handleContextAI(req, res);
  }
  return legacyAnalyze(req, res);
};
