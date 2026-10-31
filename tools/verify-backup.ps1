param([string]$Zip, [switch]$Full)
$ErrorActionPreference = 'Stop'
if (-not $Zip) {
  $latest = Get-ChildItem '$PSScriptRoot\backup' -Filter 'feiyu-*.zip' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $latest) { Write-Host '[FAIL] no backup found'; exit 1 }
  $Zip = $latest.FullName
}
Write-Host "Verify: $Zip"
Add-Type -AssemblyName System.IO.Compression.FileSystem
$tmp = Join-Path $env:TEMP ("feiyu_verify_" + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
try {
  [System.IO.Compression.ZipFile]::ExtractToDirectory($Zip, $tmp)
  $mf = Join-Path $tmp 'MANIFEST.json'
  if (-not (Test-Path $mf)) { Write-Host '[FAIL] MANIFEST.json missing'; exit 1 }
  $m = Get-Content -LiteralPath $mf -Raw -Encoding UTF8 | ConvertFrom-Json
  Write-Host ("Manifest: {0} files / {1} MB / {2}" -f $m.fileCount, [math]::Round($m.totalBytes/1MB,1), $m.createdAt)
  $bad = 0; $missing = 0; $checked = 0
  $list = if ($Full) { $m.files } else { $m.files | Get-Random -Count ([Math]::Min(100, $m.files.Count)) }
  foreach ($f in $list) {
    $p = Join-Path $tmp ($f.path.Replace('/', '\'))
    $checked++
    if (-not (Test-Path -LiteralPath $p)) { $missing++; Write-Host "  [MISSING] $($f.path)"; continue }
    $h = (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash
    if ($h -ne $f.sha256) { $bad++; Write-Host "  [CORRUPT] $($f.path)" }
  }
  Write-Host ("Checked {0}: missing {1}, corrupt {2}" -f $checked, $missing, $bad)
  if ($missing -eq 0 -and $bad -eq 0) { Write-Host '[PASS]'; exit 0 } else { Write-Host '[FAIL]'; exit 1 }
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}