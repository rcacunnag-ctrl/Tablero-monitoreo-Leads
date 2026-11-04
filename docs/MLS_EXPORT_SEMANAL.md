# Exportación semanal de Matrix (Beaches MLS)

Una persona con acceso a Matrix hace **una exportación por semana (lunes)** y deja los archivos en una carpeta. El agente
trabaja con esos datos durante la semana: no vuelve a entrar al MLS. Los datos se quedan en este PC (`C:\MLS-semanal`,
fuera de OneDrive) y no se publican ni se comparten.

**Uso medido:** máximo 3 o 4 exportaciones por semana, con pausas normales entre pasos. No repetir exportaciones iguales.
Para uso interno de análisis de inversión; respetar las reglas de uso de datos de Beaches MLS.

## Antes de empezar (una vez)
1. Crear la carpeta `C:\MLS-semanal` (ya existe en el PC de Roberto).
2. Cada lunes, crear una subcarpeta con la fecha: `C:\MLS-semanal\2026-11-09`.

## Las exportaciones de cada semana
Todas se hacen igual: **Matrix → SEARCH → Residential**, se rellenan los criterios de la tabla, se abre **Results**,
se marcan todos los resultados y se exporta en formato **DataMaster_CSV** (pasos abajo).

| Archivo | Estado (Status) | Fechas | Otros criterios |
|---|---|---|---|
| `A-oportunidades.zip` | **Active** y **Coming Soon** (desmarcar el resto) | sin fechas | County: Broward, Palm Beach · Property Subtype: Single Family Residence · List Price (000s): `0-400` |
| `B-motivados.zip` | **Expired**, **Withdrawn** y **Canceled** | en cada casilla de fecha, los últimos 60 días: `mm/dd/aaaa-mm/dd/aaaa` | igual que A |
| `C-cerradas.zip` | **Closed** | los últimos 14 días: `mm/dd/aaaa-mm/dd/aaaa` | County: Broward, Palm Beach · Single Family Residence · List Price (000s): `0-600` |
| `D-comparables-<zip>.zip` | **Closed** | desde el 01/06/2026 hasta hoy | Zip Code: los códigos que indique el sistema (ver abajo) · Single Family Residence |

- **D no es semanal.** Se hace la primera vez y luego solo para códigos postales nuevos. Después de importar A, el
  sistema imprime «códigos postales sin historial de ventas»: se exporta una D con esos códigos separados por coma.
- Si Matrix no deja escribir `0-400` en precio, escribir `400` en el máximo; el rango es en miles (la casilla «000s» marcada).

## Cómo exportar (por cada archivo)
1. **SEARCH → Residential.** Si hay criterios de una búsqueda anterior, usar **Clear** (abajo a la izquierda).
2. En **Status – Date or Range**: marcar solo los estados de la tabla. Donde la tabla pide fechas, escribirlas en la casilla del estado.
3. **Property Subtype**: seleccionar *Single Family Residence*. **County** (o **Zip Code**): escribir los valores separados por coma.
4. **List Price (000s)**: el rango de la tabla.
5. Abajo a la izquierda, pulsar **Results**. Revisar el número de resultados (A: cientos; C: decenas a pocos cientos).
6. Marcar **todo**: en la barra de arriba de la lista, junto a «Checked», pulsar **All** (marca los resultados de todas las páginas).
7. Abajo, en la barra *Actions*, pulsar **Export**.
8. **Export file format**: elegir **DataMaster_CSV** (el único que trae superficie, comentarios, folio y foto). Pulsar **Export**.
9. El navegador baja `DataMaster_CSV.zip`. Si Edge pregunta si se conserva, elegir **Mantener / Keep**.
10. Mover el archivo a `C:\MLS-semanal\<fecha>\` y renombrarlo según la tabla (`A-oportunidades.zip`, etc.).

No abrir los .zip ni descomprimirlos a mano: el importador los lee tal cual.

## Importar
Doble clic en `C:\MLS-semanal\IMPORTAR.cmd` (usa la carpeta con la fecha más reciente). Imprime cuántos registros cargó por
archivo, los códigos postales sin historial de ventas y las propiedades nuevas de la semana. Importar el mismo archivo dos
veces no duplica nada.

## Qué trae el formato DataMaster_CSV (probado el 2026-11-04 con 141 ventas cerradas del 33406)
64 columnas: dirección, ciudad, código postal, condado, **folio** (cruza con el catastro), habitaciones, baños,
**superficie**, lote, año, precio de lista y de cierre, fechas de lista, cierre, pendiente, retiro y vencimiento, **DOM**,
**comentarios públicos** (dicen si es remodelada, «Investor Special», «requires updating»), techo, ventanas, interior,
condiciones especiales (*Short Sale*, *REO*…), impuesto anual, cuota HOA y **una foto** por propiedad.
No trae: historial de rebajas (se detecta comparando las exportaciones de semanas distintas), comentarios privados de agentes,
latitud ni longitud (se obtienen del folio o de la dirección).
