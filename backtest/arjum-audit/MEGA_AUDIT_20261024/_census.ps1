$root = 'd:\auto-cuan-2'
$out  = Join-Path $root 'backtest\arjum-audit\MEGA_AUDIT_20261024\_census_raw.txt'
$skip = '\\(node_modules|\.next|\.git|\.aider\.tags\.cache\.v4)\\'
$rows = New-Object System.Collections.Generic.List[string]
Get-ChildItem -Path $root -Recurse -File -Force -ErrorAction SilentlyContinue | ForEach-Object {
  $full = $_.FullName
  if ($full -match $skip) { return }
  $rel = $full.Substring($root.Length + 1)
  $lines = 0
  if ($_.Length -lt 3000000) {
    try {
      $sr = New-Object System.IO.StreamReader($full, [System.Text.Encoding]::UTF8, $true)
      $buf = New-Object char[] 65536
      $n = 0
      while (($n = $sr.Read($buf, 0, $buf.Length)) -gt 0) {
        for ($i = 0; $i -lt $n; $i++) { if ($buf[$i] -eq [char]10) { $lines++ } }
      }
      $sr.Close()
      if ($_.Length -gt 0) { $lines++ }
    } catch { $lines = -1 }
  } else { $lines = -2 }
  $rows.Add(($rel + '|' + $_.Length + '|' + $lines))
}
$rows | Sort-Object | Set-Content -Encoding UTF8 $out
Write-Output ("FILES=" + $rows.Count)
