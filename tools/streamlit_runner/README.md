# Auto-Cuan Streamlit Manual Runner

Local Streamlit app for manually running Auto-Cuan screeners and refreshes.

## Features

- **Day Trade Screener** — Run with automatic batch loop, live progress, result preview
- **Sektor Hot Refresh** — Manual refresh of Sektor Hot data
- **Konglo Screener** — Run Konglo swing screener
- **Non-Konglo Screener** — Run Non-Konglo screener with batch loop

## Setup

```bash
cd tools/streamlit_runner

# Create virtual environment
python3 -m venv venv
source venv/bin/activate  # Linux/Mac
# or: venv\Scripts\activate  # Windows

# Install dependencies
pip install -r requirements.txt

# Create .env file from example
cp .env.example .env
# Edit .env with your actual API_BASE_URL and CRON_SECRET
```

## Run

```bash
streamlit run app.py
```

App will open at http://localhost:8501

## Configuration

| Variable | Description | Required |
|----------|-------------|----------|
| `API_BASE_URL` | Vercel deployment URL, no trailing slash (Preview recommended) | Yes |
| `CRON_SECRET` | Bearer token for protected API actions (same as Vercel env) | Yes |
| `VERCEL_BYPASS_TOKEN` | Bypass token for Vercel Deployment Protection | Only if Preview is protected |

You can also type these directly into the Streamlit sidebar.

### Vercel Deployment Protection

If your Preview deployment shows "Authentication Required" when accessed without login:

1. Go to Vercel Project Settings → Deployment Protection
2. Find "Protection Bypass for Automation"
3. Copy the bypass token
4. Add it to `.env` as `VERCEL_BYPASS_TOKEN=<token>` or type in sidebar

The bypass token is appended as query parameters to every API request:
- `x-vercel-set-bypass-cookie=true`
- `x-vercel-protection-bypass=<token>`

## Security

- CRON_SECRET is never committed to git
- `.env` is in `.gitignore`
- Secrets are typed into local Streamlit input or read from local `.env`
- No secrets are exposed to frontend/web code

## Day Trade Runner Flow

1. Click "Run Day Trade Screener"
2. App calls `/api/sector-hot?action=daytrade-screener-run&force=1&batch=0`
3. If response `status: running` with `next_batch`, auto-continues
4. Progress updates: scanned/universe, batch N/total, passed, failed
5. Stops when `status: published | already_done | failed`
6. Displays latest Day Trade results table

## API Actions Used

| Action | Auth | Purpose |
|--------|------|---------|
| `?action=daytrade-screener-run&force=1` | Bearer CRON_SECRET | Run Day Trade scan |
| `?action=daytrade-screener` | Public | Read latest results |
| `?action=refresh` | Bearer CRON_SECRET | Refresh Sektor Hot |
| `?action=refresh-screener` | Bearer CRON_SECRET | Run Konglo screener |
| `?action=nk-screener-run&force=1` | Bearer CRON_SECRET | Run Non-Konglo screener |
| `?action=nk-screener-results` | Public (login-gated) | Read Non-Konglo results |
