'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const audit = require('../tools/audit-fca-92-konglo-ownership');

test('owner normalization removes legal suffix noise but preserves identity tokens', () => {
  assert.equal(audit.normalizeOwnerName('PT. Sinarmas Sekuritas Tbk.'), 'SINARMAS SEKURITAS');
  assert.equal(audit.normalizeOwnerName('PT ARTHA GRAHA NETWORK'), 'ARTHA GRAHA NETWORK');
  assert.equal(audit.normalizeOwnerName('ABC Holdings Pte. Ltd.'), 'ABC HOLDINGS');
});

test('generic nominee/custody names are excluded from controller inference', () => {
  assert.equal(audit.isGenericNomineeOwner('HSBC - Fund Services Client'), true);
  assert.equal(audit.isGenericNomineeOwner('Citibank N.A. Custodian'), true);
  assert.equal(audit.isGenericNomineeOwner('PT Artha Graha Network'), false);
});

test('investor adapters accept common ownership snapshot field aliases', () => {
  const rows = audit.normalizeInvestors({
    ownership: {
      investors: [
        { investor_name: 'PT Alpha', ownership_pct: '51.25%', shares_owned: '1,000,000' },
        { nama: 'Beta Family', persentase: '20,5', jumlah_saham: '500000' }
      ]
    }
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'PT Alpha');
  assert.equal(rows[0].pct, 51.25);
  assert.equal(rows[1].pct, 20.5);
});

test('curated SQL membership parser recognizes CORE/AFFILIATE/RADAR rows', () => {
  const sql = [
    "('SINARMAS_CORE', 'DUTI', 'Duta Pertiwi', 'CORE', true, 7),",
    "('DJARUM_HARTONO_AFFILIATE', 'SUPR', 'Solusi Tunas Pratama', 'AFFILIATE', true, 1),",
    "('BARITO_PRAJOGO_RADAR', 'SSIA', 'Surya Semesta', 'RADAR', true, 1)"
  ].join('\n');
  const rows = audit.parseCuratedMembership(sql);
  assert.deepEqual(rows.map(r => [r.group_code, r.ticker, r.member_type]), [
    ['SINARMAS_CORE', 'DUTI', 'CORE'],
    ['DJARUM_HARTONO_AFFILIATE', 'SUPR', 'AFFILIATE'],
    ['BARITO_PRAJOGO_RADAR', 'SSIA', 'RADAR']
  ]);
});

test('exact shareholder overlap creates a strong candidate only when evidence is material', () => {
  const signature = new Map([
    ['GROUP_A', new Map([
      ['ALPHA FAMILY', { normalized_name: 'ALPHA FAMILY', display_names: new Set(['Alpha Family']), source_tickers: new Set(['AAA','AAB']), max_pct: 40 }]
    ])],
    ['GROUP_B', new Map([
      ['SMALL OWNER', { normalized_name: 'SMALL OWNER', display_names: new Set(['Small Owner']), source_tickers: new Set(['BBB']), max_pct: 0.5 }]
    ])]
  ]);
  const investors = [
    { rank: 1, name: 'Alpha Family', normalized_name: 'ALPHA FAMILY', pct: 20 },
    { rank: 2, name: 'Small Owner', normalized_name: 'SMALL OWNER', pct: 0.2 }
  ];
  const candidates = audit.inferCandidates(investors, signature);
  assert.equal(candidates[0].group_code, 'GROUP_A');
  assert.equal(candidates[0].confidence, 'STRONG');
  assert.equal(candidates[1].confidence, 'WEAK');
});

test('candidate state never auto-resolves ambiguous strong overlaps', () => {
  assert.equal(
    audit.classifyCandidateState([], [
      { confidence: 'STRONG' },
      { confidence: 'STRONG' }
    ]),
    'AMBIGUOUS_STRONG'
  );
  assert.equal(
    audit.classifyCandidateState([{ group_code: 'KNOWN' }], []),
    'EXISTING_MAPPING'
  );
  assert.equal(audit.classifyCandidateState([], []), 'UNRESOLVED');
});
