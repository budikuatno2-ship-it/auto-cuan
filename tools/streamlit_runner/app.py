"""
Auto-Cuan Manual Runner — Streamlit App
========================================
Run refresh/screener flows manually without browser console.
No secrets stored in repo. All config via sidebar inputs.
"""

import time
import json
import streamlit as st
import requests

# ---------------------------------------------------------------------------
# Page config
# ---------------------------------------------------------------------------
st.set_page_config(
    page_title="Auto-Cuan Manual Runner",
    page_icon="🚀",
    layout="wide",
)

st.title("🚀 Auto-Cuan Manual Runner")
st.caption("Run refresh & screener flows manually. No crons, no browser console.")

# ---------------------------------------------------------------------------
# Sidebar — Configuration
# ---------------------------------------------------------------------------
st.sidebar.header("⚙️ Configuration")

base_url = st.sidebar.text_input(
    "AUTO_CUAN_BASE_URL",
    placeholder="https://your-preview-or-prod.vercel.app",
    help="Enter the Vercel Preview URL or Production URL (no trailing slash).",
)

cron_secret = st.sidebar.text_input(
    "CRON_SECRET",
    type="password",
    placeholder="your-cron-secret",
    help="The CRON_SECRET environment variable value.",
)

delay_seconds = st.sidebar.slider(
    "Delay between Non-Konglo calls (seconds)",
    min_value=1,
    max_value=10,
    value=3,
    step=1,
)

max_nk_runs = st.sidebar.number_input(
    "Max Non-Konglo runs",
    min_value=1,
    max_value=200,
    value=90,
    step=1,
)

REQUEST_TIMEOUT = 120  # seconds


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def get_headers():
    """Build request headers with authorization."""
    return {
        "Authorization": f"Bearer {cron_secret}",
        "Content-Type": "application/json",
    }


def validate_config():
    """Check that base_url and cron_secret are filled in."""
    if not base_url or not base_url.strip():
        st.error("❌ Please enter AUTO_CUAN_BASE_URL in the sidebar.")
        return False
    if not cron_secret or not cron_secret.strip():
        st.error("❌ Please enter CRON_SECRET in the sidebar.")
        return False
    return True


def call_api(endpoint, params=None, timeout=REQUEST_TIMEOUT):
    """Make a GET request to the API and return (response, error_msg)."""
    url = f"{base_url.rstrip('/')}{endpoint}"
    try:
        resp = requests.get(url, headers=get_headers(), params=params, timeout=timeout)
        return resp, None
    except requests.exceptions.Timeout:
        return None, "⏱️ Request timed out."
    except requests.exceptions.ConnectionError:
        return None, "🔌 Connection error. Check your BASE_URL."
    except Exception as e:
        return None, f"❌ Unexpected error: {e}"


def show_raw_json(data, label="Raw JSON Response"):
    """Show expandable raw JSON."""
    with st.expander(f"📋 {label}"):
        st.json(data)


# ---------------------------------------------------------------------------
# Tab layout
# ---------------------------------------------------------------------------
tab_a, tab_b, tab_c, tab_d, tab_e = st.tabs([
    "🔄 Sektor Hot Refresh",
    "📊 Konglo Screener",
    "📈 Non-Konglo Screener",
    "🐛 Debug Members",
    "✅ Smoke Test",
])

# ===========================================================================
# A. Sektor Hot Refresh
# ===========================================================================
with tab_a:
    st.header("🔄 Sektor Hot Refresh")
    st.markdown("Calls `/api/sector-hot?action=refresh` to refresh sector hot data.")

    if st.button("▶️ Run Sektor Hot Refresh", key="btn_sector_refresh"):
        if validate_config():
            with st.spinner("Running Sektor Hot Refresh..."):
                resp, err = call_api("/api/sector-hot", params={"action": "refresh"})

            if err:
                st.error(err)
            else:
                st.metric("HTTP Status", resp.status_code)
                try:
                    data = resp.json()
                except Exception:
                    st.error("Failed to parse JSON response.")
                    st.code(resp.text[:2000])
                    data = None

                if data:
                    col1, col2, col3 = st.columns(3)
                    col1.metric("success", str(data.get("success", "N/A")))
                    col2.metric("scannedCount", data.get("scannedCount", "N/A"))
                    col3.metric("failedCount", data.get("failedCount", "N/A"))

                    col4, col5, col6 = st.columns(3)
                    col4.metric("groupsProcessed", data.get("groupsProcessed", "N/A"))
                    col5.metric("memberRowsAttempted", data.get("memberRowsAttempted", "N/A"))
                    col6.metric("memberRowsInserted", data.get("memberRowsInserted", "N/A"))

                    col7, col8 = st.columns(2)
                    member_errors = data.get("memberInsertErrors", data.get("memberUpsertErrors", []))
                    error_count = len(member_errors) if isinstance(member_errors, list) else member_errors
                    col7.metric("memberInsertErrors", error_count)
                    col8.metric("zeroActiveGroupsCleaned", data.get("zeroActiveGroupsCleaned", "N/A"))

                    # Show member insert errors detail
                    if member_errors and isinstance(member_errors, list) and len(member_errors) > 0:
                        st.error(f"⚠️ {len(member_errors)} member insert error(s):")
                        for me in member_errors[:10]:
                            st.write(f"- `{me}`")

                    # Show failed tickers
                    failed_tickers = data.get("failedTickers", [])
                    if failed_tickers:
                        with st.expander(f"❌ Failed Tickers ({len(failed_tickers)})"):
                            st.write(", ".join(failed_tickers[:50]))

                    sample = data.get("sample_member")
                    if sample:
                        st.subheader("Sample Member")
                        st.json(sample)

                    show_raw_json(data)

# ===========================================================================
# B. Konglo Screener
# ===========================================================================
with tab_b:
    st.header("📊 Konglo Screener")
    st.markdown("Calls `/api/sector-hot?action=refresh-screener&ai=0`")
    st.warning("⚠️ Always uses `ai=0`. Screener AI is **disabled**.")

    if st.button("▶️ Run Konglo Screener", key="btn_konglo"):
        if validate_config():
            with st.spinner("Running Konglo Screener (ai=0)... This may take 1-3 minutes."):
                resp, err = call_api(
                    "/api/sector-hot",
                    params={"action": "refresh-screener", "ai": "0"},
                    timeout=300,  # screener needs longer timeout
                )

            if err:
                st.error(err)
            else:
                st.metric("HTTP Status", resp.status_code)
                try:
                    data = resp.json()
                except Exception:
                    st.error("Failed to parse JSON response.")
                    st.code(resp.text[:2000])
                    data = None

                if data:
                    # --- Key metrics (correct field names from API) ---
                    success = data.get("success", False)
                    universe_count = data.get("universe_count", 0)
                    scanned_count = data.get("scanned_count", 0)
                    generated_count = data.get("generated_count", 0)
                    saved_count = data.get("saved_count", 0)
                    failed_count = data.get("failed_count", 0)
                    save_error = data.get("save_error")
                    ai_diagnostic = data.get("ai_diagnostic", "")

                    col1, col2, col3 = st.columns(3)
                    col1.metric("success", str(success))
                    col2.metric("Universe", universe_count)
                    col3.metric("Scanned", scanned_count)

                    col4, col5, col6 = st.columns(3)
                    col4.metric("Generated (passed filters)", generated_count)
                    col5.metric("Saved to DB", saved_count)
                    col6.metric("Failed (fetch)", failed_count)

                    # --- Critical warnings ---
                    if success and saved_count == 0:
                        st.error(
                            "⚠️ **Run succeeded but 0 rows saved!** "
                            "Web UI Konglo page will still show empty. "
                            "Check `save_error` in raw JSON below."
                        )
                    elif not success and saved_count == 0:
                        st.error(
                            "❌ **Refresh failed — no rows saved.** "
                            "Web UI Konglo page will remain empty."
                        )
                    elif success and saved_count > 0:
                        st.success(
                            f"✅ **{saved_count} rows saved successfully.** "
                            f"Web UI Konglo page should show data after reload."
                        )

                    if save_error:
                        st.error(f"💾 Save Error: `{save_error}`")

                    # --- AI diagnostic ---
                    if ai_diagnostic:
                        st.info(f"🤖 AI: {ai_diagnostic}")

                    # --- Failed tickers ---
                    failed_items = data.get("screener_failed_tickers", [])
                    if failed_items:
                        st.subheader(f"Failed Tickers ({len(failed_items)})")
                        for item in failed_items[:20]:
                            if isinstance(item, dict):
                                st.write(f"- **{item.get('ticker', '?')}**: {item.get('reason', 'unknown')}")
                            else:
                                st.write(f"- {item}")
                        if len(failed_items) > 20:
                            st.caption(f"... and {len(failed_items) - 20} more (see raw JSON)")

                    # --- AI candidate tickers sent ---
                    ai_candidates = data.get("ai_candidates_sent", [])
                    if ai_candidates:
                        with st.expander(f"🎯 AI Candidates Sent ({len(ai_candidates)})"):
                            st.write(", ".join(ai_candidates))

                    show_raw_json(data)

# ===========================================================================
# C. Non-Konglo Screener
# ===========================================================================
with tab_c:
    st.header("📈 Non-Konglo Screener")
    st.markdown(
        "Calls `/api/sector-hot?action=nk-screener-run&force=1` in a loop "
        "until finalize / already_done / already_completed."
    )
    st.info(f"Max runs: **{max_nk_runs}** | Delay: **{delay_seconds}s** between calls")

    if st.button("▶️ Run Non-Konglo Until Finalize", key="btn_nk"):
        if validate_config():
            progress_bar = st.progress(0)
            status_container = st.container()
            log_container = st.container()
            all_responses = []
            stopped = False

            for run_num in range(1, max_nk_runs + 1):
                progress_bar.progress(run_num / max_nk_runs)

                with status_container:
                    st.write(f"**Run #{run_num}** — calling API...")

                resp, err = call_api(
                    "/api/sector-hot",
                    params={"action": "nk-screener-run", "force": "1"},
                )

                if err:
                    st.error(f"Run #{run_num} failed: {err}")
                    stopped = True
                    break

                if resp.status_code != 200:
                    st.error(f"Run #{run_num} — HTTP {resp.status_code}")
                    try:
                        st.json(resp.json())
                    except Exception:
                        st.code(resp.text[:2000])
                    stopped = True
                    break

                try:
                    data = resp.json()
                except Exception:
                    st.error(f"Run #{run_num} — Failed to parse JSON")
                    st.code(resp.text[:2000])
                    stopped = True
                    break

                all_responses.append({"run": run_num, "data": data})

                # Display live progress
                with log_container:
                    step = data.get("step", data.get("status", "unknown"))
                    processed = data.get("processed", data.get("scanned_count", "?"))
                    total_universe = data.get("universe_count", data.get("totalUniverse", "?"))
                    batch_index = data.get("batch_index", data.get("batchIndex", "?"))
                    total_batches = data.get("batch_count", data.get("totalBatches", "?"))
                    passed = data.get("passed", data.get("result_count", "?"))
                    failed_c = data.get("failed", data.get("failed_count", "?"))
                    published = data.get("published", data.get("published_count", "?"))
                    top_score = data.get("top_score", "?")
                    message = data.get("message", "")

                    st.markdown(
                        f"**Run #{run_num}** | step: `{step}` | "
                        f"processed: {processed}/{total_universe} | "
                        f"batch: {batch_index}/{total_batches} | "
                        f"passed: {passed} | failed: {failed_c} | "
                        f"published: {published} | top_score: {top_score}"
                    )
                    if message:
                        st.caption(f"  ↳ {message}")

                # Check for terminal states
                status_val = str(data.get("step", data.get("status", ""))).lower()
                if any(term in status_val for term in ["finalize", "already_done", "already_completed", "done", "completed", "published"]):
                    st.success(f"✅ Non-Konglo finished at run #{run_num} — status: `{step}`")
                    stopped = True
                    break

                # Check if API returns success=false with specific messages
                if not data.get("success", True) and data.get("skipped"):
                    st.warning(f"⏭️ Skipped: {data.get('error', 'unknown reason')}")
                    stopped = True
                    break

                # Delay between calls
                if run_num < max_nk_runs:
                    time.sleep(delay_seconds)

            if not stopped:
                st.warning(f"⚠️ Reached max runs ({max_nk_runs}) without finalize. You may increase max runs and retry.")

            progress_bar.progress(1.0)

            # Show all raw responses
            if all_responses:
                show_raw_json(all_responses, "All Non-Konglo Responses")

# ===========================================================================
# D. Debug Sektor Hot Members
# ===========================================================================
with tab_d:
    st.header("🐛 Debug Sektor Hot Members")
    st.markdown("Calls `/api/sector-hot?action=debug-members&group=GROUP_CODE`")

    group_code = st.text_input(
        "Group Code",
        value="SALIM_CORE",
        placeholder="e.g. SALIM_CORE, BUMN_KARYA_INFRA_CORE",
        key="debug_group",
    )

    if st.button("▶️ Debug Group Members", key="btn_debug"):
        if validate_config():
            if not group_code.strip():
                st.error("Please enter a group code.")
            else:
                with st.spinner(f"Debugging {group_code}..."):
                    resp, err = call_api(
                        "/api/sector-hot",
                        params={"action": "debug-members", "group": group_code.strip()},
                    )

                if err:
                    st.error(err)
                else:
                    st.metric("HTTP Status", resp.status_code)
                    try:
                        data = resp.json()
                    except Exception:
                        st.error("Failed to parse JSON response.")
                        st.code(resp.text[:2000])
                        data = None

                    if data:
                        # API returns nested structure:
                        # mapping: {data, error, active_count}
                        # latest_header: {data, error}
                        # members_latest: {row_count, with_last_price, with_change_pct, with_volume, with_ratio, error, sample, field_names}
                        # conclusion: string

                        mapping = data.get("mapping", {})
                        latest_header = data.get("latest_header", {})
                        members_latest = data.get("members_latest", {})

                        col1, col2 = st.columns(2)
                        col1.metric("Active Member Count", mapping.get("active_count", "N/A"))
                        col2.metric("members_latest row_count", members_latest.get("row_count", "N/A"))

                        col3, col4 = st.columns(2)
                        col3.metric("with_last_price", members_latest.get("with_last_price", "N/A"))
                        col4.metric("with_change_pct", members_latest.get("with_change_pct", "N/A"))

                        col5, col6 = st.columns(2)
                        col5.metric("with_volume", members_latest.get("with_volume", "N/A"))
                        col6.metric("with_ratio", members_latest.get("with_ratio", "N/A"))

                        # Show errors if any
                        if mapping.get("error"):
                            st.error(f"Mapping error: {mapping['error']}")
                        if latest_header.get("error"):
                            st.error(f"Latest header error: {latest_header['error']}")
                        if members_latest.get("error"):
                            st.error(f"Members latest error: {members_latest['error']}")

                        header_data = latest_header.get("data")
                        if header_data:
                            st.subheader("Latest Header")
                            st.json(header_data)

                        sample_row = members_latest.get("sample")
                        if sample_row:
                            st.subheader("Sample Row")
                            st.json(sample_row)

                        conclusion = data.get("conclusion")
                        if conclusion:
                            st.subheader("Conclusion")
                            if conclusion == "DB_HAS_DATA":
                                st.success(f"✅ {conclusion}")
                            elif conclusion == "ROWS_EXIST_BUT_NULL_FIELDS":
                                st.warning(f"⚠️ {conclusion}")
                            else:
                                st.error(f"❌ {conclusion}")

                        show_raw_json(data)

# ===========================================================================
# E. Smoke Test Checklist
# ===========================================================================
with tab_e:
    st.header("✅ Smoke Test Checklist")
    st.markdown("Use this checklist to manually verify all critical flows after a deployment.")

    st.subheader("Sektor Hot Detail Pages")
    st.checkbox("SALIM_CORE — detail loads correctly", key="smoke_salim")
    st.checkbox("BUMN_KARYA_INFRA_CORE — detail loads correctly", key="smoke_bumn")
    st.checkbox("KALBE_CORE — detail loads correctly", key="smoke_kalbe")
    st.checkbox("MAP_GROUP_CORE — detail loads correctly", key="smoke_map")
    st.checkbox("DJARUM_HARTONO_RADAR — detail loads correctly", key="smoke_djarum")

    st.subheader("Screener Flows")
    st.checkbox("Konglo Screener — runs without error", key="smoke_konglo")
    st.checkbox("Non-Konglo — reaches finalize", key="smoke_nk")

    st.subheader("Templates & Content")
    st.checkbox("IHSG full template — renders correctly", key="smoke_ihsg")
    st.checkbox("BBCA stock template — renders correctly", key="smoke_bbca")
    st.checkbox("BREN stock template — renders correctly", key="smoke_bren")
    st.checkbox("DATA stock template — renders correctly", key="smoke_data")

    st.subheader("Other")
    st.checkbox("Follow-up answer — works", key="smoke_followup")
    st.checkbox("Lihat News — displays correctly", key="smoke_news")

    st.divider()
    st.caption("Checkboxes are for your manual tracking only. They reset on page reload.")

# ---------------------------------------------------------------------------
# Footer
# ---------------------------------------------------------------------------
st.divider()
st.caption("Auto-Cuan Manual Runner • No secrets stored in repo • ai=1 is NEVER called")
