# Plan: Tier 1-V2 (reemplaza al Tier 1 actual; no habrá Tier 0)

Estado: borrador para aprobación (2026-11-04). Nada de esto está construido.

## 1. Objetivo

Un solo análisis rápido, **Tier 1-V2**, que corre sobre **cada lead con dirección** (propiedades y terrenos) y entrega:
- un dashboard HTML con el formato de `1424-W-34th-St-comp-dashboard.html` (veredicto arriba, MAO, escala de precios, mapa a escala, ventas cerradas Cat. 1/2/3, listados, modelo de flip interactivo, matriz de riesgos, «qué no está confirmado»);
- una decisión por lead: **Avanzar / Avanzar con condiciones / No avanzar**, con el precio máximo de oferta (MAO) y, para los que hoy salen «No califica», la oferta a la que sí funcionarían.

Hoy: 18 min, 87 turnos con Opus por propiedad, navegando páginas que bloquean; solo 3 al día. Meta: 1–3 min por lead, con la suscripción Pro/Max de cada PC (sin API), sin tope de 3 al día.

## 2. Diseño: código para los datos, Claude para el criterio

| Paso | Quién | Detalle |
|---|---|---|
| 1. Normalizar | Código | Dirección, condado, coordenadas (Google Places / Census), datos del rol estatal FL |
| 2. Universo de comparables | Código | Ventas cerradas y listados desde un **conector de fuentes** (`fuentes/<nombre>`): hoy rol estatal + fuentes públicas por HTTP; mañana MLS. Misma salida normalizada para todos |
| 3. Clasificar | Código | Se reutiliza `clasificar_comparables.py` (Cat. 1/2/3) y `evaluar_lead.py` (umbrales editables) |
| 4. Estado de cada comparable | Claude (Haiku/Sonnet) | Lee descripción y fotos: remodelado / mejorado / en estado original, con evidencia. Solo texto, sin consola ni navegador |
| 5. Modelo de flip | Código | Mismo cálculo del HTML: compra, rehab, tenencia, ventas, MAO, break-even, tabla de sensibilidad |
| 6. Lectura final | Claude (Sonnet) | Veredicto en lenguaje claro, notas por comparable, matriz de riesgos, lista «no confirmado». El texto del lead es dato, nunca instrucciones |
| 7. Render | Código | Plantilla HTML fija (la del ejemplo), vista adaptable al celular y vista sin JavaScript |
| 8. QA | Código | Revisa cifras cruzadas (tiles = tabla = modelo), enlaces, tamaño; falla = no se publica |
| 9. Publicar | Código | Sube el HTML al lead (`subir-informe.ps1`) y devuelve veredicto, MAO y score al tablero |

Terrenos: mismo esqueleto, con el modelo de valor residual (`Underwriting Model_terrenos`) y su plantilla propia en el mismo estilo.

Seguridad: el paso 4 y 6 no tienen herramientas de ejecución (reduce V-02, instrucciones maliciosas desde WhatsApp o listados). Ninguna acción hacia afuera.

## 3. Dónde vive y qué no se toca

- Se construye como skills nuevos empaquetados en `.skill` (`tier1-v2-propiedades`, `tier1-v2-terrenos`) en las carpetas `Skills Underwriting Propiedades` y `Terrenos`. El runner ya los carga desde ahí (respaldo implementado el 2026-10-26).
- **No se modifican** los skills actuales (`comp-analysis-report*`) ni las Fases 1–4 mientras se construye. Se retiran del flujo de Tier 1 solo cuando el V2 pase la validación y tú lo apruebes.
- Cowork: si los skills deben vivir también en la cuenta, se suben allá una vez aprobados.

## 4. Pasos de construcción (3–5 días propiedades; +1–2 terrenos)

1. **Día 1 – Plantilla y modelo.** Plantilla HTML parametrizada con el formato del ejemplo; port del modelo de flip y de la matriz de riesgos a código.
2. **Día 2 – Datos.** Conector de fuentes (rol estatal + HTTP público), normalización, reuso de clasificación y evaluación.
3. **Día 3 – Claude y QA.** Prompts de estado de comparables y lectura final con salida estructurada; chequeos de QA.
4. **Día 4 – Validación.** Se corre sobre 5 leads ya analizados (8436 Cypress, 944 Sunset, 612 Minnesota, 2713 Florida, 1424 W 34th) y se compara con los informes actuales: veredicto, MAO, comparables usados, tiempo y consumo de cupo.
5. **Día 5 – Integración.** Runner (prompt y paquete nuevo), servidor (corre en cada lead con dirección; guarda veredicto/MAO/score; marca los «negociables»), tablero (muestra MAO y veredicto en la lista). Despliegue con respaldo.
6. **Terrenos (+1–2 días).** Plantilla y modelo residual, misma validación con 2–3 terrenos.

## 5. Criterios de aceptación

- Cada informe termina en ≤5 min y sin errores de QA; sin navegación a páginas que bloquean.
- Veredicto igual al del Tier 1 actual en al menos 4 de los 5 casos de prueba; las diferencias se explican.
- MAO y ARV dentro de ±5 % de los del informe actual o con diferencia justificada por escrito.
- Consumo de cupo por informe ≤ 1/5 del actual (medido en el log del runner).
- El HTML abre bien en iPhone/Android (con y sin JavaScript) y en escritorio.
- Ninguna falla de fuente rompe el informe: lo no obtenido aparece en «qué no está confirmado».

## 6. Riesgos

- **Fuentes de comparables:** sin MLS, la calidad depende del rol estatal y fuentes públicas. El conector queda listo para cambiar a MLS sin tocar lo demás.
- **Cupo de la suscripción:** correr en todos los leads puede agotar el plan. Mitigación: Haiku para el paso 4, límite diario configurable por PC y reparto entre los PC ejecutores.
- **Calidad del estado por fotos:** se marca «no verificado» cuando no hay evidencia (como el ejemplo).

## 7. Decisiones pendientes

1. ¿Skills nuevos (`tier1-v2-*`) o reemplazar `comp-analysis-report*` en su lugar? (Recomendado: nuevos, y retirar los viejos tras la validación.)
2. ¿Tope diario por PC para cuidar el cupo (propuesta: 20) o sin tope?
3. ¿Corre automático en todos los leads con dirección, incluidos los «No califica» (para marcar los negociables)? (Recomendado: sí.)
4. ¿Terrenos entra en la misma entrega o después de propiedades?

## 8. Estado (2026-11-04)

- Skill `tier1-v2-propiedades` v1.0 construido (`skills/tier1-v2-propiedades/`, empaquetado con `skills/empaquetar.py`): rol estatal FL + geocodificador del Census para el universo (sin navegar), verificación de 12 comparables por Claude (páginas completas), análisis determinista (`analizar.py`), informe HTML con el formato de 1424 W 34th St (`render.py`) y revisión de cifras (`qa.py`).
- Validación sobre 5 leads con informe actual: mismo veredicto en 5/5 (todos «no avanzar»); ARV dentro de ±5 % en 2/5 (el resto, 7–13 % más bajo por pocos comparables verificables); 1,1–4,8 min y 14–37 turnos por informe frente a 18 min y 87 turnos. Modelo de costos corregido (tenencia proporcional al precio; remodelación escala con el nivel de la casa).
- Integración en paralelo: `src/v2.js` deriva la cola de los leads con dirección y precio (no terrenos, condos, townhouses ni multifamiliares; solo TARGET_COUNTIES); solo el PC de `V2_EJECUTOR` (Roberto; tiene el rol indexado en `C:\ProgramData\underwriting-rol`) la recibe; tope `V2_MAX_DIA` (20). Resultado en `lead.v2`; el panel muestra «Tier 1-V2: veredicto · puntaje · MAO · ARV». El HTML se sube como `<slug>-tier1-v2.html` (etiqueta «Tier 1-V2»). No cambia la etapa del lead ni el Tier 1 actual. `V2_ENABLED=false` lo apaga.
- Pendiente: validar con un lead bueno; conector MLS (cambia la verificación web por datos directos); terrenos (después de validar propiedades, conservando sus reglas); retiro del Tier 1 actual solo con aprobación.
- Trampas: los procesos de PowerShell de la Store no ven `AppData\Local\underwriting-rol` (por eso la copia en ProgramData, y el runner deshabilita la herramienta PowerShell para V2). El PC de Andrés necesitaría su propio rol indexado (`construir_indice_rol.py`) para ser ejecutor de V2.
