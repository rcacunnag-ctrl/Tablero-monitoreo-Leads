#!/usr/bin/env python3
"""Tier 1-V2, paso 2: de universo.json (+ verif.json opcional) a analisis.json.

Hace todo lo determinista: fusiona la verificación hecha con Claude, clasifica Cat. 1/2/3
(clasificar_comparables.py), calcula bandas, ARV, modelo de flip, MAO, sensibilidad, matriz de riesgos y la decisión.
Los números salen de aquí; Claude solo redacta (narrativa.json) y verifica condiciones.

    python analizar.py <carpeta>      # lee universo.json y, si existe, verif.json
"""
import json
import os
import statistics as st
import subprocess
import sys
from datetime import date, datetime

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)
from universo import geocodificar, haversine  # noqa: E402

CRITERIOS = os.path.join(os.path.expanduser("~"), "OneDrive", "Documents", "4. Ejecucion de procesos", "1. Underwriting",
                         "0. Base formatos", "Criterios Estandar Comparables.xlsx")
REN_OK = ("yes", "new", "partial")


def carga(ruta, defecto=None):
    try:
        with open(ruta, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return defecto


def mediana(xs):
    xs = [x for x in xs if x]
    return st.median(xs) if xs else None


def redondea(v, paso=1000):
    return int(round(v / paso) * paso) if v is not None else None


def dias_entre(f1, f2):
    return (datetime.fromisoformat(f1) - datetime.fromisoformat(f2)).days


def modelo(compra, reno, arv, u, meses=None, objetivo=None):
    m = meses or u["meses_tenencia"]
    t = objetivo if objetivo is not None else u["ganancia_objetivo_usd"]
    cierre = compra * u["cierre_compra_pct"]
    cp = u["tenencia_pct_anual"] / 12  # impuesto y seguro crecen con el precio; el resto es fijo
    tenencia = m * (u["tenencia_fija_mensual_usd"] + compra * cp)
    costo = compra + cierre + reno + tenencia
    venta = arv * u["venta_pct"]
    ganancia = arv - venta - costo
    base = arv * (1 - u["venta_pct"]) - reno - m * u["tenencia_fija_mensual_usd"]
    return {"compra": compra, "cierre": cierre, "reno": reno, "tenencia": tenencia, "costo": costo, "arv": arv, "venta": venta,
            "ganancia": ganancia, "roi": ganancia / costo if costo else None,
            "mao": (base - t) / (1 + u["cierre_compra_pct"] + m * cp), "equilibrio": base / (1 + u["cierre_compra_pct"] + m * cp)}


def main():
    carpeta = sys.argv[1]
    u = carga(os.path.join(AQUI, "..", "assets", "umbrales.json"))
    uni = carga(os.path.join(carpeta, "universo.json"))
    ver = carga(os.path.join(carpeta, "verif.json"), {})
    suj, lead = uni["sujeto"], uni["lead"]
    hoy = date.today().isoformat()

    # --- fusiona la verificación de Claude (condición, habitaciones, DOM) ---
    vs = ver.get("sujeto", {})
    for k in ("beds", "baths"):
        if vs.get(k):
            suj[k] = vs[k]
    cerradas = uni["cerradas"]
    for c in cerradas:
        v = (ver.get("cerradas") or {}).get(str(c["id"]))
        if v:
            for k in ("ren", "beds", "baths", "dom", "nota", "fuente_verif"):
                if v.get(k) is not None:
                    c[k if k != "fuente_verif" else "fuente"] = v[k]
            c["verificada"] = True
    extras = ver.get("ventas_extra") or []
    if extras:  # ventas posteriores al corte del rol que Claude encontró; se geocodifican igual
        g = geocodificar([(f"E{i}", e["direccion"].split(",")[0], suj["ciudad"], suj["zip"]) for i, e in enumerate(extras) if not e.get("lat")])
        for i, e in enumerate(extras):
            lat, lng = (e.get("lat"), e.get("lng")) if e.get("lat") else g.get(f"E{i}", (None, None))
            d = haversine(suj["lat"], suj["lng"], lat, lng) if lat and "lat" in suj else e.get("dist")
            cerradas.append({"id": len(cerradas) + 1, "direccion": e["direccion"], "ciudad": suj["ciudad"], "zip": suj["zip"], "lat": lat, "lng": lng,
                             "dist": round(d, 2) if d is not None else None, "precio": e["precio"], "fecha": e["fecha"], "sqft": e.get("sqft"),
                             "anio": e.get("anio"), "ppsf": round(e["precio"] / e["sqft"], 1) if e.get("sqft") else None, "beds": e.get("beds"),
                             "baths": e.get("baths"), "dom": e.get("dom"), "ren": e.get("ren", "likely"), "nota": e.get("nota", ""),
                             "fuente": e.get("fuente", "web"), "area": "", "verificada": True})
    cerradas = [c for c in cerradas if c["precio"]]

    # --- clasificación Cat. 1/2/3 con el script compartido ---
    data = {"asof": hoy, "subject": {"address": suj["direccion"], "short_name": suj["calle"], "lat": suj.get("lat"), "lng": suj.get("lng"), "sqft": suj["sqft"],
                                     "beds": suj.get("beds"), "baths": suj.get("baths"), "year": suj.get("anio"), "area": suj.get("legal"), "ren": "no",
                                     "city": suj["ciudad"], "zip": suj["zip"], "type": "SFR"},
            "closed": [{"id": c["id"], "address": c["direccion"], "lat": c["lat"], "lng": c["lng"], "beds": c["beds"], "baths": c["baths"], "sqft": c["sqft"],
                        "year": c["anio"], "price": c["precio"], "date": c["fecha"], "dom": c["dom"], "ren": c["ren"], "area": c.get("area", ""),
                        "city": c["ciudad"], "zip": c["zip"], "market_sale": True, "waterfront": False, "type": "SFR"} for c in cerradas]}
    dj = os.path.join(carpeta, "data.json")
    with open(dj, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False)
    cmd = [sys.executable, os.path.join(AQUI, "clasificar_comparables.py"), "--tier1", dj, "--flujo", "propiedades", "--lang", "en", "--escribir-cat",
           "--salida", os.path.join(carpeta, "Comp_Classification.xlsx")]
    if os.path.exists(CRITERIOS):
        cmd += ["--criterios", CRITERIOS]
    subprocess.run(cmd, check=True, capture_output=True)
    cats = {c["id"]: c for c in carga(dj)["closed"]}
    for c in cerradas:
        c["cat"] = cats[c["id"]].get("cat", 3)
        c["cat_why"] = cats[c["id"]].get("cat_why", "")

    # --- bandas y ARV ---
    # Solo cuentan comparables geocodificados (dentro del radio) y de un producto parecido: ±25 % de superficie y
    # construidos dentro de ±30 años del sujeto. Una obra nueva de 2021 no es comparable con una casa de 1957.
    sf = suj["sqft"]
    anio_s = suj.get("anio") or 0
    cerca = [c for c in cerradas if c.get("dist") is not None and c.get("ppsf") and (not anio_s or not c.get("anio") or abs(c["anio"] - anio_s) <= 30)
             and abs(c["sqft"] - sf) / sf <= 0.25]
    reno_c = [c for c in cerca if c["ren"] in REN_OK and c["cat"] in (1, 2)]
    reno_v = [c for c in cerca if c["ren"] in REN_OK and c.get("verificada")]  # renovados verificados, de cualquier categoría
    asis = [c for c in cerca if c["ren"] == "no"]
    med_ren = mediana([c["ppsf"] for c in reno_c])
    med_asis = mediana([c["ppsf"] for c in asis])
    techo = max((c["precio"] for c in (reno_c or reno_v)), default=None)
    minimo = u["comps_renovados_minimos"]
    if len(reno_c) >= minimo:
        arv_modelo = med_ren * sf
        confianza = "high" if len(reno_c) >= max(3, minimo) else "medium"
        nota_arv = f"Median renovated/improved $/sf of {len(reno_c)} Cat. 1-2 sales × {sf:,.0f} sf"
    elif len(reno_v) >= minimo:
        arv_modelo = mediana([c["ppsf"] for c in reno_v]) * sf
        confianza = "medium" if len(reno_v) >= 3 else "low"
        nota_arv = f"Median $/sf of {len(reno_v)} verified renovated sales that miss Cat. 1-2 on size, bed/bath or distance × {sf:,.0f} sf"
    else:
        base_med = mediana([c["ppsf"] for c in cerca])
        arv_modelo = (base_med * sf * 0.95) if base_med else None
        confianza = "low"
        nota_arv = (f"UNVERIFIED: no renovated Cat. 1-2 sale was verified, so this is the median $/sf of the {len(cerca)} nearest similar sales × {sf:,.0f} sf, less 5% "
                    "(it mixes renovated and as-is houses and is not a renovated value)")
    med_todas = mediana([c["ppsf"] for c in cerca])
    arv_decl = lead.get("arv_declarado")
    arv = redondea(arv_modelo, 5000) if arv_modelo else None
    if arv and arv_decl and arv_decl < arv:
        arv, nota_arv = redondea(arv_decl, 5000), nota_arv + f"; capped at the wholesaler's claim ${arv_decl:,.0f}"

    # --- modelo de flip ---
    cond = vs.get("condicion") or "unknown"
    # El costo por pie cuadrado sube con el nivel de la casa: ARV/sf de $300 es el nivel de referencia, con tope del factor
    factor = min(u["rehab_factor_max"], max(1.0, (arv / sf) / u["rehab_factor_precio_ref_ppsf"])) if arv else 1.0
    reno = max(u["rehab_minimo_usd"], redondea((vs.get("reno_usd") or u["rehab_usd_por_sf"][cond] * sf * factor), 1000))
    precio = lead.get("precio")
    base = modelo(precio, reno, arv, u) if (precio and arv) else None
    mao = redondea(base["mao"], 1000) if base else None
    brecha = ((precio - base["mao"]) / precio) if base else None

    # sensibilidad
    filas = []
    if base:
        pasos = sorted({redondea(precio, 1000), *[redondea(precio * (1 - p), 1000) for p in (0.05, 0.10, 0.15)], mao}, reverse=True)
        for p in pasos:
            filas.append({"compra": p, "completo": modelo(p, reno, arv, u)["ganancia"], "liviano": modelo(p, reno * u["rehab_liviano_factor"], arv, u)["ganancia"],
                          "arv_alto": modelo(p, reno, redondea(arv * u["arv_alto_factor"], 5000), u)["ganancia"],
                          "nota": "Price offered." if p == redondea(precio, 1000) else "Maximum offer for the target profit." if p == mao else ""})

    # --- decisión ---
    T = u["ganancia_objetivo_usd"]
    P = base["ganancia"] if base else None
    if base is None:
        veredicto, score = "Do not advance", 0
        razon = "No price or no supportable ARV: no decision can be computed."
    elif P >= T and confianza != "low":
        veredicto, score = "Advance to Tier 2", int(70 + min(30, 30 * (P - T) / T))
    elif (P >= u["condiciones_ganancia_min_pct_objetivo"] * T and confianza != "low") or (P >= T and confianza == "low") or (P >= 0 and brecha <= u["condiciones_brecha_max"]):
        veredicto = "Advance with conditions"
        score = int(45 + 24 * max(0, min(1, (P - u["condiciones_ganancia_min_pct_objetivo"] * T) / (0.6 * T))))
    else:
        veredicto, score = "Do not advance", int(44 * max(0, 1 - max(0, brecha) / 0.5))
    negociable = bool(base) and veredicto != "Advance to Tier 2" and brecha is not None and 0 < brecha <= u["negociable_brecha_max"]

    # --- riesgos deterministas (Claude agrega los propios en narrativa.json) ---
    riesgos = [{"t": "Rehab runs over budget", "p": "High" if cond in ("full", "unknown") else "Medium", "i": "High",
                "expo": f"${reno * 0.2:,.0f} to ${reno * 0.5:,.0f} over ${reno:,.0f}",
                "q": "Walk the property with your trades before the deposit goes hard; budget is " + ("ASSUMED from a full-rehab $/sf." if cond in ("full", "unknown") else "ASSUMED from a lighter-scope $/sf.")}]
    if base and brecha > 0:
        riesgos.append({"t": f"Paying ${precio:,.0f} when the deal needs ${mao:,.0f}", "p": "High", "i": "High", "expo": "The whole margin",
                        "q": f"Offer at ${mao:,.0f} with the walk-through as the reason, or pass."})
    if len(reno_c) < u["comps_renovados_minimos"]:
        riesgos.append({"t": "Few renovated comparables support the resale price", "p": "High", "i": "Medium", "expo": "ARV could be $15,000 to $40,000 lower",
                        "q": "Treat the ARV as a range until renovated sales are verified (listing remarks and photos)."})
    ultima = uni["cobertura"].get("ultima_venta")
    if ultima and dias_entre(hoy, ultima[:10]) > u["rol_antiguedad_aviso_dias"]:
        riesgos.append({"t": "Recent sales may be missing", "p": "Medium", "i": "Medium", "expo": "Market may have moved since the last record",
                        "q": f"The state roll ends {ultima[:7]}; pull the last 5 months from the MLS before offering."})
    if arv_decl and arv and arv_decl > arv * 1.1:
        riesgos.append({"t": "Claimed ARV is above the supported value", "p": "High", "i": "Medium", "expo": f"${arv_decl - arv:,.0f} over the model",
                        "q": "Underwrite on the modeled ARV, not the claim."})

    uso = {"candidatas": uni["cobertura"]["candidatas"], "en_radio_total": uni["cobertura"]["dentro_del_radio"], "dentro_del_radio": len(cerradas), "usadas_para_arv": len(cerca),
           "fuera_por_tamano_o_anio": sum(1 for c in cerradas if c.get("dist") is not None and c not in cerca),
           "fuera_del_radio": uni["cobertura"].get("fuera_del_radio", 0), "sin_coordenadas": uni["cobertura"].get("sin_coordenadas", 0),
           "verificadas": sum(1 for c in cerradas if c.get("verificada")), "renovadas_verificadas": len(reno_v)}
    salida = {"generado": hoy, "uso_comps": uso, "sujeto": suj, "lead": lead, "cobertura": uni["cobertura"], "verificacion": vs, "cerradas": cerradas,
              "activas": ver.get("activas") or [], "fuentes_extra": ver.get("fuentes") or [],
              "bandas": {"mediana_renovada_ppsf": med_ren, "mediana_asis_ppsf": med_asis, "techo": techo,
                         "renovadas": len(reno_c), "asis": len(asis), "cat": {n: sum(1 for c in cerradas if c["cat"] == n) for n in (1, 2, 3)}},
              "arv": {"valor": arv, "modelado": redondea(arv_modelo, 1000) if arv_modelo else None, "declarado": arv_decl, "confianza": confianza, "nota": nota_arv},
              "modelo": {"compra": precio, "reno": reno, "reno_condicion": cond, "meses": u["meses_tenencia"], "base": base, "mao": mao, "brecha": brecha,
                         "u": u, "filas": filas},
              "decision": {"veredicto": veredicto, "score": score, "negociable": negociable, "oferta_sugerida": mao if negociable else None, "provisional": confianza == "low"},
              "riesgos": riesgos}
    with open(os.path.join(carpeta, "analisis.json"), "w", encoding="utf-8") as fh:
        json.dump(salida, fh, ensure_ascii=False, indent=1)
    print(json.dumps({"veredicto": veredicto, "score": score, "arv": arv, "mao": mao, "ganancia": round(P) if P is not None else None,
                      "renovadas_cat12": len(reno_c), "confianza": confianza, "negociable": negociable}, ensure_ascii=False))


if __name__ == "__main__":
    main()
