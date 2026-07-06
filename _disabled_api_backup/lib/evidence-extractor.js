/**
 * Evidence Extractor - Process and summarize uploaded evidence
 * Stores compact summaries, never raw base64 or huge OCR dumps
 */

/**
 * Build compact image metadata (without storing base64)
 * @param {Array} images - Array of { data, mimeType, filename, timeframe }
 * @returns {object} Compact summary
 */
function extractImageEvidence(images) {
  if (!images || images.length === 0) return null;

  const summary = {
    count: images.length,
    timeframes: [],
    filenames: [],
    hasMultiTimeframe: false
  };

  images.forEach(img => {
    const tf = img.timeframe || detectTimeframeFromName(img.filename);
    if (tf) summary.timeframes.push(tf);
    if (img.filename) summary.filenames.push(String(img.filename).slice(0, 50));
  });

  summary.hasMultiTimeframe = summary.timeframes.length >= 2;
  summary.timeframeLabel = summary.timeframes.length > 0
    ? summary.timeframes.join(' + ')
    : 'Unknown';

  return summary;
}

/**
 * Extract document evidence summaries
 * @param {Array} documents - Array of { text, filename, type }
 * @returns {object} Compact document summary
 */
function extractDocumentEvidence(documents) {
  if (!documents || documents.length === 0) return null;

  const validDocs = documents.filter(d => d.text && d.text.trim().length > 0);
  if (validDocs.length === 0) return null;

  const summary = {
    count: validDocs.length,
    types: [],
    totalChars: 0,
    hasBrokerData: false,
    hasNewsData: false,
    hasCorporateAction: false
  };

  validDocs.forEach(doc => {
    const textLower = (doc.text || '').toLowerCase();
    summary.totalChars += doc.text.length;
    if (doc.type) summary.types.push(doc.type);

    // Detect content type
    if (/broker|net\s*buy|net\s*sell|top\s*buyer|top\s*seller/i.test(textLower)) {
      summary.hasBrokerData = true;
    }
    if (/news|berita|katalis|catalyst|earnings|laba|rugi/i.test(textLower)) {
      summary.hasNewsData = true;
    }
    if (/right\s*issue|stock\s*split|dividen|corporate\s*action|merger|akuisisi/i.test(textLower)) {
      summary.hasCorporateAction = true;
    }
  });

  return summary;
}

/**
 * Calculate evidence level from available data
 * @param {object} params - { hasImages, imageCount, hasDocuments, hasBrokerData, hasNewsData }
 * @returns {number} Evidence level 1-6
 */
function calculateEvidenceLevel(params) {
  const { hasImages, imageCount, hasDocuments, hasBrokerData, hasNewsData } = params;

  if (!hasImages && !hasDocuments) return 1;
  if (imageCount === 1 && !hasDocuments) return 2;
  if (imageCount >= 2 && !hasDocuments) return 3;
  if (imageCount === 1 && hasDocuments) return 4;
  if (imageCount >= 2 && hasDocuments) {
    // Check if multiple supporting evidence types
    let supportCount = 0;
    if (hasBrokerData) supportCount++;
    if (hasNewsData) supportCount++;
    if (supportCount >= 2) return 6;
    return 5;
  }
  if (hasDocuments && !hasImages) return 2;
  return 1;
}

/**
 * Get score cap based on evidence level
 */
function getScoreCap(evidenceLevel) {
  const caps = { 1: 55, 2: 70, 3: 80, 4: 85, 5: 90, 6: 95 };
  return caps[evidenceLevel] || 55;
}

/**
 * Detect timeframe from filename
 */
function detectTimeframeFromName(filename) {
  if (!filename) return null;
  const f = filename.toLowerCase();
  if (/1w|weekly|1\s*week|minggu/i.test(f)) return '1W';
  if (/1d|daily|1\s*day|harian/i.test(f)) return '1D';
  if (/4h|4\s*hour|4\s*jam/i.test(f)) return '4H';
  if (/1h|1\s*hour|1\s*jam/i.test(f)) return '1H';
  if (/15m|15\s*min/i.test(f)) return '15M';
  return null;
}

/**
 * Build evidence badges list for frontend display
 * @param {object} context - latestAnalysisContext
 * @returns {Array} badges like ['Chart', '1W', '1D', 'News', 'Broker Summary']
 */
function getEvidenceBadges(context) {
  const badges = [];
  if (!context) return badges;

  if (context.chartSummary || (context.detectedTimeframes && context.detectedTimeframes.length > 0)) {
    badges.push('Chart');
    if (context.detectedTimeframes) {
      context.detectedTimeframes.forEach(tf => {
        if (!badges.includes(tf)) badges.push(tf);
      });
    }
  }
  if (context.newsProvided || context.newsSummary) badges.push('News');
  if (context.brokerSummaryProvided || context.brokerSummaryBias) badges.push('Broker Summary');
  if (context.orderbookProvided || context.orderbookSummary) badges.push('Orderbook');
  if (context.marketMakerCodeSummary) badges.push('MM Code');
  if (context.corporateActionSummary) badges.push('Corp Action');

  return badges;
}

module.exports = {
  extractImageEvidence,
  extractDocumentEvidence,
  calculateEvidenceLevel,
  getScoreCap,
  detectTimeframeFromName,
  getEvidenceBadges
};
