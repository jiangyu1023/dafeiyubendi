# One-shot DSH restart helper.
# Runs detached (parent = WmiPrvSE, NOT a child of DSH), so killing DSH's process
# tree does not kill this script.
# ASCII only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI when there is no BOM.
$ErrorActionPreference = 'Continue'
$log = "$(Split-Path $PSScriptRoot -Parent)\scripts\restart-dsh.log"
function Log($m) {
  $line = "$(Get-Date -Format 'HH:mm:ss') $m"
  Add-Content -LiteralPath $log -Value $line -Encoding UTF8
}

Log '=== restart helper started (waiting 30s before killing DSH) ==='
Start-Sleep -Seconds 30

$main = Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" |
  Where-Object { $_.CommandLine -like '*dsh-desktop-host*' } |
  Select-Object -First 1
if (-not $main) { Log 'DSH main process not found; abort'; exit 1 }
$oldPid = [int]$main.ProcessId
Log "old DSH main pid=$oldPid"

taskkill /PID $oldPid /T /F 2>&1 | ForEach-Object { Log "taskkill: $_" }
Start-Sleep -Seconds 3

$exe = 'D:\deepseek harness\DeepSeek Harness.exe'
try {
  # 和桌面快捷方式完全一样：exe 不带参数 + 工作目录 D:\deepseek harness
  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = $exe
  $psi.WorkingDirectory = 'D:\deepseek harness'
  $psi.UseShellExecute = $false
  $np = [System.Diagnostics.Process]::Start($psi)
  Log "relaunched DSH pid=$($np.Id)"
} catch {
  Log "relaunch failed: $($_.Exception.Message)"
  exit 1
}

# Wait until the new DSH process owns a listening TCP port (port number is random each boot).
$port = $null
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 2
  if (-not (Get-Process -Id $np.Id -ErrorAction SilentlyContinue)) { Log 'new DSH process exited'; break }
  $rows = netstat -ano | Select-String 'LISTENING'
  foreach ($r in $rows) {
    if ($r.Line -match "\s$($np.Id)\s*$") {
      $m = [regex]::Match($r.Line, 'TCP\s+\S+:(\d+)\s')
      if ($m.Success) { $port = $m.Groups[1].Value; break }
    }
  }
  if ($port) { break }
}
Log "DSH listening port=$port after $([math]::Round($i*2,0))s"

# Let it settle, then re-detect the port and write config.json.
Start-Sleep -Seconds 5
$syncOk = $false
for ($t = 0; $t -lt 4; $t++) {
  Push-Location $PSScriptRoot
  $out = & node 'tools\sync-dsh-url.mjs' 2>&1
  Pop-Location
  $out | ForEach-Object { Log "sync: $_" }
  if ($LASTEXITCODE -eq 0) { $syncOk = $true; break }
  Start-Sleep -Seconds 8
}
Log "sync-dsh-url ok=$syncOk"

# Restart the bridge so it reads the new dsh.baseUrl. The guard loop (start.bat) respawns it.
$line = netstat -ano | Select-String ':3100\s' | Select-String 'LISTENING'
if ($line) {
  $bpid = ($line.Line -replace '.*LISTENING\s+', '').Trim()
  Log "bridge pid=$bpid -> restart"
  taskkill /PID $bpid /F 2>&1 | ForEach-Object { Log "taskkill bridge: $_" }
  Start-Sleep -Seconds 12
} else {
  Log 'bridge not listening; leave as is'
}

# Verify.
$ct = (Get-Content '$PSScriptRoot\state\console-token' -Raw).Trim()
for ($v = 0; $v -lt 8; $v++) {
  try {
    $j = (Invoke-WebRequest "http://127.0.0.1:3100/api/status?token=$ct" -UseBasicParsing -TimeoutSec 8 -ErrorAction Stop).Content | ConvertFrom-Json
    Log "status: dshReady=$($j.dshReady) connected=$($j.snowluma.connected) mode=$($j.mode) role=$($j.role)"
    break
  } catch {
    Start-Sleep -Seconds 5
  }
}
$line2 = netstat -ano | Select-String ':3100\s' | Select-String 'LISTENING'
if ($line2) { Log "bridge back: $($line2.Line.Trim())" } else { Log 'bridge NOT listening after restart' }
Log '=== done ==='
