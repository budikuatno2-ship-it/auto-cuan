/**
 * sync_stock_summary_dates.ts
 * 
 * Minimal Deno script for GitHub Actions.
 * Fetches stock_summary from IDX for fallback dates until data is found.
 * Does NOT use Cron.ts (which has hardcoded date ranges).
 * 
 * Logic:
 * 1. Try today (WIB), then yesterday, then -2d ... -7d
 * 2. After each syncStockSummary call, verify rows exist in SQLite
 * 3. Stop on first date with actual rows
 * 4. Print selected source date for downstream Python sync
 * 5. Exit 1 if no data found for any date
 */

import { syncStockSummary } from '@app/Backend/Sync/StockSummary.ts'
import Database from '@app/Database.ts'
import { stockSummary } from '@app/Backend/Schemas/StockSummary.ts'
import { eq, sql } from 'drizzle-orm'

// WIB = UTC+7
const now = new Date()
const wib = new Date(now.getTime() + 7 * 60 * 60 * 1000)

function formatDate(d: Date): string {
  return d.getFullYear().toString() +
    String(d.getMonth() + 1).padStart(2, '0') +
    String(d.getDate()).padStart(2, '0')
}

function dateToUnixMs(dateStr: string): number {
  // YYYYMMDD -> unix ms for start of that day in WIB
  const y = parseInt(dateStr.slice(0, 4), 10)
  const m = parseInt(dateStr.slice(4, 6), 10) - 1
  const d = parseInt(dateStr.slice(6, 8), 10)
  // Create date at midnight WIB, convert to UTC
  const dt = new Date(Date.UTC(y, m, d, -7, 0, 0))
  return dt.getTime()
}

// Build fallback date list: today, -1d, -2d, ..., -7d
const datesToTry: string[] = []
for (let i = 0; i <= 7; i++) {
  const d = new Date(wib.getTime() - i * 24 * 60 * 60 * 1000)
  datesToTry.push(formatDate(d))
}

console.log(`[sync_dates] Current time UTC: ${now.toISOString()}`)
console.log(`[sync_dates] Current time WIB: ${wib.toISOString().replace('Z', '+07:00')}`)
console.log(`[sync_dates] Fallback dates to try: ${datesToTry.join(', ')}`)
console.log('')

let selectedDate: string | null = null

for (const dateStr of datesToTry) {
  console.log(`[sync_dates] --- Trying ${dateStr} ---`)

  // Call syncStockSummary (it won't throw on empty data, just warns)
  try {
    await syncStockSummary(dateStr)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[sync_dates] syncStockSummary threw for ${dateStr}: ${msg}`)
    continue
  }

  // Verify rows actually exist for this date in SQLite
  const targetMs = dateToUnixMs(dateStr)
  // Allow a window of +/- 12 hours to account for timezone differences in stored timestamps
  const windowStart = targetMs - 12 * 60 * 60 * 1000
  const windowEnd = targetMs + 36 * 60 * 60 * 1000

  try {
    const result = await Database.select({
      count: sql<number>`COUNT(*)`,
    }).from(stockSummary).where(
      sql`${stockSummary.date} >= ${windowStart} AND ${stockSummary.date} < ${windowEnd}`
    )

    const rowCount = result[0]?.count ?? 0
    console.log(`[sync_dates] Rows in stock_summary for ${dateStr}: ${rowCount}`)

    if (rowCount > 0) {
      selectedDate = dateStr
      console.log(`[sync_dates] SUCCESS: Found ${rowCount} rows for ${dateStr}`)

      // Print sample tickers
      const samples = await Database.select({
        code: stockSummary.code,
        close: stockSummary.close,
        foreignBuy: stockSummary.foreignBuy,
        foreignSell: stockSummary.foreignSell,
        foreignNet: stockSummary.foreignNet,
      }).from(stockSummary).where(
        sql`${stockSummary.date} >= ${windowStart} AND ${stockSummary.date} < ${windowEnd} AND ${stockSummary.code} IN ('BBCA', 'NAYZ', 'WMUU', 'ADRO', 'TLKM')`
      )

      if (samples.length > 0) {
        console.log(`[sync_dates] Sample tickers for ${dateStr}:`)
        for (const s of samples) {
          console.log(`  ${s.code}: close=${s.close}, fBuy=${s.foreignBuy}, fSell=${s.foreignSell}, fNet=${s.foreignNet}`)
        }
      } else {
        console.log(`[sync_dates] Note: BBCA/NAYZ/WMUU not found but other stocks exist.`)
        // Show first 5 tickers instead
        const anyFive = await Database.select({
          code: stockSummary.code,
          close: stockSummary.close,
        }).from(stockSummary).where(
          sql`${stockSummary.date} >= ${windowStart} AND ${stockSummary.date} < ${windowEnd}`
        ).limit(5)
        console.log(`[sync_dates] First 5 tickers: ${anyFive.map(r => r.code).join(', ')}`)
      }

      break
    } else {
      console.log(`[sync_dates] No rows for ${dateStr} — IDX returned empty data.`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[sync_dates] DB query failed for ${dateStr}: ${msg}`)
  }

  console.log('')
}

console.log('')
if (selectedDate) {
  console.log(`[sync_dates] ========================================`)
  console.log(`[sync_dates] SELECTED SOURCE DATE: ${selectedDate}`)
  console.log(`[sync_dates] ========================================`)
} else {
  console.error(`[sync_dates] ========================================`)
  console.error(`[sync_dates] FAILED: No IDX stock_summary data found for any fallback date.`)
  console.error(`[sync_dates] Dates tried: ${datesToTry.join(', ')}`)
  console.error(`[sync_dates] Supabase will remain unchanged.`)
  console.error(`[sync_dates] ========================================`)
  Deno.exit(1)
}
