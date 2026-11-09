'use strict';

/**
 * lib/sector-radar.js
 * Auto-Cuan Sektor Hot & Radar Konglomerasi Engine
 *
 * Mengagregasi data grup konglomerasi utama (BARITO_GROUP, DJARUM_GROUP,
 * SALIM_GROUP, SINARMAS_GROUP, ASTRA_GROUP, dll.) dengan minimal 4 sampai 15
 * emiten per grup, menghitung rata-rata perubahan % dan total net flow grup.
 */

const fs = require('node:fs');
const path = require('node:path');
const { numberOrNull, unknown, DATA_STATUS } = require('./market-data-contract');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(ROOT, 'config', 'conglomerates.json');
const FAST_BUNDLE_DIR = path.join(ROOT, 'data', 'fast-bundle');
const CANDLES_DIR = path.join(ROOT, 'data', 'daily-candles');
const MULTI_DAY_FOREIGN = path.join(ROOT, 'data', 'foreign-flow-multi-day.json');

function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function getTickerQuote(ticker) {
  // Check fast-bundle
  const fb = safeReadJson(path.join(FAST_BUNDLE_DIR, `${ticker}.json`));
  if (fb && fb.quote) {
    const price = numberOrNull(fb.quote.last != null ? fb.quote.last : fb.quote.close);
    const changePct = numberOrNull(fb.quote.changePct != null ? fb.quote.changePct : fb.quote.change_pct);
    const volume = numberOrNull(fb.quote.volume);
    return {
      price,
      change_pct: changePct,
      volume,
      data_status: price == null && changePct == null ? DATA_STATUS.NOT_PUBLISHED : (price == null || changePct == null ? DATA_STATUS.PARTIAL : DATA_STATUS.AVAILABLE)
    };
  }

  // Check daily candles
  const cnd = safeReadJson(path.join(CANDLES_DIR, `${ticker}.json`));
  if (cnd) {
    const list = Array.isArray(cnd) ? cnd : (Array.isArray(cnd.candles) ? cnd.candles : []);
    if (list.length > 0) {
      const last = list[list.length - 1];
      const prev = list.length > 1 ? list[list.length - 2] : null;
      const c = numberOrNull(last.close);
      const prevC = prev ? numberOrNull(prev.close) : c;
      const chg = (c != null && prevC != null && prevC > 0) ? Number((((c - prevC) / prevC) * 100).toFixed(2)) : null;
      return {
        price: c,
        change_pct: chg,
        volume: numberOrNull(last.volume),
        data_status: DATA_STATUS.AVAILABLE
      };
    }
  }

  // BUG-V5-P8: the previous fallback invented a believable quote when no source
  // existed (price 1000 / change 1.5% / volume 5,000,000). Absence is now
  // absence — null + NOT_PUBLISHED — never a synthesised number.
  return { price: unknown(), change_pct: unknown(), volume: unknown(), data_status: DATA_STATUS.NOT_PUBLISHED };
}

function getTickerForeignNet(ticker, multiDayData) {
  if (multiDayData && multiDayData[ticker] && multiDayData[ticker].foreign_net_today != null) {
    const n = numberOrNull(multiDayData[ticker].foreign_net_today);
    return n;
  }
  return unknown();
}

function getSectorRadarGroups() {
  const cfg = safeReadJson(CONFIG_FILE) || { conglomerates: [] };
  const foreignData = (safeReadJson(MULTI_DAY_FOREIGN) || {}).data || {};

  const groups = cfg.conglomerates.map(group => {
    let sumChg = 0;
    let sumVol = 0;
    let sumNetFlow = 0;
    let validCount = 0;
    let topTicker = null;
    let topChg = -999;

    const enrichedMembers = (group.members || []).map(m => {
      const q = getTickerQuote(m.ticker);
      const fNet = getTickerForeignNet(m.ticker, foreignData);

      if (q.change_pct != null && q.change_pct > topChg) {
        topChg = q.change_pct;
        topTicker = m.ticker;
      }

      if (q.change_pct != null) {
        sumChg += q.change_pct;
        validCount++;
      }
      if (q.volume != null) {
        sumVol += q.volume;
      }
      if (fNet != null) {
        sumNetFlow += fNet;
      }

      // BUG-V5-P8: `volume_ratio_30d` was a flat fabricated 1.45 and must be
      // null until an actual 30-day volume ratio is derived from real candles.
      return {
        ticker: m.ticker,
        stock_name: m.stock_name,
        last_price: q.price,
        change_pct: q.change_pct,
        volume_today: q.volume,
        volume_ratio_30d: unknown(),
        net_foreign: fNet,
        member_type: m.member_type || 'MEMBER',
        data_status: q.data_status
      };
    });

    const count = enrichedMembers.length;
    const avgChg = validCount > 0 ? Number((sumChg / validCount).toFixed(2)) : null;
    // BUG-V5-P8: `avg_volume_ratio` was a flat fabricated 1.65. Emit null until
    // real per-member 30d volume ratios exist; never invent a group constant.
    const avgVolRatio = null;

    return {
      group_code: group.group_code,
      group_aliases: group.group_aliases || [group.group_code],
      group_name: group.group_name,
      owner_label: group.owner_label,
      stock_count: count,
      member_count: count,
      avg_change_pct: avgChg,
      avg_volume_ratio: avgVolRatio,
      top_ticker: topTicker || (enrichedMembers[0] && enrichedMembers[0].ticker) || null,
      top_change_pct: topChg > -900 ? topChg : null,
      net_flow: sumNetFlow,
      members: enrichedMembers
    };
  });

  return groups;
}

function getGroupDetail(groupQuery) {
  if (!groupQuery) return null;
  const q = String(groupQuery).toUpperCase().trim();
  const groups = getSectorRadarGroups();

  for (const g of groups) {
    if (g.group_code === q || (g.group_aliases && g.group_aliases.includes(q))) {
      return {
        group: {
          group_code: g.group_code,
          group_name: g.group_name,
          owner_label: g.owner_label,
          stock_count: g.stock_count,
          member_count: g.member_count,
          avg_change_pct: g.avg_change_pct,
          avg_volume_ratio: g.avg_volume_ratio,
          top_ticker: g.top_ticker,
          net_flow: g.net_flow
        },
        members: g.members
      };
    }
  }

  // Check prefix / partial matching
  for (const g of groups) {
    if (g.group_code.includes(q) || q.includes(g.group_code.replace('_GROUP', '')) || q.includes(g.group_code.replace('KONGLO_', ''))) {
      return {
        group: {
          group_code: g.group_code,
          group_name: g.group_name,
          owner_label: g.owner_label,
          stock_count: g.stock_count,
          member_count: g.member_count,
          avg_change_pct: g.avg_change_pct,
          avg_volume_ratio: g.avg_volume_ratio,
          top_ticker: g.top_ticker,
          net_flow: g.net_flow
        },
        members: g.members
      };
    }
  }

  // Fallback first group if not found
  const fb = groups[0];
  return fb ? { group: fb, members: fb.members } : null;
}

module.exports = {
  getSectorRadarGroups,
  getGroupDetail
};
