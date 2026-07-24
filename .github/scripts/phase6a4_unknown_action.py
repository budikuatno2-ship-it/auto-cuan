from pathlib import Path

sector_path = Path('api/sector-hot.js')
sector = sector_path.read_text(encoding='utf-8')
marker = '// ===== ACTION ALLOWLIST (PHASE 6A.4) ====='
if marker not in sector:
    anchor = "    const action = req.query.action || null;\n    const groupCode = req.query.group || null;\n\n"
    block = """    // ===== ACTION ALLOWLIST (PHASE 6A.4) =====
    // Unknown actions must never fall through to the default Sektor Hot list/detail
    // response, because that would bypass the premium read policy.
    const knownActions = new Set([
      'telegram-webhook', 'telegram-daily-picks', 'telegram-monitor-picks',
      'web-daily-picks', 'web-top5-history', 'web-top5-history-archive',
      'screener', 'refresh-screener', 'nk-screener-run', 'nk-screener-results',
      'foreign-import-upload', 'daytrade-screener', 'daytrade-screener-run',
      'create-screener-share-link', 'public-screener-share', 'refresh', 'debug-members'
    ]);
    if (action !== null && !knownActions.has(action)) {
      return res.status(400).json({ success: false, error: 'Aksi tidak valid.' });
    }

"""
    if sector.count(anchor) != 1:
        raise SystemExit('sector action anchor not unique')
    sector = sector.replace(anchor, anchor + block, 1)
sector = sector.replace('// === DAY TRADE SCREENER: READ (public — returns latest results) ===', '// === DAY TRADE SCREENER: READ (premium browser read) ===')
sector_path.write_text(sector, encoding='utf-8')

test_path = Path('test/subscription-phase6a-access.test.js')
tests = test_path.read_text(encoding='utf-8')
name = 'unknown sector-hot actions cannot fall through to premium list or detail payloads'
if name not in tests:
    tests += """

test('unknown sector-hot actions cannot fall through to premium list or detail payloads', async () => withSessionSecret(async () => {
  await withApiHandler('../api/sector-hot', database(account(), []), async handler => {
    for (const query of [{ action: 'unknown-action' }, { action: 'unknown-action', group: 'TEST' }]) {
      const res = responseCapture();
      await handler({ method: 'GET', query, headers: {} }, res);
      assert.equal(res.statusCode, 400);
      assert.deepEqual(res.body, { success: false, error: 'Aksi tidak valid.' });
      assert.equal('groups' in res.body, false);
      assert.equal('members' in res.body, false);
      assert.equal('results' in res.body, false);
    }
  });
}));
"""
test_path.write_text(tests, encoding='utf-8')
