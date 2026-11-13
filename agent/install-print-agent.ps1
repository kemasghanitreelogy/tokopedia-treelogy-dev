# One-time setup of the Treelogy print agent on a Windows laptop.
#
# Run in PowerShell (no admin needed), from the folder holding print-agent.ps1:
#   powershell -ExecutionPolicy Bypass -File .\install-print-agent.ps1
#
# It asks for the server, the agent token and which Windows printer to use, saves them
# under %LOCALAPPDATA%\Treelogy, and registers a scheduled task that starts the agent
# at every logon, hidden, and restarts it if it ever stops.

$ErrorActionPreference = 'Stop'
$home_ = Join-Path $env:LOCALAPPDATA 'Treelogy'
New-Item -ItemType Directory -Force -Path $home_ | Out-Null
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Copy-Item -Path (Join-Path $here 'print-agent.ps1') -Destination (Join-Path $home_ 'print-agent.ps1') -Force

$configPath = Join-Path $home_ 'print-agent.json'
$existing = $null
if (Test-Path $configPath) { $existing = Get-Content $configPath -Raw | ConvertFrom-Json }

function Ask([string]$label, [string]$default) {
  $shown = if ($default) { " [$default]" } else { '' }
  $v = Read-Host "$label$shown"
  if ([string]::IsNullOrWhiteSpace($v)) { return $default } else { return $v.Trim() }
}

Write-Host ''
Write-Host 'Treelogy print agent - pemasangan' -ForegroundColor Cyan
$server = Ask 'Alamat server' $(if ($existing) { $existing.server } else { 'https://api.treelogy-services.my.id' })
$token = Ask 'Token agen (dari Kemas)' $(if ($existing) { $existing.token } else { '' })
if ([string]::IsNullOrWhiteSpace($token)) { throw 'Token agen wajib diisi.' }

Write-Host ''
Write-Host 'Printer yang terpasang di Windows:' -ForegroundColor Cyan
$printers = @(Get-Printer | Select-Object -ExpandProperty Name)
for ($i = 0; $i -lt $printers.Count; $i++) { Write-Host ('  {0}. {1}' -f ($i + 1), $printers[$i]) }
$guess = $printers | Where-Object { $_ -match 'OKAY|D100|label|thermal' } | Select-Object -First 1
if ($existing -and $existing.printer) { $guess = $existing.printer }
$pick = Ask 'Nomor atau nama printer label' $guess
if ($pick -match '^\d+$' -and [int]$pick -ge 1 -and [int]$pick -le $printers.Count) { $printer = $printers[[int]$pick - 1] } else { $printer = $pick }
if (-not ($printers -contains $printer)) { throw "Printer '$printer' tidak ada di daftar Windows." }
$name = Ask 'Nama laptop ini di dashboard' $(if ($existing -and $existing.name) { $existing.name } else { $env:COMPUTERNAME })

@{ server = $server; token = $token; printer = $printer; name = $name } | ConvertTo-Json | Set-Content -Path $configPath -Encoding UTF8
Write-Host "Konfigurasi disimpan: $configPath" -ForegroundColor Green

# The task: at logon, hidden, kept alive.
$taskName = 'Treelogy Print Agent'
$script = Join-Path $home_ 'print-agent.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $script)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'Meneruskan label dari dashboard Treelogy ke printer di meja packing' | Out-Null
Start-ScheduledTask -TaskName $taskName

Write-Host ''
Write-Host "Agen terpasang dan sudah berjalan (tugas terjadwal '$taskName')." -ForegroundColor Green
Write-Host "Log: $(Join-Path $home_ 'print-agent.log')"
Write-Host 'Di dashboard, menu Label akan menunjukkan "Printer gudang: siap" dalam satu menit.'
