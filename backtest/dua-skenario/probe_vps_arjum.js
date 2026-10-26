'use strict';

const { execFileSync } = require('child_process');

const SSH_KEY_PATH = 'D:\\Private Key Oracle\\ssh-key-2026-07-02.key';
const VPS_HOST = 'ubuntu@168.110.221.197';

function probeVps() {
  const remoteScript = `
    const fs = require('fs');
    let key = '';
    const envCandidates = [
      '/home/ubuntu/auto-cuan/.env.ai-eval-once',
      '/home/ubuntu/auto-cuan/.env',
      '/home/ubuntu/auto-cuan/.env.local',
      '/home/ubuntu/auto-cuan-runner/.env'
    ];
    for (const f of envCandidates) {
      if (fs.existsSync(f)) {
        const m = fs.readFileSync(f, 'utf8').match(/^ARJUM_API_KEY=(.*)$/m);
        if (m) { key = m[1].trim().replace(/^['"]|['"]$/g, ''); break; }
      }
    }
    if (!key) {
      console.log('No key found in candidate files');
      process.exit(1);
    }
    async function test() {
      const url = 'https://stock.arjum.com/api/history/BRPT?limit=500&frame=daily';
      try {
        const r = await fetch(url, { headers: { 'X-API-Key': key, 'Accept': 'application/json' } });
        console.log('VPS Probe Status:', r.status, r.statusText);
        const data = await r.json();
        console.log('Keys:', Object.keys(data));
        const rows = data.rows || data.data || [];
        console.log('Rows count:', rows.length);
        if (rows.length > 0) {
          console.log('Latest row:', rows[0].date, rows[0].close);
          console.log('Earliest row:', rows[rows.length - 1].date, rows[rows.length - 1].close);
        }
      } catch (err) {
        console.error('Fetch error:', err.message);
      }
    }
    test();
  `;

  const args = [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=15',
    '-i', SSH_KEY_PATH,
    VPS_HOST,
    `node -e "${remoteScript.replace(/\n\s+/g, ' ').replace(/"/g, '\\"')}"`
  ];

  const out = execFileSync('ssh', args, { encoding: 'utf8' });
  console.log(out);
}

probeVps();
