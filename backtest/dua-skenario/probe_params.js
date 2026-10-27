'use strict';

const { execFileSync } = require('child_process');

const SSH_KEY_PATH = 'D:\\Private Key Oracle\\ssh-key-2026-07-02.key';
const VPS_HOST = 'ubuntu@168.110.221.197';

function probeParams() {
  const remoteScript = `
    const fs = require('fs');
    let key = '';
    const envCandidates = ['/home/ubuntu/auto-cuan/.env.ai-eval-once', '/home/ubuntu/auto-cuan/.env'];
    for (const f of envCandidates) {
      if (fs.existsSync(f)) {
        const m = fs.readFileSync(f, 'utf8').match(/^ARJUM_API_KEY=(.*)$/m);
        if (m) { key = m[1].trim().replace(/^['"]|['"]$/g, ''); break; }
      }
    }
    async function test() {
      // Test different param styles: to_date, end_date, start_date
      const urls = [
        'https://stock.arjum.com/api/history/BRPT?limit=500&frame=daily&end_date=2024-01-01',
        'https://stock.arjum.com/api/history/BRPT?limit=500&frame=daily&to=2024-01-01',
        'https://stock.arjum.com/api/history/BRPT?limit=1000&frame=daily'
      ];
      for (const u of urls) {
        const r = await fetch(u, { headers: { 'X-API-Key': key } });
        const d = await r.json();
        const rows = d.rows || d.data || [];
        console.log(u.split('?')[1], '-> Status:', r.status, 'Rows:', rows.length, 'Earliest:', rows[rows.length-1]?.date, 'Latest:', rows[0]?.date);
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

probeParams();
