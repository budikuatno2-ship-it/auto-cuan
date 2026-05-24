/**
 * Output Sanitizer - Clean AI output before rendering
 * Handles: FCA guard, empty section removal, report style guard, trading plan guard, news question append
 */

// FCA-related terms to remove when FCA is not confirmed
const FCA_TERMS = [
  'FCA',
  'Full Call Auction',
  'papan pemantauan khusus',
  'saham FCA',
  'risiko FCA',
  'Risiko FCA',
  'FCA score cap',
  'Position Sizing FCA',
  'PERINGATAN FCA',
  'FCA Check',
  'FCA Risk',
  'status FCA',
  'Status FCA'
];

// Report-style headers to remove in conversational mode
const REPORT_HEADERS = [
  /\d+\.\s*INPUT QUALITY/gi,
  /\d+\.\s*TECHNICAL ANALYSIS/gi,
  /\d+\.\s*RISK MANAGEMENT/gi,
  /\d+\.\s*SCORE\s*&?\s*DECISION/gi,
  /\d+\.\s*ACTION PLAN/gi,
  /\d+\.\s*WHAT COULD GO WRONG/gi,
  /INPUT QUALITY\s*&?\s*EVIDENCE SUMMARY/gi,
  /\d+\.\s*DATA YANG TERBACA/gi,
  /\d+\.\s*BIAS\s*\d/gi,
  /\d+\.\s*LEVEL PENTING/gi,
  /\d+\.\s*ENTRY\s*\/?\s*SL\s*\/?\s*TP/gi,
  /\d+\.\s*RISIKO UTAMA/gi,
  /\d+\.\s*KESIMPULAN\s*CEPAT/gi,
];

/**
 * Sanitize AI output based on context
 * @param {string} html - Raw AI HTML output
 * @param {object} options - { fcaStatus, responseMode, hasChart, hasNews, hasBrokerSummary }
 * @returns {string} Sanitized HTML
 */
function sanitizeOutput(html, options = {}) {
  if (!html) return html;

  const { fcaStatus, responseMode, hasChart, hasNews, hasBrokerSummary } = options;
  let output = html;

  // A. FCA Guard - Remove FCA content if not confirmed
  if (!isFCAConfirmed(fcaStatus)) {
    output = removeFCAContent(output);
  }

  // B. Empty Section Guard
  output = removeEmptySections(output);

  // C. Report Style Guard (only for non-full-analysis modes)
  if (responseMode && responseMode !== 'full_analysis') {
    output = cleanReportHeaders(output);
  }

  // D. Remove redundant disclaimers
  output = cleanDisclaimers(output);

  // E. Clean up empty divs and unnecessary whitespace
  output = cleanEmptyElements(output);

  return output;
}

/**
 * Check if FCA status is confirmed
 */
function isFCAConfirmed(fcaStatus) {
  return fcaStatus === 'confirmed_by_mapping' ||
         fcaStatus === 'confirmed_by_user' ||
         fcaStatus === 'confirmed_by_uploaded_evidence';
}

/**
 * Remove all FCA-related paragraphs/sections from HTML
 */
function removeFCAContent(html) {
  let output = html;

  // Remove entire div sections containing FCA terms
  output = output.replace(/<div[^>]*>[\s\S]*?<\/div>/gi, function(match) {
    const textContent = match.replace(/<[^>]*>/g, '');
    // Check if this div contains any FCA-related term
    if (/FCA|Full\s*Call\s*Auction|papan\s*pemantauan\s*khusus/i.test(textContent)) {
      // Remove the div if it's an FCA-specific section (< 2000 chars or has FCA keywords in heading-like content)
      if (textContent.length < 2000 || /fca\s*(check|risk|warning|status|score|cap)/i.test(textContent)) {
        return '';
      }
      // For larger divs, strip FCA sentences but keep the rest
      return match.replace(/<(?:p|li|span|strong|h[1-6]|div)[^>]*>[^<]*(?:FCA|Full\s*Call\s*Auction|papan\s*pemantauan\s*khusus|saham\s*FCA|risiko\s*FCA|Position\s*Sizing\s*FCA|FCA\s*score\s*cap|PERINGATAN\s*FCA|FCA\s*Check|FCA\s*Risk|status\s*FCA|Status\s*FCA)[^<]*<\/(?:p|li|span|strong|h[1-6]|div)>/gi, '');
    }
    return match;
  });

  // Remove individual paragraphs/list items mentioning FCA (catch-all pass)
  output = output.replace(/<(?:p|li|span|strong|h[1-6])[^>]*>[^<]*(?:FCA|Full\s*Call\s*Auction|papan\s*pemantauan\s*khusus|saham\s*FCA|risiko\s*FCA|Position\s*Sizing\s*FCA|FCA\s*score\s*cap|PERINGATAN\s*FCA|FCA\s*Check|FCA\s*Risk)[^<]*<\/(?:p|li|span|strong|h[1-6])>/gi, '');

  // Remove remaining inline FCA text that might leak through
  output = output.replace(/(?:Status\s+FCA\s*:\s*(?:not_detected|Tidak terdeteksi|Tidak ada)[^<.]*\.?)/gi, '');
  output = output.replace(/(?:FCA\s*\/\s*Full\s*Call\s*Auction\s*Risk\s*Check)/gi, '');
  
  // Final safety pass: remove any remaining standalone FCA mentions in sentences
  output = output.replace(/[^<>]*\b(?:FCA|Full\s*Call\s*Auction|papan\s*pemantauan\s*khusus)\b[^<>]*/gi, function(match) {
    // Only remove if it's inside an HTML tag content (not an attribute)
    // This prevents removing text that's inside larger important content
    if (match.trim().length < 200) return '';
    return match;
  });

  return output;
}

/**
 * Remove empty sections (Final Note, warnings, etc.)
 */
function removeEmptySections(html) {
  let output = html;

  // Remove sections where content after heading is minimal
  output = output.replace(/<div[^>]*>\s*<(?:h[2-4]|p[^>]*class[^>]*font-semibold)[^>]*>[^<]*(?:Final Note|Catatan Akhir|Peringatan|Warning|FCA Check|Broker Summary Check|News Check)[^<]*<\/(?:h[2-4]|p)>\s*(?:<(?:p|div)[^>]*>\s*(?:&nbsp;|\s|-)*\s*<\/(?:p|div)>\s*)*<\/div>/gi, '');

  // Remove div blocks that are essentially empty (only whitespace/empty paragraphs)
  output = output.replace(/<div[^>]*>\s*(?:<p[^>]*>\s*<\/p>\s*)*\s*<\/div>/gi, '');

  return output;
}

/**
 * Remove numbered report headers in conversational mode
 */
function cleanReportHeaders(html) {
  let output = html;
  for (const pattern of REPORT_HEADERS) {
    output = output.replace(pattern, '');
  }
  return output;
}

/**
 * Reduce verbose disclaimers to a single short line
 */
function cleanDisclaimers(html) {
  let output = html;

  // Remove long disclaimer blocks, keep only short ones
  const longDisclaimerPattern = /<(?:p|div)[^>]*>[^<]*(?:Disclaimer|DISCLAIMER|disclaimer)[^<]*(?:bukan\s*(?:merupakan\s*)?(?:saran|rekomendasi)\s*(?:investasi|jual|beli)[^<]*){2,}<\/(?:p|div)>/gi;
  output = output.replace(longDisclaimerPattern, '');

  // Remove repetitive disclaimers (keep first occurrence)
  let disclaimerCount = 0;
  output = output.replace(/<(?:p|div|span)[^>]*>[^<]*(?:bukan\s*(?:merupakan\s*)?(?:saran|rekomendasi)\s*(?:investasi|jual|beli))[^<]*<\/(?:p|div|span)>/gi, function(match) {
    disclaimerCount++;
    if (disclaimerCount > 1) return '';
    return match;
  });

  return output;
}

/**
 * Clean empty HTML elements
 */
function cleanEmptyElements(html) {
  let output = html;
  // Remove empty paragraphs
  output = output.replace(/<p[^>]*>\s*<\/p>/gi, '');
  // Remove consecutive <br> tags (more than 2)
  output = output.replace(/(<br\s*\/?>[\s]*){3,}/gi, '<br><br>');
  // Remove empty list items
  output = output.replace(/<li[^>]*>\s*<\/li>/gi, '');
  // Remove empty unordered lists
  output = output.replace(/<ul[^>]*>\s*<\/ul>/gi, '');
  return output;
}

/**
 * Generate news follow-up question if needed
 * @param {object} context - { hasNews, hasCorporateAction, hasChart }
 * @returns {string|null} HTML follow-up question or null
 */
function generateNewsFollowUp(context) {
  if (!context) return null;
  if (context.hasNews || context.hasCorporateAction) return null;
  if (!context.hasChart && !context.hasTicker) return null;

  return '<p class="text-sm text-gray-400 mt-3 italic">Ada news atau corporate action terbaru terkait saham ini? Kalau ada, kirim link/screenshot/ringkasannya supaya penilaian bisa diperbarui.</p>';
}

module.exports = { sanitizeOutput, isFCAConfirmed, removeFCAContent, generateNewsFollowUp };
