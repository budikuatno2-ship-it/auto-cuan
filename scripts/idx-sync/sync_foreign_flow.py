#!/usr/bin/env python3
"""
sync_foreign_flow.py — Sync per-stock foreign flow from IDX-API SQLite to Supabase.

Source: ./data/database.sqlite → stock_summary table
Destination: Supabase → idx_foreign_flow_daily table

Usage:
  # Full sync (latest trade date, all stocks)
  python3 sync_foreign_flow.py

  # Dry-run (preview only, no Supabase writes)
  python3 sync_foreign_flow.py --dry-run

  # Dry-run with specific tickers only
  python3 sync_foreign_flow.py --dry-run --tickers BBCA,NAYZ,WMUU

  # Sync specific date
  python3 sync_foreign_flow.py --date 20260603

  # Sync specific tickers only
  python3 sync_foreign_flow.py --tickers BBCA,NAYZ,WMUU

Environment variables required:
  SUPABASE_URL              — Supabase project URL
  SUPABASE_SERVICE_ROLE_KEY — Supabase service role key (never printed)

Cron (weekdays 16:30 WIB = 09:30 UTC):
  30 9 * * 1-5 cd /path/to/IDX-API && python3 sync_foreign_flow.py >> /var/log/sync_foreign_flow.log 2>&1
"""

import sqlite3
import os
import sys
import json
import argparse
from datetime import datetime, timezone, timedelta
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError


# === Configuration ===
SQLITE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "database.sqlite")
SUPABASE_TABLE = "idx_foreign_flow_daily"
BATCH_SIZE = 200  # Supabase REST upsert batch size


def parse_args():
    parser = argparse.ArgumentParser(description="Sync foreign flow from SQLite to Supabase")
    parser.add_argument("--dry-run", action="store_true", help="Preview only, no Supabase writes")
    parser.add_argument("--date", type=str, default=None, help="Specific date YYYYMMDD to sync")
    parser.add_argument("--tickers", type=str, default=None, help="Comma-separated ticker filter (e.g. BBCA,NAYZ,WMUU)")
    return parser.parse_args()


def unix_ms_to_date_str(unix_ms):
    """Convert unix timestamp milliseconds to YYYY-MM-DD string."""
    if not unix_ms or unix_ms <= 0:
        return None
    dt = datetime.fromtimestamp(unix_ms / 1000, tz=timezone(timedelta(hours=7)))  # WIB
    return dt.strftime("%Y-%m-%d")


def get_latest_trade_date(conn):
    """Get the most recent trade date from stock_summary."""
    cursor = conn.execute("""
        SELECT MAX(date) FROM stock_summary
        WHERE date IS NOT NULL AND date > 0
    """)
    row = cursor.fetchone()
    if row and row[0]:
        return row[0]
    return None


def get_trade_date_for_yyyymmdd(conn, date_str):
    """Find the unix_ms timestamp for a given YYYYMMDD date string."""
    # Parse YYYYMMDD to datetime, then to unix ms range for that day
    dt = datetime.strptime(date_str, "%Y%m%d")
    # Set to WIB (UTC+7)
    dt_wib = dt.replace(hour=0, minute=0, second=0)
    start_ms = int((dt_wib - timedelta(hours=7)).timestamp() * 1000)
    end_ms = start_ms + (24 * 60 * 60 * 1000)

    cursor = conn.execute("""
        SELECT DISTINCT date FROM stock_summary
        WHERE date >= ? AND date < ?
        ORDER BY date DESC LIMIT 1
    """, (start_ms, end_ms))
    row = cursor.fetchone()
    if row:
        return row[0]

    # Fallback: find closest date
    cursor = conn.execute("""
        SELECT DISTINCT date FROM stock_summary
        WHERE date IS NOT NULL AND date > 0
        ORDER BY ABS(date - ?) LIMIT 1
    """, (start_ms,))
    row = cursor.fetchone()
    if row:
        return row[0]
    return None


def fetch_foreign_flow_rows(conn, target_date_ms, ticker_filter=None):
    """
    Fetch stock_summary rows for a specific date.
    Returns list of dicts ready for Supabase upsert.
    """
    query = """
        SELECT code, date, close, foreign_buy, foreign_sell, foreign_net
        FROM stock_summary
        WHERE date = ?
    """
    params = [target_date_ms]

    if ticker_filter:
        placeholders = ",".join(["?"] * len(ticker_filter))
        query += f" AND code IN ({placeholders})"
        params.extend(ticker_filter)

    cursor = conn.execute(query, params)
    rows = cursor.fetchall()
    return rows


def transform_rows(rows, target_date_ms):
    """
    Transform SQLite rows into Supabase-ready dicts.
    Skips rows where foreign_buy, foreign_sell, and foreign_net are all zero.
    Skips rows with missing ticker or invalid date.
    """
    trade_date_str = unix_ms_to_date_str(target_date_ms)
    if not trade_date_str:
        return [], 0

    records = []
    skipped = 0

    for row in rows:
        code, date_ms, close_price, foreign_buy, foreign_sell, foreign_net = row

        # Skip if ticker missing
        if not code or not code.strip():
            skipped += 1
            continue

        ticker = code.strip().upper()

        # Skip if all foreign values are zero or None
        fb = foreign_buy or 0
        fs = foreign_sell or 0
        fn = foreign_net or 0

        if fb == 0 and fs == 0 and fn == 0:
            skipped += 1
            continue

        # Close price for value estimation
        cp = close_price or 0

        # Calculate estimated Rupiah values
        # foreign_buy/sell are in shares, multiply by close for estimated value
        foreign_buy_value = int(fb * cp)
        foreign_sell_value = int(fs * cp)
        foreign_net_value = int(fn * cp)

        record = {
            "trade_date": trade_date_str,
            "ticker": ticker,
            "foreign_buy_value": foreign_buy_value,
            "foreign_sell_value": foreign_sell_value,
            "foreign_net_value": foreign_net_value,
            "foreign_buy_volume": fb,
            "foreign_sell_volume": fs,
            "foreign_net_volume": fn,
            "close_price": cp,
            "value_is_estimated": True
        }

        records.append(record)

    return records, skipped


def supabase_upsert(records, supabase_url, supabase_key, dry_run=False):
    """
    Upsert records to Supabase idx_foreign_flow_daily table.
    Uses Supabase REST API with on_conflict resolution.
    Returns (success_count, error_count).
    """
    if dry_run:
        return len(records), 0

    if not supabase_url or not supabase_key:
        print("[ERROR] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set.")
        return 0, len(records)

    url = f"{supabase_url}/rest/v1/{SUPABASE_TABLE}"
    headers = {
        "apikey": supabase_key,
        "Authorization": f"Bearer {supabase_key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates"  # Upsert on unique key
    }

    success_count = 0
    error_count = 0

    # Batch upsert
    for i in range(0, len(records), BATCH_SIZE):
        batch = records[i:i + BATCH_SIZE]
        body = json.dumps(batch).encode("utf-8")

        req = Request(url, data=body, headers=headers, method="POST")

        try:
            response = urlopen(req, timeout=30)
            status = response.getcode()
            if status in (200, 201):
                success_count += len(batch)
            else:
                # Read response for debugging
                resp_body = response.read().decode("utf-8", errors="replace")
                print(f"[WARN] Batch {i//BATCH_SIZE + 1}: HTTP {status} — {resp_body[:200]}")
                error_count += len(batch)
        except HTTPError as e:
            resp_body = e.read().decode("utf-8", errors="replace") if e.fp else ""
            print(f"[ERROR] Batch {i//BATCH_SIZE + 1}: HTTP {e.code} — {resp_body[:200]}")
            error_count += len(batch)
        except URLError as e:
            print(f"[ERROR] Batch {i//BATCH_SIZE + 1}: Network error — {e.reason}")
            error_count += len(batch)
        except Exception as e:
            print(f"[ERROR] Batch {i//BATCH_SIZE + 1}: {type(e).__name__} — {e}")
            error_count += len(batch)

    return success_count, error_count


def format_large_number(value):
    """Format large number for display (IDR or shares)."""
    abs_val = abs(value)
    if abs_val >= 1_000_000_000_000:
        formatted = f"{abs_val / 1_000_000_000_000:.1f} Triliun"
    elif abs_val >= 1_000_000_000:
        formatted = f"{abs_val / 1_000_000_000:.1f} Miliar"
    elif abs_val >= 1_000_000:
        formatted = f"{abs_val / 1_000_000:.1f} Juta"
    elif abs_val >= 1_000:
        formatted = f"{abs_val / 1_000:.1f} Ribu"
    else:
        formatted = str(abs_val)

    # Clean trailing .0
    formatted = formatted.replace(".0 ", " ")

    if value >= 0:
        return f"+{formatted}"
    else:
        return f"-{formatted}"


def print_dry_run_preview(records, max_display=10):
    """Print a preview of records that would be inserted."""
    print(f"\n{'='*70}")
    print(f"DRY-RUN PREVIEW — {len(records)} records would be upserted")
    print(f"{'='*70}")
    print(f"{'Ticker':<8} {'Trade Date':<12} {'Net Vol':>12} {'Net Value (est)':>20} {'Close':>10}")
    print(f"{'-'*8} {'-'*12} {'-'*12} {'-'*20} {'-'*10}")

    # Sort by absolute net value descending for visibility
    sorted_records = sorted(records, key=lambda r: abs(r["foreign_net_value"]), reverse=True)

    for rec in sorted_records[:max_display]:
        net_vol_text = format_large_number(rec["foreign_net_volume"])
        net_val_text = format_large_number(rec["foreign_net_value"])
        print(f"{rec['ticker']:<8} {rec['trade_date']:<12} {net_vol_text:>12} {net_val_text:>20} {rec['close_price']:>10,.0f}")

    if len(records) > max_display:
        print(f"... and {len(records) - max_display} more rows")

    print(f"{'='*70}")


def main():
    args = parse_args()

    print(f"[sync_foreign_flow] Started at {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"[sync_foreign_flow] SQLite path: {SQLITE_PATH}")
    print(f"[sync_foreign_flow] Dry-run: {args.dry_run}")

    # Validate SQLite exists
    if not os.path.exists(SQLITE_PATH):
        print(f"[ERROR] SQLite database not found: {SQLITE_PATH}")
        sys.exit(1)

    # Parse ticker filter
    ticker_filter = None
    if args.tickers:
        ticker_filter = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]
        print(f"[sync_foreign_flow] Ticker filter: {ticker_filter}")

    # Get env vars (only needed if not dry-run)
    supabase_url = os.environ.get("SUPABASE_URL", "")
    supabase_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

    if not args.dry_run and (not supabase_url or not supabase_key):
        print("[ERROR] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set for live sync.")
        print("[HINT] Use --dry-run to preview without Supabase connection.")
        sys.exit(1)

    # Open SQLite
    conn = sqlite3.connect(SQLITE_PATH)

    try:
        # Determine target date
        if args.date:
            target_date_ms = get_trade_date_for_yyyymmdd(conn, args.date)
            if not target_date_ms:
                print(f"[ERROR] No data found for date {args.date}")
                sys.exit(1)
        else:
            target_date_ms = get_latest_trade_date(conn)
            if not target_date_ms:
                print("[ERROR] No trade dates found in stock_summary table.")
                sys.exit(1)

        trade_date_str = unix_ms_to_date_str(target_date_ms)
        print(f"[sync_foreign_flow] Target trade date: {trade_date_str} (unix_ms: {target_date_ms})")

        # Fetch rows
        rows = fetch_foreign_flow_rows(conn, target_date_ms, ticker_filter)
        print(f"[sync_foreign_flow] Raw rows from SQLite: {len(rows)}")

        if not rows:
            print("[WARN] No rows found. Nothing to sync.")
            sys.exit(0)

        # Transform
        records, skipped = transform_rows(rows, target_date_ms)
        print(f"[sync_foreign_flow] Records to upsert: {len(records)}")
        print(f"[sync_foreign_flow] Skipped (all-zero or invalid): {skipped}")

        if not records:
            print("[WARN] No valid records after filtering. Nothing to sync.")
            sys.exit(0)

        # Dry-run preview
        if args.dry_run:
            print_dry_run_preview(records)
            print("\n[DRY-RUN] No data was written to Supabase.")
            sys.exit(0)

        # Live upsert
        print(f"[sync_foreign_flow] Upserting to Supabase ({len(records)} records, batch size {BATCH_SIZE})...")
        success, errors = supabase_upsert(records, supabase_url, supabase_key)

        # Summary
        print(f"\n{'='*50}")
        print(f"SYNC COMPLETE")
        print(f"{'='*50}")
        print(f"Trade date:     {trade_date_str}")
        print(f"Total synced:   {success}")
        print(f"Errors:         {errors}")
        print(f"Skipped:        {skipped}")
        print(f"{'='*50}")

        if errors > 0:
            sys.exit(1)

    finally:
        conn.close()


if __name__ == "__main__":
    main()
