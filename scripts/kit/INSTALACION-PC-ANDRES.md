# Instalar o actualizar este PC como ejecutor de informes del Monitor de Propiedades

Instrucciones para una sesión de Claude Code en el PC de **Andres** (usuario de Windows `AndresYory`).
Sirve para instalar por primera vez **o actualizar** una instalación anterior: el instalador se puede repetir.

## Qué queda funcionando y qué queda instalado pero apagado

| Función | Estado en este PC |
|---|---|
| **Tier 1** (skill `comp-analysis-report`, y `tier1-v2-propiedades` si algún día se le asigna) | **Activo.** Corre lo que se pida en el panel con «Ejecutar en: PC Andres». |
| **Tier 2** (fases 1 a 4 con el Intake Service) | **Instalado y deshabilitado.** El servidor no le asigna órdenes ni le entrega las que haya. Roberto lo habilita desde su chat de Claude, sin tocar este PC. |
| Rol estatal de Florida (820 MB, mejora Tier 2 y Tier 1-V2) | No instalado. Solo se construye si Roberto lo pide. |

## Contexto (no cambiar)

- El panel corre en un servidor Oracle: `http://100.97.63.81:3000`. Solo responde por **Tailscale**.
- Este PC no recibe conexiones. Una **tarea programada** de Windows corre cada 15 minutos `tier1-runner.ps1 -Ejecutor Andres`, pregunta al panel si hay órdenes para «Andres» y, solo si hay, abre `claude -p`. Sin órdenes no consume nada.
- Los skills llegan de dos maneras: sincronizados por Claude Desktop o desde los paquetes `.skill` de `Documents\Monitor Underwriting\Skills Underwriting` (el runner usa el más reciente). **No modificar los skills.**
- El kit está descomprimido en `%USERPROFILE%\Downloads\Kit-PC-Andres` (carpetas `scripts`, `Intake Service`, `Skills Underwriting` y `0. Base formatos`, y el archivo `LEEME.txt`).

## Reglas para esta sesión

- **No** cambiar la configuración de Tailscale ni del servidor Oracle. Si el panel no responde, avisar a Andres: el dueño del monitor (Roberto) debe dar acceso.
- **No** iniciar sesión por el usuario. `claude auth login` y el inicio de sesión de Chrome los hace Andres.
- **No** habilitar Tier 2 aquí: se habilita desde el servidor.
- **No** borrar archivos fuera de la carpeta del kit.
- Mostrar cada error y proponer la solución antes de aplicarla.

## Pasos

### 1. Requisitos (verificar; instalar solo lo que falte)

```powershell
pwsh --version          # PowerShell 7
python --version        # Python 3
claude --version        # Claude Code CLI
```

- **Falta PowerShell 7:** `winget install Microsoft.PowerShell`
- **Falta Python:** `winget install Python.Python.3.13`. Después, abrir una terminal nueva.
- **`claude` no se reconoce:** agregar su carpeta al PATH y abrir una terminal nueva:
  ```powershell
  [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ";$env:USERPROFILE\.local\bin", 'User')
  ```
- **Chrome** con la extensión de Claude conectada a la cuenta de Andres (la usan las fases 1 y 2 del Tier 2, cuando se habilite).

### 2. Comprobar el acceso al panel

```powershell
Invoke-RestMethod http://100.97.63.81:3000/api/leads | Select-Object -ExpandProperty ejecutores
```

Debe responder `Roberto` y `Andres`. Si da timeout: encender Tailscale; si sigue fallando falta un permiso en la red de Tailscale de Roberto (`autogroup:shared` hacia `100.97.63.81:3000`): **detenerse y pedírselo a Roberto.**

### 3. Instalar o actualizar

```powershell
cd "$env:USERPROFILE\Downloads\Kit-PC-Andres"
pwsh -ExecutionPolicy Bypass -File .\scripts\instalar-ejecutor.ps1 -Ejecutor Andres
```

El instalador (sobrescribe lo anterior con las versiones nuevas):
- revisa los requisitos e instala las librerías de Python (openpyxl, matplotlib, python-docx, reportlab, pillow, numpy);
- deja `Documentos\Monitor Underwriting\` con `1. Underwriting\0. Base formatos`, `1. Underwriting\1. Propiedades - Leads`, `Intake Service`, `scripts` y `Skills Underwriting` (los paquetes `.skill` de Tier 1, Tier 1-V2 y Tier 2);
- apunta el rol estatal a `Documentos\Monitor Underwriting\datos\rol` (no se construye);
- registra la tarea **«Monitor Tier1 - comp-analysis-report»**.

Si alguna línea dice **FALTA**, resolverla y volver a correr el instalador.

### 4. Pasos que hace Andres

1. En una terminal: `claude auth login`, con su cuenta de Claude.
2. Abrir **Claude Desktop** una vez para que sincronice los skills (si no sincroniza, no pasa nada: el runner usa los paquetes `.skill`).
3. Iniciar sesión en la extensión de Claude en Chrome.

### 5. Verificación final

```powershell
# a) La tarea existe y está lista
Get-ScheduledTask -TaskName 'Monitor Tier1 - comp-analysis-report' | Select-Object State

# b) Los paquetes de skills están
Get-ChildItem "$env:USERPROFILE\Documents\Monitor Underwriting\Skills Underwriting" -Filter *.skill | Select-Object -ExpandProperty Name

# c) Una corrida en seco del ejecutor (sin órdenes debe terminar en silencio con código 0)
pwsh -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\Documents\Monitor Underwriting\scripts\tier1-runner.ps1" -Ejecutor Andres -LeadsRoot "$env:USERPROFILE\Documents\Monitor Underwriting\1. Underwriting" -IntakeDir "$env:USERPROFILE\Documents\Monitor Underwriting\Intake Service"
"exit=$LASTEXITCODE"

# d) Log del ejecutor (aparece cuando procesa la primera orden)
Get-ChildItem "$env:LOCALAPPDATA\MonitorTier1" -ErrorAction SilentlyContinue

# e) Tier 2 debe estar deshabilitado para este PC: la lista debe salir vacía
Invoke-RestMethod "http://100.97.63.81:3000/api/tier2-jobs?ejecutor=Andres"
```

### 6. Cierre

Reportar a Andres, en una lista corta: qué quedó instalado, el resultado de a) a e) y cualquier FALTA pendiente.
Andres le avisa a Roberto para una prueba: un Tier 1 desde el panel con **«Ejecutar en: PC Andres»**. Para activar Tier 2 en este PC, Roberto lo habilita desde su chat; no hay que hacer nada más aquí.

## Día a día

- PC encendido, con la sesión de Windows abierta (la tarea solo corre con la sesión iniciada) y Tailscale conectado.
- Sesión de Claude vigente. Si un informe falla por autenticación, repetir `claude auth login`.
- Los informes quedan en `Documentos\Monitor Underwriting\1. Underwriting\1. Propiedades - Leads\<dirección>\Informes Tier 1\` y también se suben al panel.
- Log del ejecutor: `%LOCALAPPDATA%\MonitorTier1\`.
