'use strict';

// Keep the large, validated endpoint intact while applying narrow compatibility
// fixes at load time. This does not add a Vercel function.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const sourcePath = path.join(__dirname, '..', 'lib', 'sector-hot-legacy.js');
const virtualPath = path.join(__dirname, 'sector-hot-legacy.virtual.js');
let source = fs.readFileSync(sourcePath, 'utf8');

const oldLockCode = "return row.is_locked === true || row.locked === true || row.is_final === true || !!row.first_sent_at ||\n    text.indexOf('locked') >= 0 || text.indexOf('final') >= 0;";
const newLockCode = "var payload = getDashboardLockedRowPayload(row);\n  return row.is_locked === true || row.locked === true || row.is_final === true || !!row.first_sent_at ||\n    !!payload.web_daily_locked_at || !!payload.telegram_daily_sent_at ||\n    text.indexOf('locked') >= 0 || text.indexOf('final') >= 0;";

if (!source.includes(oldLockCode)) {
  throw new Error('sector-hot dashboard lock patch target not found');
}
source = source.replace(oldLockCode, newLockCode);

// The legacy list endpoint used to treat a transient mapping-query failure as
// "zero active groups" and hide every cached sector. Preserve the last valid
// sector_hot_latest cache when the mapping lookup fails or unexpectedly returns
// no matching codes. Group codes are normalized to avoid case/space mismatch.
const oldMappingBlock = `const { data: activeMembersList } = await supabase
      .from('sector_hot_group_members')
      .select('group_code')
      .eq('is_active', true);
    const activeGroupCounts = {};
    (activeMembersList || []).forEach(function(m) { activeGroupCounts[m.group_code] = (activeGroupCounts[m.group_code] || 0) + 1; });

    const filteredGroups = (groupsData || []).filter(function(g) {
      return activeGroupCounts[g.group_code] > 0;
    });

    const groups = filteredGroups.sort(function(a, b) {`;

const newMappingBlock = `const { data: activeMembersList, error: activeMembersError } = await supabase
      .from('sector_hot_group_members')
      .select('group_code')
      .eq('is_active', true);
    const activeGroupCounts = {};
    (activeMembersList || []).forEach(function(m) {
      var code = String(m && m.group_code || '').trim().toUpperCase();
      if (code) activeGroupCounts[code] = (activeGroupCounts[code] || 0) + 1;
    });

    const sourceGroups = groupsData || [];
    const filteredGroups = activeMembersError ? sourceGroups : sourceGroups.filter(function(g) {
      var code = String(g && g.group_code || '').trim().toUpperCase();
      return activeGroupCounts[code] > 0;
    });
    const visibleGroups = (filteredGroups.length > 0 || sourceGroups.length === 0)
      ? filteredGroups
      : sourceGroups;

    const groups = visibleGroups.sort(function(a, b) {`;

if (!source.includes(oldMappingBlock)) {
  throw new Error('sector-hot mapping fallback patch target not found');
}
source = source.replace(oldMappingBlock, newMappingBlock);

const compiled = new Module(virtualPath, module);
compiled.filename = virtualPath;
compiled.paths = Module._nodeModulePaths(__dirname);
compiled._compile(source, virtualPath);
module.exports = compiled.exports;
