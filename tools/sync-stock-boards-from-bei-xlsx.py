#!/usr/bin/env python3
"""Safely sync official BEI board XLSX files into the existing stock_boards table.

Dry-run is the default.  This tool never runs in production automatically.

Examples:
  python3 tools/sync-stock-boards-from-bei-xlsx.py --utama /data/Utama.xlsx --pengembangan /data/Pengembangan.xlsx
  python3 tools/sync-stock-boards-from-bei-xlsx.py --utama /data/Utama.xlsx --pengembangan /data/Pengembangan.xlsx --replace-official-board-scope --apply
"""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile
import xml.etree.ElementTree as ET

BOARD_ARGS = (("utama", "UTAMA"), ("pengembangan", "PENGEMBANGAN"),
              ("akselerasi", "AKSELERASI"), ("ekonomi-baru", "EKONOMI BARU"))
NS = {"x": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


def load_env_file(filename):
    if not os.path.isfile(filename):
        return
    with open(filename, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key, value = key.strip(), value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


def cell_text(cell, shared):
    value = cell.find("x:v", NS)
    if value is None:
        inline = cell.find("x:is/x:t", NS)
        return inline.text.strip() if inline is not None and inline.text else ""
    raw = value.text or ""
    if cell.get("t") == "s" and raw.isdigit():
        return shared[int(raw)].strip()
    return raw.strip()


def xlsx_rows(filename):
    with zipfile.ZipFile(filename) as book:
        shared = []
        if "xl/sharedStrings.xml" in book.namelist():
            root = ET.fromstring(book.read("xl/sharedStrings.xml"))
            shared = ["".join(node.itertext()) for node in root.findall("x:si", NS)]
        sheet_files = [name for name in book.namelist() if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", name)]
        for sheet_file in sheet_files:
            root = ET.fromstring(book.read(sheet_file))
            for row in root.findall(".//x:sheetData/x:row", NS):
                values = {}
                for cell in row.findall("x:c", NS):
                    match = re.match(r"([A-Z]+)", cell.get("r", ""))
                    if match:
                        values[match.group(1)] = cell_text(cell, shared)
                if values:
                    yield values


def ticker_rows(filename, board):
    tickers = set()
    ticker_column = None
    for values in xlsx_rows(filename):
        if ticker_column is None:
            for column, value in values.items():
                label = re.sub(r"\s+", " ", value.strip().upper())
                if "KODE" in label or "TICKER" in label or "SYMBOL" in label:
                    ticker_column = column
                    break
            continue
        value = values.get(ticker_column, "")
        ticker = re.sub(r"\.JK$", "", value.strip().upper())
        if re.fullmatch(r"[A-Z0-9]{2,5}", ticker) and ticker not in {"NO", "KODE", "CODE", "IDX", "BEI"}:
            tickers.add(ticker)
    if not tickers:
        raise ValueError("No ticker column or ticker values found in " + filename)
    return [{"ticker": ticker, "board": board} for ticker in sorted(tickers)]


def request(url, method, key, payload=None):
    headers = {"apikey": key, "Authorization": "Bearer " + key}
    if payload is not None:
        headers.update({"Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=minimal"})
    req = urllib.request.Request(url, data=payload, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=30) as response:
        return response.read()


def main():
    parser = argparse.ArgumentParser(description="Dry-run by default: upsert ticker + board from official BEI XLSX files.")
    for flag, _ in BOARD_ARGS:
        parser.add_argument("--" + flag, metavar="XLSX")
    parser.add_argument("--apply", action="store_true", help="perform Supabase upserts (default is dry-run)")
    parser.add_argument("--replace-official-board-scope", action="store_true", help="with --apply, deactivate/delete stale UTAMA/PENGEMBANGAN rows only")
    parser.add_argument("--delete-missing", action="store_true", help="deprecated; use --replace-official-board-scope --apply")
    args = parser.parse_args()
    sources = [(getattr(args, flag.replace("-", "_")), board) for flag, board in BOARD_ARGS if getattr(args, flag.replace("-", "_"))]
    if not sources:
        parser.error("provide at least one board file, for example --utama FILE.xlsx")
    if args.delete_missing:
        parser.error("use --replace-official-board-scope --apply; deletion is otherwise intentionally unsupported")
    if args.replace_official_board_scope and not (getattr(args, "utama") and getattr(args, "pengembangan")):
        parser.error("--replace-official-board-scope requires both --utama and --pengembangan official files")
    for filename in (".env.local", ".env.intraday-runtime", ".env"):
        load_env_file(filename)
    rows, counts = [], {}
    for filename, board in sources:
        if not zipfile.is_zipfile(filename):
            raise ValueError("Expected an XLSX zip file: " + filename)
        board_rows = ticker_rows(filename, board)
        rows.extend(board_rows)
        counts[board] = len(board_rows)
    print("mode=" + ("APPLY" if args.apply else "DRY_RUN"))
    print("counts_by_board=" + json.dumps(counts, sort_keys=True))
    print("total_rows=" + str(len(rows)))
    print("samples=" + json.dumps(rows[:10]))
    url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    # Scope replacement needs a read even in dry-run, but is never destructive without --apply.
    stale = []
    has_active = False
    root_url = url.rstrip("/").replace("/rest/v1", "") if url else ""
    if args.replace_official_board_scope and url and key:
        try:
            raw = request(root_url + "/rest/v1/stock_boards?select=ticker,board,is_active&board=in.(UTAMA,PENGEMBANGAN)", "GET", key)
            existing = json.loads(raw.decode("utf-8"))
            has_active = any("is_active" in row for row in existing)
        except urllib.error.HTTPError:
            raw = request(root_url + "/rest/v1/stock_boards?select=ticker,board&board=in.(UTAMA,PENGEMBANGAN)", "GET", key)
            existing = json.loads(raw.decode("utf-8"))
        official = set(row["ticker"] for row in rows)
        stale = [row for row in existing if str(row.get("ticker", "")).upper() not in official]
        print("official_scope_before=" + str(len(existing)))
        print("official_scope_after=" + str(len(rows)))
        print("stale_rows=" + str(len(stale)))
        print("stale_samples=" + json.dumps(stale[:10]))
    elif args.replace_official_board_scope:
        print("stale_rows=unknown (set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to inspect existing rows)")
    if not args.apply:
        print("Dry-run only. Add --replace-official-board-scope --apply to align official UTAMA+PENGEMBANGAN rows.")
        return
    if not url or not key:
        raise ValueError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required only with --apply")
    endpoint = root_url + "/rest/v1/stock_boards?on_conflict=ticker"
    for start in range(0, len(rows), 250):
        batch = rows[start:start + 250]
        request(endpoint, "POST", key, json.dumps(batch).encode("utf-8"))
        print("upserted=" + str(start + 1) + "-" + str(start + len(batch)))
    if args.replace_official_board_scope and stale:
        tickers = ",".join(str(row["ticker"]) for row in stale)
        scope = root_url + "/rest/v1/stock_boards?ticker=in.(" + urllib.parse.quote(tickers, safe=",") + ")&board=in.(UTAMA,PENGEMBANGAN)"
        if has_active:
            request(scope, "PATCH", key, json.dumps({"is_active": False}).encode("utf-8"))
            print("deactivated_stale=" + str(len(stale)))
        else:
            print("WARNING: stock_boards has no is_active column; deleting stale rows due to explicit --replace-official-board-scope --apply")
            request(scope, "DELETE", key)
            print("deleted_stale=" + str(len(stale)))
    print("Applied " + str(len(rows)) + " stock_boards upserts.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, zipfile.BadZipFile, urllib.error.URLError, urllib.error.HTTPError) as error:
        print("ERROR: " + str(error), file=sys.stderr)
        sys.exit(1)
