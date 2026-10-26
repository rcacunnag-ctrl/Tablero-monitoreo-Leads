# Plan: flujo de leads con reglas, acciones y Tier 1

Fecha: 2026-10-06 · Estado: **completado y desplegado en Oracle** (2026-10-06). Las casillas se marcan a medida que se completan.

## Reglas acordadas

| # | Caso | Resultado |
|---|---|---|
| R1 | Mensaje que no es anuncio | Se ignora |
| R2 | Sin dirección (no hay número + calle) y sin ARV | **Descarte automático** (no se guarda) |
| R3 | Sin dirección y con ARV | Entra como **Pendiente dirección** con la alerta "Solicitar dirección al wholesaler" |
| R4 | Con dirección en Broward o Palm Beach (Martin se quitó el 2026-10-26) | Entra como **Nuevo** |
| R5 | Con dirección fuera de esos condados | **Descarte automático** |
| R6 | Con dirección, pero el condado no se puede determinar (ni por tablas ni por el geocodificador del Census) | Entra como **Revisar condado** y el usuario decide |
| R7 | Dirección ya descartada antes | No vuelve a entrar. Solo se guarda la dirección normalizada, sin otros datos |

"Dirección" significa número + calle (ej. `1234 NW 5th Ave`). Si el anuncio solo trae ciudad o ZIP, cuenta como sin dirección.

## Acciones del usuario en el panel

| Acción | Disponible en | Efecto |
|---|---|---|
| **Descartar** | Todos los estados | Se pide confirmación y se borra el lead del almacenamiento (y del Excel/CSV). Se guarda solo la dirección para cumplir R7 |
| **Tier 1** | Nuevo, Revisar condado | Se elige el usuario (Andres, Carlos o Jaime) y el estado pasa a **Tier 1** |
| **Agregar dirección** | Pendiente dirección (y Revisar condado, para corregirla) | El usuario escribe la dirección que le dio el wholesaler, el sistema valida el condado. Si está en zona, pasa a **Tier 1** con el usuario elegido. Si no, se **descarta** |

**Lanzar el skill `comp-analysis-report` al pasar a Tier 1:** queda creada pero **deshabilitada** (`TIER1_SKILL_ENABLED=false`). Cuando se active, deja un trabajo en `data/tier1-jobs/` con el lead y el usuario. Ese archivo lo recogerá el PC personal de Andres, Carlos o Jaime. Ese lado (el que ejecuta Claude en el PC personal) no está incluido en este plan.

## Pasos

### 1. Almacenamiento y reglas
- [x] 1.1 `src/leads.js`: almacén `data/leads.json` (leads activos + direcciones descartadas), con escritura atómica y operaciones de alta, descarte, Tier 1 y agregar dirección
- [x] 1.2 `src/pipeline.js`: aplicar R1–R7 al procesar cada mensaje
- [x] 1.3 Activar el geocodificador del Census (`USE_CENSUS_GEOCODER=true`) para R6
- [x] 1.4 Migración: los registros actuales de `propiedades.jsonl` pasan por las reglas una sola vez y el archivo original se conserva como `.bak`

### 2. Panel
- [x] 2.1 Quitar la columna y el filtro **Zona**. Agregar **Estado** con su filtro y contadores por estado
- [x] 2.2 Botones **Tier 1**, **Descartar** y **Agregar dirección**, con selector de usuario
- [x] 2.3 Alerta visible en los leads Pendiente dirección, con el contacto y el teléfono del wholesaler
- [x] 2.4 Protección básica de las acciones contra peticiones desde otros sitios. El acceso sigue limitado a Tailscale

### 3. Tier 1 → skill (deshabilitado)
- [x] 3.1 `src/tier1.js`: función `lanzarCompAnalysis(lead, usuario)` controlada por `TIER1_SKILL_ENABLED`
- [x] 3.2 Lista de usuarios configurable (`TIER1_USERS=Andres,Carlos,Jaime`)

### 4. Salidas
- [x] 4.1 El Excel y el CSV se regeneran desde `leads.json` en cada cambio, con la columna `estado` en lugar de `en_zona`

### 5. Pruebas y despliegue
- [x] 5.1 Pruebas automáticas de R1–R7 y de las tres acciones (`npm test`)
- [x] 5.2 Prueba manual del panel en local
- [x] 5.3 Desplegar en Oracle (`monitor-wa`) y verificar logs y panel por Tailscale

## Fuera de alcance por ahora
- El receptor en el PC personal que ejecuta el skill.
- La validación con IA. El flujo actual usa reglas.
- Login propio del panel. El acceso lo controla Tailscale.

## Plan 2 (2026-10-10): etapas, criterios, mapa, informes y notificaciones

Todo cabe en Oracle Always Free sin costo. Medición del 2026-10-10:
- RAM: el monitor usa 138 MB y quedan 378 MB disponibles, además de 1.8 GB de swap.
- Disco: 6.8 de 45 GB.
- Carga: 0.09.

El mapa y las pestañas los procesa el navegador. Los informes son archivos estáticos pequeños y los correos son pocos al día. El límite real es el plan de Claude: cada informe Tier 1 dura unos 22 minutos. Por eso los Tier 1 automáticos tienen un tope diario.

### Decisiones
| # | Decisión |
|---|---|
| C1 | Condados: solo Palm Beach y Broward (hasta el 2026-10-26 también Martin; R4/R5). Sin calle, un lead cuya ciudad es de otro condado se descarta |
| C2 | Margen = (ARV − precio) / ARV × 100 |
| C3 | **Tier 1 automático** si **% of ARV = precio / ARV × 100 ≤ 75 %** (hasta el 2026-10-16: margen ≥ 60 %) y el precio es **< $300,000**. Si no cumple, queda **"No califica"** con el motivo, en la pestaña Nuevo, y se puede pasar a Tier 1 a mano. Sin precio o sin ARV queda Nuevo con la alerta "Solicitar … al wholesaler" |
| C4 | Tope de **3 informes Tier 1 automáticos por día** (zona America/New_York). Los que no caben esperan al día siguiente. Los Tier 1 manuales no tienen tope |
| C5 | Los criterios se aplican a los leads que entran desde ahora, al agregar el precio y al confirmar una dirección en zona. Los leads anteriores no se reevalúan |
| C6 | Tier 2 y Compra se activan con botones manuales. Tier 2 lanzará las fases 1–4 en el PC (Fase D) |
| C7 | "Informe de decisión" es un informe nuevo, por definir. Por ahora se notifican los comparables y las alertas |
| C8 | Notificaciones por **WhatsApp con el mismo número** (decisión del usuario, 2026-10-10), en un **resumen cada 2 horas** al "Grupo prueba Wholesaler", solo si hay novedades y entre 8 y 21 h (hora de Florida). El usuario acepta el riesgo bajo de bloqueo. Si algún día se quiere eliminar, la opción es un segundo número solo para avisos |

### Fases
- [x] **A. Panel y reglas** (sin tokens):
  - [x] pestañas Nuevo / Tier 1 / Tier 2 / Compra;
  - [x] mapa emergente (Google Maps embebido, sin clave);
  - [x] margen visible;
  - [x] criterios C3 con tope C4;
  - [x] inspección en Tier 1: si se hace, si se ejecutó y la observación, con usuario y fecha;
  - [x] botones "Pasar a Tier 2" y "Pasar a Compra".
- [x] **B. Enlaces a informes:** al terminar, el ejecutor del PC sube el dashboard HTML a Oracle. El panel y la vista de solo lectura lo enlazan. El informe se sirve aislado (CSP sandbox) para que no pueda usar la API del panel.
- [x] **C. Avisos por WhatsApp** (`src/notify.js`), en un resumen con secciones:
  - lead con alerta ("Pedir datos al wholesaler");
  - informe Tier 1 listo o con error;
  - informes Tier 2 (comparables, alertas, decisión) al subirlos.
- [x] **D. Tier 2 automático** con el Intake Service del PC (ver bitácora 2026-10-10)

## Plan 3 (2026-10-16): actualizaciones del tablero

| # | Cambio | Estado |
|---|---|---|
| 1 | Pestaña **Descartados**: el lead queda 48 h (recuperable con usuario), luego se borra con sus informes; la dirección sigue bloqueada | hecho |
| 2 | **Nuevo Propiedades / Nuevo Terrenos** (tipo `land` = terreno) | hecho |
| 3 | Tier 1, Tier 2, Compra y Descartados: columna Tipo muestra **Terreno / Propiedad** | hecho |
| 4 | Estado en el mercado (For sale / Contingent / Pending / Off market / Sold, fecha, precio, reducciones, días). Zillow, Redfin y Realtor bloquean consultas directas (403/429/captcha); RentCast no distingue Pending/Contingent. Solución: el runner del PC (MERCADO_EJECUTOR) consulta con **Codex `--search`** y, si falla, **Claude Haiku 5.5**; una vez por lead con dirección (al entrar o si cambia la dirección) | hecho |
| 5 | Columna Contacto eliminada (el contacto sigue en la alerta y el detalle) | hecho |
| 6 | Piñón ⚙️ para editar dirección, condado, precio, ARV, beds, baths, sqft y tipo en Nuevo; recalcula condado y criterios | hecho |
| 7 | **% of ARV** con regla ≤ 75 % (+ precio < $300k, tope 3/día) | hecho |

## Plan 4 (2026-10-20): leads por correo

Un buzón dedicado (Colombia Hosting, cPanel; `mail.haitech-consulting.com:993`) alimenta el mismo tablero que WhatsApp.

| # | Paso | Estado |
|---|---|---|
| 1 | `src/email.js`: sondeo IMAP cada 5 min desde Oracle, solo lectura (no marca ni mueve correos); estado en `data/email-state.json` (UIDVALIDITY + último UID) | hecho |
| 2 | Cada correo pasa a publicaciones `{id, timestamp, groupName, sender, text, images}` y entra a la misma cola (`enqueuePost` → `processInbox`): mismas reglas de extracción, condado, repost y correcciones, criterios (% of ARV ≤ 75 %), Tier 1 automático, avisos y mercado | hecho |
| 3 | Boletines con tarjetas (formato Kassas): una publicación por tarjeta, leída del HTML (precio, ciudad, dirección, ARV, beds/baths, sqft, lote); se corrigen las cifras que la plantilla parte en dos líneas ("1, 143", lote "7" + "013") | hecho |
| 4 | Autor = remitente original de un reenvío; grupo = `Email: <autor>` | hecho |
| 5 | Adjuntos: solo imágenes (OCR local); el resto, PDF incluidos, se ignora (decisión del usuario: no se necesita leer PDF); tope de tamaño | hecho |
| 6 | Seguridad: el texto del correo nunca se pasa a Claude; sin abrir enlaces; la contraseña solo en el `.env` del servidor (`EMAIL_HOST`, `EMAIL_USER`, `EMAIL_PASS`) | hecho |
| 6b | Varias cuentas: la primera con `EMAIL_HOST/USER/PASS` y las demás con `EMAIL_2_*` … `EMAIL_9_*` (`EMAIL_n_PORT`, `EMAIL_n_SOLO_NUEVOS=true` para no importar lo que ya hay). Agregar o quitar una cuenta: `./scripts/correo.sh agregar | quitar <usuario o número> | listar` en el servidor (edita el `.env`, hace copia `.env.bak-correo` y reinicia). El estado de lectura es por cuenta | hecho |
| 7 | Despliegue: la imagen necesita `npm ci` (nuevas dependencias `imapflow` y `mailparser`) | hecho |

## Bitácora
- 2026-10-06: plan creado. Decisiones: R6 = Census y, si no resuelve, Revisar condado. Dirección = número + calle. R7 = no reingresa.
- 2026-10-06: implementado (`src/leads.js`, `actions.js`, `tier1.js`, `migrate.js`; cambios en `pipeline.js`, `sink.js`, `dashboard.js`, `process-inbox.js`, `config.js`). Pruebas: 18/18 en Linux (la de OCR falla solo en Windows por la ruta del fixture, no por estos cambios). Prueba manual del panel con datos de ejemplo: migración, Tier 1, agregar dirección (en zona, fuera y sin determinar) y rechazo de peticiones externas (403).
- 2026-10-06: desplegado en `monitor-wa`. Respaldo previo en `~/monitor/data.bak-*`. La migración pasó 2 filas a 2 leads. El de Lake Wales (Polk) quedó en "Revisar condado" porque la migración no vuelve a geocodificar: se descarta a mano.
- Pendiente conocido: un lead "Pendiente dirección" descartado no deja dirección que recordar, así que si se republica vuelve a entrar.
- 2026-10-07: depuración. (1) El colector unía en una publicación todos los mensajes del mismo autor en 90 s: ahora cada mensaje con texto es una publicación y solo las fotos se agrupan. (2) Las direcciones de secciones "Comps" y de líneas "SOLD" ya no se toman como propiedades. (3) La calle no cruza saltos de línea ni toma el final de un precio ("000 1025 N H St"). (4) Con varias propiedades en un mensaje, cada fila guarda solo su bloque. (5) El panel muestra la dirección completa en una línea. Pruebas: 20/20 en Linux. Reparación única de los datos: la publicación unida se separó por "Terms:" y se reprocesó (4 leads, 6 descartes, descartes previos conservados). Las fotos de esa publicación no se asignaron a ningún anuncio. Respaldo en `~/monitor/data.bak-*-prerepar`.
- 2026-10-07: vista de solo lectura para terceros (`src/vista.js`, página separada en `src/page.js`). Copia del panel sin acciones en `data/vista/`, regenerada con cada cambio y servida en el puerto 3001 solo bajo `/v/<VISTA_TOKEN>/`. Publicada a internet con Tailscale Funnel (`https://monitor-wa.tail4070cb.ts.net/v/<token>/`). El panel con acciones (:3000) sigue solo en Tailscale. El token vive en `.env` del servidor; para revocar el enlace se cambia el token y se reinicia. Pruebas: 21/21 en Linux; comprobado desde fuera que la raíz y un código falso dan 404.
- 2026-10-07: lanzamiento de comp-analysis-report activado (`TIER1_SKILL_ENABLED=true` en el servidor). Cada paso a Tier 1 deja una orden en `data/tier1-jobs/<id>.json` (pendiente → en_proceso → listo | error). API para el PC ejecutor por Tailscale: `GET /api/tier1-jobs?estado=pendiente` y `POST /api/tier1-jobs/<id>/estado` (cabecera `X-Monitor: 1`). El panel y la vista muestran "Informe: en cola / generando / listo / error". Ejecutor: tarea programada `tier1-comp-analysis` en la app de Claude del PC de Roberto, cada hora; máximo 2 órdenes por ejecución; entregables en `4. Ejecucion de procesos\1. Underwriting\1. Propiedades - Leads\<propiedad>\Informes Tier 1\` según el skill. Pruebas: 22/22 en Linux.
- 2026-10-07: el ejecutor pasó de la tarea programada de la app (abría una sesión de ~65k tokens de contexto cada hora aunque no hubiera órdenes; ~130k tokens de entrada por revisión vacía) a una tarea de Windows sin costo en reposo: `scripts/tier1-runner.ps1`, registrada en el Programador de tareas como "Monitor Tier1 - comp-analysis-report" (cada 15 min, usuario interactivo, `conhost --headless`). Solo si hay órdenes ejecuta `claude -p` con los skills que sincroniza la app (`--plugin-dir`, se busca también dentro de `AppData\Local\Packages\Claude_*`). A Claude se le pasan solo los datos extraídos, no el texto libre del mensaje. Una ejecución a la vez; órdenes en proceso > 4 h vuelven a la cola; log con tokens por informe en `%LOCALAPPDATA%\MonitorTier1\`. Requiere `claude auth login` en el PC.
- 2026-10-08: regla de precio y edición de datos. Un lead sin precio lleva la alerta "Solicitar precio al wholesaler" (o "dirección y precio"); no bloquea Tier 1, pero el diálogo lo advierte. Botón "Agregar precio" (precio obligatorio, ARV opcional; acepta 325000, 325,000 o $325k) y botón "Editar datos" (precio, ARV, beds, baths, sqft, lote, año, tipo, contacto, teléfono, email). Cada cambio guarda usuario, fecha y campos (`cambios`, últimos 20) y actualiza la orden de Tier 1 si sigue en cola. Las alertas se recalculan al arrancar. Corregido además el guardado de los diálogos del panel: dependía del evento `close` del diálogo, que no siempre se dispara; ahora se guarda en el envío del formulario. Pruebas: 23/23 en Linux.
- 2026-10-08: ajustes pedidos. "Editar datos" solo existe en leads sin precio (el servidor lo rechaza si ya hay precio). Sin precio no se puede pasar a Tier 1: el botón no aparece y el servidor lo rechaza. Al agregar una dirección en zona a un lead sin precio, queda como Nuevo con la alerta de precio; pasa a Tier 1 cuando se agrega el precio. La alerta de pedir la dirección al wholesaler se mantiene. Pruebas: 23/23 en Linux.
- 2026-10-08: se quitó "Editar datos" a pedido. Solo queda "Agregar precio" (precio obligatorio, ARV opcional; un ARV vacío conserva el existente) en leads sin precio; con precio el servidor lo rechaza. La ruta de edición general ya no existe. Pruebas: 23/23 en Linux.
- 2026-10-10: Fase A desplegada (commit 204f480). Pruebas: 25/25 en Linux.
- 2026-10-10: Fase B, enlaces a informes (`src/informes.js`).
  - Al terminar un informe, el ejecutor del PC sube el dashboard HTML con `scripts/subir-informe.ps1` (`POST /api/leads/<id>/informes?tier=1|2&nombre=…`, cabecera `X-Monitor: 1`, `application/octet-stream`). El mismo script sirve para Tier 2 y para subidas manuales.
  - Archivos permitidos: .html, .docx, .pdf y .xlsx, de hasta 40 MB. Se guardan en `data/informes/<id>/`; un archivo con el mismo nombre reemplaza al anterior.
  - El panel los enlaza en la columna Estado ("📄 T1 · Dashboard"). La vista pública los sirve desde `data/informes`, sin copiarlos.
  - El HTML se abre con `CSP: sandbox`, en un origen aislado del panel; los .docx y .xlsx se descargan.
  - Al descartar el lead se borran sus archivos. El panel avisa si el disco pasa del 80 %.
  - Se subió el informe ya existente de 1500 N Congress Ave (2.1 MB).
  - Pruebas: 26/26 en Linux. Verificado en el panel por Tailscale y en la vista pública por Funnel (con token 200; con otro token 404).
  - Respaldos: desde ahora conviene excluir `informes/` (`rsync -a --exclude informes data/ data.bak-…/`), porque los originales están en OneDrive.
- 2026-10-10: Fase B subida (commit af8a65f).
- 2026-10-10: Fase C, avisos por WhatsApp.
  - Cola en `data/notificaciones.json`. Cada 5 minutos se revisa si toca enviar: hay novedades, pasaron 2 horas desde el último resumen y es horario 8–21 h de Florida.
  - Un solo mensaje por envío, con máximo 10 líneas por sección. Al enviar se vuelve a consultar cada lead: no salen los descartados ni las alertas ya resueltas. Si el envío falla, la cola se conserva.
  - Los mensajes propios ya se ignoraban al leer el grupo, así que los avisos no vuelven a entrar como leads.
  - Configuración en `.env` (`NOTIF_*`); en el servidor quedó `NOTIF_ENABLED=true`. Respaldo previo: `.env.bak-fasec` y `data.bak-*-fasec` (sin `informes/`).
  - Pruebas: 27/27 en Linux.
- 2026-10-10: a pedido del usuario, el resumen ya no incluye la sección de Tier 1 automático ni el enlace al panel.
- 2026-10-10: Fase C subida (commit be628b1).
- 2026-10-10: Fase D, Tier 2 automático. Se reutiliza el **Intake Service** del PC, que ya corría las fases 1–4 con `claude -p`.
  - **Qué aporta el Intake:** Chrome conectado, modelo por fase (Sonnet en 1, 2 y 4; Opus en 3), reintento automático cuando se acaba el cupo (espera la hora de reinicio), registro de tokens y Excel de control.
  - **Los skills no se modifican.**
  - **Oracle** (`src/tier2.js`): "Pasar a Tier 2" pide la cantidad de comparables (8, 12 o 20; la Fase 2 la exige) y deja una orden por lead que avanza fase por fase: pendiente → en_proceso → listo (pasa a la siguiente) | error, y al final "completo".
  - **API:** `GET /api/tier2-jobs` y `POST /api/tier2-jobs/<id>/estado` (`fase` debe coincidir con la fase en curso; `caso_id` es el del Intake). El panel muestra "Fase N/4 · estado" y, si hay error, el botón "Reintentar fase N".
  - **Condados:** solo Broward y Palm Beach, que son los que cubren los skills. Martin pasa a Tier 2 sin orden: queda como excepción manual.
  - **Avisos al grupo:** informes Tier 2 listos (al subirse) y "Tier 2 con error".
  - **Puente en `scripts/tier1-runner.ps1` (`Sync-Tier2`, sin abrir Claude):**
    - arranca el Intake si no responde, con `iniciar_local.ps1` vía WMI para que siga vivo cuando termina la tarea;
    - crea el caso con el contexto del wholesaler (solo datos extraídos);
    - dispara `siguiente-fase` al terminar cada fase;
    - reporta el avance y los errores, y respeta el estado `esperando_cupo`;
    - reintenta solo cuando se pide desde el panel;
    - sube los .docx de comparables (fase 3) y de alertas/decisión (fase 4);
    - abre Chrome si está cerrado antes de las fases 1 y 2.
  - **Ajustes al Intake `server.py`** (respaldo `server.py.bak-2026-10-10`): busca los informes en `Informes Tier 2/` y el contexto llega a todas las fases. Además, `iniciar_local.ps1` pasa el `--plugin-dir` con los skills de la app.
  - **Pruebas:** 28/28 en Linux y prueba aislada del Intake. El Intake arrancó por WMI y respondió `/health`. El puente sin órdenes termina limpio. Falta la primera corrida real, que consume tokens y espera la orden del usuario.
  - En el servidor quedó `TIER2_SKILL_ENABLED=true`. Respaldos: `.env.bak-fased` y `data.bak-*-fased`.
- 2026-10-11: falló el informe Tier 1 de 10303 Oliver Ln. Claude delegó el trabajo a un subagente en segundo plano y cerró la sesión; `claude -p` lo cortó a los 600 s sin entregables. Corrección en `tier1-runner.ps1`:
  - `--disallowedTools Agent` y una instrucción de hacer todo en la misma sesión;
  - `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`, para esperar las tareas en segundo plano en vez de cortarlas;
  - lectura del JSON aunque el CLI imprima avisos antes;
  - "listo" solo si existe un dashboard HTML nuevo en `Informes Tier 1`.
  - Reencolado y verificado: listo en 18 minutos (122 turnos), dashboard de 2.1 MB subido al panel.

- 2026-10-11: los avisos al grupo pasan a **dos resúmenes al día, 11:00 y 17:30 hora de Colombia** (`NOTIF_HORARIOS`, `NOTIF_TZ=America/Bogota`). Solo se envían si hay novedades. Si a esa hora no se pudo enviar, se reintenta durante la hora siguiente; después, lo pendiente pasa al siguiente horario. Pruebas: 28/28 en Linux.
- 2026-10-13: **varios PC ejecutores.**
  - En el panel, los botones Tier 1 y Tier 2 tienen el selector "Ejecutar en" (PC Roberto / PC Andres). Cada orden guarda su `ejecutor`, y `GET /api/tier1-jobs` y `/api/tier2-jobs` aceptan `?ejecutor=`.
  - El tope diario de automáticos cuenta por PC.
  - Los Tier 1 automáticos van a `TIER1_AUTO_EJECUTOR`. La decisión del usuario fue el PC de Andres; en el servidor queda `Roberto` hasta que ese PC esté instalado.
  - `tier1-runner.ps1` recibe `-Ejecutor` y `-IntakeDir`. El Intake lee su carpeta de trabajo de `.project_dir`.
  - Kit de instalación para el PC de Andres: `scripts/instalar-ejecutor.ps1` y el zip con `0. Base formatos` (copia local), el Intake y los scripts. Los skills ya los tiene instalados en su cuenta.
  - Pruebas: 29/29 en Linux.
- 2026-10-15: modelo del Tier 1 por PC (`TIER1_MODELO_POR_PC`). Viaja en cada orden como `modelo` y `esfuerzo`, y el ejecutor lo pasa a `claude -p --model … --effort …`.
  - En el servidor: PC Andres con `claude-fable-5-1:medium` (plan Max) y PC Roberto con `claude-opus-5-5:medium`. Opus 5.5 exige Claude Code 2.1.280 o superior; el PC de Roberto se actualizó a 2.1.300.
  - El log registra el modelo usado. Si el modelo pide créditos de uso, la orden queda en error con ese motivo.
  - `GET /scripts/<tier1-runner|subir-informe|instalar-ejecutor>.ps1` sirve los scripts por Tailscale, para actualizar un PC sin reenviar el kit.
  - Pruebas: 30/30 en Linux.
- 2026-10-15: prueba del PC de Andres. Hizo el Tier 1 de 612 Minnesota St con Fable 5.1 en 16 minutos y subió el dashboard. Decisión del usuario: los Tier 1 automáticos se quedan en el PC de Roberto (`TIER1_AUTO_EJECUTOR=Roberto`).
- 2026-10-15: los mapas de los informes mostraban "Access blocked" de OpenStreetMap. Causa: el panel servía los informes con `Referrer-Policy: no-referrer`, y OpenStreetMap bloquea las peticiones sin Referer. Arreglo: los informes usan `strict-origin`, que envía solo el dominio, nunca la ruta ni el token. Verificado: las 15 imágenes del mapa cargan.
- 2026-10-16: se quitó la alerta "Solicitar ARV al wholesaler", porque ese dato nunca llega. Un lead sin ARV queda en Nuevo y sin alerta: no se evalúan los criterios y el paso a Tier 1 se decide a mano. Pruebas: 30/30 en Linux.
- 2026-10-16: enlaces **Redfin · Zillow · Realtor** debajo de "Ver mapa" y en la ventana del mapa. Zillow usa la URL `/homes/<dirección>_rb/`; Redfin y Realtor usan la redirección de DuckDuckGo al primer resultado del sitio. Se generan en el panel, así que aplican también a los leads que ya existían. La columna Fecha muestra el formato "Friday, Oct 16", sin hora.
- 2026-10-16: filtro de direcciones basura del OCR (`esCalleValida` en `src/extract.js`). El nombre de la calle debe ser creíble: una sola letra (calles de Lake Worth), un ordinal o palabras de 3 letras o más; se admiten artículos como "La" o "De". "SR" ya no se acepta sin número. Se descartaron los 5 leads basura existentes (1 Sr, 25 Sr, 4 rd, 20 od gal RD SE, 5 ie le RF a ST): quedan 39 leads, y sus direcciones quedan bloqueadas. Respaldo en `data.bak-*-ocr`. Pruebas: 31/31 en Linux.
- 2026-10-16: reposts y correcciones del wholesaler (`addLeads` en `src/leads.js`).
  - **Repost** (misma clave de dirección que un lead activo): no crea un lead nuevo. Actualiza `publicaciones`, `ultima_publicacion` y, si cambió el precio, `precio_repost`.
  - **Corrección** (mismo autor y grupo, mismo precio y ARV, misma calle y unidad, otro número, dentro de 48 h): reemplaza la dirección del lead anterior (`direccion_corregida_de`) y bloquea la dirección vieja.
  - Extractor: el cardinal final no se toma si sigue "Palm" ("814 42nd St West Palm Beach" → calle "814 42nd St", ciudad West Palm Beach).
  - Limpieza única: de los 3 leads de SE 15th St #513 queda el de 1731 (731 era un error del wholesaler y el otro era el repost del 9-oct). También se corrigió 814 42nd St a West Palm Beach. Respaldo en `data.bak-*-dup`.
  - Revisión de las 30 direcciones con el Census para los enlaces de los portales: 28 coinciden, 814 se corrigió y 239 Gulfstream Blvd (Boynton Beach) no aparece en el Census; se dejó tal como la escribió el wholesaler.
  - Pruebas: 32/32 en Linux.
- 2026-10-16: las filas del panel alternan dos tonos (blanco y `#F2F6FB`; al pasar el mouse, `#E6EEF8`), con equivalentes para el modo oscuro. Aplica también a la vista pública.
- 2026-10-16: Plan 3, pasos 1-3 y 5-7. `discardLead` pasa el lead a `papelera` (48 h; `purgarDescartados` cada hora borra lead e informes); `recuperarLead`; `editarLead` y `TIPOS`; `pctArv` reemplaza a `margenPct` (`pct_arv` en lugar de `margen_pct`, se migra al arrancar). Con los datos actuales ningún "No califica" pasa a cumplir con la regla nueva. Pruebas: 33 (32 + OCR solo en Linux).
- 2026-10-16: Plan 3, paso 4. `src/mercado.js` tiene la cola (`GET /api/mercado-jobs?ejecutor=`, solo para MERCADO_EJECUTOR, por defecto TIER1_AUTO_EJECUTOR) y valida el reporte (`POST /api/mercado-jobs/:id/estado`), que guarda `lead.mercado` con la dirección consultada. Tras 3 errores con la misma dirección deja de consultarla. Runner: `Sync-Mercado` procesa 6 leads por corrida con su propio candado; Codex usa `--output-schema`. Panel: línea plegable debajo del precio con notas y fuentes; Excel: columnas `mercado_*`. Piloto: Codex tarda 13–33 s por lead y Haiku unos 49 s.
- 2026-10-16: la tarea programada del PC de Roberto apuntaba a `Program Files\WindowsApps\Microsoft.PowerShell_7.6.6.0...\pwsh.exe`, que desapareció cuando la Store actualizó PowerShell. El runner dejaba de correr sin avisar (ni Tier 1 automático ni mercado; no había órdenes atrasadas). Arreglo: la tarea usa el alias estable `%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe`, y `instalar-ejecutor.ps1` lo prefiere al crear la tarea.
- 2026-10-20: Plan 4, lector de correo. Con el boletín de prueba (Kassas, 8 tarjetas) salen 8 publicaciones; 7 con calle completa y 1 ("Inwood Dr", sin número) se descarta por no tener dirección ni ARV. Se corrigió un error real al probar: `uidValidity` de ImapFlow es BigInt y se comparaba como texto, así que cada pasada releía todo el buzón. Pruebas: 36 (+1 OCR solo en Linux).
- 2026-10-20: lector de correo con varias cuentas y `scripts/correo.sh`. Sin PDF (decisión del usuario). Pruebas: 37 (+1 OCR solo en Linux).
