param([string]$Zip, [string]$Root = $PSScriptRoot, [switch]$Force)
$ErrorActionPreference = 'Stop'
if (-not $Zip) {
  $latest = Get-ChildItem (Join-Path $Root 'backup') -Filter 'feiyu-*.zip' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $latest) { Write-Host '[FAIL] no backup found'; exit 1 }
  $Zip = $latest.FullName
}
Write-Host "Restore from: $Zip"
if (-not $Force) {
  $ans = Read-Host "Overwrite state/memory/roles/data/config.json? Current data will be backed up first. (y/N)"
  if ($ans -ne 'y') { Write-Host 'Cancelled'; exit 0 }
}
Write-Host '[1/4] backup current...'
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'tools\backup.ps1') -Root $Root
Write-Host '[2/4] stop bridge...'
$line = netstat -ano | Select-String ':3100\s' | Select-String 'LISTENING'
if ($line) {
  $procId = ($line.Line -replace '.*LISTENING\s+', '').Trim()
  taskkill /PID $procId /F 2>&1 | Out-Null
  Start-Sleep -Seconds 2
}
Write-Host '[3/4] extracting...'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$tmp = Join-Path $env:TEMP ("feiyu_restore_" + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
try {
  [System.IO.Compression.ZipFile]::ExtractToDirectory($Zip, $tmp)
  foreach ($t in @('state', 'memory', 'roles', 'data')) {
    $src = Join-Path $tmp $t
    if (Test-Path $src) {
      $dst = Join-Path $Root $t
      Remove-Item $dst -Recurse -Force -ErrorAction SilentlyContinue
      Copy-Item $src $dst -Recurse -Force
      Write-Host "    restored $t"
    }
  }
  $cfg = Join-Path $tmp 'config.json'
  if (Test-Path $cfg) { Copy-Item $cfg (Join-Path $Root 'config.json') -Force; Write-Host '    restored config.json' }
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host '[4/4] done. Run $(Split-Path $PSScriptRoot -Parent)\scripts\一键恢复.bat next.'