'use strict';

// Minimal in-memory fake of the @supabase/supabase-js query builder surface
// actually used by lib/stock-daily-history-store.js and lib/foreign-flow-store.js:
// .from(table).select(cols).in(col, vals).order(col, {ascending}).limit(n)
// .from(table).upsert(rows, { onConflict })
// .from(table).delete().in(col, vals)
//
// Not a full Supabase emulation — only what these two modules call.

function makeFakeSupabase(initialTables) {
  const tables = {};
  Object.keys(initialTables || {}).forEach((t) => {
    tables[t] = (initialTables[t] || []).map((row, i) =>
      row.id ? row : Object.assign({ id: `${t}-seed-${i}` }, row));
  });

  function conflictKey(onConflict) {
    return String(onConflict || '').split(',').map((s) => s.trim());
  }

  function upsert(table, rows, options) {
    const keys = conflictKey(options && options.onConflict);
    rows.forEach((row) => {
      const existingIndex = tables[table].findIndex((existing) =>
        keys.every((k) => String(existing[k]) === String(row[k])));
      const withId = Object.assign({ id: row.id || `${table}-${tables[table].length}-${Math.random().toString(36).slice(2)}` }, row);
      if (existingIndex >= 0) {
        tables[table][existingIndex] = Object.assign({}, tables[table][existingIndex], row);
      } else {
        tables[table].push(withId);
      }
    });
    return Promise.resolve({ data: rows, error: null });
  }

  function from(table) {
    if (!tables[table]) tables[table] = [];
    let filterCol = null;
    let filterVals = null;
    let eqFilters = {};
    let gteFilters = {};
    let lteFilters = {};
    let orderCol = null;
    let orderAsc = true;
    let limitN = null;
    let mode = null; // 'select' | 'delete'

    const builder = {
      select() { mode = 'select'; return builder; },
      upsert(rows, options) { return upsert(table, rows, options); },
      delete() { mode = 'delete'; return builder; },
      eq(col, val) { eqFilters[col] = val; return builder; },
      gte(col, val) { gteFilters[col] = val; return builder; },
      lte(col, val) { lteFilters[col] = val; return builder; },
      in(col, vals) { filterCol = col; filterVals = vals; return builder; },
      order(col, opts) { orderCol = col; orderAsc = !opts || opts.ascending !== false; return builder; },
      limit(n) { limitN = n; return builder; },
      then(resolve) {
        let rows = tables[table].slice();
        if (filterCol) rows = rows.filter((r) => filterVals.map(String).includes(String(r[filterCol])));
        Object.keys(eqFilters).forEach((col) => {
          rows = rows.filter((r) => String(r[col]) === String(eqFilters[col]));
        });
        Object.keys(gteFilters).forEach((col) => {
          rows = rows.filter((r) => String(r[col]) >= String(gteFilters[col]));
        });
        Object.keys(lteFilters).forEach((col) => {
          rows = rows.filter((r) => String(r[col]) <= String(lteFilters[col]));
        });
        if (orderCol) {
          rows.sort((a, b) => {
            if (a[orderCol] === b[orderCol]) return 0;
            const cmp = a[orderCol] < b[orderCol] ? -1 : 1;
            return orderAsc ? cmp : -cmp;
          });
        }
        if (limitN != null) rows = rows.slice(0, limitN);

        if (mode === 'delete') {
          const idsToDelete = new Set(rows.map((r) => r.id));
          tables[table] = tables[table].filter((r) => !idsToDelete.has(r.id));
          return resolve({ data: rows, error: null });
        }
        return resolve({ data: rows, error: null });
      }
    };
    return builder;
  }

  return { from, _tables: tables };
}

module.exports = { makeFakeSupabase };
