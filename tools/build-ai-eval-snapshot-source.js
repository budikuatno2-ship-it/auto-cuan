'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');

function arg(name, fallback) {
  const prefix = '--' + name + '=';
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function boundedInt(value, fallback, min, max) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase runtime env belum lengkap.');

  const output = path.resolve(arg('output', 'tmp/ai-eval-context-snapshots.jsonl'));
  const limit = boundedInt(arg('limit', '5000'), 5000, 1, 20000);
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const account = await supabase
    .from('app_users')
    .select('id,username')
    .eq('username', 'budi')
    .maybeSingle();
  if (account.error || !account.data || !account.data.id) {
    throw new Error('Akun admin budi tidak ditemukan.');
  }

  const result = await supabase
    .from('ai_context_snapshots')
    .select('source,context_key,payload,captured_at,updated_at')
    .eq('user_id', String(account.data.id))
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (result.error) throw new Error('Gagal membaca snapshot AI admin: ' + result.error.message);

  const rows = Array.isArray(result.data) ? result.data : [];
  const latest = new Map();
  for (const row of rows) {
    const identity = String(row.source || '') + ':' + String(row.context_key || '');
    if (!latest.has(identity)) {
      latest.set(identity, {
        source: row.source,
        context_key: row.context_key,
        payload: row.payload,
        captured_at: row.captured_at,
        updated_at: row.updated_at
      });
    }
  }

  const exported = Array.from(latest.values());
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, exported.map((row) => JSON.stringify(row)).join('\n') + (exported.length ? '\n' : ''), 'utf8');

  process.stdout.write(JSON.stringify({
    success: true,
    exported: exported.length,
    stock_snapshots: exported.filter((row) => row.source === 'stock_analysis_followup').length,
    portfolio_snapshots: exported.filter((row) => row.source === 'portfolio_chat').length,
    identity_removed: true,
    output
  }) + '\n');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { boundedInt };
