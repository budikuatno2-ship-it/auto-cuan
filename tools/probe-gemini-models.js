'use strict';

const fs = require('fs');
const path = require('path');

// Try to read .env file if present
function loadEnv() {
  const candidates = [
    path.join(__dirname, '..', '.env'),
    path.join(__dirname, '..', '.env.local'),
    path.join(process.env.USERPROFILE || 'C:\\Users\\ADVAN', '.env')
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        const content = fs.readFileSync(p, 'utf8');
        for (const line of content.split('\n')) {
          const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)?\s*$/);
          if (match && match[1] && match[2]) {
            const val = match[2].trim().replace(/^['"]|['"]$/g, '');
            if (!process.env[match[1]]) {
              process.env[match[1]] = val;
            }
          }
        }
      } catch (_) {}
    }
  }
}

loadEnv();

const apiKey = (
  process.env.API_KEY_ANALISA_SAHAM_PORTOFOLIO ||
  process.env.GEMINI_API_KEY ||
  process.argv[2] ||
  ''
).trim();

if (!apiKey) {
  console.error('ERROR: No Gemini API Key found in environment, .env, or CLI arguments.');
  console.error('Usage: node tools/probe-gemini-models.js [API_KEY]');
  process.exit(1);
}

const candidateModels = [
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-2.5-flash-thinking',
  'gemini-3-flash',
  'gemini-3.0-flash',
  'gemini-3.0-flash-preview',
  'gemini-3.1-flash',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  'gemini-3.7-flash',
  'gemini-3.8-flash',
  'gemini-3-pro',
  'gemini-3.8-pro'
];

async function probe() {
  console.log(`Testing Gemini API Key: ${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`);
  console.log('Fetching official model list from Google API...');
  
  let availableList = [];
  try {
    const listRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`);
    if (listRes.status === 200) {
      const data = await listRes.json();
      availableList = (data.models || []).map(m => m.name.replace(/^models\//, ''));
      console.log(`Found ${availableList.length} total models returned by Google.`);
    } else {
      console.log(`models.list returned HTTP ${listRes.status}: ${(await listRes.text()).slice(0, 200)}`);
    }
  } catch (err) {
    console.log(`models.list error: ${err.message}`);
  }

  console.log('\n| Model Name | HTTP Status | Outcome | Available in models.list? |');
  console.log('| :--- | :---: | :--- | :---: |');

  const results = [];

  for (const model of candidateModels) {
    const inList = availableList.includes(model) ? 'Yes' : 'No';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Ping' }] }]
        })
      });

      const bodyText = await res.text();
      let outcome = 'OK';
      if (res.status === 200) {
        outcome = 'SUCCESS';
      } else if (res.status === 404) {
        outcome = 'NOT FOUND (404)';
      } else if (res.status === 400) {
        outcome = 'BAD REQUEST (400)';
      } else if (res.status === 403) {
        outcome = 'BLOCKED (403)';
      } else {
        outcome = `HTTP ${res.status}`;
      }

      console.log(`| \`${model}\` | **${res.status}** | ${outcome} | ${inList} |`);
      results.push({ model, status: res.status, outcome, inList });
    } catch (e) {
      console.log(`| \`${model}\` | **ERROR** | ${e.message} | ${inList} |`);
      results.push({ model, status: 'ERROR', outcome: e.message, inList });
    }
  }

  return results;
}

probe().then(() => {
  console.log('\nProbe finished.');
}).catch(console.error);
