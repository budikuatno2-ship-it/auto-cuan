# Auto-Cuan Local Scan Runner (PowerShell)
# ==========================================
# Calls existing Vercel API endpoints from CMD.
# No Node.js, npm, npx, or Vercel CLI needed.
# Config stored at: %USERPROFILE%\.auto-cuan-scan.env
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File tools\local_scan_runner.ps1 konglo
#   powershell -ExecutionPolicy Bypass -File tools\local_scan_runner.ps1 nonkonglo
#   powershell -ExecutionPolicy Bypass -File tools\local_scan_runner.ps1 swing-all
#   powershell -ExecutionPolicy Bypass -File tools\local_scan_runner.ps1 daytrade morning
#   powershell -ExecutionPolicy Bypass -File tools\local_scan_runner.ps1 daytrade midday
#   powershell -ExecutionPolicy Bypass -File tools\local_scan_runner.ps1 daytrade afternoon
#   powershell -ExecutionPolicy Bypass -File tools\local_scan_runner.ps1 setup

param(
    [Parameter(Position=0)]
    [string]$Command = "",
    [Parameter(Position=1)]
    [string]$SubArg = ""
)

$ConfigPath = Join-Path $env:USERPROFILE ".auto-cuan-scan.env"

# === CONFIG HELPERS ===
function Load-Config {
    $cfg = @{ API_BASE_URL = ""; CRON_SECRET = ""; VERCEL_BYPASS_TOKEN = "" }
    if (Test-Path $ConfigPath) {
        Get-Content $ConfigPath | ForEach-Object {
            $line = $_.Trim()
            if ($line -and -not $line.StartsWith("#")) {
                $parts = $line -split "=", 2
                if ($parts.Count -eq 2) {
                    $key = $parts[0].Trim()
                    $val = $parts[1].Trim().Trim('"').Trim("'")
                    if ($cfg.ContainsKey($key)) { $cfg[$key] = $val }
                }
            }
        }
    }
    return $cfg
}

function Save-Config($cfg) {
    $lines = @(
        "# Auto-Cuan Scan Config (generated — do not commit)",
        "API_BASE_URL=$($cfg.API_BASE_URL)",
        "CRON_SECRET=$($cfg.CRON_SECRET)",
        "VERCEL_BYPASS_TOKEN=$($cfg.VERCEL_BYPASS_TOKEN)"
    )
    $lines | Set-Content -Path $ConfigPath -Encoding UTF8
}

function Run-Setup {
    Write-Host ""
    Write-Host "  ========================================================"
    Write-Host "       AUTO-CUAN: SETUP (sekali saja)"
    Write-Host "  ========================================================"
    Write-Host ""

    $cfg = Load-Config

    # API Base URL
    $defaultUrl = if ($cfg.API_BASE_URL) { $cfg.API_BASE_URL } else { "https://auto-cuan-xxxx.vercel.app" }
    Write-Host "  1. API Base URL"
    Write-Host "     Contoh: https://auto-cuan-xxxx.vercel.app"
    $inputUrl = Read-Host "     URL [$defaultUrl]"
    if ($inputUrl.Trim()) { $cfg.API_BASE_URL = $inputUrl.Trim().TrimEnd("/") }
    elseif (-not $cfg.API_BASE_URL) { $cfg.API_BASE_URL = $defaultUrl }

    # CRON_SECRET
    Write-Host ""
    Write-Host "  2. CRON_SECRET"
    Write-Host "     (dari Vercel Environment Variables)"
    $inputSecret = Read-Host "     Secret (input tersembunyi)" -AsSecureString
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($inputSecret)
    $plainSecret = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    if ($plainSecret.Trim()) { $cfg.CRON_SECRET = $plainSecret.Trim() }

    # Vercel Bypass Token (optional)
    Write-Host ""
    Write-Host "  3. Vercel Protection Bypass Token (optional, kosongkan jika tidak perlu)"
    $inputBypass = Read-Host "     Token"
    $cfg.VERCEL_BYPASS_TOKEN = $inputBypass.Trim()

    Save-Config $cfg
    Write-Host ""
    Write-Host "  [OK] Config tersimpan di: $ConfigPath"
    Write-Host "  Kamu bisa langsung double-click AUTO_CUAN_SCAN_MENU.bat."
    Write-Host ""
}

# === API CALL HELPER ===
function Call-Api($cfg, $action, $extraParams = @{}) {
    $url = "$($cfg.API_BASE_URL)/api/sector-hot?action=$action"
    foreach ($key in $extraParams.Keys) {
        $url += "&$key=$($extraParams[$key])"
    }
    if ($cfg.VERCEL_BYPASS_TOKEN) {
        $url += "&x-vercel-protection-bypass=$($cfg.VERCEL_BYPASS_TOKEN)"
    }

    $headers = @{}
    if ($cfg.CRON_SECRET) {
        $headers["Authorization"] = "Bearer $($cfg.CRON_SECRET)"
    }

    try {
        $response = Invoke-RestMethod -Uri $url -Headers $headers -Method Get -TimeoutSec 120
        return $response
    } catch {
        $statusCode = $null
        if ($_.Exception.Response) { $statusCode = [int]$_.Exception.Response.StatusCode }
        return @{ success = $false; error = "HTTP $statusCode - $($_.Exception.Message)"; _http_status = $statusCode }
    }
}

# === SCAN EXECUTORS ===
function Run-Konglo($cfg) {
    Write-Host ""
    Write-Host "  Running: Konglo Swing Screener"
    Write-Host "  $('-' * 50)"

    $data = Call-Api $cfg "refresh-screener" @{ ai = "0" }

    if ($data.success) {
        Write-Host "  Status: SUCCESS"
        Write-Host "  Universe: $($data.universe_count)"
        Write-Host "  Scanned: $($data.scanned_count)"
        Write-Host "  Saved: $($data.saved_count)"
        Write-Host "  Failed: $($data.failed_count)"
        if ($data.message) { Write-Host "  Message: $($data.message)" }
        return $true
    } else {
        Write-Host "  Status: FAILED"
        Write-Host "  Error: $($data.error)"
        return $false
    }
}

function Run-NonKonglo($cfg) {
    Write-Host ""
    Write-Host "  Running: Non-Konglo Swing Screener"
    Write-Host "  $('-' * 50)"

    $maxCalls = 60
    $callCount = 0
    $finalOk = $false

    while ($callCount -lt $maxCalls) {
        $callCount++
        $params = @{}
        if ($callCount -eq 1) { $params["force"] = "1" }

        Write-Host "`r  [NK] Call $callCount/$maxCalls..." -NoNewline
        $data = Call-Api $cfg "nk-screener-run" $params

        if (-not $data) { Write-Host "`n  ERROR: No response at call $callCount"; break }

        # Terminal: finalize/published
        if ($data.step -eq "finalize" -or $data.status -eq "published" -or ($data.success -and $data.published -gt 0)) {
            Write-Host "`n  Status: PUBLISHED"
            Write-Host "  Published: $($data.published)"
            $finalOk = $true
            break
        }

        # Already done
        if ($data.message -and $data.message -match "No action needed") {
            Write-Host "`n  Already done for today."
            $finalOk = $true
            break
        }

        # Error handling
        if (-not $data.success -and -not $data.step) {
            if ($data.skipped) { Write-Host "`n  SKIPPED: $($data.error)"; break }
            if ($data.error -match "pending|processing") {
                Write-Host "`r  Waiting for pending batches...   " -NoNewline
                Start-Sleep -Seconds 2
                continue
            }
            Write-Host "`n  FAILED: $($data.error)"
            break
        }

        # Progress
        $step = $data.step
        if ($step -eq "start") {
            Write-Host "`n  Universe: $($data.universe_count) tickers, $($data.batch_count) batches"
        } elseif ($step -eq "batch") {
            $bi = if ($data.batch_index -ne $null) { $data.batch_index + 1 } else { $callCount }
            $bc = if ($data.batch_count) { $data.batch_count } else { "?" }
            Write-Host "`r  [NK] Batch $bi/$bc | Passed: $($data.passed) | Failed: $($data.failed)   " -NoNewline
        }

        Start-Sleep -Milliseconds 600
    }

    if (-not $finalOk -and $callCount -ge $maxCalls) {
        Write-Host "`n  ERROR: Max calls reached ($maxCalls)."
    }
    return $finalOk
}

function Run-DayTrade($cfg, $mode) {
    Write-Host ""
    Write-Host "  Running: Day Trade Screener (mode: $mode)"
    Write-Host "  NOTE: Day Trade scan saat ini berbasis candle harian sebagai radar awal."
    Write-Host "        Konfirmasi intraday tetap wajib."
    Write-Host "  $('-' * 50)"

    $maxBatches = 120
    $batch = 0
    $finalOk = $false

    while ($batch -lt $maxBatches) {
        $params = @{ force = "1"; batch = "$batch" }
        if ($mode -and $mode -ne "full") { $params["mode"] = $mode }

        Write-Host "`r  [DT/$mode] Batch $($batch + 1)..." -NoNewline
        $data = Call-Api $cfg "daytrade-screener-run" $params

        if (-not $data) { Write-Host "`n  ERROR: No response at batch $batch"; break }

        if (-not $data.success -and $data.status -ne "running") {
            Write-Host "`n  FAILED: $($data.error)"
            break
        }

        # Progress
        $scanned = if ($data.scanned_count) { $data.scanned_count } else { "-" }
        $passed = if ($data.passed_count) { $data.passed_count } else { "-" }
        $failed = if ($data.failed_count) { $data.failed_count } else { "-" }
        $universe = if ($data.universe_count) { $data.universe_count } else { "-" }
        $bc = if ($data.batch_count) { $data.batch_count } else { "?" }
        Write-Host "`r  [DT/$mode] Batch $($batch + 1)/$bc | Scanned: $scanned | Passed: $passed | Failed: $failed   " -NoNewline

        $status = $data.status
        if ($status -eq "published" -or $status -eq "already_done") {
            Write-Host "`n  Status: $($status.ToUpper())"
            Write-Host "  Published: $($data.published_count)"
            $finalOk = $true
            break
        }
        if ($status -eq "failed") {
            Write-Host "`n  FAILED: $($data.error)"
            break
        }

        $nextBatch = $data.next_batch
        if ($nextBatch -ne $null -and $nextBatch -gt $batch) { $batch = $nextBatch }
        else { $batch++ }

        Start-Sleep -Milliseconds 500
    }

    if (-not $finalOk -and $batch -ge $maxBatches) {
        Write-Host "`n  ERROR: Max batches reached ($maxBatches)."
    }
    return $finalOk
}

# === MAIN ===
$startTime = Get-Date

# Handle setup command
if ($Command -eq "setup") {
    Run-Setup
    exit 0
}

# Load config
$cfg = Load-Config
if (-not $cfg.API_BASE_URL -or -not $cfg.CRON_SECRET) {
    Write-Host ""
    Write-Host "  ========================================================"
    Write-Host "  Config belum lengkap."
    Write-Host "  Jalankan setup dulu (pilih menu 8 atau ketik 'setup')."
    Write-Host "  Config path: $ConfigPath"
    Write-Host "  ========================================================"
    Write-Host ""
    Run-Setup
    $cfg = Load-Config
    if (-not $cfg.API_BASE_URL -or -not $cfg.CRON_SECRET) {
        Write-Host "  Setup belum selesai. Coba lagi."
        exit 1
    }
}

Write-Host ""
Write-Host "  ========================================================"
Write-Host "  Auto-Cuan Local Scan Runner"
Write-Host "  API: $($cfg.API_BASE_URL)"
Write-Host "  ========================================================"

$success = $false

switch ($Command) {
    "konglo" { $success = Run-Konglo $cfg }
    "nonkonglo" { $success = Run-NonKonglo $cfg }
    { $_ -eq "non-konglo" } { $success = Run-NonKonglo $cfg }
    "swing-all" {
        Write-Host "`n  Mode: Swing All (Konglo first, then Non-Konglo)"
        $kongloOk = Run-Konglo $cfg
        if (-not $kongloOk) {
            Write-Host "`n  Konglo failed. Non-Konglo dibatalkan."
        } else {
            Write-Host "`n  Konglo selesai. Memulai Non-Konglo..."
            $nkOk = Run-NonKonglo $cfg
            if (-not $nkOk) {
                Write-Host "`n  Konglo selesai, Non-Konglo gagal."
            } else {
                $success = $true
            }
        }
    }
    "daytrade" {
        $mode = if ($SubArg) { $SubArg } else { "morning" }
        if ($mode -notin @("morning", "midday", "afternoon", "full")) {
            Write-Host "  Invalid mode: $mode (valid: morning, midday, afternoon, full)"
            exit 1
        }
        $success = Run-DayTrade $cfg $mode
    }
    default {
        Write-Host ""
        Write-Host "  Usage:"
        Write-Host "    .\local_scan_runner.ps1 konglo"
        Write-Host "    .\local_scan_runner.ps1 nonkonglo"
        Write-Host "    .\local_scan_runner.ps1 swing-all"
        Write-Host "    .\local_scan_runner.ps1 daytrade morning"
        Write-Host "    .\local_scan_runner.ps1 daytrade midday"
        Write-Host "    .\local_scan_runner.ps1 daytrade afternoon"
        Write-Host "    .\local_scan_runner.ps1 daytrade full"
        Write-Host "    .\local_scan_runner.ps1 setup"
        exit 0
    }
}

$elapsed = ((Get-Date) - $startTime).TotalSeconds
Write-Host ""
Write-Host "  ========================================================"
if ($success) { Write-Host "  DONE ($([math]::Round($elapsed))s)" }
else { Write-Host "  FINISHED WITH ERRORS ($([math]::Round($elapsed))s)" }
Write-Host "  ========================================================"
Write-Host ""
