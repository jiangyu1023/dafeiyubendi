# 大肥鱼备份 v2：state / memory / roles / data / config.json + MANIFEST(sha256)
# 说明：先复制到临时暂存目录再打包，避免 Compress-Archive 把单个文件（config.json）
# 和目录混在一起时，解压后变成 config.json/ 目录。
[CmdletBinding()]
param([string]$Root = $PSScriptRoot, [int]$KeepDays = 30, [switch]$KeepForever)

$ErrorActionPreference = 'Stop'
$now = Get-Date
$stamp = $now.ToString('yyyy-MM-dd_HHmmss')
$dir = Join-Path $Root 'backup'
New-Item -ItemType Directory -Path $dir -Force | Out-Null
$zip = Join-Path $dir "feiyu-$stamp.zip"

$stage = Join-Path $env:TEMP ("feiyu_bk_" + $stamp)
New-Item -ItemType Directory -Path $stage -Force | Out-Null

$targets = @('state', 'memory', 'roles', 'data', 'config.json')
foreach ($t in $targets) {
  $src = Join-Path $Root $t
  if (Test-Path $src) {
    Copy-Item -LiteralPath $src -Destination $stage -Recurse -Force
  }
}

# ---- MANIFEST：文件清单 + sha256 ----
$files = Get-ChildItem $stage -Recurse -File
$entries = @()
foreach ($f in $files) {
  $rel = $f.FullName.Substring($stage.Length + 1).Replace('\', '/')
  $hash = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash
  $entries += [ordered]@{ path = $rel; bytes = $f.Length; sha256 = $hash }
}
$manifest = [ordered]@{
  schema    = 2
  app       = 'feiyu'
  createdAt = $now.ToString('o')
  host      = $env:COMPUTERNAME
  fileCount = $entries.Count
  totalBytes = ($files | Measure-Object -Property Length -Sum).Sum
  files     = $entries
}
$manifestPath = Join-Path $stage 'MANIFEST.json'
($manifest | ConvertTo-Json -Depth 6) | Out-File -LiteralPath $manifestPath -Encoding utf8

Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal -Force

# ---- 自检 ----
Add-Type -AssemblyName System.IO.Compression.FileSystem
$a = [System.IO.Compression.ZipFile]::OpenRead($zip)
$entryCount = $a.Entries.Count
$hasConfigFile = (($a.Entries | Where-Object { $_.FullName -eq 'config.json' }) | Measure-Object).Count -gt 0
$hasManifest = (($a.Entries | Where-Object { $_.FullName -eq 'MANIFEST.json' }) | Measure-Object).Count -gt 0
$hasMemory = (($a.Entries | Where-Object { $_.FullName -like 'memory*' }) | Measure-Object).Count -gt 0
$a.Dispose()
$size = [math]::Round((Get-Item $zip).Length / 1KB, 0)

Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue

# ---- 滚动清理：30 天内保留；每月 1 号那份永久保留 ----
$old = @()
if (-not $KeepForever) {
  $old = Get-ChildItem $dir -Filter 'feiyu-*.zip' |
    Where-Object { $_.LastWriteTime -lt $now.AddDays(-$KeepDays) -and $_.Name -notmatch 'feiyu-\d{4}-\d{2}-01_' }
  $old | Remove-Item -Force -ErrorAction SilentlyContinue
}

$flag = if ($hasConfigFile -and $hasManifest -and $hasMemory) { '结构正常' } else { 'WARN 结构异常' }
Write-Host ("[OK] {0}  {1}KB  {2} 个条目  {3}  清理 {4} 个旧备份" -f $zip, $size, $entryCount, $flag, $old.Count)
Write-Host ("     manifest: {0} 个文件 / {1} MB" -f $manifest.fileCount, [math]::Round($manifest.totalBytes / 1MB, 1))
