'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { validateAnswer } = require('../lib/ai-answer-contract');
const { enrichCase, stockFacts } = require('../lib/ai-eval-derived-facts');
const { buildRetryDataset } = require('../tools/build-ai-eval-failed-retry-dataset');

function portfolioCase(id) {
  return {
    id,
    task: 'portfolio_chat',
    intent: 'average_down',
    question: 'Kalau tambah 2 lot, risikonya bagaimana?',
    context: {
      plans: [{
        ticker: 'BELL',
        lots: 300,
        entryPriceIdr: 109,
        currentPriceIdr: 0,
        stopLossIdr: 100,
        tp1Idr: 185,
        tp2Idr: 210,
        capitalIdr: 3270000,
        estimatedMaxLossIdr: 270000
      }],
      simulation: {
        label: 'SIMULASI',
        add_lots: 2,
        available_funds_idr: 5000000,
        setup_still_valid: true
      }
    },
    expected: {
      allowed_numbers: [300, 109, 100, 185, 210, 3270000, 270000, 2, 5000000],
      require_snapshot_scope: true
    }
  };
}

test('portfolio enrichment exposes bounded arithmetic facts and rounding variants', () => {
  const enriched = enrichCase(portfolioCase('portfolio-1'));
  const facts = enriched.context.calculation_facts.plans[0];
  assert.equal(facts.existing_shares, 30000);
  assert.equal(facts.risk_per_share_idr, 9);
  assert.equal(facts.risk_per_lot_idr, 900);
  assert.equal(facts.risk_pct_of_position, 8.26);
  assert.equal(facts.tp1_gross_profit_idr, 2280000);
  assert.equal(facts.simulation.add_shares, 200);
  assert.equal(facts.simulation.additional_capital_idr, 21800);
  assert.equal(facts.simulation.total_lots, 302);
  assert.equal(facts.simulation.total_shares, 30200);
  assert.equal(facts.simulation.additional_risk_idr, 1800);
  assert.equal(facts.simulation.total_risk_idr, 271800);
  assert.ok(enriched.expected.allowed_numbers.includes(8.26));
  assert.ok(enriched.expected.allowed_numbers.includes(8.3));
  assert.ok(enriched.expected.allowed_numbers.includes(302));
  assert.ok(enriched.expected.allowed_numbers.includes(21800));
  assert.equal(enriched.expected.allowed_numbers.includes(123456), false);
});

test('derived portfolio answer passes while an unrelated financial number still fails', () => {
  const enriched = enrichCase(portfolioCase('portfolio-2'));
  const valid = validateAnswer({
    direct_answer: 'Simulasi tambah 2 lot membuat total menjadi 302 lot.',
    data_used: ['calculation_facts.plans[0].simulation'],
    reasoning: 'Tambahan 2 lot berarti 200 saham. Dengan basis entry 109, modal tambahan 21.800 dan risiko tambahan 1.800. Total risiko menjadi 271.800 atau sekitar 8,3% dari modal posisi simulasi.',
    action: 'Gunakan hasil ini hanya sebagai simulasi.',
    invalidation: 'Hitung ulang jika harga tambahan bukan 109 atau stop loss bukan 100.',
    confidence: 'SEDANG',
    levels: { last: null, entry_low: 109, entry_high: 109, stop_loss: 100, tp1: 185, tp2: 210 },
    missing_data: ['Harga pasar saat ini belum tersedia.'],
    warnings: ['Bukan transaksi nyata.'],
    source_scope: 'snapshot'
  }, {
    allowed_numbers: enriched.expected.allowed_numbers,
    require_snapshot_scope: true
  });
  assert.equal(valid.valid, true, valid.errors.join('; '));

  const invalid = validateAnswer({
    direct_answer: 'Modal tambahan yang dibutuhkan adalah 123.456.',
    action: 'Tinjau ulang.',
    invalidation: 'Batal jika data berubah.',
    levels: {},
    source_scope: 'snapshot'
  }, {
    allowed_numbers: enriched.expected.allowed_numbers,
    require_snapshot_scope: true
  });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some((error) => error.includes('123456')));
});

test('stock facts derive only level-based risk and reward metrics', () => {
  const facts = stockFacts({ entry_low: 109, stop_loss: 100, tp1: 185, tp2: 210 });
  assert.equal(facts.risk_per_share, 9);
  assert.equal(facts.reward_to_tp1_per_share, 76);
  assert.equal(facts.risk_reward_tp1, 8.44);
  assert.equal(facts.risk_pct, 8.26);
  assert.equal(facts.tp1_upside_pct, 69.72);
});

test('failed retry builder selects exact rejection IDs and enriches only those cases', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-eval-retry-'));
  try {
    const dataset = path.join(dir, 'dataset.jsonl.gz');
    const rejections = path.join(dir, 'rejections.jsonl');
    const output = path.join(dir, 'retry.jsonl.gz');
    const report = path.join(dir, 'retry-report.json');
    const rows = [
      portfolioCase('case-a'),
      portfolioCase('case-b'),
      portfolioCase('case-c')
    ];
    fs.writeFileSync(dataset, zlib.gzipSync(Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n') + '\n')));
    fs.writeFileSync(rejections, [
      JSON.stringify({ id: 'case-a', task: 'portfolio_chat', intent: 'average_down', failure: { stage: 'deterministic' } }),
      JSON.stringify({ id: 'case-c', task: 'portfolio_chat', intent: 'average_down', failure: { stage: 'judge' } })
    ].join('\n') + '\n');

    const result = await buildRetryDataset({
      datasetGz: dataset,
      rejectionsFile: rejections,
      outputGz: output,
      reportFile: report
    });
    assert.equal(result.requested_rejection_count, 2);
    assert.equal(result.output_case_count, 2);
    assert.equal(result.missing_count, 0);
    const outputRows = zlib.gunzipSync(fs.readFileSync(output)).toString('utf8').trim().split(/\r?\n/).map(JSON.parse);
    assert.deepEqual(outputRows.map((row) => row.id), ['case-a', 'case-c']);
    assert.ok(outputRows.every((row) => row.context.calculation_facts));
    assert.ok(outputRows.every((row) => row.expected.derived_numbers_source === 'context.calculation_facts'));
    assert.ok(fs.existsSync(report));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
