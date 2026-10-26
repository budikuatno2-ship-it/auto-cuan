'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SSH_KEY_PATH = 'D:\\Private Key Oracle\\ssh-key-2026-07-02.key';
const VPS_HOST = 'ubuntu@168.110.221.197';

function runSsh(remoteCmd) {
  const args = [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=15',
    '-i', SSH_KEY_PATH,
    VPS_HOST,
    remoteCmd
  ];
  return execFileSync('ssh', args, { maxBuffer: 15 * 1024 * 1024, encoding: 'utf8' });
}

function inspect() {
  console.log('Inspecting Arjum candles on VPS...');
  const remoteCmd = `
    node -e '
      const fs = require("fs");
      const dir = "/home/ubuntu/auto-cuan/data/daily-candles";
      if (!fs.existsSync(dir)) { console.log("Dir does not exist"); process.exit(0); }
      const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
      console.log("Total Arjum files:", files.length);

      let minBars = 99999, maxBars = 0, ge300 = 0, lt300 = 0;
      let minDate = "9999-99-99", maxDate = "0000-00-00";
      const sampleCounts = [];

      for (let i = 0; i < files.length; i++) {
        try {
          const d = JSON.parse(fs.readFileSync(dir + "/" + files[i], "utf8"));
          const n = d.candles ? d.candles.length : 0;
          if (n < minBars) minBars = n;
          if (n > maxBars) maxBars = n;
          if (n >= 300) ge300++; else lt300++;
          if (d.candles && d.candles.length > 0) {
            const first = d.candles[0].date;
            const last = d.candles[d.candles.length - 1].date;
            if (first && first < minDate) minDate = first;
            if (last && last > maxDate) maxDate = last;
          }
          if (i < 5) sampleCounts.push({ file: files[i], bars: n, source: d.source, range: d.range });
        } catch(e) {}
      }

      console.log("Min bars:", minBars, "Max bars:", maxBars);
      console.log("Files >= 300 bars:", ge300, "| < 300 bars:", lt300);
      console.log("Date bounds:", minDate, "to", maxDate);
      console.log("Samples:", JSON.stringify(sampleCounts));
    '
  `;

  const out = runSsh(remoteCmd.trim());
  console.log(out);
}

inspect();
