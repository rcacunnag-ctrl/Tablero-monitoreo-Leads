#!/usr/bin/env python3
"""
clasificar_comparables.py - Clasifica cada comparable en Categoria 1, 2 o 3 y deja un Excel que explica por que.

Por que existe
--------------
Quien recibe un informe de comparables tiene que poder ver, comparable por comparable, que se comparo contra el
sujeto y por que quedo en Cat. 1, 2 o 3. Este script aplica las reglas de la hoja de categorias (base + adicionales
del usuario), criterio por criterio, y escribe un Excel autocontenido: Leyenda (que exige cada categoria),
Clasificacion (matriz comparable x criterio con valor y resultado) y Detalle (una fila por comparable y criterio).

Reglas de categoria
    Cat. 1 = cumple todos los criterios de Cat. 1 (y los de Cat. 2 donde Cat. 1 no pide nada).
    Cat. 2 = no llega a Cat. 1 pero cumple todos los criterios de Cat. 2.
    Cat. 3 = referencia: no cumple Cat. 2. Se muestra, pero no sostiene el rango de valor.
    Dato faltante: si el criterio dice "bloquea", impide la categoria; si dice "no bloquea", no la impide y queda
    citado como "sin dato" en la explicacion.

Sintaxis de las reglas (columnas "Cat. 1 exige" y "Cat. 2 exige")
    -            no se exige            igual        mismo valor que el sujeto
    ±1           diferencia absoluta    ±10%         diferencia relativa al sujeto
    75%-128%     rango relativo         <=0.5 / >=3  limite absoluto del valor del comparable
    es si        valor fijo (no usar "=": Excel lo toma como formula)
    A o B        alternativas; cada una puede ser campo:regla (zip:igual)

Perfiles: propiedades | terrenos_A (ventas de terrenos) | terrenos_B (obra nueva). Cada perfil lee su hoja del
Excel de criterios (Categorias, Categorias_A, Categorias_B). Si no se pasa --criterios, usa los valores por
defecto de este script (iguales a los del Excel base) y lo dice en la Leyenda.

Uso
    # Fase 2 (entrada generica, ver formato abajo)
    python clasificar_comparables.py --entrada clasificacion_entrada.json --criterios "<Criterios ...xlsx>" \
        --salida "<lead>/Informes Tier 2/Clasificacion_Comparables_<slug>.xlsx"
    # Tier 1 (lee el data.json del skill y le devuelve cat y cat_why a cada comparable)
    python clasificar_comparables.py --tier1 data.json --flujo propiedades|terrenos [--criterios ...] \
        --salida "<lead>/Informes Tier 1/Clasificacion_Comparables_<slug>.xlsx" --escribir-cat

Entrada generica (JSON)
    {"lead": "...", "asof": "2026-10-05",
     "sets": [{"perfil": "propiedades", "nombre": "Comparables",
               "sujeto": {"direccion": "...", "lat": .., "lng": .., ...},
               "comparables": [{"id": 1, "direccion": "...", ...}]}],
     "adicionales": [{"criterio": "Piscina", "campo": "piscina", "cat1": "igual", "cat2": "-",
                      "si_falta": "no bloquea", "nota": "pedido por el usuario", "perfil": "propiedades"}]}
    Campos por perfil: ver CAMPOS abajo. distancia_mi, meses_venta, anios_obra, ciudad y zip se derivan si faltan
    (lat/lng, fecha_venta, anio_obra, direccion "calle, Ciudad, FL 33xxx").
"""

import argparse
import json
import math
import re
import sys
import unicodedata
from datetime import date
from pathlib import Path

CAMPOS = {
    "propiedades": "direccion ciudad zip subdivision lat lng distancia_mi estado_mercado tipo recamaras banos sqft anio "
                   "rehab frente_agua fecha_venta meses_venta venta_mercado",
    "terrenos_A": "direccion ciudad zip lat lng distancia_mi estado_mercado zonificacion zonificacion_equivalente area_terreno frente "
                  "frente_agua estado construido_despues fecha_venta meses_venta venta_calificada",
    "terrenos_B": "direccion ciudad zip lat lng distancia_mi zonificacion zonificacion_equivalente area_terreno "
                  "anio_obra anios_obra con_precio_salida tipologia",
}

# (criterio, campo, cat1, cat2, si_falta, nota) - deben coincidir con las hojas del Excel base
DEFAULTS = {
    "propiedades": [
        ("Estado de mercado", "estado_mercado", "es cerrada", "es cerrada o es pendiente o es activa", "bloquea",
         "solo una venta cerrada demuestra valor pagado; activa/pendiente = precio pedido; inactiva (retirada, "
         "expirada, cancelada) = referencia"),
        ("Tipo de propiedad", "tipo", "igual", "igual", "bloquea", "SFR con SFR, condo con condo"),
        ("Recámaras", "recamaras", "igual", "±1", "bloquea", ""),
        ("Baños", "banos", "igual", "±1", "bloquea", ""),
        ("Superficie bajo aire (sqft)", "sqft", "±10%", "75%-128%", "bloquea", "porcentaje sobre el área del sujeto"),
        ("Año de construcción", "anio", "±10", "±15", "no bloquea", ""),
        ("Subdivisión / zona", "subdivision", "igual o distancia_mi:<=0.5", "-", "no bloquea",
         "misma subdivisión, o a media milla o menos"),
        ("Ciudad / ZIP", "ciudad", "igual o zip:igual", "-", "no bloquea", ""),
        ("Distancia al sujeto (mi)", "distancia_mi", "-", "<=1", "bloquea", "Cat. 1 ya la acota con la zona"),
        ("Rehabilitada / con mejoras", "rehab", "es remodelado o es con mejoras", "-", "bloquea",
         "criterio principal: el mercado objetivo son propiedades rehabilitadas o con mejoras (techo, ventanas de "
         "impacto, cocina, baños, con permiso o evidencia); 'sin verificar' = sin dato, no llega a Cat. 1"),
        ("Meses desde la venta", "meses_venta", "<=6", "<=12", "no bloquea", "listados activos: sin dato"),
        ("Venta de mercado", "venta_mercado", "es si", "es si", "no bloquea", "no: descalificada, short sale, familiar"),
        ("Frente de agua", "frente_agua", "igual", "igual", "no bloquea", "waterfront contra interior no se mezcla"),
    ],
    "terrenos_A": [
        ("Estado de mercado", "estado_mercado", "es cerrada", "es cerrada o es pendiente o es activa", "bloquea",
         "solo una venta cerrada demuestra valor pagado; activa/pendiente = precio pedido; inactiva (retirada, "
         "expirada, cancelada) = referencia"),
        ("Zonificación", "zonificacion", "igual", "igual o zonificacion_equivalente:es si", "bloquea",
         "equivalente = misma densidad y usos"),
        ("Área del terreno (pie²)", "area_terreno", "±15%", "60%-170%", "bloquea", ""),
        ("Frente (pies)", "frente", "±15%", "±25%", "no bloquea", ""),
        ("Frente de agua", "frente_agua", "igual", "igual", "no bloquea", "waterfront contra interior no se mezcla"),
        ("Construido después de la venta", "construido_despues", "es si", "-", "bloquea",
         "criterio principal: el terreno se vendió y luego tuvo obra nueva (año de construcción o permiso posterior "
         "a la venta)"),
        ("Estado (vacante / teardown)", "estado", "igual", "-", "no bloquea", "'sin verificar' = sin dato"),
        ("Ciudad / ZIP", "ciudad", "igual o zip:igual", "-", "no bloquea", ""),
        ("Distancia al sujeto (mi)", "distancia_mi", "<=0.5", "<=1", "bloquea", ""),
        ("Meses desde la venta", "meses_venta", "<=12", "<=24", "no bloquea", "listados activos: sin dato"),
        ("Venta calificada", "venta_calificada", "es si", "es si", "no bloquea", "QUAL_CD 01/02"),
    ],
    "terrenos_B": [
        ("Zonificación", "zonificacion", "igual", "igual o zonificacion_equivalente:es si", "bloquea", ""),
        ("Área del terreno (pie²)", "area_terreno", "±15%", "60%-170%", "bloquea", ""),
        ("Ciudad / ZIP", "ciudad", "igual o zip:igual", "-", "no bloquea", ""),
        ("Distancia al sujeto (mi)", "distancia_mi", "<=0.5", "<=1", "bloquea", ""),
        ("Años desde la obra", "anios_obra", "<=3", "<=5", "bloquea", ""),
        ("Con precio de salida", "con_precio_salida", "es si", "-", "no bloquea",
         "sin venta = evidencia de tipología, no de precio"),
    ],
}
# sinonimos de estado de mercado (portales, rol, Fase 3) -> valor canonico de las reglas
ESTADOS = {"cerrada": ("cerrad", "closed", "sold", "vendid", "recently sold"),
           "pendiente": ("pendient", "pending", "contingent", "under contract", "bajo contrato"),
           "activa": ("activ", "for sale", "en venta", "coming soon", "listed"),
           "inactiva": ("inactiv", "withdrawn", "expired", "cancel", "off market", "off-market", "fuera de mercado",
                        "retirad", "expirad", "sin estado")}
# Fuente esperada de cada dato (se imprime en la Leyenda; la fuente real de cada valor viaja en _fuentes)
FUENTE_DEF = {
    "estado_mercado": "Zillow / Homes.com / rol estatal (venta registrada)", "tipo": "Appraiser (uso DOR)",
    "recamaras": "Appraiser (BCPA/PAPA); si difiere del MLS manda el appraiser", "banos": "Appraiser (BCPA/PAPA)",
    "sqft": "Appraiser: superficie bajo aire", "anio": "Appraiser / rol estatal: año real de construcción",
    "subdivision": "Appraiser: subdivisión", "ciudad": "Dirección completa (Zillow / appraiser)",
    "zip": "Dirección completa", "distancia_mi": "Calculada: haversine entre coordenadas (geocodificación)",
    "rehab": "rehab_estado + evidencia: remarks (Zillow/Homes.com), año efectivo y NCONST_VAL del rol, permisos, fotos, salto de precio",
    "frente_agua": "Appraiser / remarks / mapa (waterfront, canal, intracoastal)",
    "fecha_venta": "Rol estatal / appraiser / Zillow (historial de ventas)", "meses_venta": "Calculado: (fecha de corte - fecha de venta) / 30.44",
    "venta_mercado": "Appraiser (Qualified / Disqualified) y rol (QUAL_CD 01/02)",
    "zonificacion": "Appraiser / municipio: distrito de zonificación", "zonificacion_equivalente": "Fase 2: misma densidad y usos que el distrito del sujeto",
    "area_terreno": "Appraiser / rol: LND_SQFOOT", "frente": "Appraiser / polígono de la parcela",
    "estado": "Uso DOR y VI_CD de la venta, remarks, año de construcción posterior, permiso de demolición",
    "construido_despues": "Rol estatal: ACT_YR_BLT posterior a la venta, NCONST_VAL > 0, permiso de obra",
    "venta_calificada": "Rol estatal QUAL_CD 01/02; appraiser 'Qualified'",
    "anio_obra": "Rol / appraiser: año real de construcción", "anios_obra": "Calculado: año de corte - año de la obra",
    "con_precio_salida": "Venta calificada o listado de la obra nueva", "tipologia": "Rol: DOR_UC y NO_RES_UNTS",
}
ETIQ = {"direccion": "Dirección", "folio": "Folio / PCN", "precio": "Precio", "precio_sf": "$/pie²",
        "lote": "Lote (pie²)", "piscina": "Piscina", "garage": "Garage", "zona_fema": "Zona FEMA",
        "dom": "Días en mercado", "extendido": "Comparable extendido", "score": "Score de similitud (Fase 2)",
        "agua": "Servicio de agua", "alcantarillado": "Alcantarillado / séptico", "lat": "Latitud", "lng": "Longitud",
        "nota": "Nota", "just_value": "Just value (appraiser)", "humedales": "Humedales",
        "que_se_construyo": "Qué se construyó después", "precio_sf_terreno": "$/pie² de terreno",
        "zip": "ZIP", "fecha_venta": "Fecha de venta", "ciudad": "Ciudad", "subdivision": "Subdivisión"}
HOJA = {"propiedades": "Categorias", "terrenos_A": "Categorias_A", "terrenos_B": "Categorias_B"}
SIN_DATO = {"", "-", "none", "null", "n/a", "na", "sin dato", "sin verificar", "no hay informacion", "unverified",
            "desconocido"}
SI = {"si", "yes", "true", "1", "y", "s"}
NO = {"no", "false", "0", "n"}
DEL_COMP = {"estado_mercado", "distancia_mi", "meses_venta", "anios_obra", "venta_mercado", "venta_calificada", "con_precio_salida",
            "zonificacion_equivalente"}
TXT3 = "No cumple Cat. 2: referencia, no sostiene el rango de valor"

# ---------- idioma de salida: es (Fase 2) | en (Tier 1, --lang en) ----------
LANG = "es"


def L(es, en):
    return en if LANG == "en" else es


CRIT_EN = {"Estado de mercado": "Market status", "Tipo de propiedad": "Property type", "Recámaras": "Bedrooms",
           "Baños": "Bathrooms", "Superficie bajo aire (sqft)": "Living area (sqft)", "Año de construcción": "Year built",
           "Subdivisión / zona": "Subdivision / area", "Ciudad / ZIP": "City / ZIP", "Distancia al sujeto (mi)": "Distance to subject (mi)",
           "Rehabilitada / con mejoras": "Renovated / improved", "Meses desde la venta": "Months since sale",
           "Venta de mercado": "Arm's-length sale", "Frente de agua": "Waterfront", "Zonificación": "Zoning",
           "Área del terreno (pie²)": "Land area (sf)", "Frente (pies)": "Frontage (ft)",
           "Construido después de la venta": "Built after the sale", "Estado (vacante / teardown)": "Status (vacant / teardown)",
           "Venta calificada": "Qualified sale", "Años desde la obra": "Years since construction",
           "Con precio de salida": "Has an exit price"}
NOTA_EN = {"solo una venta cerrada demuestra valor pagado; activa/pendiente = precio pedido; inactiva (retirada, "
           "expirada, cancelada) = referencia": "only a closed sale proves value paid; active/pending = asking price; "
           "inactive (withdrawn, expired, cancelled) = reference",
           "SFR con SFR, condo con condo": "SFR with SFR, condo with condo",
           "porcentaje sobre el área del sujeto": "percent of the subject's area",
           "misma subdivisión, o a media milla o menos": "same subdivision, or half a mile or less",
           "Cat. 1 ya la acota con la zona": "Cat. 1 already bounds it through the area",
           "criterio principal: el mercado objetivo son propiedades rehabilitadas o con mejoras (techo, ventanas de "
           "impacto, cocina, baños, con permiso o evidencia); 'sin verificar' = sin dato, no llega a Cat. 1":
           "primary criterion: the target market is renovated or improved homes (roof, impact windows, kitchen, baths, "
           "with permit or evidence); 'unverified' = no data, cannot reach Cat. 1",
           "listados activos: sin dato": "active listings: no data",
           "no: descalificada, short sale, familiar": "no: disqualified, short sale, related parties",
           "waterfront contra interior no se mezcla": "waterfront and interior never mix",
           "equivalente = misma densidad y usos": "equivalent = same density and uses",
           "criterio principal: el terreno se vendió y luego tuvo obra nueva (año de construcción o permiso posterior "
           "a la venta)": "primary criterion: the parcel sold and then got a new build (year built or permit after the sale)",
           "'sin verificar' = sin dato": "'unverified' = no data",
           "sin venta = evidencia de tipología, no de precio": "no sale = evidence of product type, not of price"}
FUENTE_EN = {
    "estado_mercado": "Zillow / Homes.com / state roll (recorded sale)", "tipo": "Appraiser (DOR use code)",
    "recamaras": "Appraiser (BCPA/PAPA); the appraiser wins over the MLS", "banos": "Appraiser (BCPA/PAPA)",
    "sqft": "Appraiser: living area", "anio": "Appraiser / state roll: actual year built",
    "subdivision": "Appraiser: subdivision", "ciudad": "Full address (Zillow / appraiser)",
    "zip": "Full address", "distancia_mi": "Computed: haversine between coordinates (geocoding)",
    "rehab": "ren flag + evidence: remarks (Zillow/Homes.com), roll effective year and NCONST_VAL, permits, photos, price jump",
    "frente_agua": "Appraiser / remarks / map (waterfront, canal, intracoastal)",
    "fecha_venta": "State roll / appraiser / Zillow (sale history)", "meses_venta": "Computed: (as-of date - sale date) / 30.44",
    "venta_mercado": "Appraiser (Qualified / Disqualified) and roll (QUAL_CD 01/02)",
    "zonificacion": "Appraiser / municipality: zoning district", "zonificacion_equivalente": "Same density and uses as the subject's district",
    "area_terreno": "Appraiser / roll: LND_SQFOOT", "frente": "Appraiser / parcel polygon",
    "estado": "DOR use and VI_CD of the sale, remarks, later year built, demolition permit",
    "construido_despues": "State roll: ACT_YR_BLT after the sale, NCONST_VAL > 0, building permit",
    "venta_calificada": "State roll QUAL_CD 01/02; appraiser 'Qualified'",
    "anio_obra": "Roll / appraiser: actual year built", "anios_obra": "Computed: as-of year - year built",
    "con_precio_salida": "Qualified sale or listing of the new build", "tipologia": "Roll: DOR_UC and NO_RES_UNTS"}
ETIQ_EN = {"direccion": "Address", "folio": "Folio / PCN", "precio": "Price", "precio_sf": "$/sf", "lote": "Lot (sf)",
           "piscina": "Pool", "garage": "Garage", "zona_fema": "FEMA zone", "dom": "Days on market",
           "extendido": "Extended-search comp", "score": "Similarity score", "agua": "Water service",
           "alcantarillado": "Sewer / septic", "lat": "Latitude", "lng": "Longitude", "nota": "Note",
           "just_value": "Just value (appraiser)", "humedales": "Wetlands", "que_se_construyo": "What was built after",
           "precio_sf_terreno": "Land $/sf", "zip": "ZIP", "fecha_venta": "Sale date", "ciudad": "City",
           "subdivision": "Subdivision"}
VAL_EN = {"cerrada": "closed", "pendiente": "pending", "activa": "active", "inactiva": "inactive",
          "remodelado": "renovated", "con mejoras": "improved", "vacante": "vacant", "sin verificar": "unverified",
          "si": "yes", "sí": "yes"}


FIELD_EN = {"estado_mercado": "market_status", "tipo": "property_type", "recamaras": "beds", "banos": "baths",
            "anio": "year_built", "ciudad": "city", "distancia_mi": "distance_mi", "frente_agua": "waterfront",
            "fecha_venta": "sale_date", "meses_venta": "months_since_sale", "venta_mercado": "arms_length_sale",
            "zonificacion": "zoning", "zonificacion_equivalente": "equivalent_zoning", "area_terreno": "land_sf",
            "frente": "frontage_ft", "estado": "parcel_status", "construido_despues": "built_after",
            "venta_calificada": "qualified_sale", "anio_obra": "year_built", "anios_obra": "years_since_built",
            "con_precio_salida": "has_exit_price", "tipologia": "product_type", "direccion": "address",
            "precio": "price", "precio_sf": "price_sf", "lote": "lot_sf", "piscina": "pool", "nota": "note",
            "subdivision": "subdivision", "rehab": "rehab", "agua": "water", "alcantarillado": "sewer",
            "zona_fema": "fema_zone", "extendido": "extended", "humedales": "wetlands", "que_se_construyo": "built_what",
            "precio_sf_terreno": "land_price_sf"}


def fld(k):
    """Nombre del campo como se muestra (en: nombre en ingles; la clave interna no cambia)."""
    return FIELD_EN.get(k, k) if LANG == "en" else k


def val(x):
    """Valor de texto en el idioma de salida (solo valores conocidos de las reglas)."""
    return VAL_EN.get(str(x).strip().lower(), x) if LANG == "en" and isinstance(x, str) else x


def etiq(k):
    return (ETIQ_EN if LANG == "en" else ETIQ).get(k)


# ---------- normalizacion ----------
def norm(v):
    if v is None:
        return None
    if isinstance(v, bool):
        return "si" if v else "no"
    if isinstance(v, (int, float)):
        return None if (isinstance(v, float) and math.isnan(v)) else v
    s = unicodedata.normalize("NFKD", str(v)).encode("ascii", "ignore").decode().strip().lower()
    s = re.sub(r"\s+", " ", s)
    if s in SIN_DATO:
        return None
    if s in SI:
        return "si"
    if s in NO:
        return "no"
    try:
        return float(s.replace(",", "").replace("$", ""))
    except ValueError:
        return s


def num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def fmt(v):
    if v is None:
        return L("sin dato", "no data")
    if isinstance(v, float):
        return f"{v:,.2f}".rstrip("0").rstrip(".") if abs(v) < 100 else f"{v:,.0f}"
    if isinstance(v, int) and not isinstance(v, bool):
        return f"{v:,}" if abs(v) >= 10000 else str(v)
    return str(val(v))


def mostrar(v):
    """Valor tal como vino de la fuente (para el auditor): sin normalizar texto ni agrupar miles en folios/ZIP."""
    if v is None or (isinstance(v, str) and not v.strip()):
        return L("sin dato", "no data")
    if isinstance(v, bool):
        return L("sí", "yes") if v else "no"
    if isinstance(v, float):
        return f"{v:.2f}".rstrip("0").rstrip(".")
    return str(val(v))


def haversine(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 3958.8 * 2 * math.asin(math.sqrt(h))


def parse_fecha(v):
    if not v:
        return None
    m = re.match(r"(\d{4})-(\d{1,2})-(\d{1,2})", str(v))
    if m:
        return date(*map(int, m.groups()))
    m = re.match(r"(\d{1,2})/(\d{1,2})/(\d{4})", str(v))
    return date(int(m.group(3)), int(m.group(1)), int(m.group(2))) if m else None


def derivar(d, sujeto, asof):
    """Completa campos derivables sin pisar los que ya vienen."""
    d = dict(d)
    m = re.search(r",\s*([^,]+?),\s*FL\s*(\d{5})", str(d.get("direccion", "")), re.I)
    if m:
        if not d.get("ciudad"):
            d["ciudad"] = m.group(1).strip()
        if not d.get("zip"):
            d["zip"] = m.group(2)
    if d.get("distancia_mi") is None and sujeto is not None:
        try:
            d["distancia_mi"] = round(haversine((float(sujeto["lat"]), float(sujeto["lng"])),
                                                (float(d["lat"]), float(d["lng"]))), 2)
        except (KeyError, TypeError, ValueError):
            pass
    em = norm(d.get("estado_mercado"))
    if isinstance(em, str):
        for clave, pal in ESTADOS.items():
            if any(em.startswith(x) for x in pal):
                d["estado_mercado"] = clave
                break
    f = parse_fecha(d.get("fecha_venta"))
    if f and asof and d.get("meses_venta") is None:
        d["meses_venta"] = round((asof - f).days / 30.44, 1)
    if d.get("anio_obra") and asof and d.get("anios_obra") is None:
        d["anios_obra"] = asof.year - int(d["anio_obra"])
    return d


# ---------- reglas ----------
def evaluar_alt(alt, campo, sujeto, comp):
    """Una alternativa de una regla. Devuelve (True/False/None, texto)."""
    alt = alt.strip()
    m = re.match(r"^([a-z_]+):(.+)$", alt)
    pre = ""
    if m:
        campo, alt = m.group(1), m.group(2).strip()
        pre = fld(campo) + " "
    cv, sv = norm(comp.get(campo)), norm(sujeto.get(campo))
    if alt.lower().startswith("es ") or alt.startswith("="):
        obj = norm(alt[1:] if alt.startswith("=") else alt[3:])
        return (None, f"{pre}{L('sin dato', 'no data')}") if cv is None else (cv == obj, f"{pre}= {fmt(cv)}")
    a = alt.replace("+-", "±").replace(" ", "").lower()
    if a.startswith(("<=", ">=", "<", ">")):
        op = re.match(r"(<=|>=|<|>)", a).group(1)
        lim = float(a[len(op):])
        if num(cv) is None:
            return None, f"{pre}{L('sin dato', 'no data')}"
        ok = {"<=": cv <= lim, ">=": cv >= lim, "<": cv < lim, ">": cv > lim}[op]
        return ok, f"{pre}{fmt(cv)}"
    if cv is None or sv is None:
        return None, f"{pre}{L('sin dato', 'no data')}" + (L(" (sujeto)", " (subject)") if sv is None and cv is not None else "")
    if a == "igual":
        return cv == sv, pre + (L("igual", "equal") if cv == sv else f"{fmt(cv)} vs {fmt(sv)}")
    if num(cv) is None or num(sv) is None:
        return None, f"{pre}{L('no numérico', 'not numeric')}"
    m = re.match(r"^(\d+(?:\.\d+)?)%-(\d+(?:\.\d+)?)%$", a)
    if m and sv:
        r = cv / sv * 100
        return float(m.group(1)) <= r <= float(m.group(2)), f"{pre}{r:.0f}% {L('del sujeto', 'of subject')}"
    m = re.match(r"^±(\d+(?:\.\d+)?)(%?)$", a)
    if m:
        lim, pct = float(m.group(1)), m.group(2) == "%"
        if pct:
            if not sv:
                return None, L("sujeto en cero", "subject is zero")
            d = (cv - sv) / sv * 100
            return abs(d) <= lim + 1e-9, f"{pre}{d:+.0f}%"
        d = cv - sv
        return abs(d) <= lim + 1e-9, f"{pre}{d:+g}"
    raise ValueError(f"Regla no reconocida: '{alt}'")


def evaluar(regla, campo, sujeto, comp):
    if regla is None or str(regla).strip() in ("", "-"):
        return "na", ""
    res = [evaluar_alt(x, campo, sujeto, comp) for x in re.split(r"\s+o\s+", str(regla).strip())]
    if any(r is True for r, _ in res):
        return True, next(t for r, t in res if r is True)
    if any(r is None for r, _ in res):
        return None, "; ".join(t for _, t in res)
    return False, "; ".join(t for _, t in res)


def legible(regla):
    if regla is None or str(regla).strip() in ("", "-"):
        return L("no se exige", "not required")
    out = []
    for a in re.split(r"\s+o\s+", str(regla).strip()):
        m = re.match(r"^([a-z_]+):(.+)$", a.strip())
        pre, a = (fld(m.group(1)) + " ", m.group(2).strip()) if m else ("", a.strip())
        a2 = a.replace("+-", "±")
        if a2 == "igual":
            t = L("igual al sujeto", "equal to subject")
        elif a2.lower().startswith("es ") or a2.startswith("="):
            t = f"= {val(a2[1:] if a2.startswith('=') else a2[3:])}"
        elif re.match(r"^\d.*%-.*%$", a2):
            t = L(f"entre {a2.replace('-', ' y ')} del sujeto", f"between {a2.replace('-', ' and ')} of subject")
        elif a2.startswith("±"):
            t = f"{a2} {L('del sujeto', 'of subject') if a2.endswith('%') else L('respecto al sujeto', 'vs subject')}"
        else:
            t = a2.replace("<=", "≤ ").replace(">=", "≥ ")
        out.append(pre + (L("igual al sujeto", "equal to subject") if t == "igual al sujeto" else t))
    return L(" o ", " or ").join(out)


# ---------- criterios ----------
def cargar_criterios(perfil, xlsx):
    filas = [dict(zip(("criterio", "campo", "cat1", "cat2", "si_falta", "nota"), f), origen="base",
                  fuente=FUENTE_DEF.get(f[1], "")) for f in DEFAULTS[perfil]]
    fuente = "valores por defecto de clasificar_comparables.py (no se pasó --criterios)"
    if xlsx:
        import openpyxl
        wb = openpyxl.load_workbook(xlsx, data_only=True)
        hoja = HOJA[perfil]
        if hoja not in wb.sheetnames:
            sys.exit(f"ERROR: el archivo de criterios no tiene la hoja '{hoja}'. No se suponen categorías.")
        ws = wb[hoja]
        enc = [norm(c.value) or "" for c in ws[1]]
        col = {k: next((i for i, h in enumerate(enc) if isinstance(h, str) and h.startswith(p)), None)
               for k, p in (("criterio", "criterio"), ("campo", "campo"), ("cat1", "cat. 1"), ("cat2", "cat. 2"),
                            ("si_falta", "si falta"), ("nota", "nota"), ("origen", "origen"),
                            ("fuente", "fuente"))}
        filas = []
        for r in ws.iter_rows(min_row=2, values_only=True):
            if not r or not r[col["criterio"]] or not r[col["campo"]]:
                continue
            g = lambda k, d="": (r[col[k]] if col[k] is not None and r[col[k]] is not None else d)
            filas.append({"criterio": str(g("criterio")), "campo": str(g("campo")).strip(), "cat1": str(g("cat1", "-")),
                          "cat2": str(g("cat2", "-")), "si_falta": str(g("si_falta", "no bloquea")),
                          "nota": str(g("nota")), "origen": str(g("origen", "base")) or "base",
                          "fuente": str(g("fuente")) or FUENTE_DEF.get(str(g("campo")).strip(), "")})
        fuente = f"{Path(xlsx).name}, hoja {hoja} (modificado {date.fromtimestamp(Path(xlsx).stat().st_mtime)})"
    if LANG == "en":
        for f in filas:
            f["fuente"] = FUENTE_EN.get(f["campo"], f["fuente"]) if f["fuente"] == FUENTE_DEF.get(f["campo"], "") else f["fuente"]
            f["criterio"], f["nota"] = CRIT_EN.get(f["criterio"], f["criterio"]), NOTA_EN.get(f["nota"], f["nota"])
            f["si_falta"] = {"bloquea": "blocks", "no bloquea": "does not block"}.get(f["si_falta"], f["si_falta"])
            f["origen"] = "base" if f["origen"] == "base" else f["origen"]
        fuente = fuente.replace("valores por defecto de clasificar_comparables.py (no se pasó --criterios)",
                                "clasificar_comparables.py defaults (no --criterios given)").replace(", hoja ", ", sheet ").replace(
                                "(modificado ", "(modified ")
    return filas, fuente


def clasificar(filas, sujeto, comp):
    det, falla1, falla2, sd1, sd2 = [], [], [], [], []
    for f in filas:
        r2, t2 = evaluar(f["cat2"], f["campo"], sujeto, comp)
        r1, t1 = evaluar(f["cat1"] if str(f["cat1"]).strip() not in ("", "-") else f["cat2"], f["campo"], sujeto, comp)
        bloquea = norm(f["si_falta"]) in ("bloquea", "blocks")
        for r, falla, sd, cat in ((r1, falla1, sd1, 1), (r2, falla2, sd2, 2)):
            if r is False:
                falla.append(f)
            elif r is None:
                (falla if bloquea else sd).append(f)
        if r1 == "na" and r2 == "na":
            res = "—"
        elif r1 is True and r2 in (True, "na"):
            res = "✓1"
        elif r2 is True or (r2 == "na" and r1 is False):
            res = "✓2"
        elif r2 is False:
            res = "✗"
        else:
            res = "s.d."
        det.append({"criterio": f["criterio"], "campo": f["campo"], "sujeto": sujeto.get(f["campo"]),
                    "comparable": comp.get(f["campo"]), "res": res, "cat1": r1, "cat2": r2, "dif": t1 or t2,
                    "bloquea": bloquea,
                    "regla1": legible(f["cat1"] if str(f["cat1"]).strip() not in ("", "-") else f["cat2"]),
                    "regla2": legible(f["cat2"]),
                    "fuente_c": (comp.get("_fuentes") or {}).get(f["campo"]) or f.get("fuente") or "",
                    "evid_c": (comp.get("_evidencias") or {}).get(f["campo"]) or "",
                    "fuente_s": (sujeto.get("_fuentes") or {}).get(f["campo"]) or f.get("fuente") or ""})
    cat = 1 if not falla1 else 2 if not falla2 else 3

    def motivo(f, cat_obj):
        d = next(x for x in det if x["criterio"] == f["criterio"])
        regla = f["cat1"] if cat_obj == 1 and str(f["cat1"]).strip() not in ("", "-") else f["cat2"]
        if (d["cat1"] if cat_obj == 1 else d["cat2"]) is None:
            return f"{f['criterio']}: {L('sin dato (bloquea)', 'no data (blocks)')}"
        return f"{f['criterio']} {d['dif']} (Cat. {cat_obj} {L('exige', 'requires')} {legible(regla)})"

    if cat == 1:
        why = L(f"Cat. 1: cumple los {len(filas)} criterios de Cat. 1", f"Cat. 1: meets all {len(filas)} Cat. 1 criteria")
    elif cat == 2:
        why = L("Cat. 2: no llega a Cat. 1 por ", "Cat. 2: misses Cat. 1 on ") + "; ".join(motivo(f, 1) for f in falla1)
    else:
        why = L("Cat. 3 (referencia): no cumple Cat. 2 por ", "Cat. 3 (reference): fails Cat. 2 on ") + "; ".join(motivo(f, 2) for f in falla2)
    sd = [f["criterio"] for f in (sd1 if cat == 1 else sd2 if cat == 2 else [])]
    if sd:
        why += L(". Sin dato, no bloquea: ", ". No data, does not block: ") + ", ".join(sd)
    return cat, why, det


# ---------- adaptadores Tier 1 ----------
REN = {"yes": "remodelado", "new": "remodelado", "partial": "con mejoras", "no": "as-is", "likely": None}
SEG = {"vacant": "vacante", "teardown": "teardown", "unverified": None}


def desde_tier1(data, flujo):
    s, sets = data["subject"], []
    if flujo == "propiedades":
        suj = {"direccion": s.get("address"), "lat": s.get("lat"), "lng": s.get("lng"), "tipo": s.get("type"),
               "recamaras": s.get("beds"), "banos": s.get("baths"), "sqft": s.get("sqft"), "anio": s.get("year"),
               "subdivision": s.get("area"), "ciudad": s.get("city"), "zip": s.get("zip"),
               "rehab": REN.get(s.get("ren"), s.get("ren")), "frente_agua": s.get("waterfront")}
        comps = [{"id": c.get("id", i + 1), "direccion": c.get("address"), "lat": c.get("lat"), "lng": c.get("lng"),
                  "distancia_mi": c.get("dist"), "tipo": c.get("type", s.get("type")), "recamaras": c.get("beds"),
                  "banos": c.get("baths"), "sqft": c.get("sqft"), "anio": c.get("year"), "subdivision": c.get("area"),
                  "ciudad": c.get("city"), "zip": c.get("zip"), "rehab": REN.get(c.get("ren"), c.get("ren")),
                  "fecha_venta": c.get("date"), "venta_mercado": c.get("market_sale"),
                  "estado_mercado": "cerrada", "frente_agua": c.get("waterfront"),
                  "precio": c.get("price"), "precio_sf": round(c["price"] / c["sqft"], 2) if c.get("price") and c.get("sqft") else None,
                  "dom": c.get("dom"), "lote": c.get("lot"), "piscina": c.get("pool"), "nota": c.get("note"),
                  "_evidencias": {"rehab": f"ren={c.get('ren')}: {c.get('note') or L('sin nota', 'no note')}"},
                  "_fuentes": {k: L("data.json del Tier 1 (fuentes en references/sources.md)",
                                    "Tier 1 data.json (sources in references/sources.md)") for k in ("rehab",)}}
                 for i, c in enumerate(data.get("closed", []))]
        sets.append({"perfil": "propiedades", "nombre": L("Ventas cerradas", "Closed sales"), "clave": "closed", "sujeto": suj,
                     "comparables": comps})
    else:
        base = {"direccion": s.get("address"), "lat": s.get("lat"), "lng": s.get("lng"), "zonificacion": s.get("zoning"),
                "area_terreno": s.get("lot_sf"), "ciudad": s.get("city"), "zip": s.get("zip")}
        sa = dict(base, frente=s.get("frontage_ft"), frente_agua=s.get("waterfront"), estado=SEG.get(s.get("status"),
                  "vacante" if s.get("status") == "vacant" else s.get("status")))
        ca = [{"id": c.get("id", i + 1), "direccion": c.get("address"), "lat": c.get("lat"), "lng": c.get("lng"),
               "distancia_mi": c.get("dist"), "zonificacion": c.get("zoning"),
               "zonificacion_equivalente": c.get("same_zoning"), "area_terreno": c.get("lot_sf"),
               "frente": c.get("frontage_ft"), "frente_agua": c.get("waterfront"), "estado": SEG.get(c.get("seg")),
               "fecha_venta": c.get("date"), "venta_calificada": c.get("qualified"), "estado_mercado": "cerrada",
               "construido_despues": (bool(c.get("built_after")) if "built_after" in c else None),
               "precio": c.get("price"), "nota": c.get("note"),
               "_evidencias": {"construido_despues": str(c.get("built_after") or L("sin obra registrada", "no build recorded")),
                               "estado": c.get("note") or ""}}
              for i, c in enumerate(data.get("land_sales", []))]
        cb = [{"id": c.get("id", i + 1), "direccion": c.get("address"), "lat": c.get("lat"), "lng": c.get("lng"),
               "distancia_mi": c.get("dist"), "zonificacion": c.get("zoning"),
               "zonificacion_equivalente": c.get("same_zoning"), "area_terreno": c.get("lot_sf"),
               "anio_obra": c.get("year"), "tipologia": c.get("type"),
               "con_precio_salida": bool(c.get("price")) and c.get("status") in ("sold", None)}
              for i, c in enumerate(data.get("new_builds", []))]
        sets.append({"perfil": "terrenos_A", "nombre": L("Set A - ventas de terrenos", "Set A - land sales"), "clave": "land_sales",
                     "sujeto": sa, "comparables": ca})
        if cb:
            sets.append({"perfil": "terrenos_B", "nombre": L("Set B - obra nueva", "Set B - new builds"), "clave": "new_builds",
                         "sujeto": dict(base), "comparables": cb})
    return {"lead": s.get("address"), "asof": data.get("asof"), "sets": sets, "adicionales": []}


# ---------- salida Excel ----------
def escribir_xlsx(ruta, lead, asof, resultados, traza=None):
    import openpyxl
    from openpyxl.comments import Comment
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.utils import get_column_letter
    wb = openpyxl.Workbook()
    H = Font(bold=True, color="FFFFFF")
    HF = PatternFill("solid", fgColor="1F3864")
    CF = {1: "C6EFCE", 2: "FFEB9C", 3: "D9D9D9"}
    RF = {"✓1": "C6EFCE", "✓2": "FFEB9C", "✗": "F4CCCC", "s.d.": "EDEDED", "—": "FFFFFF"}
    th = Side(style="thin", color="BFBFBF")
    B = Border(left=th, right=th, top=th, bottom=th)
    W = Alignment(wrap_text=True, vertical="top")

    def head(ws, row, vals):
        for j, v in enumerate(vals, 1):
            c = ws.cell(row, j, v)
            c.font, c.fill, c.alignment, c.border = H, HF, W, B

    ws = wb.active
    ws.title = L("Leyenda", "Legend")
    ws["A1"] = L("Clasificación de comparables — qué se comparó y qué exige cada categoría",
                 "Comparable classification — what was compared and what each category requires")
    ws["A1"].font = Font(bold=True, size=14)
    ws["A2"] = f"{L('Sujeto', 'Subject')}: {lead}"
    ws["A3"] = f"{L('Fecha de corte', 'As-of date')}: {asof}"
    ws["A4"] = L("Cat. 1 = comparable directo: cumple todo lo de la columna Cat. 1 (y Cat. 2 donde Cat. 1 no pide nada). "
                 "Cat. 2 = comparable secundario: no llega a Cat. 1 pero cumple todo lo de Cat. 2. "
                 "Cat. 3 = referencia: no cumple Cat. 2; se muestra, pero no sostiene el rango de valor.",
                 "Cat. 1 = direct comp: meets everything in the Cat. 1 column (and Cat. 2 where Cat. 1 asks nothing). "
                 "Cat. 2 = secondary comp: misses Cat. 1 but meets everything in Cat. 2. "
                 "Cat. 3 = reference: fails Cat. 2; shown, but it does not support the value range.")
    ws["A5"] = L("Dato faltante: 'bloquea' impide la categoría; 'no bloquea' no la impide y se cita como sin dato. "
                 "Resultado por criterio: ✓1 cumple Cat. 1 · ✓2 cumple Cat. 2 · ✗ no cumple Cat. 2 · s.d. sin dato · — no se exige.",
                 "Missing data: 'blocks' denies the category; 'does not block' allows it and is cited as no data. "
                 "Result per criterion: ✓1 meets Cat. 1 · ✓2 meets Cat. 2 · ✗ fails Cat. 2 · n.d. no data · — not required.")
    for c in ("A4", "A5"):
        ws[c].alignment = W
        ws.merge_cells(f"{c}:I{c[1:]}")
        ws.row_dimensions[int(c[1:])].height = 45
    r = 7
    for res in resultados:
        ws.cell(r, 1, f"{res['nombre']} — {L('perfil', 'profile')} {res['perfil']} — {L('criterios', 'criteria')}: {res['fuente']}").font = Font(bold=True)
        r += 1
        head(ws, r, L(["Criterio", "Campo", "Valor del sujeto", "Cat. 1 exige", "Cat. 2 exige", "Cat. 3",
                       "Si falta el dato", "Origen", "Nota", "Fuente del dato"],
                      ["Criterion", "Field", "Subject value", "Cat. 1 requires", "Cat. 2 requires", "Cat. 3",
                       "If data is missing", "Origin", "Note", "Data source"]))
        for f in res["filas"]:
            r += 1
            vals = [f["criterio"], fld(f["campo"]), L("no aplica (se mide en el comparable)", "n/a (measured on the comparable)") if f["campo"] in DEL_COMP
                    else mostrar((res["sujeto"].get(f["campo"]))), legible(f["cat1"] if str(f["cat1"]).strip() not in ("", "-") else f["cat2"]),
                    legible(f["cat2"]), L(TXT3, "Fails Cat. 2: reference only, does not support the value range"),
                    f["si_falta"], L(f["origen"], {"adicional (esta corrida)": "additional (this run)"}.get(f["origen"], f["origen"])),
                    f["nota"], f.get("fuente", "")]
            for j, v in enumerate(vals, 1):
                c = ws.cell(r, j, v)
                c.alignment, c.border = W, B
                if f["origen"] != "base":
                    c.fill = PatternFill("solid", fgColor="DDEBF7")
        r += 1
        cuenta = {k: sum(1 for x in res["comps"] if x["cat"] == k) for k in (1, 2, 3)}
        ws.cell(r, 1, f"{L('Resultado', 'Result')}: Cat. 1 = {cuenta[1]} · Cat. 2 = {cuenta[2]} · Cat. 3 = {cuenta[3]} "
                      f"({L('de', 'of')} {len(res['comps'])})").font = Font(italic=True)
        r += 2
    for j, w in enumerate((28, 18, 18, 30, 30, 26, 14, 22, 40, 45), 1):
        ws.column_dimensions[get_column_letter(j)].width = w

    for res in resultados:
        nom = L("Clasificacion", "Classification") if len(resultados) == 1 else (L("Clasif_", "Class_") + res["perfil"].split("_")[-1])
        ws = wb.create_sheet(nom[:31])
        crit = [f["criterio"] for f in res["filas"]]
        head(ws, 1, ["#", L("Dirección", "Address"), L("Categoría", "Category"), L("Por qué", "Why")] + crit + [L("Evidencias registradas", "Recorded evidence")])
        fila = [L("Sujeto", "Subject"), res["sujeto"].get("direccion"), "—", L("Valores del sujeto", "Subject values")] + \
               [L("no aplica", "n/a") if f["campo"] in DEL_COMP else mostrar(res["sujeto"].get(f["campo"])) for f in res["filas"]]
        for j, v in enumerate(fila, 1):
            c = ws.cell(2, j, v)
            c.font, c.border, c.alignment = Font(bold=True), B, W
        for i, x in enumerate(res["comps"], 3):
            vals = [x["id"], x["direccion"], f"Cat. {x['cat']}", x["why"]]
            for j, v in enumerate(vals, 1):
                c = ws.cell(i, j, v)
                c.border, c.alignment = B, W
            ws.cell(i, 3).fill = PatternFill("solid", fgColor=CF[x["cat"]])
            for j, d in enumerate(x["det"], 5):
                c = ws.cell(i, j, f"{mostrar((d['comparable']))} — {L(d['res'], {'s.d.': 'n.d.'}.get(d['res'], d['res']))}")
                c.border, c.alignment = B, W
                c.fill = PatternFill("solid", fgColor=RF.get(d["res"], "FFFFFF"))
                nota = f"{L('Fuente', 'Source')}: {d['fuente_c'] or L('no informada', 'not reported')}" + (f"\n{L('Evidencia', 'Evidence')}: {d['evid_c']}" if d["evid_c"] else "") \
                    + f"\nCat. 1 {L('exige', 'requires')}: {d['regla1']}\nCat. 2 {L('exige', 'requires')}: {d['regla2']}"
                c.comment = Comment(nota[:1500], "clasificar_comparables")
            ev = x["datos"].get("_evidencias") or {}
            nom_c = {f["campo"]: f["criterio"] for f in res["filas"]}
            c = ws.cell(i, 5 + len(x["det"]), " | ".join(f"{nom_c.get(k) or etiq(k) or k}: {v}" for k, v in ev.items() if v) or "—")
            c.border, c.alignment = B, W
        for j, w in enumerate([6, 38, 10, 60] + [18] * len(crit) + [60], 1):
            ws.column_dimensions[get_column_letter(j)].width = w
        ws.freeze_panes = "E3"

    ws = wb.create_sheet(L("Detalle", "Detail"))
    head(ws, 1, L(["Set", "#", "Comparable", "Categoría", "Criterio", "Campo", "Sujeto", "Comparable (valor)",
                   "Diferencia", "Cat. 1 exige", "Cumple Cat. 1", "Cat. 2 exige", "Cumple Cat. 2", "Si falta el dato",
                   "Fuente del dato (comparable)", "Evidencia (comparable)", "Fuente del dato (sujeto)"],
                  ["Set", "#", "Comparable", "Category", "Criterion", "Field", "Subject", "Comparable (value)",
                   "Difference", "Cat. 1 requires", "Meets Cat. 1", "Cat. 2 requires", "Meets Cat. 2", "If data is missing",
                   "Data source (comparable)", "Evidence (comparable)", "Data source (subject)"]))
    r = 1
    lab = {True: L("sí", "yes"), False: "no", None: L("sin dato", "no data"), "na": L("no se exige", "not required")}
    for res in resultados:
        for x in res["comps"]:
            for d in x["det"]:
                r += 1
                for j, v in enumerate([res["nombre"], x["id"], x["direccion"], x["cat"], d["criterio"], fld(d["campo"]),
                                       mostrar((d["sujeto"])), mostrar((d["comparable"])), d["dif"], d["regla1"],
                                       lab[d["cat1"]], d["regla2"], lab[d["cat2"]],
                                       L("bloquea", "blocks") if d["bloquea"] else L("no bloquea", "does not block"), d["fuente_c"], d["evid_c"],
                                       d["fuente_s"]], 1):
                    c = ws.cell(r, j, v)
                    c.border, c.alignment = B, W
    for j, w in enumerate((20, 5, 34, 9, 24, 16, 14, 14, 18, 22, 10, 22, 10, 12, 34, 40, 30), 1):
        ws.column_dimensions[get_column_letter(j)].width = w
    ws.auto_filter.ref = f"A1:Q{max(r, 1)}"
    ws.freeze_panes = "F2"

    # ---- Datos: TODO lo que se recibio del sujeto y de cada comparable, usado o no en un criterio
    for res in resultados:
        nom = L("Datos", "Data") if len(resultados) == 1 else (L("Datos_", "Data_") + res["perfil"].split("_")[-1])
        ws = wb.create_sheet(nom[:31])
        usados = {}
        for f in res["filas"]:
            usados.setdefault(f["campo"], []).append(f["criterio"])
        todos = [res["sujeto"]] + [x["datos"] for x in res["comps"]]
        claves = list(dict.fromkeys([f["campo"] for f in res["filas"]] +
                                    [k for d in todos for k in d if not k.startswith("_") and k != "id"]))
        head(ws, 1, L(["Dato", "Campo", "Usado en criterio", "Sujeto"], ["Data item", "Field", "Used in criterion", "Subject"]) +
             [f"#{x['id']} · Cat. {x['cat']} · {x['direccion']}" for x in res["comps"]])
        r = 1
        for k in claves:
            r += 1
            vals = [etiq(k) or next((f["criterio"] for f in res["filas"] if f["campo"] == k), fld(k)), fld(k),
                    ", ".join(usados.get(k, [])) or L("contexto (no decide la categoría)", "context (does not decide the category)")]
            vals += [L("no aplica (dato del comparable)", "n/a (comparable data)") if (n == 0 and k in DEL_COMP) else
                     (mostrar(d.get(k)) if not isinstance(d.get(k), (list, dict)) else json.dumps(d.get(k), ensure_ascii=False))
                     for n, d in enumerate(todos)]
            for j, v in enumerate(vals, 1):
                c = ws.cell(r, j, v)
                c.border, c.alignment = B, W
                if j >= 4:
                    d = todos[j - 4]
                    fu, ev = (d.get("_fuentes") or {}).get(k), (d.get("_evidencias") or {}).get(k)
                    if fu or ev:
                        c.comment = Comment(((f"{L('Fuente', 'Source')}: {fu}" if fu else "") + (f"\n{L('Evidencia', 'Evidence')}: {ev}" if ev else ""))[:1500],
                                            "clasificar_comparables")
            if k not in usados:
                for j in range(1, 4):
                    ws.cell(r, j).font = Font(italic=True, color="595959")
        # bloques de fuentes y evidencias, para que se lean sin abrir comentarios
        for titulo, clave in ((L("FUENTE — ", "SOURCE — "), "_fuentes"), (L("EVIDENCIA — ", "EVIDENCE — "), "_evidencias")):
            ks = list(dict.fromkeys(k for d in todos for k in (d.get(clave) or {})))
            for k in ks:
                r += 1
                vals = [titulo + (etiq(k) or fld(k)), fld(k), ", ".join(usados.get(k, [])) or L("contexto", "context")] + \
                       [str((d.get(clave) or {}).get(k) or "—") for d in todos]
                for j, v in enumerate(vals, 1):
                    c = ws.cell(r, j, v)
                    c.border, c.alignment = B, W
                    c.fill = PatternFill("solid", fgColor="F2F2F2")
        for j, w in enumerate([28, 20, 26, 22] + [26] * len(res["comps"]), 1):
            ws.column_dimensions[get_column_letter(j)].width = w
        ws.freeze_panes = "E2"

    # ---- Trazabilidad: como se llego a la categoria y de donde salio cada cosa
    from datetime import datetime
    ws = wb.create_sheet(L("Trazabilidad", "Traceability"))
    traza = traza or {}
    filas_t = [] if LANG == "en" else [
        ("Generado", datetime.now().isoformat(timespec="seconds")),
        ("Script", "clasificar_comparables.py (0. Base formatos/_scripts; copia en el Tier 1)"),
        ("Archivo de entrada", traza.get("entrada") or "—"),
        ("Archivo de criterios", traza.get("criterios") or "valores por defecto del script (iguales a las hojas Categorias)"),
        ("Fecha de corte", asof),
        ("Método", "Cada criterio se evalúa contra el sujeto con su regla de Cat. 1 y de Cat. 2. Cat. 1 = cumple todas las "
                   "reglas de Cat. 1 (y de Cat. 2 donde Cat. 1 no pide nada); Cat. 2 = cumple todas las de Cat. 2; "
                   "Cat. 3 = el resto. Un dato faltante en un criterio 'bloquea' impide la categoría; en uno 'no bloquea' "
                   "se permite y se cita como sin dato. No hay ponderación ni juicio: el resultado es reproducible."),
        ("Datos derivados", "distancia_mi = haversine entre coordenadas (millas); meses_venta = (fecha de corte - fecha "
                            "de venta) / 30.44; anios_obra = año de corte - año de la obra; ciudad y ZIP = de la dirección "
                            "completa; estado_mercado normalizado a cerrada / pendiente / activa / inactiva."),
        ("Comparación de textos", "sin mayúsculas ni acentos; 'sí/yes/true' = si; 'sin verificar', vacío o 'no hay "
                                  "información' = sin dato."),
        ("Hojas", "Leyenda (reglas y fuente esperada de cada dato) · Clasificacion (matriz; cada celda tiene un "
                  "comentario con fuente, evidencia y reglas) · Detalle (una fila por comparable y criterio) · Datos "
                  "(todos los datos recibidos, también los de contexto que no deciden la categoría, con fuentes y "
                  "evidencias) · Trazabilidad."),
    ]
    if LANG == "en":
        filas_t = [
            ("Generated", datetime.now().isoformat(timespec="seconds")),
            ("Script", "clasificar_comparables.py --lang en (0. Base formatos/_scripts; copy in the Tier 1 skill)"),
            ("Input file", traza.get("entrada") or "—"),
            ("Criteria workbook", traza.get("criterios") or "script defaults (identical to the Categorias sheets)"),
            ("As-of date", asof),
            ("Method", "Each criterion is tested against the subject with its Cat. 1 and Cat. 2 rule. Cat. 1 = meets every "
                       "Cat. 1 rule (and Cat. 2 where Cat. 1 asks nothing); Cat. 2 = meets every Cat. 2 rule; Cat. 3 = the "
                       "rest. Missing data on a 'blocks' criterion denies the category; on a 'does not block' one it is "
                       "allowed and cited as no data. No weighting and no judgment: the result is reproducible."),
            ("Derived data", "distance = haversine between coordinates (miles); months since sale = (as-of date - sale "
                             "date) / 30.44; years since construction = as-of year - year built; city and ZIP = from the "
                             "full address; market status normalized to closed / pending / active / inactive."),
            ("Text comparison", "case- and accent-insensitive; 'yes/si/true' = yes; 'unverified', blank or 'no data' = no data."),
            ("Sheets", "Legend (rules and expected source of each data item) · Classification (matrix; each cell has a "
                       "comment with source, evidence and rules) · Detail (one row per comp and criterion) · Data (every "
                       "field received, including context fields that do not decide the category, with sources and "
                       "evidence) · Traceability."),
        ]
    for res in resultados:
        filas_t.append((f"{L('Criterios', 'Criteria')} — {res['nombre']}", res["fuente"]))
        filas_t.append((f"{L('Resultado', 'Result')} — {res['nombre']}", " · ".join(
            f"Cat. {k} = {sum(1 for x in res['comps'] if x['cat'] == k)}" for k in (1, 2, 3))))
    for ad in traza.get("adicionales") or []:
        filas_t.append((L("Criterio adicional de esta corrida", "Additional criterion of this run"), json.dumps(ad, ensure_ascii=False)))
    head(ws, 1, L(["Elemento", "Detalle"], ["Item", "Detail"]))
    for i, (k, v) in enumerate(filas_t, 2):
        for j, val in enumerate((k, v), 1):
            c = ws.cell(i, j, val)
            c.border, c.alignment = B, W
    ws.column_dimensions["A"].width, ws.column_dimensions["B"].width = 34, 120
    Path(ruta).parent.mkdir(parents=True, exist_ok=True)
    wb.save(ruta)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--entrada", help="JSON genérico (Fase 2)")
    g.add_argument("--tier1", help="data.json del Tier 1")
    ap.add_argument("--flujo", choices=["propiedades", "terrenos"], help="con --tier1")
    ap.add_argument("--criterios", help="Excel de criterios con la hoja Categorias / Categorias_A / Categorias_B")
    ap.add_argument("--adicionales", help="JSON con una lista de criterios adicionales de esta corrida")
    ap.add_argument("--salida", required=True, help="ruta del Excel de salida")
    ap.add_argument("--salida-json", help="resumen {set: [{id, direccion, cat, cat_why}]}")
    ap.add_argument("--escribir-cat", action="store_true", help="con --tier1: escribe cat y cat_why en el data.json")
    ap.add_argument("--lang", choices=["es", "en"], default="es", help="idioma del Excel y de cat_why (Tier 1: en)")
    a = ap.parse_args()
    global LANG
    LANG = a.lang

    if a.tier1:
        if not a.flujo:
            ap.error("--tier1 requiere --flujo")
        data = json.loads(Path(a.tier1).read_text(encoding="utf-8"))
        ent = desde_tier1(data, a.flujo)
        ent["adicionales"] = data.get("criterios_adicionales", [])
    else:
        ent = json.loads(Path(a.entrada).read_text(encoding="utf-8"))
    if a.adicionales:
        ent.setdefault("adicionales", []).extend(json.loads(Path(a.adicionales).read_text(encoding="utf-8")))
    asof = parse_fecha(ent.get("asof")) or date.today()

    resultados, cache = [], {}
    for st in ent["sets"]:
        perfil = st["perfil"]
        if perfil not in cache:
            cache[perfil] = cargar_criterios(perfil, a.criterios)
        filas, fuente = [dict(f) for f in cache[perfil][0]], cache[perfil][1]
        for ad in ent.get("adicionales", []):
            if ad.get("perfil", perfil) != perfil:
                continue
            nueva = {"criterio": ad["criterio"], "campo": ad["campo"], "cat1": ad.get("cat1", "-"),
                     "cat2": ad.get("cat2", "-"), "si_falta": ad.get("si_falta", L("no bloquea", "does not block")),
                     "nota": ad.get("nota", ""), "origen": ad.get("origen", L("adicional (esta corrida)", "additional (this run)")),
                     "fuente": ad.get("fuente", "")}
            filas = [f for f in filas if f["campo"] != nueva["campo"] or f["criterio"] != nueva["criterio"]] + [nueva]
        for f in filas:  # valida la sintaxis antes de clasificar
            for regla in (f["cat1"], f["cat2"]):
                try:
                    evaluar(regla, f["campo"], {}, {})
                except ValueError as e:
                    sys.exit(f"ERROR en '{f['criterio']}': {e}")
        suj = derivar(st["sujeto"], None, asof)
        comps = []
        for c in st["comparables"]:
            c = derivar(c, suj, asof)
            cat, why, det = clasificar(filas, suj, c)
            comps.append({"id": c.get("id"), "direccion": c.get("direccion"), "cat": cat, "why": why, "det": det,
                          "datos": c})
        resultados.append({"perfil": perfil, "nombre": st.get("nombre", perfil), "clave": st.get("clave"),
                           "sujeto": suj, "filas": filas, "fuente": fuente, "comps": comps})

    traza = {"entrada": a.entrada or a.tier1, "criterios": a.criterios, "adicionales": ent.get("adicionales", [])}
    escribir_xlsx(a.salida, ent.get("lead"), asof.isoformat(), resultados, traza)
    resumen = {r["nombre"]: [{"id": x["id"], "direccion": x["direccion"], "cat": x["cat"], "cat_why": x["why"]}
                             for x in r["comps"]] for r in resultados}
    if a.salida_json:
        Path(a.salida_json).write_text(json.dumps(resumen, ensure_ascii=False, indent=1), encoding="utf-8")
    if a.tier1 and a.escribir_cat:
        for r in resultados:
            for c, x in zip(data.get(r["clave"], []), r["comps"]):
                c["cat"], c["cat_why"] = x["cat"], x["why"]
        Path(a.tier1).write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({r["nombre"]: {f"cat{k}": sum(1 for x in r["comps"] if x["cat"] == k) for k in (1, 2, 3)}
                      for r in resultados}, ensure_ascii=False))
    print(f"Excel: {a.salida}")


if __name__ == "__main__":
    main()
