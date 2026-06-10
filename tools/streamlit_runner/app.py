"""
Auto-Cuan Streamlit Manual Runner
=================================
Local tool for manually running screeners and refreshes.
No secrets are committed. CRON_SECRET is read from .env or sidebar input.
"""

import os
import time
import streamlit as st
import requests
import pandas as pd
from dotenv import load_dotenv

# Load .env if present
load_dotenv()

# ============================================================
# SIDEBAR — Configuration
# ============================================================

st.set_page_config(page_title="Auto-Cuan Runner", page_icon="📊", layout="wide")

st.sidebar.title("⚙️ Configuration")

api_base = st.sidebar.text_input(
    "API Base URL",
    value=os.getenv("API_BASE_URL", ""),
    placeholder="https://your-preview-url.vercel.app",
    help="Vercel Preview deployment URL (no trailing slash)"
)

cron_secret = st.sidebar.text_input(
    "CRON_SECRET",
    value=os.getenv("CRON_SECRET", ""),
    type="password",
    help="Bearer token for protected API actions"
)

vercel_bypass = st.sidebar.text_input(
    "Vercel Protection Bypass Token (optional)",
    value=os.getenv("VERCEL_BYPASS_TOKEN", ""),
    type="password",
    help="Needed only if Preview has Vercel Deployment Protection enabled"
)

st.sidebar.divider()
st.sidebar.caption("⚠️ Secrets are stored in local session only. Never committed.")
if vercel_bypass:
    st.sidebar.success("🔓 Bypass token set — will bypass Vercel auth.")
else:
    st.sidebar.info("ℹ️ No bypass token. If Preview is protected, requests may fail.")

# ============================================================
# HELPERS
# ============================================================

def get_headers(auth=False):
    """Build request headers."""
    headers = {}
    if auth and cron_secret:
        headers["Authorization"] = f"Bearer {cron_secret}"
    return headers


def api_url(action, **params):
    """Build full API URL with optional Vercel bypass params."""
    base = api_base.rstrip("/")
    query = f"action={action}"
    for k, v in params.items():
        if v is not None:
            query += f"&{k}={v}"
    # Append Vercel Protection Bypass params if token is set
    if vercel_bypass:
        query += f"&x-vercel-set-bypass-cookie=true&x-vercel-protection-bypass={vercel_bypass}"
    return f"{base}/api/sector-hot?{query}"


def call_api(action, auth=False, **params):
    """Call API and return JSON response with robust error handling."""
    url = api_url(action, **params)
    headers = get_headers(auth=auth)
    try:
        resp = requests.get(url, headers=headers, timeout=120)

        # Try JSON parse
        try:
            return resp.json()
        except (ValueError, requests.exceptions.JSONDecodeError):
            # Response is not JSON — likely Vercel auth page or error page
            body_preview = resp.text[:300] if resp.text else "(empty)"
            is_vercel_auth = (
                "Authentication Required" in resp.text or
                "Vercel Authentication" in resp.text or
                "x-vercel-protection" in resp.text.lower() or
                "vercel.com" in resp.text.lower() and resp.status_code in (401, 403, 200)
            )

            error_msg = f"Non-JSON response (HTTP {resp.status_code})"
            if is_vercel_auth:
                error_msg = (
                    "Preview deployment is protected by Vercel Authentication. "
                    "Add VERCEL_BYPASS_TOKEN in the sidebar or use an unprotected deployment."
                )

            return {
                "success": False,
                "error": error_msg,
                "_http_status": resp.status_code,
                "_response_preview": body_preview,
                "_is_vercel_auth": is_vercel_auth
            }

    except requests.exceptions.Timeout:
        return {"success": False, "error": "Request timeout (120s). The API may be processing a large batch."}
    except requests.exceptions.ConnectionError as e:
        return {"success": False, "error": f"Connection error: {str(e)[:200]}"}
    except Exception as e:
        return {"success": False, "error": f"Request failed: {str(e)[:200]}"}


def check_config():
    """Validate configuration."""
    if not api_base:
        st.error("❌ API Base URL belum diisi. Isi di sidebar kiri.")
        return False
    if not cron_secret:
        st.error("❌ CRON_SECRET belum diisi. Isi di sidebar kiri.")
        return False
    return True


def show_error_details(data):
    """Show detailed error info for debugging."""
    if data.get("_is_vercel_auth"):
        st.error(f"🔒 {data['error']}")
    else:
        st.error(f"❌ {data.get('error', 'Unknown error')}")

    if data.get("_http_status") or data.get("_response_preview"):
        with st.expander("🔍 Debug Details"):
            if data.get("_http_status"):
                st.write(f"**HTTP Status:** {data['_http_status']}")
            if data.get("_response_preview"):
                st.code(data["_response_preview"][:500], language="html")


# ============================================================
# TABS
# ============================================================

st.title("📊 Auto-Cuan Manual Runner")

tab_dt, tab_sektor, tab_konglo, tab_nk = st.tabs([
    "🎯 Day Trade Screener",
    "🔥 Sektor Hot Refresh",
    "📈 Konglo Screener",
    "📊 Non-Konglo Screener"
])

# ============================================================
# TAB: DAY TRADE SCREENER
# ============================================================

with tab_dt:
    st.header("Day Trade Screener")
    st.caption("Intraday momentum & pre-spike radar. Deterministic, no AI.")

    col1, col2 = st.columns([2, 1])
    with col1:
        dt_mode = st.selectbox("Run Mode", ["auto", "morning", "midday", "afternoon"],
                               help="Auto = detect from WIB time")
    with col2:
        st.write("")  # spacer

    if st.button("🚀 Run Day Trade Screener", type="primary", use_container_width=True):
        if not check_config():
            st.stop()

        # Initialize progress
        progress_bar = st.progress(0)
        status_text = st.empty()
        metrics_cols = st.columns(5)
        detail_text = st.empty()

        batch = 0
        max_batches = 100  # safety limit
        final_status = None
        last_data = None

        while batch < max_batches:
            status_text.info(f"⏳ Calling batch {batch}...")

            params = {"force": "1", "batch": str(batch)}
            if dt_mode != "auto":
                params["mode"] = dt_mode

            data = call_api("daytrade-screener-run", auth=True, **params)

            # Check for non-JSON / auth errors first
            if data.get("_is_vercel_auth") or data.get("_http_status"):
                show_error_details(data)
                final_status = "failed"
                last_data = data
                break

            if not data.get("success") and data.get("status") != "running":
                show_error_details(data)
                final_status = "failed"
                last_data = data
                break

            status = data.get("status", "unknown")
            universe = data.get("universe_count", 0)
            scanned = data.get("scanned_count", 0)
            passed = data.get("passed_count", 0)
            failed = data.get("failed_count", 0)
            batch_count = data.get("batch_count", 1)
            published = data.get("published_count", 0)
            message = data.get("message", "")

            # Update progress
            pct = scanned / universe if universe > 0 else 0
            progress_bar.progress(min(pct, 1.0))

            with metrics_cols[0]:
                st.metric("Status", status.upper())
            with metrics_cols[1]:
                st.metric("Scanned", f"{scanned}/{universe}")
            with metrics_cols[2]:
                st.metric("Batch", f"{batch + 1}/{batch_count}")
            with metrics_cols[3]:
                st.metric("Passed", passed)
            with metrics_cols[4]:
                st.metric("Failed", failed)

            detail_text.caption(f"📋 {message}")

            # Check terminal states
            if status in ("published", "already_done"):
                final_status = status
                last_data = data
                break
            elif status == "failed":
                final_status = "failed"
                last_data = data
                break

            # Continue to next batch
            next_batch = data.get("next_batch")
            if next_batch is not None and next_batch > batch:
                batch = next_batch
            else:
                batch += 1

            time.sleep(0.5)  # brief pause between batch calls

        # Final result
        progress_bar.progress(1.0)

        if final_status == "published":
            status_text.success(f"✅ Published! {last_data.get('published_count', 0)} candidates.")
        elif final_status == "already_done":
            status_text.success(f"✅ Already done for today. {last_data.get('published_count', 0)} candidates.")
        elif final_status != "failed":
            status_text.error(f"❌ Run ended with status: {final_status}")

        # Show failed tickers if any
        failed_tickers = last_data.get("failed_tickers") if last_data else None
        if failed_tickers:
            with st.expander(f"⚠️ Failed Tickers ({len(failed_tickers)})"):
                st.json(failed_tickers[:20])

        # Load and display latest results (only if not auth failure)
        if final_status in ("published", "already_done"):
            st.divider()
            st.subheader("📊 Latest Day Trade Results")
            read_data = call_api("daytrade-screener", auth=False)

            if read_data.get("_is_vercel_auth"):
                show_error_details(read_data)
            elif read_data.get("success") and read_data.get("results"):
                results = read_data["results"]
                meta = read_data.get("meta", {})

                # Status distribution
                st.caption(f"Last updated: {meta.get('calculated_at', '—')} | Mode: {meta.get('run_mode', '—')}")
                status_counts = {}
                for r in results:
                    s = r.get("status", "UNKNOWN")
                    status_counts[s] = status_counts.get(s, 0) + 1

                priority_order = ["READY_BREAKOUT", "PRE_SPIKE_WATCH", "MOMENTUM_CONTINUATION",
                                  "RECLAIM_CANDIDATE", "WAIT_PULLBACK", "SPECULATIVE", "AVOID"]
                sorted_counts = sorted(status_counts.items(),
                                       key=lambda x: priority_order.index(x[0]) if x[0] in priority_order else 99)

                if sorted_counts:
                    scols = st.columns(len(sorted_counts))
                    for i, (s, c) in enumerate(sorted_counts):
                        with scols[i]:
                            st.metric(s.replace("_", " ").title(), c)

                # Build DataFrame
                display_cols = [
                    "ticker", "board", "status", "daytrade_score", "setup",
                    "last_price", "change_pct", "volume_ratio_20d", "value_today",
                    "prespike_score", "momentum_score", "entry_low", "entry_high",
                    "stop_loss", "tp1", "tp2", "risk_reward", "time_plan", "notes"
                ]
                df = pd.DataFrame(results)
                available_cols = [c for c in display_cols if c in df.columns]
                df_display = df[available_cols].copy()

                # Format value_today
                if "value_today" in df_display.columns:
                    df_display["value_today"] = df_display["value_today"].apply(
                        lambda v: f"{v/1e9:.1f}B" if v and v >= 1e9 else (f"{v/1e6:.0f}M" if v and v >= 1e6 else "—")
                    )

                st.dataframe(df_display, use_container_width=True, height=600)
            else:
                st.warning("Data belum tersedia atau gagal dimuat.")

    # Quick read (no run)
    st.divider()
    if st.button("📖 Read Latest Day Trade Results (no run)"):
        if not api_base:
            st.error("❌ API Base URL belum diisi.")
        else:
            read_data = call_api("daytrade-screener", auth=False)

            if read_data.get("_is_vercel_auth"):
                show_error_details(read_data)
            elif read_data.get("success") and read_data.get("results"):
                results = read_data["results"]
                meta = read_data.get("meta", {})
                st.info(f"Status: {meta.get('status', '—')} | Published: {meta.get('published_count', 0)} | "
                        f"Mode: {meta.get('run_mode', '—')} | Updated: {meta.get('calculated_at', '—')}")

                df = pd.DataFrame(results)
                cols = ["ticker", "status", "daytrade_score", "setup", "last_price",
                        "change_pct", "volume_ratio_20d", "risk_reward", "notes"]
                available = [c for c in cols if c in df.columns]
                st.dataframe(df[available], use_container_width=True, height=400)
            else:
                show_error_details(read_data)


# ============================================================
# TAB: SEKTOR HOT REFRESH
# ============================================================

with tab_sektor:
    st.header("Sektor Hot Refresh")
    st.caption("Refresh data Grup Konglomerat Hot (harga, volume, ranking).")

    if st.button("🔄 Refresh Sektor Hot", type="primary"):
        if not check_config():
            st.stop()

        with st.spinner("Refreshing Sektor Hot..."):
            data = call_api("refresh", auth=True)

        if data.get("_is_vercel_auth"):
            show_error_details(data)
        elif data.get("success"):
            st.success(f"✅ Refresh complete! Scanned: {data.get('scannedCount', '—')}, "
                       f"Failed: {data.get('failedCount', 0)}, Groups: {data.get('groupsProcessed', '—')}")
            if data.get("failedTickers"):
                with st.expander("⚠️ Failed Tickers"):
                    st.write(data["failedTickers"])
        else:
            show_error_details(data)

        with st.expander("📋 Raw Response"):
            st.json(data)


# ============================================================
# TAB: KONGLO SCREENER
# ============================================================

with tab_konglo:
    st.header("Konglo Swing Screener")
    st.caption("Run Konglo screener (deterministic only, no AI).")
    st.warning("⚠️ This calls refresh-screener WITHOUT ai=1. AI remains disabled.")

    if st.button("🔬 Run Konglo Screener", type="primary"):
        if not check_config():
            st.stop()

        with st.spinner("Running Konglo Screener (no AI)..."):
            # Explicitly NO ai=1 parameter — deterministic only
            data = call_api("refresh-screener", auth=True)

        if data.get("_is_vercel_auth"):
            show_error_details(data)
        elif data.get("success"):
            st.success(f"✅ Screener complete! Universe: {data.get('universe_count', '—')}, "
                       f"Saved: {data.get('saved_count', 0)}, Failed: {data.get('failed_count', 0)}")
        else:
            show_error_details(data)

        with st.expander("📋 Raw Response"):
            st.json(data)


# ============================================================
# TAB: NON-KONGLO SCREENER
# ============================================================

with tab_nk:
    st.header("Non-Konglo Swing Screener")
    st.caption("Run Non-Konglo screener with automatic batch loop.")

    if st.button("🚀 Run Non-Konglo Screener", type="primary", key="nk_run"):
        if not check_config():
            st.stop()

        progress_bar = st.progress(0)
        status_text = st.empty()
        metrics_row = st.columns(5)
        detail_text = st.empty()

        max_calls = 50  # safety limit — NK has ~50-80 batches of 8 tickers
        call_count = 0
        final_status = None
        last_data = None
        universe_count = 0
        total_scanned = 0
        total_passed = 0
        total_failed = 0
        batch_count_est = 0

        while call_count < max_calls:
            call_count += 1
            status_text.info(f"⏳ NK Screener call #{call_count}...")

            # force=1 only on first call to trigger clean start
            # Subsequent calls use auto-mode (no force) to process batches naturally
            params = {"force": "1"} if call_count == 1 else {}
            data = call_api("nk-screener-run", auth=True, **params)

            # Check for auth/non-JSON errors
            if data.get("_is_vercel_auth") or (data.get("_http_status") and data.get("_http_status") not in (200, 401)):
                show_error_details(data)
                final_status = "failed"
                last_data = data
                break

            last_data = data

            # Handle non-success responses
            if not data.get("success"):
                error_msg = data.get("error", "")
                step = data.get("step", "")

                # Skipped (outside time window) — should not happen with force=1
                if data.get("skipped"):
                    st.warning(f"⚠️ Skipped: {error_msg}")
                    final_status = "skipped"
                    break

                # Cannot finalize: pending/processing remain — batches still in progress
                # This can happen if a batch is currently being processed by another request
                # or if there's a race condition. Continue looping — next call will process batch.
                if "pending/processing batches remain" in error_msg or "processing" in error_msg.lower():
                    pending_count = data.get("pending", "?")
                    detail_text.caption(f"⏳ Finalize attempted but {pending_count} batch(es) remain. Processing next...")
                    time.sleep(1.5)
                    continue

                # Blocked by stale processing without force (shouldn't happen since we use force=1)
                if step == "blocked":
                    detail_text.caption(f"⚠️ Stale processing jobs detected. Retrying with force=1...")
                    time.sleep(1.0)
                    continue

                # Failed to publish (no candidates) — acceptable end state
                if "No candidates passed filters" in error_msg or data.get("published") == 0:
                    final_status = "no_candidates"
                    status_text.warning(f"⚠️ {error_msg}")
                    break

                # Other failures
                show_error_details(data)
                final_status = "failed"
                break

            # Success response — determine step and update progress
            step = data.get("step", "auto")

            # START step: universe created, batches built
            if step == "start":
                universe_count = data.get("universe_count", 0)
                batch_count_est = data.get("batch_count", 0)
                detail_text.caption(f"✅ Universe: {universe_count} tickers → {batch_count_est} batches created")
                with metrics_row[0]:
                    st.metric("Universe", universe_count)
                with metrics_row[1]:
                    st.metric("Batches", batch_count_est)

            # BATCH step: one batch processed
            elif step == "batch":
                batch_idx = data.get("batch_index", 0)
                batch_passed = data.get("passed", 0)
                batch_failed = data.get("failed", 0)
                batch_processed = data.get("processed", 0)
                total_passed += batch_passed
                total_failed += batch_failed
                total_scanned += batch_processed

                # Update progress bar
                pct = min((batch_idx + 1) / max(batch_count_est, 1), 0.95) if batch_count_est > 0 else min(call_count / 50, 0.95)
                progress_bar.progress(pct)

                detail_text.caption(
                    f"Batch {batch_idx + 1}/{batch_count_est or '?'}: "
                    f"+{batch_passed} passed, {batch_failed} failed | "
                    f"Total: scanned={total_scanned}, passed={total_passed}"
                )

                with metrics_row[0]:
                    st.metric("Scanned", total_scanned)
                with metrics_row[1]:
                    st.metric("Batches", f"{batch_idx + 1}/{batch_count_est or '?'}")
                with metrics_row[2]:
                    st.metric("Passed", total_passed)
                with metrics_row[3]:
                    st.metric("Failed", total_failed)
                with metrics_row[4]:
                    st.metric("Call #", call_count)

                if data.get("staging_error"):
                    st.warning(f"⚠️ Staging error: {data['staging_error']}")

            # FINALIZE step: done!
            elif step == "finalize":
                final_status = "published"
                break

            # "No action needed" (already published today)
            elif data.get("message", "").startswith("No action needed"):
                final_status = "already_done"
                break

            # Small delay between calls to avoid hammering API
            time.sleep(0.5)

        # Final state
        progress_bar.progress(1.0)

        if final_status == "published":
            pub_count = last_data.get("published", 0) if last_data else 0
            staging = last_data.get("staging_count", 0) if last_data else 0
            status_text.success(f"✅ Non-Konglo Screener published! {pub_count} top candidates (from {staging} staging).")
        elif final_status == "already_done":
            status_text.success("✅ Already published for today. No action needed.")
        elif final_status == "no_candidates":
            pass  # warning already shown
        elif final_status == "skipped":
            pass  # warning already shown
        elif final_status != "failed":
            if call_count >= max_calls:
                status_text.error(f"❌ Reached max call limit ({max_calls}). NK scan may be too large or stalled.")
            else:
                status_text.error(f"❌ Ended with unexpected state: {final_status}")

        with st.expander("📋 Last API Response"):
            st.json(last_data or {})

        # Auto-read results if published
        if final_status == "published":
            st.divider()
            st.subheader("📊 Latest Non-Konglo Results")
            read_data = call_api("nk-screener-results", auth=False)
            if read_data.get("success") and read_data.get("results"):
                results = read_data["results"]
                meta_nk = read_data.get("meta", {})
                st.caption(f"Run date: {meta_nk.get('run_date', '—')} | Published: {meta_nk.get('published_count', 0)}")
                df = pd.DataFrame(results)
                cols = ["rank", "ticker", "status", "score", "grade", "setup_type",
                        "last_price", "change_pct", "volume_ratio_avg20", "risk_reward",
                        "entry_low", "entry_high", "stop_loss", "tp1", "status_reason"]
                available = [c for c in cols if c in df.columns]
                st.dataframe(df[available], use_container_width=True, height=500)
            elif read_data.get("error"):
                st.warning(f"Read results: {read_data.get('error', 'Unknown')}")

    # Quick read (no run)
    st.divider()
    if st.button("📖 Read Latest Non-Konglo Results", key="nk_read"):
        if not api_base:
            st.error("❌ API Base URL belum diisi.")
        else:
            # NK results require login headers — for Streamlit we just show raw
            data = call_api("nk-screener-results", auth=False)
            if data.get("_is_vercel_auth"):
                show_error_details(data)
            elif data.get("success") and data.get("results"):
                df = pd.DataFrame(data["results"])
                st.dataframe(df, use_container_width=True, height=400)
            else:
                show_error_details(data)
