# Matrix (Beaches MLS) → tablero: exportación semanal

Una persona con acceso a Matrix baja **3 archivos pequeños una vez por semana** (viernes o lunes, lo importante es que se haga cada semana; lo que cambió
en los últimos 7 días, no todo el mercado). El
importador los une, detecta las señales de negociación y envía las propiedades al tablero. Los archivos quedan en este PC
(`C:\monitor\datos\mls`, fuera de OneDrive) y no se comparten. Uso medido: 3 descargas por semana, con pausas normales entre pasos;
para análisis interno de inversión, respetando las reglas de uso de datos de Beaches MLS.

## Qué llega al tablero
| Caso | Qué pasa |
|---|---|
| **Con señal de negociación**: condición especial (*Short Sale*, *REO*, *Probate*, *Foreclosure*, *Auction*), *Listing Terms* de financiamiento o creativo (*Owner Carry*, *Private Financing*, *Assumable*, *Lease Option/Purchase*, *Contract*, *Trust Deed*), o comentarios de vendedor motivado / financiamiento del vendedor | **Entra al tablero** (Nuevo Propiedades y Oportunidades) con la etiqueta 🏷 MLS y sus señales. El Tier 1-V2 corre igual y suma su puntaje |
| **Sin señal** (solo nueva, rebaja o vuelta al mercado) | Entra **oculta**. Corre el Tier 1-V2: con **60 o más** se muestra; con menos pasa a Descartados (5 días) con el puntaje. Si luego el precio baja **5 % o más**, se evalúa de nuevo |

No pasan por el Tier 1 automático (no traen ARV): solo el Tier 1-V2 decide. El V2 corre en el PC de Roberto (tope diario `V2_MAX_DIA`).

## Una sola vez: agregar 3 campos al formulario
Matrix → SEARCH → Residential → *Additional Fields → Add/Remove*: agregar **Major Change Timestamp**, **Listing Terms** y
**Special Listing Conditions**.

## Las 3 búsquedas de cada semana
Criterios comunes: **Status** Active (y Coming Soon) · **County** Broward y Palm Beach · **Property Subtype** Single Family Residence ·
**Major Change Timestamp** = últimos 7 días en formato `mm/dd/aaaa-mm/dd/aaaa`.

| Archivo | Criterio propio | Casos medidos (7 días, 7-nov) |
|---|---|---|
| `M-movimiento.zip` | List Price (000s): `0-300` | 27 |
| `S-condiciones.zip` | List Price `0-400` · **Special Listing Conditions**: *Short Sale*, *Probate Listing*, *In Foreclosure*, *Real Estate Owned*, *Auction* | 18 |
| `T-financiamiento.zip` | List Price `0-400` · **Listing Terms**: *Owner May Carry*, *Owner Will Carry*, *Private Financing Available*, *Assumable*, *Lease Option*, *Lease Purchase*, *Contract*, *Trust Deed* | 1 (la primera carga, sin fechas, fueron 25) |

Los campos de Matrix se combinan con **Y**, no con **O**: por eso son 3 búsquedas. El conteo «matches» de abajo parpadea mientras carga; leerlo cuando se estabiliza.

## Cómo exportar (por cada archivo)
1. **Clear** (abajo a la izquierda) y rellenar los criterios de la tabla.
2. Pulsar **Results**; arriba, junto a «Checked», pulsar **All**.
3. Barra *Actions* → **Export** → *Export file format* **DataMaster_CSV** → **Export**.
4. Edge pregunta si se conserva el archivo: **Mantener**. Queda como `DataMaster_CSV.zip` en Descargas.
5. Moverlo a `C:\monitor\datos\mls\<fecha de la descarga>\` (p. ej. `2026-11-14`) y renombrarlo `M-movimiento.zip`, `S-condiciones.zip` o `T-financiamiento.zip`.
   La letra inicial indica qué búsqueda es: de ahí sale la señal de *Listing Terms*.

## Importar y enviar
Doble clic en `C:\monitor\datos\mls\IMPORTAR.cmd`: usa la carpeta con la fecha más reciente, muestra cuántas propiedades hay, cuántas con señal y
cuántas esperan el V2, y pregunta si las envía al tablero. Importar el mismo archivo dos veces no duplica nada; una propiedad que viene en
varios archivos cuenta una vez.

## Cuántos casos por semana (medido 7-nov, Broward + Palm Beach, unifamiliar)
- **Con señal de negociación: unos 19** (18 condiciones especiales ≤ $400K, 1 de Listing Terms, más los pocos con frases en los comentarios).
- **Sin señal: unos 20** (nuevas, rebajas y vueltas al mercado ≤ $300K); entran al tablero solo las que el V2 puntúe en 60 o más.
- Stock que hoy ya está en el mercado y no se baja cada semana: 68 con condición especial ≤ $400K y 25 con Listing Terms ≤ $400K.

## Lo que trae el DataMaster_CSV
Dirección, ciudad, zip, condado, **folio**, habitaciones, baños, superficie, lote, año, precios de lista y cierre, fechas, **DOM**, **comentarios
públicos**, *Special Listing Conditions*, impuesto, HOA y una foto. **No trae** *Listing Terms* (por eso el archivo T), historial de rebajas
(se detecta al repetir semanas), comentarios privados ni datos del agente (por ahora no se necesitan: solo la dirección y los datos de la propiedad).
Otros tipos de vivienda: el Tier 1-V2 hoy no analiza condominios, townhouses ni multifamiliares; con los mismos filtros, sumar townhouse y villa
da 97 casos por semana (≤ $300K) y con condominios 958.
