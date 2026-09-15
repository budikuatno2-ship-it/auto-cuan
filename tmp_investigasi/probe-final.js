'use strict';
// READ-ONLY: final confirmations.
//  (1) prod 1d vs 7d broker-summary: is multi-day just single-day x multiplier?
//  (2) prod Market Scanner per range: are 14d and 30d the same stock set?
const HOST = 'https://auto-cuan.vercel.app';

async function getJson(url) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 25000);
    const res = await fetch(url, { signal: c.signal });
    clearTimeout(t);
    const text = await res.text();
    try { return JSON.parse(text); } catch (_) { return { _raw: text.slice(0, 140) }; }
  } catch (e) { return { _err: String((e && e.message) || e) }; }
}

async function main() {
  console.log('--- BBCA: 1d vs 7d vs 30d total_buy_val (scaling check) ---');
  const out = {};
  for (const r of ['1d', '7d', '30d', '60d']) {
    const j = await getJson(`${HOST}/api/sector-hot?action=bandarmologi&ticker=BBCA&range=${r}`);
    const bs = j.broker_summary || {};
    out[r] = { total_buy_val: bs.total_buy_val, net_flow: bs.net_flow, date: bs.date };
    console.log(r, JSON.stringify(out[r]));
  }
  const base = out['1d'].total_buy_val;
  for (const r of ['7d', '30d', '60d']) {
    const ratio = base ? out[r].total_buy_val / base : null;
    console.log(`ratio ${r}/1d =`, ratio && ratio.toFixed(3));
  }

  console.log('\n--- Market Scanner: per-range S1/S2 sets ---');
  const sets = {};
  for (const r of ['1d', '5d', '7d', '14d', '30d', '60d']) {
    const j = await getJson(`${HOST}/api/sector-hot?action=bandarmologi-intel&range=${r}`);
    const idx = j.indexes || {};
    sets[r] = {
      updated_at: j.updated_at,
      s1: (idx.harga_di_bawah_modal_bandar || []).map(x => x.ticker),
      s2: (idx.silent_foreign_accumulation || []).map(x => x.ticker),
      s3: (idx.ritel_cutloss_bandar_nampung || []).map(x => x.ticker),
      s4: (idx.distribusi_ke_ritel || []).map(x => x.ticker),
      s5: (idx.cr3_massive || []).map(x => x.ticker)
    };
  }
  for (const r of Object.keys(sets)) {
    const s = sets[r];
    console.log(r, 'updated_at=', s.updated_at, 'S1=', s.s1.length, 'S2=', JSON.stringify(s.s2), 'S3=', JSON.stringify(s.s3), 'S4=', JSON.stringify(s.s4), 'S5=', s.s5.length);
  }
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  console.log('\nS1 14d == S1 30d ?', eq(sets['14d'].s1, sets['30d'].s1));
  console.log('S1 5d == S1 14d ?', eq(sets['5d'].s1, sets['14d'].s1));
  const inter = sets['14d'].s1.filter(t => sets['30d'].s1.includes(t));
  console.log('14d/30d intersection size =', inter.length, 'of', new Set(sets['14d'].s1.concat(sets['30d'].s1)).size, 'union');
}

main().catch(e => console.error('PROBE ERROR', e));
