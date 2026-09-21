const assert = require('assert');

function setupEnvironment() {
  const dom = {
    getElementById() { return null; }
  };
  global.document = dom;
  global.window = global;
  require('../public/chart-analysis-runtime');
}

async function runTests() {
  console.log('--- Running public/chart-analysis-runtime.js Bug Reproduction Tests ---');
  setupEnvironment();

  // BUG-CAR-01: formatAnalysisText fails to parse H3 (### ) or H1 (# ) headers
  console.log('\nTesting BUG-CAR-01: Markdown headers other than "## " rendered as raw text...');
  try {
    // Simulate internal formatAnalysisText by inspecting render output or HTML generator
    // formatAnalysisText lines.forEach checks only trimmed.startsWith('## ')
    const sampleAiOutput = '### Sinyal dan Rekomendasi\n- Support kuat di 5000\n- Resistance di 5200';

    // Mock DOM elements for triggerAiChartAnalysis
    let renderedHtml = '';
    const mockWrap = {
      style: {},
      dataset: {},
      set innerHTML(val) { renderedHtml = val; },
      get innerHTML() { return renderedHtml; }
    };

    global.document.getElementById = function(id) {
      if (id === 'aiChartAnalysisResultWrap' || id === 'unifiedAiChartResultWrap') return mockWrap;
      return null;
    };

    global.fetch = async function(url) {
      if (url.includes('action=status')) {
        return { ok: true, json: async () => ({ hasKey: true }) };
      }
      if (url.includes('action=analyze')) {
        return {
          ok: true,
          json: async () => ({
            success: true,
            data: {
              model: 'gemini-2.5-flash',
              analysisText: sampleAiOutput
            }
          })
        };
      }
      return { ok: false };
    };

    await global.triggerAiChartAnalysis('BBCA');
    await new Promise(r => setTimeout(r, 50));

    // The heading "### Sinyal dan Rekomendasi" should be parsed into a styled section header
    // But since it starts with ### instead of ##, it is rendered as raw "### Sinyal dan Rekomendasi"
    assert.strictEqual(
      renderedHtml.includes('### Sinyal dan Rekomendasi'),
      false,
      `BUG-CAR-01 PROVEN: Heading "### Sinyal dan Rekomendasi" was not parsed as a header and rendered as raw text with hashes`
    );
  } catch (err) {
    console.log('   [FAIL - BUG PROVEN]', err.message);
  }

  // BUG-CAR-02: copyChartVisionResult crashes with TypeError when called without element parameter
  console.log('\nTesting BUG-CAR-02: copyChartVisionResult TypeError on undefined parameter...');
  try {
    let errorThrown = null;
    try {
      // Calling programmatically or via un-bound event listener
      global.copyChartVisionResult();
    } catch (e) {
      errorThrown = e;
    }

    assert.strictEqual(
      errorThrown === null,
      true,
      `BUG-CAR-02 PROVEN: copyChartVisionResult crashed with ${errorThrown && errorThrown.name}: ${errorThrown && errorThrown.message}`
    );
  } catch (err) {
    console.log('   [FAIL - BUG PROVEN]', err.message);
  }

  // BUG-CAR-03: Concurrent duplicate calls to triggerAiChartAnalysis trigger parallel AI API calls
  console.log('\nTesting BUG-CAR-03: Duplicate concurrent analysis triggers burning user quota...');
  try {
    let analyzeCallCount = 0;
    global.fetch = async function(url) {
      if (url.includes('action=status')) {
        return { ok: true, json: async () => ({ hasKey: true }) };
      }
      if (url.includes('action=analyze')) {
        analyzeCallCount++;
        await new Promise(r => setTimeout(r, 50));
        return {
          ok: true,
          json: async () => ({ success: true, data: { analysisText: 'Result' } })
        };
      }
      return { ok: false };
    };

    // Rapid double-click
    const p1 = global.triggerAiChartAnalysis('BBCA');
    const p2 = global.triggerAiChartAnalysis('BBCA');
    await Promise.all([p1, p2]);

    assert.strictEqual(
      analyzeCallCount,
      1,
      `BUG-CAR-03 PROVEN: Double click dispatched ${analyzeCallCount} parallel AI vision calls without in-flight locking, burning quota twice`
    );
  } catch (err) {
    console.log('   [FAIL - BUG PROVEN]', err.message);
  }
}

runTests();
