/**
 * IDX Access Diagnostic Endpoint (TEMPORARY)
 * Tests whether Vercel Serverless can access IDX without Cloudflare/WAF block.
 * 
 * Usage: GET /api/idx-test
 * 
 * Returns diagnostics only — no secrets, no env values, no database writes.
 * Remove this file after testing.
 */

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var results = {};

  // Test 1: IDX homepage
  results.homepage = await testUrl('https://www.idx.co.id/id');

  // Test 2: IDX Stock Summary API endpoint
  results.stockSummary = await testUrl('https://www.idx.co.id/primary/TradingSummary/GetStockSummary?date=20260310');

  return res.status(200).json({
    timestamp: new Date().toISOString(),
    runtime: 'vercel-serverless',
    region: process.env.VERCEL_REGION || 'unknown',
    results: results
  });
};

async function testUrl(url) {
  var diag = {
    url: url,
    httpStatus: null,
    contentType: null,
    bodyLength: null,
    isJson: false,
    isHtml: false,
    cloudflareDetected: false,
    captchaDetected: false,
    bodyPreview: null,
    error: null,
    durationMs: null
  };

  var startTime = Date.now();

  try {
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, 15000);

    var response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8',
        'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7'
      },
      signal: controller.signal,
      redirect: 'follow'
    });
    clearTimeout(timeout);

    diag.httpStatus = response.status;
    diag.contentType = response.headers.get('content-type') || null;
    diag.durationMs = Date.now() - startTime;

    // Check Cloudflare headers
    var cfRay = response.headers.get('cf-ray');
    var server = response.headers.get('server') || '';
    if (cfRay || server.toLowerCase().indexOf('cloudflare') >= 0) {
      diag.cloudflareDetected = true;
    }

    // Read body
    var bodyText = await response.text();
    diag.bodyLength = bodyText.length;

    // Determine content type
    var ct = (diag.contentType || '').toLowerCase();
    if (ct.indexOf('application/json') >= 0) {
      diag.isJson = true;
      // Validate it's actually JSON
      try {
        JSON.parse(bodyText);
      } catch (e) {
        diag.isJson = false;
        diag.bodyPreview = bodyText.slice(0, 300);
      }
    } else if (ct.indexOf('text/html') >= 0 || bodyText.trimStart().startsWith('<')) {
      diag.isHtml = true;
      diag.bodyPreview = bodyText.slice(0, 300);
    } else {
      diag.bodyPreview = bodyText.slice(0, 300);
    }

    // Detect Cloudflare challenge / captcha markers in body
    var bodyLower = bodyText.toLowerCase();
    var cfMarkers = [
      'just a moment',
      'checking your browser',
      'cf-browser-verification',
      'cloudflare',
      'ray id',
      '_cf_chl',
      'challenge-platform',
      'turnstile'
    ];
    for (var i = 0; i < cfMarkers.length; i++) {
      if (bodyLower.indexOf(cfMarkers[i]) >= 0) {
        diag.cloudflareDetected = true;
        break;
      }
    }

    var captchaMarkers = [
      'captcha',
      'hcaptcha',
      'recaptcha',
      'challenge-form',
      'verify you are human',
      'please wait',
      'turnstile'
    ];
    for (var j = 0; j < captchaMarkers.length; j++) {
      if (bodyLower.indexOf(captchaMarkers[j]) >= 0) {
        diag.captchaDetected = true;
        break;
      }
    }

  } catch (e) {
    diag.durationMs = Date.now() - startTime;
    if (e.name === 'AbortError') {
      diag.error = 'timeout (15s)';
    } else {
      diag.error = (e.message || '').slice(0, 200);
    }
  }

  return diag;
}
