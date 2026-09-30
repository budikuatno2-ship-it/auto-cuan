param(
  [Parameter(Mandatory=$true)]
  [string]$VpsHost,

  [string]$VpsUser = "ubuntu",
  [string]$Destination = "D:\\AutoCuan-Backup",
  [int]$KeepWeekly = 26
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path "D:\\")) {
  throw "Drive D: tidak tersedia. Script tidak akan fallback ke C:."
}

$Weekly = Join-Path $Destination "weekly"
New-Item -ItemType Directory -Force -Path $Weekly | Out-Null
$RemoteRoot = "/home/ubuntu/auto-cuan-backups"

Write-Host "Mencari snapshot VPS terbaru..."
$Latest = ssh "$VpsUser@$VpsHost" "readlink -f $RemoteRoot/latest"
if (-not $Latest) { throw "Snapshot VPS terbaru tidak ditemukan." }
$Stamp = Split-Path $Latest -Leaf
$Target = Join-Path $Weekly $Stamp
New-Item -ItemType Directory -Force -Path $Target | Out-Null

Write-Host "Menyalin snapshot $Stamp ke $Target"
$RemoteSpec = "$VpsUser@$VpsHost`:$Latest/"
& scp -r $RemoteSpec $Target
if ($LASTEXITCODE -ne 0) { throw "scp gagal dengan exit code $LASTEXITCODE" }

$RepoCountRemote = ssh "$VpsUser@$VpsHost" "find $Latest/repo-data -type f | wc -l"
$RepoCountLocal = (Get-ChildItem -Recurse -File (Join-Path $Target "repo-data") | Measure-Object).Count
if ([int]$RepoCountRemote -ne $RepoCountLocal) {
  throw "Jumlah file repo-data berbeda. Remote=$RepoCountRemote Local=$RepoCountLocal"
}

$VpsCountRemote = ssh "$VpsUser@$VpsHost" "find $Latest/vps-data -type f 2>/dev/null | wc -l"
$LocalVpsPath = Join-Path $Target "vps-data"
$VpsCountLocal = if (Test-Path $LocalVpsPath) { (Get-ChildItem -Recurse -File $LocalVpsPath | Measure-Object).Count } else { 0 }
if ([int]$VpsCountRemote -ne $VpsCountLocal) {
  throw "Jumlah file vps-data berbeda. Remote=$VpsCountRemote Local=$VpsCountLocal"
}

$Marker = Join-Path $Target "OFFLINE_BACKUP_OK.txt"
@(
  "snapshot=$Stamp",
  "copied_at=$(Get-Date -Format o)",
  "vps=$VpsUser@$VpsHost",
  "repo_files=$RepoCountLocal",
  "vps_data_files=$VpsCountLocal"
) | Set-Content -Encoding UTF8 $Marker

Get-ChildItem $Weekly -Directory |
  Sort-Object Name -Descending |
  Select-Object -Skip $KeepWeekly |
  Remove-Item -Recurse -Force

Write-Host ""
Write-Host "BACKUP OFFLINE OK"
Write-Host "Lokasi: $Target"
Write-Host "Repo files: $RepoCountLocal"
Write-Host "VPS data files: $VpsCountLocal"
Write-Host "Retensi mingguan: $KeepWeekly snapshot"
Write-Host "Tidak ada data yang ditulis ke drive C:."
