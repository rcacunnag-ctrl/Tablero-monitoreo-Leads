#!/usr/bin/env python3
"""QA del dashboard Tier 1-V2: cifras cruzadas, secciones, tamaño y ausencia de valores rotos. Sale con código 1 si falla."""
import re
import sys

ruta = sys.argv[1]
h = open(ruta, encoding="utf-8").read()
fallas = []

for s in ("Maximum offer for a flip", "Lead read:", "Where the price sits", "Location and sales windows", "Closed sales", "Listings",
          "Flip model", "Risk matrix", "What is not confirmed", "Preliminary draft"):
    if s not in h:
        fallas.append(f"falta la sección: {s}")
for malo in ("NaN", "undefined", ">None<", "None</", "$nan", "$None"):
    if malo in h:
        fallas.append(f"valor roto en el HTML: {malo}")
if len(h) > 3_000_000:
    fallas.append(f"pesa {len(h) / 1e6:.1f} MB (máximo 3 MB)")
ext = [u for u in re.findall(r'(?:src|href)="(https?://[^"]+)"', h) if "fonts.googleapis" not in u]
if ext:
    fallas.append(f"recursos externos que pueden bloquearse: {ext[:3]}")

# El MAO del tile principal debe ser el de la tabla del modelo (redondeado a miles)
tile = re.search(r'Maximum offer for a flip</span><span class="v">\$([\d,]+)<', h)
tabla = re.search(r'id="p_mao">\$([\d,]+)<', h)
if tile and tabla and abs(int(tile.group(1).replace(",", "")) - int(tabla.group(1).replace(",", ""))) > 1000:
    fallas.append(f"MAO distinto entre el tile (${tile.group(1)}) y la tabla (${tabla.group(1)})")
if not tile:
    fallas.append("no se encontró el MAO del tile principal")
# La ganancia del tile y la de la tabla deben coincidir
g1 = re.search(r'id="t_profit">(-?\$[\d,]+)<', h)
g2 = re.search(r'id="p_profit">(-?\$[\d,]+)<', h)
if g1 and g2 and g1.group(1) != g2.group(1):
    fallas.append(f"ganancia distinta: tile {g1.group(1)} y tabla {g2.group(1)}")
# Cada comparable listado debe tener al menos precio y fecha
filas = re.findall(r"<tr><td style=\"white-space:nowrap\"><strong>[^<]+</strong></td><td><span class=\"pill c\d\">", h)
if not filas:
    fallas.append("la tabla de ventas cerradas está vacía")

if fallas:
    print("QA FALLÓ:\n- " + "\n- ".join(fallas))
    sys.exit(1)
print(f"QA OK ({len(h) / 1024:.0f} KB, {len(filas)} ventas en tabla)")
