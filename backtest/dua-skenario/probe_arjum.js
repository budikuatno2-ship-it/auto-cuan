'use strict';

const fs = require('fs');
const path = require('path');

function getApiKey() {
  const envContent = fs.readFileSync(path.join(__dirname, '..', '..', '.env'), 'utf8');
  const m = envContent.match(/^ARJUM_API_KEY=(.*)$/m);
  if (!m) throw new Error('ARJUM_API_KEY not found in .env');
  return m[1].trim().replace(/^['"]|['"]$/g, '');
}

async function probe() {
  const key = getApiKey();
  const url = 'https://stock.arjum.com/api/history/BRPT?limit=5000&frame=daily';
  console.log('Sending single GET probe to Arjum API for BRPT...');
  const res = await fetch(url, {
    headers: {
      'X-API-Key': key,
      'Accept': 'application/json'
    }
  });

  console.log('Response Status:', res.status, res.statusText);
  const data = await res.json();
  const rows = data.rows || data.data || data.candles || [];
  console.log('Keys in response:', Object.keys(data));
  console.log('Stock code:', data.stock_code, 'Frame:', data.frame);
  console.log('Total rows returned:', rows.length);
  if (rows.length > 0) {
    console.log('Earliest row:', rows[rows.length - 1]);
    console.log('Latest row:', rows[0]);
  }
}

probe().catch(err => {
  console.error('Probe failed:', err.message);
});
