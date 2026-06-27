# Register Auto-Cuan Telegram slash commands without requiring Node.js.
# Usage:
#   powershell -ExecutionPolicy Bypass -File tools\set-telegram-commands.ps1

param(
    [string]$BotToken = ""
)

$ConfigPath = Join-Path $env:USERPROFILE ".auto-cuan-scan.env"

function Load-LocalConfig {
    $cfg = @{ TELEGRAM_BOT_TOKEN = "" }
    if (Test-Path $ConfigPath) {
        Get-Content $ConfigPath | ForEach-Object {
            $line = $_.Trim()
            if ($line -and -not $line.StartsWith("#")) {
                $parts = $line -split "=", 2
                if ($parts.Count -eq 2) {
                    $key = $parts[0].Trim()
                    $val = $parts[1].Trim().Trim('"').Trim("'")
                    if ($key -eq "TELEGRAM_BOT_TOKEN") { $cfg.TELEGRAM_BOT_TOKEN = $val }
                }
            }
        }
    }
    return $cfg
}

if (-not $BotToken.Trim()) {
    $cfg = Load-LocalConfig
    if ($cfg.TELEGRAM_BOT_TOKEN) { $BotToken = $cfg.TELEGRAM_BOT_TOKEN }
}

if (-not $BotToken.Trim()) {
    $secure = Read-Host "Telegram bot token" -AsSecureString
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    $BotToken = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

if (-not $BotToken.Trim()) {
    Write-Host "Status: FAILED"
    Write-Host "Error : TELEGRAM_BOT_TOKEN kosong."
    exit 1
}

$commands = @(
    @{ command = "start"; description = "Mulai dan panduan bot" },
    @{ command = "help"; description = "Bantuan penggunaan bot" },
    @{ command = "top"; description = "Top 10 saham potensial" },
    @{ command = "screener"; description = "Screener saham per kategori" },
    @{ command = "foreign"; description = "Foreign flow per saham" }
)

$body = @{ commands = $commands } | ConvertTo-Json -Depth 5
$url = "https://api.telegram.org/bot$($BotToken.Trim())/setMyCommands"

try {
    $response = Invoke-RestMethod -Uri $url -Method Post -Body $body -ContentType "application/json; charset=utf-8" -TimeoutSec 60
    if ($response.ok) {
        Write-Host "Status: SUCCESS"
        Write-Host "Registered commands: /start, /help, /top, /screener, /foreign"
        exit 0
    }
    Write-Host "Status: FAILED"
    Write-Host "Error : Telegram API returned ok=false"
    exit 1
} catch {
    $statusCode = $null
    if ($_.Exception.Response) { $statusCode = [int]$_.Exception.Response.StatusCode }
    Write-Host "Status: FAILED"
    Write-Host "Error : HTTP $statusCode - $($_.Exception.Message)"
    exit 1
}
