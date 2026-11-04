const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'data', 'money-sheets-local.json');

const initialStore = {
  "usr_admin_budi": {
    "2026-10": {
      "month": "2026-10",
      "revision": 1,
      "notes": "Refleksi keuangan bulan ini…",
      "sheet": {
        "version": 1,
        "rows": [
          { "id": "r1", "type": "income", "category": "Gaji", "label": "Gaji bulanan kantor", "amount": 25000000, "note": "Transfer tanggal 25", "formula": "" },
          { "id": "r2", "type": "income", "category": "Bisnis", "label": "Proyek konsultasi", "amount": 7500000, "note": "Klien freelance", "formula": "" },
          { "id": "r3", "type": "income", "category": "Dividen", "label": "Dividen interim saham", "amount": 2000000, "note": "Masuk RDN", "formula": "" },
          { "id": "r4", "type": "expense", "category": "Kebutuhan", "label": "Sewa tempat tinggal & listrik", "amount": 6500000, "note": "Rutin awal bulan", "formula": "" },
          { "id": "r5", "type": "expense", "category": "Kebutuhan", "label": "Belanja rumah tangga", "amount": 5500000, "note": "Supermarket & makan", "formula": "" },
          { "id": "r6", "type": "expense", "category": "Hiburan", "label": "Langganan & gym", "amount": 4500000, "note": "Streaming dan gym", "formula": "" },
          { "id": "r7", "type": "saving", "category": "Dana darurat", "label": "Setoran rekening khusus", "amount": 5000000, "note": "Target 6× pengeluaran", "formula": "" },
          { "id": "r8", "type": "transfer", "category": "Investasi", "label": "Tambahan modal RDN", "amount": 13000000, "note": "Transfer ke sekuritas", "formula": "" }
        ]
      }
    }
  }
};

fs.writeFileSync(filePath, JSON.stringify(initialStore, null, 2), 'utf8');
console.log('Saved initial money sheets to', filePath);
