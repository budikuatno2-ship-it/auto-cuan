#!/bin/bash
D=/home/ubuntu/auto-cuan/data/arjum-data/broker-summary-F

echo "=== 1. SEBARAN UKURAN FILE ==="
echo -n "Files < 300 bytes: "
find $D -name '*.json' -size -300c | wc -l
echo -n "Min / Median / Max size: "
find $D -name '*.json' -printf '%s\n' | sort -n | awk '{a[NR]=$1} END{print "min",a[1],"median",a[int(NR/2)],"max",a[NR]}'

echo ""
echo "=== 2. FILE BERISI ERROR/KUOTA ==="
grep -rlis 'error\|quota\|limit\|too many\|unauthorized' $D | wc -l

echo ""
echo "=== 3. ISI VALID (NODE) ==="
node -e '
const fs = require("fs");
const path = require("path");

const D = "/home/ubuntu/auto-cuan/data/arjum-data/broker-summary-F";
let total = 0, corrupted = 0, emptyBrokers = 0, validWithBrokers = 0;
let smallestFiles = [];

const tickers = fs.readdirSync(D);
for (const t of tickers) {
  const tDir = path.join(D, t);
  if (!fs.statSync(tDir).isDirectory()) continue;
  const files = fs.readdirSync(tDir).filter(f => f.endsWith(".json"));
  for (const f of files) {
    total++;
    const p = path.join(tDir, f);
    const size = fs.statSync(p).size;
    try {
      const content = fs.readFileSync(p, "utf8");
      const parsed = JSON.parse(content);
      const brokers = Array.isArray(parsed.brokers) ? parsed.brokers : [];
      if (brokers.length === 0) {
        emptyBrokers++;
      } else {
        validWithBrokers++;
      }
      if (smallestFiles.length < 5 || size < smallestFiles[smallestFiles.length - 1].size) {
        smallestFiles.push({ path: p, size, content });
        smallestFiles.sort((a, b) => a.size - b.size);
        if (smallestFiles.length > 5) smallestFiles.pop();
      }
    } catch (e) {
      corrupted++;
    }
  }
}

console.log(JSON.stringify({ total, corrupted, emptyBrokers, validWithBrokers }, null, 2));
console.log("\n--- 2 Contoh File Terkecil ---");
for (let i = 0; i < Math.min(2, smallestFiles.length); i++) {
  console.log(`[Contoh ${i + 1}] File: ${smallestFiles[i].path} (Size: ${smallestFiles[i].size} bytes)`);
  console.log(smallestFiles[i].content.slice(0, 300));
  console.log("...");
}
'

echo ""
echo "=== 4. WAKTU TULIS FILE PER JAM ==="
find $D -name '*.json' -printf '%TY-%Tm-%Td %TH\n' | sort | uniq -c

echo ""
echo "=== 5. CEK BRPT 2026-09-08 ==="
node -e '
const fs = require("fs");
const p = "/home/ubuntu/auto-cuan/data/arjum-data/broker-summary-F/BRPT/2026-09-08.json";
if (!fs.existsSync(p)) {
  console.log("File tidak ditemukan!");
  process.exit(1);
}
const data = JSON.parse(fs.readFileSync(p, "utf8"));
let buyVal = 0, sellVal = 0;
for (const b of (data.brokers || [])) {
  buyVal += Number(b.bval || b.buy_val || 0);
  sellVal += Number(b.sval || b.sell_val || 0);
}
console.log({
  stock_code: data.stock_code,
  date: data.broker_start_date || data.date,
  brokers_count: (data.brokers || []).length,
  total_buy_val: buyVal,
  expected_buy_val: 4438308000,
  buy_match: buyVal === 4438308000,
  total_sell_val: sellVal,
  expected_sell_val: 8213926000,
  sell_match: sellVal === 8213926000
});
'

echo ""
echo "=== 6. LOG 429 / REMAINING / LIMIT ==="
grep -i 'remaining\|429\|limit' /home/ubuntu/auto-cuan/data/arjum-data/_backfill/backfill-foreign.log | tail -20
