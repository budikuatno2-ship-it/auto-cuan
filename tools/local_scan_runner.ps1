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
        "# Auto-Cuan Scan Config (generated - do not commit)",
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

    $maxRetries = 3
    for ($attempt = 1; $attempt -le $maxRetries; $attempt++) {
        try {
            $response = Invoke-RestMethod -Uri $url -Headers $headers -Method Get -TimeoutSec 120
            return $response
        } catch {
            $errMsg = $_.Exception.Message
            $isDns = $errMsg -match "remote name could not be resolved|DNS|NameResolution"
            $isTimeout = $errMsg -match "timed out|timeout"
            if (($isDns -or $isTimeout) -and $attempt -lt $maxRetries) {
                Write-Host "`n  Koneksi/DNS gagal sementara. Mencoba ulang ($attempt/$maxRetries)..."
                Start-Sleep -Seconds (5 * $attempt)
                continue
            }
            $statusCode = $null
            if ($_.Exception.Response) { $statusCode = [int]$_.Exception.Response.StatusCode }
            return @{ success = $false; error = "HTTP $statusCode - $errMsg"; _http_status = $statusCode }
        }
    }
    return @{ success = $false; error = "Gagal setelah $maxRetries percobaan. Periksa koneksi internet atau API URL." }
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

    $maxCalls = 150
    $callCount = 0
    $finalOk = $false

    while ($callCount -lt $maxCalls) {
        $callCount++
        $params = @{}
        if ($callCount -eq 1) { $params["force"] = "1" }

        Write-Host "`r  [NK] Call $callCount/$maxCalls..." -NoNewline
        $data = Call-Api $cfg "nk-screener-run" $params

        if (-not $data) { Write-Host "`n  ERROR: No response at call $callCount"; break }

        # Terminal: finalize/published - only if actually published candidates
        if ($data.step -eq "finalize" -and $data.published -gt 0) {
            Write-Host "`n  Status: PUBLISHED"
            Write-Host "  Published: $($data.published)"
            $finalOk = $true
            break
        }
        if ($data.step -eq "finalize" -and ($data.published -eq 0 -or $data.published -eq $null)) {
            Write-Host "`n  Finalize: 0 kandidat lolos filter."
            if ($data.staging_count) { Write-Host "  Staging: $($data.staging_count)" }
            $finalOk = $false
            break
        }
        if ($data.status -eq "published" -and $data.published_count -gt 0) {
            Write-Host "`n  Status: PUBLISHED"
            Write-Host "  Published: $($data.published_count)"
            $finalOk = $true
            break
        }
        if ($data.status -eq "published" -and $data.step -ne "start" -and $callCount -gt 1) {
            Write-Host "`n  Status: PUBLISHED (from meta)"
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
            $batchCount = $data.batch_count
            if ($batchCount -and $batchCount -gt 0) { $maxCalls = $batchCount + 20 }
            Write-Host "`n  Universe: $($data.universe_count) tickers, $batchCount batches (max calls: $maxCalls)"
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
    $isFast = $mode.EndsWith("-fast")
    $actualMode = $mode -replace "-fast$", ""
    $speedLabel = if ($isFast) { "FAST" } else { "FULL" }

    Write-Host ""
    Write-Host "  Running: Day Trade Screener (mode: $actualMode, speed: $speedLabel)"
    Write-Host "  NOTE: Day Trade scan berbasis candle harian sebagai radar awal."
    Write-Host "        Konfirmasi intraday tetap wajib."
    if ($isFast) { Write-Host "  FAST MODE: Scan shortlist saham aktif/likuid (~150 ticker) untuk radar cepat." }
    else { Write-Host "  FULL MODE: Scan seluruh universe (semua Papan Utama + Pengembangan)." }
    Write-Host "  $('-' * 50)"

    $maxBatches = 120
    $batch = 0
    $finalOk = $false

    while ($batch -lt $maxBatches) {
        $params = @{ force = "1"; batch = "$batch" }
        if ($actualMode -and $actualMode -ne "full") { $params["mode"] = $actualMode }
        if ($isFast) { $params["speed"] = "fast" }

        Write-Host "`r  [DT/$actualMode/$speedLabel] Batch $($batch + 1)..." -NoNewline
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
        Write-Host "`r  [DT/$actualMode/$speedLabel] Batch $($batch + 1)/$bc | Scanned: $scanned | Passed: $passed | Failed: $failed   " -NoNewline

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

function Run-SektorHot($cfg) {
    Write-Host ""
    Write-Host "  Running: Refresh Sektor Hot / Group Hot"
    Write-Host "  $('-' * 50)"

    $data = Call-Api $cfg "refresh"

    if ($data.success) {
        Write-Host "  Status: SUCCESS"
        Write-Host "  Scanned: $($data.scannedCount)"
        Write-Host "  Failed: $($data.failedCount)"
        Write-Host "  Groups: $($data.groupsProcessed)"
        if ($data.message) { Write-Host "  Message: $($data.message)" }
        return $true
    } else {
        Write-Host "  Status: FAILED"
        Write-Host "  Error: $($data.error)"
        return $false
    }
}


function Parse-HhMmToMinutes($value, $fallback) {
    $raw = if ($value) { "$value".Trim() } else { "$fallback" }
    if ($raw -notmatch '^\d{1,2}:\d{2}$') { return $null }
    $parts = $raw -split ':', 2
    $h = [int]$parts[0]
    $m = [int]$parts[1]
    if ($h -lt 0 -or $h -gt 23 -or $m -lt 0 -or $m -gt 59) { return $null }
    return ($h * 60 + $m)
}

function Get-WibNow {
    return ([DateTime]::UtcNow).AddHours(7)
}

function Get-WibMinutesNow {
    $wibNow = Get-WibNow
    return ($wibNow.Hour * 60 + $wibNow.Minute)
}


function Get-WibLunchBreakWindow($wibNow) {
    # DayOfWeek: Sunday=0, Monday=1, ..., Friday=5
    $day = [int]$wibNow.DayOfWeek
    if ($day -ge 1 -and $day -le 4) {
        return @{ Start = (12 * 60); End = (13 * 60 + 30); Label = "Senin-Kamis 12:00-13:30 WIB" }
    }
    if ($day -eq 5) {
        return @{ Start = (11 * 60 + 30); End = (14 * 60); Label = "Jumat 11:30-14:00 WIB" }
    }
    return $null
}

function Is-WibLunchBreak($wibNow) {
    $breakWindow = Get-WibLunchBreakWindow $wibNow
    if ($null -eq $breakWindow) { return $false }
    $minutes = $wibNow.Hour * 60 + $wibNow.Minute
    return ($minutes -ge $breakWindow.Start -and $minutes -lt $breakWindow.End)
}

function Get-WibLunchBreakEnd($wibNow) {
    $breakWindow = Get-WibLunchBreakWindow $wibNow
    if ($null -eq $breakWindow) { return $null }
    return $wibNow.Date.AddMinutes($breakWindow.End)
}

function Move-NextRunOutOfLunchBreak($candidateTime) {
    $breakWindow = Get-WibLunchBreakWindow $candidateTime
    if ($null -eq $breakWindow) { return $candidateTime }
    $minutes = $candidateTime.Hour * 60 + $candidateTime.Minute
    if ($minutes -ge $breakWindow.Start -and $minutes -lt $breakWindow.End) {
        return $candidateTime.Date.AddMinutes($breakWindow.End)
    }
    return $candidateTime
}

function Wait-SecondsWithProgress($seconds, $label) {
    $remaining = [int][Math]::Max(0, $seconds)
    while ($remaining -gt 0) {
        $chunk = [Math]::Min($remaining, 60)
        $mins = [Math]::Ceiling($remaining / 60)
        Write-Host "`r  $label ($mins menit lagi)   " -NoNewline
        Start-Sleep -Seconds $chunk
        $remaining -= $chunk
    }
    Write-Host ""
}

function Run-DayTradeAutoLoop($cfg, $loopMode) {
    $isFull = ($loopMode -eq "full" -or $loopMode -eq "auto-full")
    $runMode = if ($isFull) { "auto-full" } else { "auto-fast" }
    $label = if ($isFull) { "FULL" } else { "FAST" }

    $startText = if ($env:AUTO_RUN_START) { $env:AUTO_RUN_START } else { "09:10" }
    $endText = if ($env:AUTO_RUN_END) { $env:AUTO_RUN_END } else { "15:40" }
    $intervalMin = if ($env:AUTO_RUN_INTERVAL_MINUTES) { [int]$env:AUTO_RUN_INTERVAL_MINUTES } else { 30 }

    $startMin = Parse-HhMmToMinutes $startText "09:10"
    $endMin = Parse-HhMmToMinutes $endText "15:40"
    if ($startMin -eq $null -or $endMin -eq $null -or $endMin -le $startMin) {
        Write-Host "  Invalid auto loop time. Use HH:mm and ensure end > start."
        return $false
    }
    if ($intervalMin -le 0) {
        Write-Host "  Invalid AUTO_RUN_INTERVAL_MINUTES. Must be positive."
        return $false
    }

    Write-Host ""
    Write-Host "  ========================================================"
    Write-Host "       DAY TRADE AUTO LOOP ($label)"
    Write-Host "  ========================================================"
    Write-Host "  Window  : $startText - $endText WIB"
    Write-Host "  Interval: $intervalMin menit"
    Write-Host "  Mode    : otomatis morning/midday/afternoon sesuai jam WIB"
    Write-Host "  Istirahat: Senin-Kamis 12:00-13:30 WIB; Jumat 11:30-14:00 WIB"
    Write-Host "  Stop    : otomatis setelah $endText WIB, atau tekan Ctrl+C"
    Write-Host "  ========================================================"
    Write-Host ""

    while ($true) {
        $nowMin = Get-WibMinutesNow
        $wibNow = Get-WibNow

        if ($nowMin -gt $endMin) {
            Write-Host "  Market window sudah lewat ($($wibNow.ToString('HH:mm')) WIB). Auto loop berhenti."
            return $true
        }

        if ($nowMin -lt $startMin) {
            $waitSec = ($startMin - $nowMin) * 60 - $wibNow.Second
            Wait-SecondsWithProgress $waitSec "Menunggu start window $startText WIB"
            continue
        }

        if (Is-WibLunchBreak $wibNow) {
            $breakEnd = Get-WibLunchBreakEnd $wibNow
            $breakWait = [int][Math]::Max(1, ($breakEnd - $wibNow).TotalSeconds)
            Write-Host ""
            Write-Host "  [$($wibNow.ToString('HH:mm:ss')) WIB] Jam istirahat. Tidak mulai scan baru."
            Write-Host "  Next boleh mulai: $($breakEnd.ToString('HH:mm:ss')) WIB"
            Wait-SecondsWithProgress $breakWait "Menunggu jam istirahat selesai"
            continue
        }

        Write-Host ""
        Write-Host "  [$($wibNow.ToString('HH:mm:ss')) WIB] Auto run Day Trade $label dimulai..."
        $ok = Run-DayTrade $cfg $runMode
        if (-not $ok) {
            Write-Host "  Auto run selesai dengan warning/error. Loop tetap lanjut sampai window berakhir."
        }

        $afterRun = Get-WibNow
        $afterMin = $afterRun.Hour * 60 + $afterRun.Minute
        if ($afterMin -ge $endMin) {
            Write-Host "  Window selesai setelah run terakhir. Auto loop berhenti."
            return $true
        }

        $next = $afterRun.AddMinutes($intervalMin)
        $next = Move-NextRunOutOfLunchBreak $next
        $endToday = $afterRun.Date.AddMinutes($endMin)
        if ($next -gt $endToday) {
            Write-Host "  Next run akan melewati $endText WIB. Auto loop berhenti."
            return $true
        }

        $wait = [int][Math]::Max(1, ($next - $afterRun).TotalSeconds)
        Write-Host ""
        Write-Host "  Next Day Trade $label run: $($next.ToString('HH:mm:ss')) WIB"
        Wait-SecondsWithProgress $wait "Menunggu next run"
    }
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
    "sektor-hot" { $success = Run-SektorHot $cfg }
    { $_ -eq "sektor" } { $success = Run-SektorHot $cfg }
    "refresh-all" {
        Write-Host "`n  Mode: Refresh All Ringan"
        Write-Host "  (Sektor Hot -> Konglo -> Non-Konglo -> Day Trade Fast)"
        $success = Run-SektorHot $cfg
        if ($success) { Write-Host "`n  Sektor Hot OK. Memulai Konglo..." }
        $kongloOk = Run-Konglo $cfg
        if ($kongloOk) { Write-Host "`n  Konglo OK. Memulai Non-Konglo..." }
        $nkOk = Run-NonKonglo $cfg
        if ($nkOk) { Write-Host "`n  Non-Konglo OK. Memulai Day Trade Fast..." }
        Run-DayTrade $cfg "auto-fast" | Out-Null
        $success = $true
    }
    "daytrade-auto" {
        $loopMode = if ($SubArg) { $SubArg } else { "fast" }
        $success = Run-DayTradeAutoLoop $cfg $loopMode
    }
    "daytrade" {
        $mode = if ($SubArg) { $SubArg } else { "auto-fast" }

        # Auto time detection for WIB
        $autoModes = @("auto-fast", "auto-full", "auto")
        if ($mode -in $autoModes) {
            $isFast = ($mode -eq "auto-fast" -or $mode -eq "auto")
            $utcNow = [DateTime]::UtcNow
            $wibNow = $utcNow.AddHours(7)
            $wibHour = $wibNow.Hour
            $wibMin = $wibNow.Minute
            $totalMin = $wibHour * 60 + $wibMin

            $detectedMode = "afternoon"
            if ($totalMin -ge 540 -and $totalMin -le 630) { $detectedMode = "morning" }
            elseif ($totalMin -gt 630 -and $totalMin -le 780) { $detectedMode = "midday" }
            elseif ($totalMin -gt 780 -and $totalMin -le 930) { $detectedMode = "afternoon" }

            Write-Host "  Auto mode selected: $detectedMode (WIB $($wibNow.ToString('HH:mm')))"
            $mode = if ($isFast) { "$detectedMode-fast" } else { $detectedMode }
        }

        $validModes = @("morning", "midday", "afternoon", "full", "morning-fast", "midday-fast", "afternoon-fast")
        if ($mode -notin $validModes) {
            Write-Host "  Invalid mode: $mode"
            Write-Host "  Valid: morning, midday, afternoon, full, morning-fast, midday-fast, afternoon-fast"
            Write-Host "  Auto: auto-fast, auto-full"
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
