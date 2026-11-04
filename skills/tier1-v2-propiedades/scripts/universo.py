#!/usr/bin/env python3
"""Tier 1-V2, paso 1: sujeto y universo de comparables, sin navegar.

Fuentes: rol estatal de Florida indexado en este PC (NAL/SDF, Broward y Palm Beach) y el geocodificador
gratuito del Census. Escribe <carpeta>/universo.json con el sujeto, las ventas cerradas candidatas (con
distancia, $/sf y señal de remodelación del catastro) y la cobertura real (hasta qué fecha llegan las ventas).

    python universo.py --lead lead.json --out work/
    python universo.py --direccion "2713 Florida St, West Palm Beach, FL 33406" --condado palm_beach --precio 355000 --out work/

lead.json = los datos ya extraídos del lead: direccion, condado, asking_usd, arv_declarado_usd, beds, baths, sqft, tipo.
El texto libre del mensaje de WhatsApp nunca entra aquí.
"""
import argparse
import csv
import io
import json
import math
import os
import re
import sys
import urllib.request
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fl_roll_lookup as roll  # noqa: E402

COND = {"palm beach": "palm_beach", "palm_beach": "palm_beach", "broward": "broward"}
SUFIJOS = {"STREET": "ST", "AVENUE": "AVE", "ROAD": "RD", "DRIVE": "DR", "LANE": "LN", "COURT": "CT", "CIRCLE": "CIR",
           "BOULEVARD": "BLVD", "PLACE": "PL", "TERRACE": "TER", "WAY": "WAY", "TRAIL": "TRL", "PARKWAY": "PKWY"}


def haversine(lat1, lon1, lat2, lon2):
    r = 3958.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def parte_direccion(texto):
    """'2713 Florida St, West Palm Beach, FL 33406' -> (calle normalizada, ciudad, zip)."""
    partes = [p.strip() for p in str(texto).split(",")]
    calle = re.sub(r"\s+", " ", partes[0].upper().replace(".", ""))
    ciudad = partes[1].upper() if len(partes) > 1 else ""
    m = re.search(r"\b(\d{5})\b", str(texto))
    z = m.group(1) if m else ""
    toks = calle.split(" ")
    if len(toks) > 1 and toks[-1] in SUFIJOS:
        toks[-1] = SUFIJOS[toks[-1]]
    return " ".join(toks), ciudad, z


def geocodificar(filas):
    """filas = [(id, calle, ciudad, zip)] -> {id: (lat, lon)} con el geocodificador por lotes del Census."""
    if not filas:
        return {}
    buf = io.StringIO()
    w = csv.writer(buf)
    for i, calle, ciudad, z in filas:
        w.writerow([i, calle, ciudad, "FL", z])
    borde = uuid.uuid4().hex
    cuerpo = []
    for nombre, valor, archivo in (("benchmark", "Public_AR_Current", None), ("addressFile", buf.getvalue(), "b.csv")):
        cab = f'--{borde}\r\nContent-Disposition: form-data; name="{nombre}"' + (f'; filename="{archivo}"\r\nContent-Type: text/csv' if archivo else "")
        cuerpo.append(f"{cab}\r\n\r\n{valor}\r\n")
    datos = ("".join(cuerpo) + f"--{borde}--\r\n").encode("utf-8")
    req = urllib.request.Request("https://geocoding.geo.census.gov/geocoder/locations/addressbatch", data=datos,
                                 headers={"Content-Type": f"multipart/form-data; boundary={borde}", "User-Agent": "tier1-v2"})
    out = {}
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            for fila in csv.reader(io.StringIO(r.read().decode("utf-8", "replace"))):
                if len(fila) >= 6 and fila[2] == "Match" and "," in fila[5]:
                    lon, lat = fila[5].split(",")
                    out[fila[0]] = (float(lat), float(lon))
    except Exception as e:  # sin red o servicio caído: el informe lo dice, no se inventan coordenadas
        print(f"AVISO geocodificación: {e}", file=sys.stderr)
    return out


def senal_rehab(brecha, nconst):
    if (brecha or 0) >= 10 or (nconst or 0) > 0:
        return "likely"
    return "no"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--lead", help="JSON con los datos extraídos del lead")
    ap.add_argument("--direccion")
    ap.add_argument("--condado")
    ap.add_argument("--precio", type=float)
    ap.add_argument("--arv", type=float)
    ap.add_argument("--beds", type=float)
    ap.add_argument("--baths", type=float)
    ap.add_argument("--sqft", type=float)
    ap.add_argument("--radio", type=float, default=1.5, help="millas")
    ap.add_argument("--meses", type=int, default=12)
    ap.add_argument("--max-candidatos", type=int, default=3000)
    ap.add_argument("--radio-max", type=float, default=2.0, help="radio al que se amplía si hay menos de 8 dentro de --radio")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    lead = json.load(open(a.lead, encoding="utf-8")) if a.lead else {}
    direccion = a.direccion or lead.get("direccion")
    condado = COND.get(str(a.condado or lead.get("condado") or "").strip().lower())
    if not direccion or not condado:
        sys.exit("Falta la dirección o el condado (solo Palm Beach y Broward tienen rol indexado)")
    precio = a.precio or lead.get("asking_usd") or lead.get("precio_usd")
    arv = a.arv or lead.get("arv_declarado_usd") or lead.get("arv_usd")
    calle, ciudad, zip_ = parte_direccion(direccion)

    intentos = []
    meta = roll.carga_meta(intentos)
    con = roll.abre_db(intentos)
    if not (meta and con):
        sys.exit("No hay rol estatal indexado en este PC: " + json.dumps(intentos, ensure_ascii=False))
    cono = roll.CONDADOS[condado]

    sujeto_nal = roll.parcela_por_direccion(con, calle, condado, intentos)
    sujeto = {"direccion": direccion, "calle": calle, "ciudad": ciudad.title(), "zip": zip_, "condado": condado}
    if sujeto_nal:
        ventas = roll.ventas_sdf(con, sujeto_nal["PARCEL_ID"], condado, intentos)
        sujeto.update({
            "folio": sujeto_nal["PARCEL_ID"], "sqft": sujeto_nal.get("TOT_LVG_AREA"), "anio": sujeto_nal.get("ACT_YR_BLT"),
            "anio_efectivo": sujeto_nal.get("EFF_YR_BLT"), "lote_sqft": sujeto_nal.get("LND_SQFOOT"),
            "uso_dor": (sujeto_nal.get("DOR_UC") or "").strip(), "barrio": (sujeto_nal.get("NBRHD_CD") or "").strip(),
            "legal": sujeto_nal.get("S_LEGAL"), "valor_just": sujeto_nal.get("JV"), "imp_qual": sujeto_nal.get("IMP_QUAL"),
            "ultima_venta": next(({"precio": v["SALE_PRC"], "fecha": f"{int(v['SALE_YR'])}-{str(v['SALE_MO']).zfill(2)}",
                                   "calificada": v.get("_es_mercado")} for v in ventas if v.get("SALE_PRC")), None)})
        # nunca se guarda el propietario ni su dirección postal
    else:
        sujeto["aviso_rol"] = "El rol no tiene una parcela única con esa dirección"
    for k, v in (("beds", a.beds or lead.get("beds")), ("baths", a.baths or lead.get("baths")), ("sqft_lead", a.sqft or lead.get("sqft"))):
        sujeto[k] = v
    sf = sujeto.get("sqft") or sujeto.get("sqft_lead")
    sujeto["sqft"] = sf

    # Candidatas: ventas calificadas recientes del mismo uso, ±25 % de superficie, misma ciudad y zip (luego se filtra por distancia)
    corte = meta["fecha_corte_rol"]
    tot = int(corte[:4]) * 12 + int(corte[5:7]) - a.meses
    where = ["s.CO_NO=?", "n.CO_NO=?", "TRIM(s.QUAL_CD) IN ('01','02')", "(s.SALE_YR*12+CAST(s.SALE_MO AS INTEGER))>=?", "s.SALE_PRC>=20000"]
    par = [cono, cono, tot]
    if sf:
        where += ["n.TOT_LVG_AREA BETWEEN ? AND ?"]
        par += [sf * 0.75, sf * 1.25]
    if sujeto.get("uso_dor"):
        where.append("TRIM(n.DOR_UC)=?")
        par.append(sujeto["uso_dor"])
    else:
        where.append("TRIM(n.DOR_UC)='001'")
    where.append("(CAST(n.PHY_ZIPCD AS INTEGER)=? OR UPPER(n.PHY_CITY)=?)")
    par += [int(zip_ or 0), ciudad]
    sql = f"""SELECT n.PARCEL_ID, n.PHY_ADDR1, n.PHY_CITY, n.PHY_ZIPCD, n.TOT_LVG_AREA, n.ACT_YR_BLT, n.EFF_YR_BLT,
                     n.LND_SQFOOT, n.NCONST_VAL, n.NBRHD_CD, n.S_LEGAL, n.IMP_QUAL, s.SALE_YR, s.SALE_MO, s.SALE_PRC
              FROM sdf s JOIN nal n ON n.CO_NO=s.CO_NO AND n.PARCEL_ID=s.PARCEL_ID
              WHERE {' AND '.join(where)} ORDER BY s.SALE_YR DESC, CAST(s.SALE_MO AS INTEGER) DESC LIMIT ?"""
    par.append(a.max_candidatos)
    filas = [dict(r) for r in con.execute(sql, par)]
    meses_usados = a.meses
    if len(filas) < 8:  # poca evidencia: se amplía a 24 meses y se dice
        par[2] = int(corte[:4]) * 12 + int(corte[5:7]) - 24
        filas = [dict(r) for r in con.execute(sql, par)]
        meses_usados = 24

    # Coordenadas (Census por lotes): sujeto + candidatas
    pedidos = [("S", calle, ciudad, zip_)] + [(str(i), f["PHY_ADDR1"], f["PHY_CITY"], str(int(f["PHY_ZIPCD"] or 0))) for i, f in enumerate(filas)]
    coords = geocodificar(pedidos)
    if "S" in coords:
        sujeto["lat"], sujeto["lng"] = coords["S"]
    # Radio: el pedido; si hay menos de 8 ventas dentro, se amplía a --radio-max y se dice
    dists = {}
    for i, f in enumerate(filas):
        c = coords.get(str(i))
        dists[i] = haversine(sujeto["lat"], sujeto["lng"], *c) if (c and "lat" in sujeto) else None
    radio_usado = a.radio
    if sum(1 for d in dists.values() if d is not None and d <= a.radio) < 8:
        radio_usado = a.radio_max
    fuera_radio = sum(1 for d in dists.values() if d is not None and d > radio_usado)
    sin_coord = sum(1 for d in dists.values() if d is None)
    cerradas = []
    for i, f in enumerate(filas):
        c = coords.get(str(i))
        d = dists[i]
        if d is not None and d > radio_usado:
            continue
        sf_c = f.get("TOT_LVG_AREA")
        brecha = (f["EFF_YR_BLT"] - f["ACT_YR_BLT"]) if (f.get("EFF_YR_BLT") and f.get("ACT_YR_BLT")) else None
        cerradas.append({
            "id": len(cerradas) + 1, "direccion": f"{f['PHY_ADDR1'].title()}, {str(f['PHY_CITY']).title()}", "calle": f["PHY_ADDR1"],
            "ciudad": str(f["PHY_CITY"]).title(), "zip": str(int(f["PHY_ZIPCD"] or 0)), "folio": f["PARCEL_ID"],
            "lat": c[0] if c else None, "lng": c[1] if c else None, "dist": round(d, 2) if d is not None else None,
            "precio": f["SALE_PRC"], "fecha": f"{int(f['SALE_YR'])}-{str(f['SALE_MO']).zfill(2)}-15",
            "sqft": sf_c, "anio": f.get("ACT_YR_BLT"), "anio_efectivo": f.get("EFF_YR_BLT"), "lote_sqft": f.get("LND_SQFOOT"),
            "ppsf": round(f["SALE_PRC"] / sf_c, 1) if sf_c else None, "barrio": (f.get("NBRHD_CD") or "").strip(), "area": (f.get("S_LEGAL") or "").strip(),
            "ren": senal_rehab(brecha, f.get("NCONST_VAL")), "ren_fuente": "catastro: año efectivo vs real" if brecha is not None else "sin dato",
            "beds": None, "baths": None, "dom": None, "fuente": f"rol estatal FL {meta['anada']}"})
    # Orden por cercanía y similitud de superficie; las 25 mejores pasan a la verificación
    n_en_radio = len(cerradas)
    cerradas.sort(key=lambda c: ((c["dist"] if c["dist"] is not None else 9), abs((c["sqft"] or sf or 0) - (sf or 0))))
    cerradas = cerradas[:40]
    for i, c in enumerate(cerradas, 1):
        c["id"] = i

    # A quiénes verificar primero: los que pueden ser renovados (señal del catastro) y están cerca; luego los más cercanos.
    # Esos mueven el ARV; verificar solo "los más cercanos" dejaba el valor sin evidencia.
    prioridad = sorted(cerradas, key=lambda c: (0 if c["ren"] == "likely" and (c["dist"] or 9) <= 1.0 else 1, c["dist"] if c["dist"] is not None else 9))
    verificar = [c["id"] for c in prioridad[:12]]
    ultima = max((c["fecha"] for c in cerradas), default=None)
    salida = {
        "generado": __import__("datetime").date.today().isoformat(),
        "lead": {"precio": precio, "arv_declarado": arv, "tipo": lead.get("tipo"), "id": lead.get("id")},
        "sujeto": sujeto,
        "cerradas": cerradas,
        "verificar": verificar,
        "cobertura": {"fuente": f"rol estatal FL {meta['anada']} (corte {corte})", "candidatas": len(filas), "dentro_del_radio": n_en_radio,
                      "radio_millas": radio_usado, "radio_pedido": a.radio, "meses": meses_usados, "ultima_venta": ultima,
                      "fuera_del_radio": fuera_radio, "sin_coordenadas": sin_coord,
                      "geocodificadas": sum(1 for p in pedidos if str(p[0]) in coords), "de": len(pedidos),
                      "aviso": "El rol estatal no incluye ventas posteriores a su fecha de corte ni listados activos o pendientes."},
        "intentos": intentos}
    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, "universo.json"), "w", encoding="utf-8") as fh:
        json.dump(salida, fh, ensure_ascii=False, indent=1)
    print(json.dumps({"sujeto": {k: sujeto.get(k) for k in ("direccion", "sqft", "anio", "anio_efectivo", "lat", "lng")},
                      "cerradas": len(cerradas), "ultima_venta": ultima, "geocodificadas": salida["cobertura"]["geocodificadas"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
