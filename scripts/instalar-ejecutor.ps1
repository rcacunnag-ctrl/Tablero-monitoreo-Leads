# Instala un PC adicional que ejecuta informes del Monitor (Tier 1 y Tier 2), p. ej. el de Andres.
# Se corre UNA vez en ese PC, desde la carpeta descomprimida del kit, en PowerShell 7 (pwsh):
#   pwsh -ExecutionPolicy Bypass -File .\scripts\instalar-ejecutor.ps1 -Ejecutor Andres
# Deja: carpetas de trabajo con "0. Base formatos", el Intake Service local (Tier 2), los scripts del
# ejecutor y la tarea programada que cada 15 min consulta las órdenes de ESTE PC en el panel.
# No toca la sesión de Claude ni los skills: eso lo hace el usuario (ver pasos al final).
param(
  [Parameter(Mandatory)][string]$Ejecutor,
  [string]$Destino = (Join-Path $env:USERPROFILE 'Documents\Monitor Underwriting'),
  [string]$Api = 'http://100.97.63.81:3000'
)
$ErrorActionPreference = 'Stop'
$kit = Split-Path $PSScriptRoot -Parent
function Ok($m) { Write-Host "  OK  $m" -ForegroundColor Green }
function Falta($m) { Write-Host "  FALTA  $m" -ForegroundColor Yellow; $script:faltas++ }
$faltas = 0

Write-Host "`n1. Requisitos"
if ($PSVersionTable.PSVersion.Major -ge 7) { Ok "PowerShell $($PSVersionTable.PSVersion)" } else { Falta 'PowerShell 7: instalar con  winget install Microsoft.PowerShell' }
$py = Get-Command python -ErrorAction SilentlyContinue
if ($py) { Ok "Python ($(& python --version 2>&1))" } else { Falta 'Python 3: instalar con  winget install Python.Python.3.13' }
if (Get-Command claude -ErrorAction SilentlyContinue) { Ok "Claude CLI $(& claude --version 2>&1)" } else { Falta 'Claude CLI: instalar con  winget install Anthropic.ClaudeCode  (o npm i -g @anthropic-ai/claude-code)' }
if (Get-Command chrome -ErrorAction SilentlyContinue) { Ok 'Chrome' } elseif (Test-Path "$env:ProgramFiles\Google\Chrome\Application\chrome.exe") { Ok 'Chrome' } else { Falta 'Google Chrome con la extensión de Claude (fases 1 y 2 del Tier 2)' }
try {
  $r = Invoke-RestMethod "$Api/api/leads" -TimeoutSec 15
  if ($r.ejecutores -contains $Ejecutor) { Ok "Panel accesible por Tailscale; '$Ejecutor' es un PC válido" } else { Falta "El panel no conoce el PC '$Ejecutor' (EJECUTORES en el servidor: $($r.ejecutores -join ', '))" }
} catch { Falta "No se llega al panel $Api : encender Tailscale y pedir acceso al dueño del monitor" }

Write-Host "`n2. Librerías de Python de los skills"
if ($py) {
  & python -m pip install --user --quiet openpyxl matplotlib python-docx reportlab pillow numpy 2>&1 | Select-Object -Last 2
  Ok 'openpyxl, matplotlib, python-docx, reportlab, pillow, numpy'
}

Write-Host "`n3. Carpetas de trabajo en $Destino"
$under = Join-Path $Destino '1. Underwriting'
New-Item -ItemType Directory -Force -Path (Join-Path $under '1. Propiedades - Leads') | Out-Null
Copy-Item -Recurse -Force (Join-Path $kit '0. Base formatos') $under
Ok "$under (con 0. Base formatos y 1. Propiedades - Leads)"
$intake = Join-Path $Destino 'Intake Service'
New-Item -ItemType Directory -Force -Path $intake | Out-Null
Copy-Item -Force (Join-Path $kit 'Intake Service\*') $intake
Set-Content -Path (Join-Path $intake '.project_dir') -Value $under -NoNewline
Ok "$intake (Tier 2, solo local)"
$scripts = Join-Path $Destino 'scripts'
New-Item -ItemType Directory -Force -Path $scripts | Out-Null
Copy-Item -Force (Join-Path $kit 'scripts\tier1-runner.ps1'), (Join-Path $kit 'scripts\subir-informe.ps1') $scripts
Ok $scripts
# Paquetes .skill de Tier 1 (comp-analysis-report y comp-analysis-report-terrenos): el runner los usa si Claude Desktop no los tiene sincronizados
$skillsDir = Join-Path $Destino 'Skills Underwriting'
New-Item -ItemType Directory -Force -Path $skillsDir | Out-Null
if (Get-ChildItem -LiteralPath $skillsDir -Filter 'comp-analysis-report*.skill' -ErrorAction SilentlyContinue) { Ok "$skillsDir (con paquetes .skill)" } else { Falta "Copiar comp-analysis-report.skill y comp-analysis-report-terrenos.skill a $skillsDir" }

Write-Host "`n4. Tarea programada (cada 15 min, con la sesión de Windows iniciada)"
# Alias estable de la Store (LOCALAPPDATA\Microsoft\WindowsApps): la ruta con versión (Program Files\WindowsApps\Microsoft.PowerShell_7.x...)
# desaparece cuando la Store actualiza PowerShell y la tarea deja de correr sin avisar.
$alias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\pwsh.exe'
$pwsh = if (Test-Path -LiteralPath $alias) { $alias } else { (Get-Command pwsh).Source }
$runner = Join-Path $scripts 'tier1-runner.ps1'
$argumentos = "--headless `"$pwsh`" -NoProfile -ExecutionPolicy Bypass -File `"$runner`" -Ejecutor `"$Ejecutor`" -LeadsRoot `"$under`" -IntakeDir `"$intake`" -Api `"$Api`""
$accion = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument $argumentos
$disparo = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 15)
$ajustes = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 3) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$quien = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'Monitor Tier1 - comp-analysis-report' -Action $accion -Trigger $disparo -Settings $ajustes -Principal $quien -Force | Out-Null
Ok "Tarea 'Monitor Tier1 - comp-analysis-report' -> órdenes de '$Ejecutor'"

Write-Host "`n5. Pasos manuales que quedan" -ForegroundColor Cyan
Write-Host "  a) En una terminal:  claude auth login   (con la cuenta de Claude de este PC)"
Write-Host "  b) Skills: Claude Desktop con los skills de propiedades instalados (comp-analysis-report y fase-1 a fase-4), o los .skill en $skillsDir (el runner usa el más reciente de los dos)."
Write-Host "  c) Chrome con la extensión Claude conectada a la misma cuenta (fases 1 y 2 del Tier 2)."
Write-Host "  d) Dejar el PC encendido con la sesión de Windows abierta y Tailscale conectado."
Write-Host "  Log del ejecutor: $env:LOCALAPPDATA\MonitorTier1\"
if ($faltas) { Write-Host "`nHay $faltas requisito(s) pendiente(s): resuélvelos y vuelve a correr este script." -ForegroundColor Yellow }
else { Write-Host "`nListo. Los informes que se pidan en el panel con 'Ejecutar en: PC $Ejecutor' correrán aquí." -ForegroundColor Green }
