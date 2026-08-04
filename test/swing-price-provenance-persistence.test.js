'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

const source = fs.readFileSync(
  path.join(root, 'api/sector-hot.js'),
  'utf8'
);

const migration = fs.readFileSync(
  path.join(
    root,
    'supabase/patch-swing-price-provenance.sql'
  ),
  'utf8'
);

function section(start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(
    end,
    startIndex + start.length
  );

  assert.notEqual(startIndex, -1);
  assert.notEqual(endIndex, -1);

  return source.slice(startIndex, endIndex);
}

test(
  'Konglo persistence keeps genuine quote provenance',
  function() {
    const mapping = section(
      'var upsertRows = results.map',
      'if (upsertRows.length > 0)'
    );

    assert.match(
      mapping,
      /price_source: r\.price_source \|\| null/
    );

    assert.match(
      mapping,
      /price_asof: r\.price_asof \|\| null/
    );

    assert.match(
      mapping,
      /price_date: r\.price_date \|\| null/
    );
  }
);

test(
  'Non-Konglo staging and latest sanitizers retain provenance',
  function() {
    const staging = section(
      'var NK_STAGING_COLUMNS',
      'var NK_STAGING_COLUMN_SET'
    );

    const latest = section(
      'var NK_LATEST_COLUMNS',
      'var NK_LATEST_COLUMN_SET'
    );

    for (const field of [
      'price_source',
      'price_asof',
      'price_date'
    ]) {
      assert.match(
        staging,
        new RegExp("'" + field + "'")
      );

      assert.match(
        latest,
        new RegExp("'" + field + "'")
      );
    }
  }
);

test(
  'Non-Konglo publish mapping passes genuine provenance',
  function() {
    const publish = section(
      'const publishRows = topCandidates.map',
      'var { error: insErr }'
    );

    assert.match(
      publish,
      /price_source: c\.price_source/
    );

    assert.match(
      publish,
      /price_asof: c\.price_asof/
    );

    assert.match(
      publish,
      /price_date: c\.price_date/
    );
  }
);

test(
  'migration adds three provenance columns to all required tables',
  function() {
    assert.equal(
      (
        migration.match(
          /ADD COLUMN IF NOT EXISTS price_source TEXT;/g
        ) || []
      ).length,
      3
    );

    assert.equal(
      (
        migration.match(
          /ADD COLUMN IF NOT EXISTS price_asof TIMESTAMPTZ;/g
        ) || []
      ).length,
      3
    );

    assert.equal(
      (
        migration.match(
          /ADD COLUMN IF NOT EXISTS price_date DATE;/g
        ) || []
      ).length,
      3
    );
  }
);

test(
  'migration never fabricates price date from operational timestamps',
  function() {
    assert.doesNotMatch(
      migration,
      /UPDATE\s+public\./i
    );

    assert.doesNotMatch(
      migration,
      /price_date\s*=\s*run_date/i
    );

    assert.doesNotMatch(
      migration,
      /price_date\s*=\s*(calculated_at|published_at|updated_at)/i
    );
  }
);

test(
  'Phase 2A preserves fallback until genuine dates are deployed',
  function() {
    assert.match(
      source,
      /function applyTrustedSwingLatestPriceDateFallback/
    );
  }
);
