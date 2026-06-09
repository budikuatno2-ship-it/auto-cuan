# Auto-Cuan Manual Runner (Streamlit)

A beginner-friendly local tool to run Auto-Cuan refresh/screener flows manually — no browser console needed.

---

## Features

| Tab | Description |
|-----|-------------|
| 🔄 Sektor Hot Refresh | Refresh sector hot data |
| 📊 Konglo Screener | Run Konglo screener (always `ai=0`) |
| 📈 Non-Konglo Screener | Loop until finalize with live progress |
| 🐛 Debug Members | Debug a specific group's members |
| ✅ Smoke Test | Manual verification checklist |

---

## Prerequisites

- **Python 3.9+** installed on your machine
- **Internet access** to reach your Vercel deployment
- Your **CRON_SECRET** value (from Vercel environment variables)

---

## Setup (Windows — Step by Step)

### 1. Check Python is installed

Open **Command Prompt** or **PowerShell** and run:

```cmd
py --version
```

You should see something like `Python 3.11.x`. If not installed, download from https://www.python.org/downloads/

> ⚠️ During installation, make sure to check **"Add Python to PATH"**.

### 2. Open terminal in the project root

Navigate to your `auto-cuan` project folder:

```cmd
cd C:\path\to\auto-cuan
```

### 3. Create a virtual environment

```cmd
py -m venv .venv
```

### 4. Activate the virtual environment

```cmd
.venv\Scripts\activate
```

You should see `(.venv)` at the beginning of your terminal prompt.

### 5. Install dependencies

```cmd
pip install -r tools/streamlit_runner/requirements.txt
```

This installs `streamlit` and `requests`.

### 6. Run the app

```cmd
streamlit run tools/streamlit_runner/app.py
```

Your browser will open automatically at `http://localhost:8501`.

---

## Setup (macOS / Linux)

```bash
# Check Python
python3 --version

# Create virtual environment
python3 -m venv .venv

# Activate
source .venv/bin/activate

# Install dependencies
pip install -r tools/streamlit_runner/requirements.txt

# Run
streamlit run tools/streamlit_runner/app.py
```

---

## What to Enter in the Sidebar

Once the app opens in your browser, fill in the **sidebar** on the left:

| Field | What to enter |
|-------|---------------|
| **AUTO_CUAN_BASE_URL** | Your Vercel URL, e.g. `https://auto-cuan-xyz.vercel.app` (no trailing slash) |
| **CRON_SECRET** | The secret from your Vercel env vars (masked in UI, never stored) |
| **Delay seconds** | Seconds between Non-Konglo batch calls (default: 3) |
| **Max Non-Konglo runs** | Maximum loop iterations before stopping (default: 90) |

> 💡 You can use either a **Preview URL** or **Production URL** — the runner works with both.

---

## Important Safety Notes

- ❌ `ai=1` is **NEVER** called — Screener AI remains disabled
- ❌ No secrets are stored in the repository
- ❌ No crons are enabled or modified
- ❌ No deployments are triggered
- ❌ No existing API endpoints are changed
- ✅ This is a **read/trigger only** local tool

---

## Troubleshooting

### `py` command not found

Try `python --version` or `python3 --version` instead. Use whichever works for all commands.

### `streamlit` command not found after install

Make sure your virtual environment is activated (you should see `(.venv)` in your prompt).

### Connection error when clicking a button

- Check that your `AUTO_CUAN_BASE_URL` is correct and accessible
- Make sure there's no trailing slash
- Verify the deployment is running (not paused)

### Timeout errors

The default timeout is 120 seconds. Some operations (like Sektor Hot Refresh with many groups) may take longer. If needed, the timeout can be adjusted in `app.py` (`REQUEST_TIMEOUT` constant).

---

## File Structure

```
tools/streamlit_runner/
├── app.py              # Main Streamlit application
├── requirements.txt    # Python dependencies
└── README.md           # This file
```

---

## Deactivating the Virtual Environment

When you're done, deactivate with:

```cmd
deactivate
```
