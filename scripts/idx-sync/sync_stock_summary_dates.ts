/**
 * sync_stock_summary_dates.ts
 * 
 * Minimal Deno script for GitHub Actions.
 * Fetches stock_summary from IDX for fallback dates until data is found.
 * Does NOT use Cron.ts (which has hardcoded date ranges).
 * 
 * Includes raw response diagnostics to identify if IDX is blocking requests.
 * 
 * Logic:
 * 1. Try historical known-good date (20260310) first as canary
 * 2. Then try today (WIB), yesterday, -2d ... -7d
 * 3. After each call, verify rows exist in SQLite
 * 4. Stop on first date with actual rows
 * 5. Print selected source date for downstream Python sync
 * 6. Exit 1 if no data found for any date
 */

import { syncStockSummary } from '@app/Backend/Sync/StockSummary.ts'
import Database from '@app/Database.ts'
import { stockSummary } from '@app/Backend/Schemas/StockSummary.ts'
import { sql } from 'drizzle-orm'

// === RAW DIAGNOSTIC FETCH ===
// This bypasses IDX-API's error swallowing to show what IDX actually returns.
async function diagnoseIDXResponse(dateStr: string): Promise<void> {
  const url = `https://www.idx.co.id/primary/TradingSummary/GetStockSummary?date=${dateStr}`
  console.log(`[diag] Fetching: ${url}`)

  const headers: Record<string, string> = {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
    'Referer': 'https://www.idx.co.id/',
    'Upgrade-Insecure-Requests': '1',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    'X-Requested-With': 'XMLHttpRequest',
  }

  // Step 1: Get session cookies
  console.log(`[diag] Step 1: Getting session from idx.co.id ...`)
  let sessionCookie = ''
  try {
    const sessionResp = await fetch('https://www.idx.co.id/id', { headers })
    console.log(`[diag]   Session response status: ${sessionResp.status}`)
    console.log(`[diag]   Session response headers content-type: ${sessionResp.headers.get('content-type')}`)
    
    const setCookies = sessionResp.headers.getSetCookie()
    sessionCookie = setCookies.join('; ')
    console.log(`[diag]   Cookies received: ${setCookies.length} cookie(s)`)
    console.log(`[diag]   Cookie names: ${setCookies.map(c => c.split('=')[0]).join(', ')}`)

    // Check if response is HTML (block page) vs expected
    const sessionBody = await sessionResp.text()
    const isHTML = sessionBody.includes('<!DOCTYPE') || sessionBody.includes('<html')
    const hasCloudflare = sessionBody.includes('cloudflare') || sessionBody.includes('cf-') || sessionBody.includes('challenge-platform')
    const hasCaptcha = sessionBody.includes('captcha') || sessionBody.includes('challenge')
    console.log(`[diag]   Session body length: ${sessionBody.length}`)
    console.log(`[diag]   Is HTML: ${isHTML}`)
    console.log(`[diag]   Has Cloudflare markers: ${hasCloudflare}`)
    console.log(`[diag]   Has captcha/challenge: ${hasCaptcha}`)
    
    if (hasCloudflare || hasCaptcha) {
      console.log(`[diag]   DIAGNOSIS: IDX is showing Cloudflare challenge/captcha page.`)
      console.log(`[diag]   This likely means GitHub Actions IP is blocked.`)
      console.log(`[diag]   First 500 chars of session response:`)
      console.log(sessionBody.slice(0, 500))
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[diag]   Session fetch FAILED: ${msg}`)
    return
  }

  // Step 2: Fetch stock summary with cookies
  console.log(`[diag] Step 2: Fetching stock summary for ${dateStr} ...`)
  try {
    const dataHeaders = { ...headers, Cookie: sessionCookie }
    const resp = await fetch(url, { headers: dataHeaders })
    
    console.log(`[diag]   Response status: ${resp.status}`)
    console.log(`[diag]   Content-Type: ${resp.headers.get('content-type')}`)
    console.log(`[diag]   Content-Length: ${resp.headers.get('content-length') || 'not set'}`)

    const body = await resp.text()
    console.log(`[diag]   Body length: ${body.length}`)

    // Detect response type
    const isJSON = body.trim().startsWith('{') || body.trim().startsWith('[')
    const isHTML = body.includes('<!DOCTYPE') || body.includes('<html')
    const hasCloudflare = body.includes('cloudflare') || body.includes('cf-') || body.includes('challenge-platform')
    const hasCaptcha = body.includes('captcha') || body.includes('challenge')
    const hasAccessDenied = body.includes('403') || body.includes('Access Denied') || body.includes('Forbidden')

    console.log(`[diag]   Is JSON: ${isJSON}`)
    console.log(`[diag]   Is HTML: ${isHTML}`)
    console.log(`[diag]   Has Cloudflare: ${hasCloudflare}`)
    console.log(`[diag]   Has captcha: ${hasCaptcha}`)
    console.log(`[diag]   Has access denied: ${hasAccessDenied}`)

    if (isJSON) {
      try {
        const parsed = JSON.parse(body)
        if (parsed && parsed.data) {
          console.log(`[diag]   Parsed JSON data[] length: ${parsed.data.length}`)
          console.log(`[diag]   recordsTotal: ${parsed.recordsTotal}`)
          if (parsed.data.length > 0) {
            const first = parsed.data[0]
            console.log(`[diag]   First record keys: ${Object.keys(first).join(', ')}`)
            console.log(`[diag]   First record (truncated): ${JSON.stringify(first).slice(0, 300)}`)
          } else {
            console.log(`[diag]   DIAGNOSIS: JSON response is valid but data[] is EMPTY for date ${dateStr}.`)
            console.log(`[diag]   This means IDX has no trading data for this date (holiday/weekend/not released).`)
          }
        } else {
          console.log(`[diag]   Parsed JSON but no .data field. Keys: ${Object.keys(parsed || {}).join(', ')}`)
          console.log(`[diag]   First 300 chars: ${body.slice(0, 300)}`)
        }
      } catch (parseErr) {
        console.log(`[diag]   JSON parse failed: ${parseErr}`)
        console.log(`[diag]   First 500 chars: ${body.slice(0, 500)}`)
      }
    } else {
      console.log(`[diag]   DIAGNOSIS: Response is NOT JSON.`)
      if (hasCloudflare || hasCaptcha) {
        console.log(`[diag]   ROOT CAUSE: Cloudflare/WAF is blocking this request.`)
        console.log(`[diag]   GitHub Actions IP is likely blocked by IDX.co.id protection.`)
      } else if (hasAccessDenied) {
        console.log(`[diag]   ROOT CAUSE: Access denied / 403.`)
      } else if (isHTML) {
        console.log(`[diag]   Response is HTML (possibly redirect/maintenance page).`)
      }
      console.log(`[diag]   First 500 chars of response body:`)
      console.log(body.slice(0, 500))
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[diag]   Data fetch FAILED: ${msg}`)
  }
}


// === MAIN SYNC LOGIC ===

// WIB = UTC+7
const now = new Date()
const wib = new Date(now.getTime() + 7 * 60 * 60 * 1000)

function formatDate(d: Date): string {
  return d.getFullYear().toString() +
    String(d.getMonth() + 1).padStart(2, '0') +
    String(d.getDate()).padStart(2, '0')
}

function dateToUnixMs(dateStr: string): number {
  const y = parseInt(dateStr.slice(0, 4), 10)
  const m = parseInt(dateStr.slice(4, 6), 10) - 1
  const d = parseInt(dateStr.slice(6, 8), 10)
  const dt = new Date(Date.UTC(y, m, d, -7, 0, 0))
  return dt.getTime()
}

// Build date list: historical canary + recent fallbacks
const historicalCanary = '20260310'  // Known good date from IDX-API Cron.ts range
const recentDates: string[] = []
for (let i = 0; i <= 7; i++) {
  const d = new Date(wib.getTime() - i * 24 * 60 * 60 * 1000)
  recentDates.push(formatDate(d))
}

console.log(`[sync_dates] Current time UTC: ${now.toISOString()}`)
console.log(`[sync_dates] Current time WIB: ${wib.toISOString().replace('Z', '+07:00')}`)
console.log(`[sync_dates] Historical canary date: ${historicalCanary}`)
console.log(`[sync_dates] Recent fallback dates: ${recentDates.join(', ')}`)
console.log('')

// === STEP 1: Run raw diagnostics on canary date ===
console.log(`[sync_dates] ====== RAW RESPONSE DIAGNOSTICS ======`)
await diagnoseIDXResponse(historicalCanary)
console.log('')

// === STEP 2: Also diagnose today's date ===
console.log(`[sync_dates] ====== RAW RESPONSE DIAGNOSTICS (today) ======`)
await diagnoseIDXResponse(recentDates[0])
console.log('')

// === STEP 3: Try all dates via syncStockSummary ===
console.log(`[sync_dates] ====== SYNC ATTEMPTS ======`)
const allDates = [historicalCanary, ...recentDates]

let selectedDate: string | null = null

for (const dateStr of allDates) {
  console.log(`[sync_dates] --- Trying ${dateStr} ---`)

  try {
    await syncStockSummary(dateStr)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[sync_dates] syncStockSummary threw for ${dateStr}: ${msg}`)
    continue
  }

  // Verify rows actually exist
  const targetMs = dateToUnixMs(dateStr)
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
        const anyFive = await Database.select({
          code: stockSummary.code,
          close: stockSummary.close,
        }).from(stockSummary).where(
          sql`${stockSummary.date} >= ${windowStart} AND ${stockSummary.date} < ${windowEnd}`
        ).limit(5)
        console.log(`[sync_dates] Note: BBCA/NAYZ/WMUU not found. First 5 tickers: ${anyFive.map(r => r.code).join(', ')}`)
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

// === FINAL RESULT ===
console.log('')
if (selectedDate) {
  console.log(`[sync_dates] ========================================`)
  console.log(`[sync_dates] SELECTED SOURCE DATE: ${selectedDate}`)
  console.log(`[sync_dates] ========================================`)
} else {
  console.error(`[sync_dates] ========================================`)
  console.error(`[sync_dates] FAILED: No IDX stock_summary data found for any date.`)
  console.error(`[sync_dates] Dates tried: ${allDates.join(', ')}`)
  console.error(`[sync_dates] See RAW RESPONSE DIAGNOSTICS above for root cause.`)
  console.error(`[sync_dates] If Cloudflare/captcha detected: GitHub Actions IP is blocked.`)
  console.error(`[sync_dates] Supabase will remain unchanged.`)
  console.error(`[sync_dates] ========================================`)
  Deno.exit(1)
}
