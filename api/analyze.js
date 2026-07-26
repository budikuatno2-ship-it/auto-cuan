'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const handlePortfolioAI = require('../lib/portfolio-ai');

const sourcePath = path.join(__dirname, '..', 'lib', 'analyze-legacy.js');
const virtualPath = path.join(__dirname, 'analyze-legacy.virtual.js');
const legacyModule = new Module(virtualPath, module);
legacyModule.filename = virtualPath;
legacyModule.paths = Module._nodeModulePaths(__dirname);
legacyModule._compile(fs.readFileSync(sourcePath, 'utf8'), virtualPath);
const legacyAnalyze = legacyModule.exports;

module.exports = async function handler(req, res) {
  if (req && req.method === 'POST' && req.body && req.body.source === 'portfolio_chat') {
    return handlePortfolioAI(req, res);
  }
  return legacyAnalyze(req, res);
};
