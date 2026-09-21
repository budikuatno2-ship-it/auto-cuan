'use strict';

const assert = require('assert');
const {
  generateGeminiContent,
  streamGeminiAnalysis
} = require('../lib/ai-gemini-provider');

let provenBugs = 0;

async function runBugProof(id, description, testFn) {
  try {
    await testFn();
    console.error(`[UNEXPECTED PASS] ${id}: Expected bug not reproduced!`);
  } catch (err) {
    if (err.name === 'AssertionError') {
      console.log(`[FAIL - BUG PROVEN] ${id} PROVEN: ${err.message}`);
      provenBugs++;
    } else {
      console.error(`[ERROR] ${id}: Unexpected error:`, err);
    }
  }
}

async function runTests() {
  console.log('--- Running lib/ai-gemini-provider.js Bug Reproduction Tests ---');

  // BUG-AGP-01: Multi-part candidate response is truncated to parts[0]
  await runBugProof('BUG-AGP-01', 'Multi-part candidate response is truncated to parts[0]', async () => {
    const fetchFnMultiPart = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                { text: 'Part 1: Analisis teknikal. ' },
                { text: 'Part 2: Rekomendasi trading.' }
              ]
            }
          }
        ]
      })
    });

    const result = await generateGeminiContent({
      apiKey: 'AIzaSyFakeKeyForTesting12345',
      prompt: 'test',
      fetchFn: fetchFnMultiPart
    });

    assert.strictEqual(
      result.text,
      'Part 1: Analisis teknikal. Part 2: Rekomendasi trading.',
      `Candidate with multiple parts must concatenate all text parts, got: "${result.text}"`
    );
  });

  // BUG-AGP-02: Deprecated model in options.model bypasses sanitizeGeminiModel
  await runBugProof('BUG-AGP-02', 'Deprecated model in options.model bypasses sanitizeGeminiModel', async () => {
    let requestedUrl = '';
    const fetchFnModel = async (url) => {
      requestedUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'Response' }] } }]
        })
      };
    };

    await generateGeminiContent({
      apiKey: 'AIzaSyFakeKeyForTesting12345',
      model: 'gemini-1.5-flash', // Explicitly deprecated in DEPRECATED_GEMINI_MODELS
      fetchFn: fetchFnModel
    });

    assert.strictEqual(
      requestedUrl.includes('gemini-1.5-flash'),
      false,
      `Deprecated model 'gemini-1.5-flash' must be sanitized and not sent in endpoint URL: ${requestedUrl}`
    );
  });

  // BUG-AGP-03: Mid-stream error in SSE payload is swallowed, returning truncated text as success
  await runBugProof('BUG-AGP-03', 'Mid-stream error in SSE payload is swallowed', async () => {
    const ssePayloadWithMidStreamError =
      'data: {"candidates": [{"content": {"parts": [{"text": "Analisis awal..."}]}}]}\n\n' +
      'data: {"error": {"code": 429, "message": "Resource has been exhausted", "status": "RESOURCE_EXHAUSTED"}}\n\n';

    const fetchFnStreamError = async () => ({
      ok: true,
      status: 200,
      text: async () => ssePayloadWithMidStreamError
    });

    let streamErrorCaught = null;
    try {
      await streamGeminiAnalysis({
        apiKey: 'AIzaSyFakeKeyForTesting12345',
        prompt: 'test',
        fetchFn: fetchFnStreamError
      });
    } catch (err) {
      streamErrorCaught = err;
    }

    assert.ok(
      streamErrorCaught && streamErrorCaught.code === 'GEMINI_RATE_LIMITED',
      `Stream with mid-stream 429 error must throw GEMINI_RATE_LIMITED error, but got: ${streamErrorCaught ? streamErrorCaught.message : 'no error (returned truncated success)'}`
    );
  });

  // BUG-AGP-04: Whitespace apiKey passes validation and triggers invalid upstream HTTP call
  await runBugProof('BUG-AGP-04', 'Whitespace apiKey passes validation', async () => {
    let fetchCalled = false;
    const fetchFnKey = async () => {
      fetchCalled = true;
      return { ok: false, status: 400 };
    };

    let keyErrorCaught = null;
    try {
      await generateGeminiContent({
        apiKey: '   ',
        prompt: 'test',
        fetchFn: fetchFnKey
      });
    } catch (err) {
      keyErrorCaught = err;
    }

    assert.strictEqual(
      keyErrorCaught && keyErrorCaught.code,
      'GEMINI_API_KEY_MISSING',
      `Whitespace apiKey must throw GEMINI_API_KEY_MISSING locally without calling fetch (fetchCalled=${fetchCalled}, got code=${keyErrorCaught && keyErrorCaught.code})`
    );
  });

  console.log(`\nProved ${provenBugs} of 4 bugs in lib/ai-gemini-provider.js.`);
}

runTests();
