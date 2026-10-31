# Daily backup: roles/ + data/ + config.json -> $(Split-Path $PSScriptRoot -Parent)\backup\<stamp>, keep last 7.
# Runs via Task Scheduler at 03:00. ASCII-only on purpose: Windows PowerShell 5.1 reads
# .ps1 as ANSI unless the file has a BOM, and non-ASCII here breaks parsing.
$ErrorActionPreference = 'Stop'

$root = "$(Split-Path $PSScriptRoot -Parent)"
$qb = Join-Path $root 'qq-bridge'
$backupRoot = Join-Path $root 'backup'
$stamp = Get-Date -Format 'yyyyMMdd-HHmm'
$dest = Join-Path $backupRoot $stamp

New-Item -ItemType Directory -Force -Path $dest | Out-Null

foreach ($item in 'roles', 'data') {
    $src = Join-Path $qb $item
    if (Test-Path $src) {
        Copy-Item $src -Destination $dest -Recurse -Force
    }
}

foreach ($file in 'config.json', 'state\mode.json', 'state\current-role.json') {
    $src = Join-Path $qb $file
    if (Test-Path $src) {
        $sub = Join-Path $dest (Split-Path $file -Parent)
        New-Item -ItemType Directory -Force -Path $sub | Out-Null
        Copy-Item $src -Destination (Join-Path $dest $file) -Force
    }
}

$all = @(Get-ChildItem $backupRoot -Directory | Sort-Object Name -Descending)
if ($all.Count -gt 7) {
    $all | Select-Object -Skip 7 | ForEach-Object { Remove-Item $_.FullName -Recurse -Force }
}

$size = (Get-ChildItem $dest -Recurse -File | Measure-Object Length -Sum).Sum
$kept = [Math]::Min($all.Count, 7)
Write-Output ("[{0}] backup ok: {1} ({2:N1} MB), kept {3}" -f (Get-Date -Format 'HH:mm:ss'), $dest, ($size / 1MB), $kept)
