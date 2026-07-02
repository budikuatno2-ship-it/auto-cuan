# Auto-Cuan Local Scan Runner (PowerShell)
# ==========================================
# Calls existing Vercel API endpoints from CMD.
# Scan and foreign import commands need no Node.js, npm, npx, local Supabase keys, or Vercel CLI.
# Config stored at: %USERPROFILE%\.auto-cuan-scan.env
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File tools\local_scan_runner.ps1 konglo
#   powershell -ExecutionPolicy Bypass -File tools\local_scan_runner.ps1 nonkonglo
#   powershell -ExecutionPolicy Bypass -File tools\local_scan_runner.ps1 swing-all
#   powershell -ExecutionPolicy Bypass -File tools\local_scan_runner.ps1 daytrade morning
#   powershell -ExecutionPolicy Bypass -File tools\local_scan_runner.ps1 daytrade midday
#   powershell -ExecutionPolicy Bypass -File tools\local_scan_runner.ps1 daytrade afternoon
#   powershell -ExecutionPolicy Bypass -File tools\local_scan_runner.ps1 foreign-import
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
    $cfg = @{ API_BASE_URL = ""; CRON_SECRET = ""; VERCEL_BYPASS_TOKEN = ""; DAYTRADE_SEND_RADAR = "" }
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
        "VERCEL_BYPASS_TOKEN=$($cfg.VERCEL_BYPASS_TOKEN)",
        "DAYTRADE_SEND_RADAR=$($cfg.DAYTRADE_SEND_RADAR)"
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

    Write-Host ""
    Write-Host "  4. Day Trade Radar fallback default (optional)"
    Write-Host "     Default manual/local Day Trade: ON. Isi 0 untuk mematikan Radar fallback."
    $inputRadar = Read-Host "     DAYTRADE_SEND_RADAR [$($cfg.DAYTRADE_SEND_RADAR)]"
    if ($inputRadar.Trim()) { $cfg.DAYTRADE_SEND_RADAR = $inputRadar.Trim() }

    Save-Config $cfg
    Write-Host ""
    Write-Host "  [OK] Config tersimpan di: $ConfigPath"
    Write-Host "  Kamu bisa langsung double-click AUTO_CUAN_SCAN_MENU.bat."
    Write-Host ""
}

function Normalize-ForeignCsvLines($lines) {
    $requiredHeader = "date,ticker,open,high,low,close,volume,freq,valuasi,nbsa"
    $cleanLines = @($lines | Where-Object { $_ -and $_.Trim() })
    if ($cleanLines.Count -eq 0) { return @($requiredHeader) }

    $first = $cleanLines[0].Trim()
    $normalizedFirst = (($first -split ',') | ForEach-Object { $_.Trim().Trim('<').Trim('>').ToLowerInvariant() }) -join ','
    if ($normalizedFirst -eq $requiredHeader) {
        $cleanLines[0] = $requiredHeader
        return $cleanLines
    }

    $cols = $first -split ','
    $firstLooksLikeData = $cols.Count -ge 10 -and ($cols[0].Trim() -match '^(\d{1,2}/\d{1,2}/\d{4}|\d{4}-\d{2}-\d{2})$')
    if ($firstLooksLikeData) {
        return @($requiredHeader) + $cleanLines
    }

    return $cleanLines
}

function Invoke-ForeignImport($cfg, $csvPath) {
    if (-not (Test-Path $csvPath)) {
        Write-Host "  Status: FAILED"
        Write-Host "  Error : CSV file tidak ditemukan: $csvPath"
        return $false
    }

    $url = "$($cfg.API_BASE_URL)/api/sector-hot?action=foreign-import-upload"
    if ($cfg.VERCEL_BYPASS_TOKEN) {
        $url += "&x-vercel-protection-bypass=$($cfg.VERCEL_BYPASS_TOKEN)"
    }

    $headers = @{ Authorization = "Bearer $($cfg.CRON_SECRET)" }
    $rawLines = Get-Content -Path $csvPath -Encoding UTF8
    $lines = @(Normalize-ForeignCsvLines $rawLines)
    $header = "date,ticker,open,high,low,close,volume,freq,valuasi,nbsa"
    if ($lines.Count -lt 2) {
        Write-Host "  Status: FAILED"
        Write-Host "  Error : CSV kosong atau tidak berisi data."
        return $false
    }

    $dataRows = @($lines | Select-Object -Skip 1)
    $batchSize = 120
    $totalBatches = [Math]::Ceiling($dataRows.Count / $batchSize)
    $totalImported = 0
    $totalUpserted = 0
    $totalDeleted = 0
    $maxRetries = 3

    Write-Host ""
    Write-Host "  Uploading CSV ke Vercel API: $($cfg.API_BASE_URL)/api/sector-hot?action=foreign-import-upload"
    Write-Host "  Source: $csvPath"
    Write-Host "  Rows  : $($dataRows.Count) data rows in $totalBatches batch(es) (batch size $batchSize)"
    Write-Host "  $('-' * 50)"

    for ($i = 0; $i -lt $totalBatches; $i++) {
        $start = $i * $batchSize
        $end = [Math]::Min($start + $batchSize - 1, $dataRows.Count - 1)
        $batchRows = @($dataRows[$start..$end])
        $csvText = (@($header) + $batchRows) -join "`r`n"
        $batchNo = $i + 1
        $isFinalBatch = ($batchNo -eq $totalBatches)

        # Build URL with batch params + skip_retention for non-final batches
        $batchUrl = $url + "&batch_index=$i&batch_total=$totalBatches"
        if (-not $isFinalBatch) { $batchUrl += "&skip_retention=1" }

        $success = $false
        for ($attempt = 1; $attempt -le $maxRetries; $attempt++) {
            $attemptLabel = if ($attempt -gt 1) { " (attempt $attempt/$maxRetries)" } else { "" }
            Write-Host "  Uploading batch $batchNo/$totalBatches ($($batchRows.Count) rows)$attemptLabel ..."

            try {
                $response = Invoke-RestMethod -Uri $batchUrl -Headers $headers -Method Post -Body $csvText -ContentType "text/csv; charset=utf-8" -TimeoutSec 120
                if (-not $response.success) {
                    Write-Host "    API returned success=false: $($response.error)"
                    if ($attempt -lt $maxRetries) {
                        $backoff = [Math]::Pow(2, $attempt) * 1000
                        Write-Host "    Retrying in $($backoff/1000)s..."
                        Start-Sleep -Milliseconds $backoff
                        continue
                    }
                    Write-Host "  Status: FAILED after $maxRetries attempts"
                    Write-Host "  Failed batch: $batchNo/$totalBatches"
                    if ($response.error) { Write-Host "  Error : $($response.error)" }
                    if ($response.errors) { Write-Host "  Errors: $($response.errors -join '; ')" }
                    Write-Host "  $('-' * 50)"
                    return $false
                }
                if ($null -ne $response.imported_count) { $totalImported += [int]$response.imported_count }
                if ($null -ne $response.upserted_count) { $totalUpserted += [int]$response.upserted_count }
                if ($null -ne $response.deleted_old_count) { $totalDeleted += [int]$response.deleted_old_count }
                $batchMs = if ($response.foreign_upload_batch_ms) { "$($response.foreign_upload_batch_ms)ms" } else { "-" }
                $retSkip = if ($response.retention_skipped) { "skipped" } else { "ran" }
                Write-Host "    OK - imported:$($response.imported_count) upserted:$($response.upserted_count) retention:$retSkip time:$batchMs"
                $success = $true
                break
            } catch {
                $statusCode = $null
                if ($_.Exception.Response) { $statusCode = [int]$_.Exception.Response.StatusCode }
                $errMsg = $_.Exception.Message
                Write-Host "    Error: HTTP $statusCode - $errMsg"
                if ($attempt -lt $maxRetries) {
                    $backoff = [Math]::Pow(2, $attempt) * 1000
                    Write-Host "    Retrying in $($backoff/1000)s..."
                    Start-Sleep -Milliseconds $backoff
                } else {
                    Write-Host "  Status: FAILED after $maxRetries attempts"
                    Write-Host "  Failed batch: $batchNo/$totalBatches"
                    Write-Host "  Error : HTTP $statusCode - $errMsg"
                    Write-Host "  Note  : Rerun is safe (upsert on trade_date,ticker is idempotent)"
                    Write-Host "  $('-' * 50)"
                    return $false
                }
            }
        }
    }

    Write-Host "  Status: SUCCESS"
    Write-Host "  Total imported rows: $totalImported"
    Write-Host "  Total upserted rows: $totalUpserted"
    Write-Host "  Total deleted old rows: $totalDeleted"
    Write-Host "  $('-' * 50)"
    return $true
}

function Read-ForeignCsvPaste {
    $csvPath = "data/foreign-watchlist.csv"
    $csvDir = Split-Path -Parent $csvPath
    if ($csvDir -and -not (Test-Path $csvDir)) {
        New-Item -ItemType Directory -Path $csvDir -Force | Out-Null
    }

    Write-Host ""
    Write-Host "  Paste full CSV content di bawah ini."
    Write-Host "  CSV format: date,ticker,open,high,low,close,volume,freq,valuasi,nbsa"
    Write-Host "  Ketik ENDCSV pada baris baru untuk selesai."
    Write-Host ""

    $lines = New-Object System.Collections.Generic.List[string]
    while ($true) {
        $line = Read-Host
        if ($line -ceq "ENDCSV") { break }
        $lines.Add($line)
    }

    $lines | Set-Content -Path $csvPath -Encoding UTF8
    Write-Host ""
    Write-Host "  CSV tersimpan otomatis ke: $csvPath"
    return $csvPath
}

function Run-ForeignImport($cfg) {
    while ($true) {
        Write-Host ""
        Write-Host "  ========================================================"
        Write-Host "       IMPORT / UPLOAD FOREIGN DATA"
        Write-Host "  ========================================================"
        Write-Host "  1. Paste CSV directly here"
        Write-Host "  2. Import from CSV file path"
        Write-Host "  3. Back to main menu"
        Write-Host ""

        $mode = Read-Host "  Pilih (1-3)"
        if ($mode -eq "1") {
            $csvPath = Read-ForeignCsvPaste
            [void](Invoke-ForeignImport $cfg $csvPath)
        } elseif ($mode -eq "2") {
            Write-Host ""
            Write-Host "  CSV format: date,ticker,open,high,low,close,volume,freq,valuasi,nbsa"
            Write-Host "  Default   : data/foreign-watchlist.csv"
            Write-Host ""

            $inputPath = Read-Host "  CSV path (kosongkan untuk default)"
            if ($inputPath.Trim()) { $csvPath = $inputPath.Trim().Trim('"') }
            else { $csvPath = "data/foreign-watchlist.csv" }

            [void](Invoke-ForeignImport $cfg $csvPath)
        } elseif ($mode -eq "3") {
            return $true
        } else {
            Write-Host ""
            Write-Host "  Pilihan tidak valid. Coba lagi."
            continue
        }

        Write-Host ""
        $again = Read-Host "  Upload foreign lagi? (Y/N)"
        if ($again -notmatch '^[Yy]$') { return $true }
    }
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
        if ($data.step -eq "finalize" -and ($data.status -eq "COMPLETED_NO_CANDIDATES" -or $data.published -eq 0 -or $data.published -eq $null)) {
            Write-Host "`n  Status: COMPLETED_NO_CANDIDATES"
            Write-Host "  Finalize: 0 kandidat lolos filter."
            if ($data.message) { Write-Host "  Message: $($data.message)" }
            if ($data.staging_count -ne $null) { Write-Host "  Staging: $($data.staging_count)" }
            if ($data.telegram -and $data.telegram.reason) { Write-Host "  Telegram skipped: $($data.telegram.reason)" }
            if ($data.diagnostics) {
                Write-Host "  Diagnostics: scanned=$($data.diagnostics.total_scanned), raw=$($data.diagnostics.raw_candidates_count), minTP1=$($data.diagnostics.after_min_tp1_upside_count), risk=$($data.diagnostics.after_risk_gate_count), liquidity=$($data.diagnostics.after_liquidity_gate_count), final=$($data.diagnostics.after_final_quality_gate_count)"
                if ($data.diagnostics.top_rejection_reasons) {
                    $reasons = @($data.diagnostics.top_rejection_reasons | Select-Object -First 5 | ForEach-Object { "$($_.reason)=$($_.count)" }) -join ", "
                    if ($reasons) { Write-Host "  Top rejection reasons: $reasons" }
                }
            }
            $finalOk = $true
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

function Format-TopReasons($value, $limit = 5) {
    if (-not $value) { return "" }
    if ($value -is [System.Array]) {
        return @($value | Select-Object -First $limit | ForEach-Object {
            if ($_.reason -ne $null -and $_.count -ne $null) { "$($_.reason)=$($_.count)" }
            elseif ($_.Name -ne $null -and $_.Value -ne $null) { "$($_.Name)=$($_.Value)" }
            else { "$($_)" }
        }) -join ", "
    }
    return @($value.PSObject.Properties | Select-Object -First $limit | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ", "
}

function Format-RejectedSamples($value, $limit = 5) {
    if (-not $value) { return "" }
    return @($value | Select-Object -First $limit | ForEach-Object {
        $ticker = if ($_.ticker) { $_.ticker } else { "-" }
        $reason = if ($_.rejection_reason) { $_.rejection_reason } elseif ($_.reason) { $_.reason } else { "-" }
        "$ticker=[$reason]"
    }) -join ", "
}

function Print-DayTradeTelegramDiagnostics($data) {
    if ($data.telegram -and $data.telegram.reason) { Write-Host "  Telegram reason: $($data.telegram.reason)" }
    elseif ($data.reason) { Write-Host "  Telegram reason: $($data.reason)" }
    $radarRequestedValue = $null
    if ($null -ne $data.radar_requested) { $radarRequestedValue = $data.radar_requested }
    elseif ($data.telegram -and $null -ne $data.telegram.radar_requested) { $radarRequestedValue = $data.telegram.radar_requested }
    if ($null -ne $radarRequestedValue) { Write-Host "  Radar requested: $($radarRequestedValue.ToString().ToLowerInvariant())" }
    $diag = if ($data.diagnostics) { $data.diagnostics } elseif ($data.telegram) { $data.telegram.diagnostics } else { $null }
    if ($diag -and $null -ne $diag.signal_count) { Write-Host "  Gate buckets: Signal $($diag.signal_count) | Radar $($diag.radar_count) | Hard Reject $($diag.hard_reject_count)" }
    $radarFallbackCount = $null
    if ($null -ne $data.radar_count) { $radarFallbackCount = $data.radar_count }
    elseif ($data.telegram -and $null -ne $data.telegram.radar_count) { $radarFallbackCount = $data.telegram.radar_count }
    if ($null -ne $radarFallbackCount) { Write-Host "  Radar fallback count: $radarFallbackCount" }
    $radarCandidateList = $null
    if ($data.radar_candidates) { $radarCandidateList = $data.radar_candidates }
    elseif ($data.telegram -and $data.telegram.radar_candidates) { $radarCandidateList = $data.telegram.radar_candidates }
    if ($radarCandidateList) { Write-Host "  Radar candidates: $($radarCandidateList -join ', ')" }
    elseif ($null -ne $radarFallbackCount) { Write-Host "  Radar candidates: -" }
    if ($null -ne $data.radar_blocked_count) { Write-Host "  Radar blocked count: $($data.radar_blocked_count)" }
    elseif ($data.telegram -and $null -ne $data.telegram.radar_blocked_count) { Write-Host "  Radar blocked count: $($data.telegram.radar_blocked_count)" }
    $radarReasons = if ($data.radar_rejection_reasons) { $data.radar_rejection_reasons } elseif ($data.telegram) { $data.telegram.radar_rejection_reasons } else { $null }
    $radarReasonText = Format-TopReasons $radarReasons 5
    if ($radarReasonText) { Write-Host "  Top radar rejection reasons: $radarReasonText" }
    if ($data.telegram -and $data.telegram.radar_skipped_reason) { Write-Host "  Radar skipped reason: $($data.telegram.radar_skipped_reason)" }
    elseif ($data.radar_skipped_reason) { Write-Host "  Radar skipped reason: $($data.radar_skipped_reason)" }
    else { Write-Host "  Radar skipped reason: -" }
    if ($diag) {
        $topText = Format-TopReasons $diag.top_rejection_reasons 5
        if ($topText) { Write-Host "  Top rejection reasons: $topText" }
        $hardText = Format-TopReasons $diag.top_hard_reject_reasons 5
        if ($hardText) { Write-Host "  Top hard reject reasons: $hardText" }
        $sampleText = Format-RejectedSamples $diag.sample_rejected 5
        if ($sampleText) { Write-Host "  Sample rejected: $sampleText" }
        $sampleRadarText = Format-RejectedSamples $diag.sample_radar_rejected 5
        if ($sampleRadarText) { Write-Host "  Sample radar rejected: $sampleRadarText" }
    }
    $sampleRadar = if ($data.sample_radar_rejected) { $data.sample_radar_rejected } elseif ($data.telegram) { $data.telegram.sample_radar_rejected } else { $null }
    $sampleRadarText2 = Format-RejectedSamples $sampleRadar 5
    if ($sampleRadarText2 -and -not ($diag -and $diag.sample_radar_rejected)) { Write-Host "  Sample radar rejected: $sampleRadarText2" }
}

function Run-DayTrade($cfg, $mode) {
    $sendRadar = $true
    if ($mode.EndsWith("-no-radar")) {
        $sendRadar = $false
        $mode = $mode -replace "-no-radar$", ""
    }
    if ($mode.EndsWith("-radar")) {
        $sendRadar = $true
        $mode = $mode -replace "-radar$", ""
    }
    $disableRadarValues = @("0", "false", "off")
    if ($disableRadarValues -contains "$($cfg.DAYTRADE_SEND_RADAR)".Trim().ToLowerInvariant() -or $disableRadarValues -contains "$($env:DAYTRADE_SEND_RADAR)".Trim().ToLowerInvariant() -or $disableRadarValues -contains "$($env:AUTO_CUAN_DAYTRADE_SEND_RADAR)".Trim().ToLowerInvariant()) { $sendRadar = $false }
    if ($cfg.DAYTRADE_SEND_RADAR -eq "1" -or $env:DAYTRADE_SEND_RADAR -eq "1" -or $env:AUTO_CUAN_DAYTRADE_SEND_RADAR -eq "1") { $sendRadar = $true }
    $isFast = $mode.EndsWith("-fast")
    $actualMode = $mode -replace "-fast$", ""
    $speedLabel = if ($isFast) { "FAST" } else { "FULL" }

    Write-Host ""
    Write-Host "  Running: Day Trade Screener (mode: $actualMode, speed: $speedLabel)"
    Write-Host "  NOTE: Day Trade scan berbasis candle harian sebagai radar awal."
    Write-Host "        Konfirmasi intraday tetap wajib."
    if ($sendRadar) { Write-Host "  RADAR FALLBACK: ON (send_radar=1 untuk no-signal diagnostics/fallback)." }
    else { Write-Host "  RADAR FALLBACK: OFF" }
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
        $params["send_radar"] = if ($sendRadar) { "1" } else { "0" }

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
            Print-DayTradeTelegramDiagnostics $data
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
    $intervalMin = if ($env:AUTO_RUN_INTERVAL_MINUTES) { [int]$env:AUTO_RUN_INTERVAL_MINUTES } else { 25 }

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
    Write-Host "  Jalankan setup dulu (pilih Settings atau ketik 'setup')."
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

if ($Command -eq "foreign-import" -or $Command -eq "foreign") {
    Run-ForeignImport $cfg | Out-Null
    exit 0
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

        $validModes = @("morning", "midday", "afternoon", "full", "morning-fast", "midday-fast", "afternoon-fast", "morning-radar", "midday-radar", "afternoon-radar", "full-radar", "morning-fast-radar", "midday-fast-radar", "afternoon-fast-radar", "morning-no-radar", "midday-no-radar", "afternoon-no-radar", "full-no-radar", "morning-fast-no-radar", "midday-fast-no-radar", "afternoon-fast-no-radar")
        if ($mode -notin $validModes) {
            Write-Host "  Invalid mode: $mode"
            Write-Host "  Valid: morning, midday, afternoon, full, morning-fast, midday-fast, afternoon-fast (append -no-radar to disable local Radar fallback)"
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
        Write-Host "    .\local_scan_runner.ps1 foreign-import"
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
