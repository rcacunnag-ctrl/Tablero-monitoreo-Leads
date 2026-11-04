#!/usr/bin/env python3
"""
fl_roll_lookup.py - Nivel 1.5 de la cascada: el rol de propiedad del estado de
Florida (NAL + SDF del Departamento de Hacienda) indexado en local.

Uso
---
    # una parcela
    python fl_roll_lookup.py --folio 494211050740 --county broward
    python fl_roll_lookup.py --folio 38-43-44-15-06-002-0990 --county palm_beach
    python fl_roll_lookup.py --address "631 NE 56 CT" --county broward

    # con las tres reglas de vigencia contra la fuente viva (BCPA / PAPA)
    python fl_roll_lookup.py --folio 494211050740 --county broward --con-vigencia

    # operaciones de conjunto: el universo de comparables (esto es el punto)
    python fl_roll_lookup.py --conjunto --county palm_beach --zip 33460 \\
        --sf-min 1313 --sf-max 2241 --ano-min 1966 --ano-max 1996 \\
        --meses 12 --solo-calificadas

Salida: JSON por stdout, mismo contrato que appraiser_lookup.py y
pbcpao_lookup.py -- bloque `intentos`, bandera `requiere_navegador`, y
codigo de salida 0 si respondio / 3 si no.

PARA QUE SIRVE Y PARA QUE NO
----------------------------
El rol NO es una fuente viva: es una foto con fecha de corte. La entrega
2026P cierra el 1-jul-2026, y en la practica los datos utiles terminan en
mayo (junio ya viene incompletisimo por rezago de registro: Palm Beach
reporta 234 ventas en junio contra 4.665 en mayo). Por eso el rol NUNCA es
nivel 1 para una parcela concreta.

Lo que si es, y no existia antes: la capacidad de hacer operaciones de
CONJUNTO sobre el condado entero -- "todas las ventas calificadas de los
ultimos 12 meses, 1.313-2.241 sf, 3/2, 1966-1996, en este zip" -- que es
justo lo que un lookup parcela-por-parcela no puede dar, y el hueco por el
que un informe ajeno encontro comparables que nuestro set no tenia.

LAS TRES REGLAS DE VIGENCIA (validar_vigencia_roll)
---------------------------------------------------
  1. Vigencia    - si la fuente viva registra una venta POSTERIOR a la fecha
                   de corte del rol, la fila del rol quedo superada para esa
                   parcela: se degrada a nivel 1 para TODOS sus campos.
  2. Integridad  - se cruza folio + superficie habitable + ano de
                   construccion. Si discrepan, NO se usa el dato del rol en
                   silencio: se escriben ambos valores con su fuente y se
                   marca para criterio humano. (appraiser_lookup.py ya tuvo
                   un bug de match equivocado de parcela: "NW 5 PL" contra
                   "NW 57 PL".)
  3. Etiquetado  - todo dato del rol sale con su anada y fecha de corte.
                   "$836.600 - fuente: rol estatal FL 2026P (corte
                   1-jul-2026), no PAPA".

QUE TAN RUIDOSA ES LA REGLA 2 (medido, no supuesto)
---------------------------------------------------
Se compararon 14 unifamiliares (DOR_UC=001) de Lake Worth contra PAPA en vivo:
las 14 coinciden EXACTO en superficie, mediana de diferencia 0,0%. La regla no
genera falsos positivos en casa unifamiliar.

De cuatro leads reales probados, disparo en dos, y en ambos por una razon
legitima que conviene conocer antes de armar comparables:
  - 3540 S Ocean Blvd 808 -> DOR_UC=004, es CONDOMINIO. El rol y PAPA no
    miden lo mismo en unidades de condominio.
  - 141 Yale Dr -> NO_BULDNG=2 y NO_RES_UNTS=2, es un DUPLEX. El rol suma las
    dos estructuras (1.597 sf), PAPA muestra 1.298. Una propiedad de dos
    unidades no es comparable de una unifamiliar, asi que el disparo de la
    regla es justo lo que uno quiere que pase.
Antes de tratar una discrepancia como error, mira DOR_UC, NO_BULDNG y
NO_RES_UNTS: casi siempre explican el numero.

EL ROL TIENE HUECOS DE COBERTURA
--------------------------------
No todas las parcelas del condado estan en el archivo. Verificado: 137 YALE DR,
Lake Worth (PCN 38434415060146160) existe en PAPA -3.400 sf, 1949- y NO esta ni
en el NAL ni en el SDF de 2026P, aunque el vecino 141 si esta. Por eso el
script sale con codigo 3 y `requiere_navegador` cuando no resuelve, en vez de
inventar: la cascada sigue a nivel 1.
"""

import argparse
import io
import json
import os
import re
import sqlite3
import sys
from datetime import date

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# datos-estado/ vive FUERA de "0. Base formatos" (OneDrive). Ver rutas_rol.py.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rutas_rol  # noqa: E402

DIR_DATOS = rutas_rol.dir_datos_estado()
DB = rutas_rol.ruta_db()
META = rutas_rol.ruta_meta()

CONDADOS = {"broward": 16, "palm_beach": 60}

# Codigos de calificacion de venta del DOR.
# Fuente: tabla oficial de Sale Qualification Codes (DOR-PTO).
# Verificado ademas contra los datos: el codigo 11 es el mas frecuente del
# archivo (87.126 filas) y su mediana de precio es $100 -- son quit claims y
# tax deeds, NO ventas de mercado. Tomarlo por "calificada" seria construir
# un CMA sobre traspasos de $100.
QUAL_MERCADO = {"01", "02"}          # arm's length, entran en ratio analysis
QUAL_CALIF_NO_RATIO = {"03", "04", "05"}  # calificadas pero excluidas del ratio
QUAL_DESCRIPCION = {
    "01": ("calificada", "arm's length por examen de la escritura"),
    "02": ("calificada", "arm's length por evidencia verificable documentada"),
    "03": ("calificada_excluida", "caracteristicas fisicas cambiaron tras la venta"),
    "04": ("calificada_excluida", "caracteristicas legales cambiaron tras la venta"),
    "05": ("calificada_excluida", "venta de multiples parcelas con distinto folio"),
    "11": ("descalificada", "corrective/quit claim/tax deed o doc stamps minimos"),
    "12": ("descalificada", "escritura desde/hacia entidad financiera o dacion en pago"),
    "13": ("descalificada", "lote de cementerio"),
    "14": ("descalificada", "reserva de ocupacion mayor a 90 dias (life estate)"),
    "15": ("descalificada", "contraprestacion indeterminable"),
    "16": ("descalificada", "interes parcial"),
    "17": ("descalificada", "organizacion religiosa, caritativa o benevolente"),
    "18": ("descalificada", "traspaso de agencia de gobierno"),
    "19": ("descalificada", "sindico, albacea, tutor o receptor (quiebra/sucesion)"),
    "20": ("descalificada", "compania de servicios publicos"),
    "30": ("descalificada", "partes afiliadas (familia, corporativa, arrendador)"),
    "37": ("descalificada", "fuera de mercado abierto, motivacion atipica"),
    "38": ("descalificada", "venta forzada, duress o para evitar ejecucion"),
    "39": ("descalificada", "discrepancia de doc stamps contra el precio"),
    "40": ("descalificada", "financiamiento o arriendo fuera de mercado"),
    "41": ("descalificada", "otra circunstancia descalificante"),
    "42": ("descalificada", "fraude hipotecario notificado por autoridad"),
    "99": ("pendiente", "venta de los ultimos 90 dias, sin decidir calificacion"),
}

# Uso DOR residencial. 001 = unifamiliar.
DOR_UC_RESIDENCIAL = {"000", "001", "002", "004", "005"}


# ----------------------------------------------------------------------
def folio_rol(folio):
    """El PARCEL_ID del rol y del catastro estatal va SIN guiones ni espacios
    en Broward (12 digitos) y Palm Beach (17). PAPA entrega el PCN con
    guiones, asi que pasarlo tal cual devuelve cero filas en silencio."""
    return re.sub(r"[-\s]", "", folio or "")


def carga_meta(intentos):
    if not os.path.exists(META):
        intentos.append({"metodo": "meta", "ok": False,
                         "detalle": f"falta {META}; corre construir_indice_rol.py"})
        return None
    m = json.load(io.open(META, encoding="utf-8"))
    intentos.append({"metodo": "meta", "ok": True,
                     "detalle": f"anada {m['anada']}, corte {m['fecha_corte_rol']}"})
    return m


def abre_db(intentos):
    if not os.path.exists(DB):
        intentos.append({"metodo": "sqlite", "ok": False,
                         "detalle": f"falta {DB}; corre construir_indice_rol.py"})
        return None
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    return con


def _cols(con, tabla):
    try:
        return [r[1] for r in con.execute(f"PRAGMA table_info({tabla})")]
    except sqlite3.Error:
        return []


def etiqueta_anada(meta, valor=None):
    """Regla 3. Devuelve el sufijo de procedencia que debe acompanar a TODO
    dato que salga del rol."""
    txt = (f"rol estatal FL {meta['anada']} "
           f"(corte {meta['fecha_corte_rol']}), no BCPA/PAPA")
    return f"{valor} - fuente: {txt}" if valor is not None else txt


# ----------------------------------------------------------------------
# Consulta de parcela
# ----------------------------------------------------------------------
def parcela_nal(con, folio, condado, intentos):
    f = folio_rol(folio)
    cono = CONDADOS[condado]
    cols = _cols(con, "nal")
    if not cols:
        intentos.append({"metodo": "rol_nal", "ok": False,
                         "detalle": "la tabla nal no existe todavia"})
        return None
    fila = con.execute(
        "SELECT * FROM nal WHERE CO_NO=? AND PARCEL_ID=?", (cono, f)).fetchone()
    if fila is None:
        # Red de seguridad: si el condado venia mal etiquetado, buscar sin el.
        fila = con.execute("SELECT * FROM nal WHERE PARCEL_ID=?", (f,)).fetchone()
        if fila is not None:
            intentos.append({
                "metodo": "rol_nal", "ok": True,
                "detalle": (f"encontrada con CO_NO={fila['CO_NO']:.0f}, NO "
                            f"{cono} que es el de --county {condado}. "
                            f"REVISAR: el condado del lead puede estar mal.")})
            return dict(fila)
        intentos.append({"metodo": "rol_nal", "ok": False,
                         "detalle": f"0 filas para PARCEL_ID={f} CO_NO={cono}"})
        return None
    intentos.append({"metodo": "rol_nal", "ok": True,
                     "detalle": f"{len(fila.keys())} campos"})
    return dict(fila)


def ventas_sdf(con, folio, condado, intentos):
    f = folio_rol(folio)
    if not _cols(con, "sdf"):
        return []
    filas = [dict(r) for r in con.execute(
        "SELECT * FROM sdf WHERE CO_NO=? AND PARCEL_ID=? "
        "ORDER BY SALE_YR DESC, SALE_MO DESC", (CONDADOS[condado], f))]
    for v in filas:
        cd = (v.get("QUAL_CD") or "").strip()
        estado, motivo = QUAL_DESCRIPCION.get(cd, ("desconocida", f"codigo {cd!r} no catalogado"))
        v["_calificacion"] = estado
        v["_calificacion_motivo"] = motivo
        v["_es_mercado"] = cd in QUAL_MERCADO
    intentos.append({"metodo": "rol_sdf", "ok": bool(filas),
                     "detalle": f"{len(filas)} ventas en el SDF"})
    return filas


def parcela_por_direccion(con, direccion, condado, intentos):
    """El NAL trae PHY_ADDR1 tal como lo somete el condado. Se normaliza a
    mayusculas y espacios simples; se exige coincidencia exacta para no
    repetir el bug de 'NW 5 PL' contra 'NW 57 PL'."""
    if not _cols(con, "nal"):
        return None
    d = re.sub(r"\s+", " ", (direccion or "").strip().upper())
    filas = [dict(r) for r in con.execute(
        "SELECT * FROM nal WHERE CO_NO=? AND UPPER(TRIM(PHY_ADDR1))=?",
        (CONDADOS[condado], d))]
    if len(filas) == 1:
        intentos.append({"metodo": "rol_nal_direccion", "ok": True,
                         "detalle": f"1 parcela exacta para {d!r}"})
        return filas[0]
    intentos.append({"metodo": "rol_nal_direccion", "ok": False,
                     "detalle": (f"{len(filas)} parcelas para {d!r}; se exige "
                                 f"coincidencia exacta y unica")})
    return None


# ----------------------------------------------------------------------
# Las tres reglas
# ----------------------------------------------------------------------
def _f(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _busca(d, *candidatos):
    """Los nombres de campo de BCPA y PAPA no son los mismos. Se busca por
    varias claves, sin distinguir mayusculas, y se reporta cual gano."""
    if not d:
        return None, None
    bajo = {str(k).lower(): k for k in d}
    for c in candidatos:
        k = bajo.get(c.lower())
        if k is not None and d[k] not in (None, "", " "):
            return d[k], k
    return None, None


def _anio_mes(txt):
    """Saca (ano, mes) de una fecha en cualquiera de los formatos que usan
    BCPA y PAPA: 2026-03-14, 03/14/2026, MAR-2026..."""
    if txt is None:
        return None
    s = str(txt)
    m = re.search(r"(\d{4})-(\d{2})", s)
    if m:
        return int(m.group(1)), int(m.group(2))
    m = re.search(r"(\d{1,2})/(\d{1,2})/(\d{4})", s)
    if m:
        return int(m.group(3)), int(m.group(1))
    m = re.search(r"(\d{4})", s)
    if m:
        return int(m.group(1)), 12
    return None


def validar_vigencia_roll(folio, roll_row, meta_roll, dato_live):
    """Devuelve {'estado': 'vigente'|'superado'|'discrepante',
                 'motivo': str, 'usar': 'roll'|'live'}

    'superado'    -> la fuente viva tiene una venta posterior al corte del rol.
    'discrepante' -> superficie o ano no cuadran: puede ser correccion de rol
                     o match equivocado de parcela. En ambos casos NO se usa
                     el rol en silencio.
    """
    corte = meta_roll["fecha_corte_rol"]
    corte_a, corte_m = int(corte[:4]), int(corte[5:7])
    detalle = {"folio": folio, "anada": meta_roll["anada"], "fecha_corte_rol": corte,
               "comparaciones": []}

    if not dato_live:
        return dict(detalle, estado="vigente", usar="roll",
                    motivo=("sin fuente viva con que contrastar; el dato del "
                            "rol se usa ETIQUETADO con su anada (regla 3) y "
                            "no se promueve a nivel 1"),
                    verificado_contra_live=False)

    # ---- Regla 1: vigencia -------------------------------------------------
    fecha_live, k_fecha = _busca(
        dato_live, "saleDate1", "sale_date",
        "sales_date_sales_information_fila_1",
        "last_sale_date", "saledate", "date_sales_history_fila_1",
        "sale_date_sales_history_fila_1")
    am = _anio_mes(fecha_live)
    if am:
        detalle["comparaciones"].append(
            {"campo": "ultima_venta_live", "live": str(fecha_live),
             "clave_live": k_fecha, "corte_rol": corte})
        if (am[0], am[1]) > (corte_a, corte_m):
            return dict(
                detalle, estado="superado", usar="live",
                motivo=(f"la fuente viva registra una venta de {am[0]}-{am[1]:02d}, "
                        f"posterior al corte {corte} del rol {meta_roll['anada']}. "
                        f"Degradar a nivel 1 (BCPA/PAPA) para TODOS los campos "
                        f"de esta parcela."),
                anotacion=(f"dato de nivel 1; el rol {meta_roll['anada']} quedo "
                           f"superado por venta de {am[0]}-{am[1]:02d}"))

    # ---- Regla 2: integridad ----------------------------------------------
    # Las claves van en orden de preferencia. Las primeras de cada tupla son
    # las REALES, verificadas el 14-sep-2026 contra una respuesta viva:
    #   BCPA -> bldgUnderAirFootage, actualAge, effectiveAge, saleDate1
    #   PAPA -> area_under_air_subarea, year_built, sale_date
    # "actualAge"/"effectiveAge" de BCPA no son edades pese al nombre: traen
    # el ANO (1959, 1960).
    pares = [
        ("superficie_habitable", _f(roll_row.get("TOT_LVG_AREA")),
         ("bldgUnderAirFootage", "area_under_air_subarea",
          "total_square_footage_subarea", "bldgTotSqFootage",
          "living_area", "tot_lvg_area", "building_area", "total_square_feet",
          "square_footage", "sq_ft", "total_sq_ft", "area_under_air"), 0.03),
        ("ano_construccion", _f(roll_row.get("ACT_YR_BLT")),
         ("actualAge", "year_built", "act_yr_blt", "actual_year_built",
          "yr_blt"), 0.0),
        ("ano_efectivo", _f(roll_row.get("EFF_YR_BLT")),
         ("effectiveAge", "effective_year", "eff_yr_blt"), 0.0),
    ]
    discrepancias = []
    for nombre, v_rol, claves, tol in pares:
        v_live_raw, k = _busca(dato_live, *claves)
        v_live = _f(re.sub(r"[^\d.]", "", str(v_live_raw))) if v_live_raw is not None else None
        if v_rol is None or v_live is None:
            detalle["comparaciones"].append(
                {"campo": nombre, "rol": v_rol, "live": v_live, "clave_live": k,
                 "resultado": "no comparable (falta un lado)"})
            continue
        if tol:
            ok = abs(v_rol - v_live) <= max(1.0, tol * max(v_rol, v_live))
        else:
            ok = v_rol == v_live
        detalle["comparaciones"].append(
            {"campo": nombre, "rol": v_rol, "live": v_live, "clave_live": k,
             "resultado": "coincide" if ok else "DISCREPA"})
        if not ok:
            discrepancias.append(f"{nombre}: rol={v_rol:g} vs live={v_live:g}")

    if discrepancias:
        return dict(
            detalle, estado="discrepante", usar="live",
            motivo=("; ".join(discrepancias) + ". Puede ser correccion de rol o "
                    "match equivocado de parcela. NO usar el dato del rol en "
                    "silencio: escribir ambos valores con su fuente y marcar "
                    "para criterio humano."),
            requiere_criterio_humano=True)

    comparados = [c for c in detalle["comparaciones"]
                  if c.get("resultado") == "coincide"]
    if not comparados:
        # La fuente viva respondio pero ninguno de sus campos pudo cruzarse.
        # Declarar "vigente" aqui seria firmar una verificacion que no ocurrio,
        # que es exactamente el fallo silencioso que la regla 2 existe para
        # evitar. Se devuelve indeterminado y se deja constancia.
        return dict(
            detalle, estado="indeterminado", usar="roll",
            motivo=("la fuente viva respondio pero no se hallo en ella ningun "
                    "campo comparable (superficie o ano). NO se verifico nada: "
                    "el dato del rol se usa ETIQUETADO con su anada y no se "
                    "promueve. Revisar los nombres de campo de la fuente viva "
                    "en validar_vigencia_roll()."),
            verificado_contra_live=False,
            requiere_criterio_humano=True)

    return dict(detalle, estado="vigente", usar="roll",
                motivo=("cuadran con la fuente viva: "
                        + ", ".join(c["campo"] for c in comparados)
                        + "; y no hay venta posterior al corte del rol"),
                verificado_contra_live=True,
                campos_verificados=[c["campo"] for c in comparados])


def trae_live(folio, condado, intentos):
    """Fuente viva por condado: BCPA para Broward, PAPA para Palm Beach.
    OJO: el Florida Statewide Cadastral (nivel 2) NO sirve aqui -- es la
    capa 'FDOR Cadastral 2025', o sea otra foto de rol, y mas vieja que
    nuestro 2026P. Contrastar el rol contra el rol no valida nada."""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    try:
        if condado == "broward":
            import appraiser_lookup as A
            sub = []
            campos = A.bcpa_parcela(folio_rol(folio), "", sub)
            intentos.extend(sub)
            if campos:
                intentos.append({"metodo": "live_bcpa", "ok": True,
                                 "detalle": f"{len(campos)} campos"})
                return campos
        else:
            import pbcpao_lookup as P
            model = P.fetch_model(folio_rol(folio))
            campos = P.map_papa(model, folio_rol(folio), True) if model else None
            if campos:
                intentos.append({"metodo": "live_papa", "ok": True,
                                 "detalle": f"{len(campos)} campos"})
                return campos
    except Exception as e:
        intentos.append({"metodo": f"live_{condado}", "ok": False,
                         "detalle": f"{type(e).__name__}: {e}"})
        return None
    intentos.append({"metodo": f"live_{condado}", "ok": False,
                     "detalle": "la fuente viva no respondio"})
    return None


# ----------------------------------------------------------------------
# Operaciones de conjunto: el universo de comparables
# ----------------------------------------------------------------------
def conjunto(con, meta, args, intentos):
    cols_nal = _cols(con, "nal")
    if not cols_nal:
        intentos.append({"metodo": "conjunto", "ok": False,
                         "detalle": "la tabla nal no existe; corre construir_indice_rol.py"})
        return None

    cono = CONDADOS[args.county]
    where = ["s.CO_NO = ?", "n.CO_NO = ?"]
    par = [cono, cono]

    if args.solo_calificadas:
        where.append("TRIM(s.QUAL_CD) IN (%s)" % ",".join("?" * len(QUAL_MERCADO)))
        par += sorted(QUAL_MERCADO)
    if args.meses:
        # El corte del rol manda, no la fecha de hoy: pedir "ultimos 12 meses"
        # contra hoy daria una ventana que el rol no puede cubrir.
        ca, cm = int(meta["fecha_corte_rol"][:4]), int(meta["fecha_corte_rol"][5:7])
        tot = ca * 12 + cm - args.meses
        where.append("(s.SALE_YR * 12 + CAST(s.SALE_MO AS INTEGER)) >= ?")
        par.append(tot)
    if args.zip:
        where.append("CAST(n.PHY_ZIPCD AS INTEGER) = ?")
        par.append(int(args.zip))
    if args.sf_min:
        where.append("n.TOT_LVG_AREA >= ?")
        par.append(args.sf_min)
    if args.sf_max:
        where.append("n.TOT_LVG_AREA <= ?")
        par.append(args.sf_max)
    if args.ano_min:
        where.append("n.ACT_YR_BLT >= ?")
        par.append(args.ano_min)
    if args.ano_max:
        where.append("n.ACT_YR_BLT <= ?")
        par.append(args.ano_max)
    if args.nbrhd:
        where.append("TRIM(n.NBRHD_CD) = ?")
        par.append(args.nbrhd.strip())
    if args.residencial:
        where.append("TRIM(n.DOR_UC) IN (%s)" % ",".join("?" * len(DOR_UC_RESIDENCIAL)))
        par += sorted(DOR_UC_RESIDENCIAL)
    if args.precio_min:
        where.append("s.SALE_PRC >= ?")
        par.append(args.precio_min)

    sql = f"""
        SELECT n.PARCEL_ID, n.PHY_ADDR1, n.PHY_CITY, n.PHY_ZIPCD,
               n.TOT_LVG_AREA, n.ACT_YR_BLT, n.EFF_YR_BLT, n.NO_BULDNG,
               n.NO_RES_UNTS, n.LND_SQFOOT, n.JV, n.LND_VAL, n.NCONST_VAL,
               n.NBRHD_CD, n.MKT_AR, n.DOR_UC, n.IMP_QUAL, n.CONST_CLASS,
               s.SALE_YR, s.SALE_MO, s.SALE_PRC, s.QUAL_CD, s.VI_CD,
               s.OR_BOOK, s.OR_PAGE, s.CLERK_NO
        FROM sdf s JOIN nal n
          ON n.CO_NO = s.CO_NO AND n.PARCEL_ID = s.PARCEL_ID
        WHERE {' AND '.join(where)}
        ORDER BY s.SALE_YR DESC, CAST(s.SALE_MO AS INTEGER) DESC, s.SALE_PRC DESC
        LIMIT ?"""
    par.append(args.limite)

    filas = [dict(r) for r in con.execute(sql, par)]
    for f in filas:
        cd = (f.get("QUAL_CD") or "").strip()
        est, mot = QUAL_DESCRIPCION.get(cd, ("desconocida", f"codigo {cd!r} no catalogado"))
        f["calificacion"] = est
        f["calificacion_motivo"] = mot
        f["fecha_venta"] = (f"{int(f['SALE_YR'])}-{str(f['SALE_MO']).zfill(2)}"
                            if f.get("SALE_YR") else None)
        # Senal catastral de rehab: brecha entre ano efectivo y ano real, mas
        # valor de construccion nueva incorporada al rol.
        ef, ac = _f(f.get("EFF_YR_BLT")), _f(f.get("ACT_YR_BLT"))
        f["rehab_brecha_anos"] = int(ef - ac) if (ef and ac) else None
        f["rehab_senal_catastral"] = bool(
            (f["rehab_brecha_anos"] or 0) >= 10 or (_f(f.get("NCONST_VAL")) or 0) > 0)
        if f.get("SALE_PRC") and f.get("TOT_LVG_AREA"):
            f["precio_sf"] = round(f["SALE_PRC"] / f["TOT_LVG_AREA"], 2)

    intentos.append({"metodo": "conjunto", "ok": True,
                     "detalle": f"{len(filas)} ventas en el universo"})
    return filas


# ----------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--folio", help="folio / PCN. Con o sin guiones, da igual")
    ap.add_argument("--address", help="direccion tal como la indexa el rol, ej. '631 NE 56 CT'")
    ap.add_argument("--county", default="broward", choices=sorted(CONDADOS))
    ap.add_argument("--con-vigencia", action="store_true",
                    help="consulta la fuente viva y aplica las tres reglas")
    ap.add_argument("--conjunto", action="store_true",
                    help="modo universo de comparables en vez de parcela")
    ap.add_argument("--zip", help="filtro de zip (modo conjunto)")
    ap.add_argument("--sf-min", type=float)
    ap.add_argument("--sf-max", type=float)
    ap.add_argument("--ano-min", type=int)
    ap.add_argument("--ano-max", type=int)
    ap.add_argument("--precio-min", type=float)
    ap.add_argument("--nbrhd", help="codigo de barrio NBRHD_CD")
    ap.add_argument("--meses", type=int, default=0,
                    help="ventana hacia atras DESDE EL CORTE DEL ROL, no desde hoy")
    ap.add_argument("--solo-calificadas", action="store_true",
                    help="solo QUAL_CD 01/02 (arm's length). Sin esto entran los "
                         "quit claims de $100, que son el 46%% del archivo")
    ap.add_argument("--residencial", action="store_true",
                    help="solo usos DOR residenciales")
    ap.add_argument("--limite", type=int, default=200)
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    intentos = []
    meta = carga_meta(intentos)
    con = abre_db(intentos)
    if meta is None or con is None:
        print(json.dumps({"metodo_usado": "ninguno", "requiere_navegador": True,
                          "intentos": intentos}, ensure_ascii=False, indent=2))
        return 3

    salida = {
        "metodo_usado": "rol_fl",
        "nivel_cascada": 1.5,
        "requiere_navegador": False,
        "condado": args.county,
        "co_no_dor": CONDADOS[args.county],
        "anada": meta["anada"],
        "tipo_entrega": meta.get("tipo_entrega"),
        "fecha_corte_rol": meta["fecha_corte_rol"],
        "fecha_descarga_rol": meta.get("fecha_descarga"),
        "etiqueta_procedencia": etiqueta_anada(meta),
        "advertencia_vigencia": (
            f"El rol es una foto al {meta['fecha_corte_rol']}. En 2026P los "
            f"datos utiles terminan en mayo-2026 (junio viene incompleto por "
            f"rezago de registro). Nunca es nivel 1 para una parcela."),
    }

    if args.conjunto:
        filas = conjunto(con, meta, args, intentos)
        salida["modo"] = "conjunto"
        salida["filtros"] = {k: v for k, v in vars(args).items()
                             if k not in ("verbose", "conjunto", "folio", "address",
                                          "con_vigencia") and v not in (None, False, 0)}
        salida["n"] = len(filas or [])
        salida["ventas"] = filas or []
        if not filas:
            salida["metodo_usado"] = "ninguno"
            salida["requiere_navegador"] = True
        salida["intentos"] = intentos
        print(json.dumps(salida, ensure_ascii=False, indent=2 if args.verbose else None))
        return 0 if filas else 3

    if not args.folio and not args.address:
        ap.error("hace falta --folio o --address (o usa --conjunto)")

    fila = None
    if args.folio:
        fila = parcela_nal(con, args.folio, args.county, intentos)
    if fila is None and args.address:
        fila = parcela_por_direccion(con, args.address, args.county, intentos)

    if fila is None:
        salida.update({"metodo_usado": "ninguno", "requiere_navegador": True,
                       "diagnostico": ("el rol local no resolvio la parcela. "
                                       "Sigue la cascada: nivel 1 (BCPA/PAPA), "
                                       "nivel 2 (catastro estatal), nivel 3 "
                                       "(navegador)."),
                       "intentos": intentos})
        print(json.dumps(salida, ensure_ascii=False, indent=2))
        return 3

    folio = fila.get("PARCEL_ID") or folio_rol(args.folio or "")
    salida["folio"] = folio
    salida["campos"] = fila
    salida["n_campos"] = len(fila)
    salida["ventas_sdf"] = ventas_sdf(con, folio, args.county, intentos)

    ef, ac = _f(fila.get("EFF_YR_BLT")), _f(fila.get("ACT_YR_BLT"))
    salida["rehab"] = {
        "ano_efectivo": ef, "ano_real": ac,
        "brecha_anos": int(ef - ac) if (ef and ac) else None,
        "valor_construccion_nueva": _f(fila.get("NCONST_VAL")),
        "valor_demolicion": _f(fila.get("DEL_VAL")),
        "senal_catastral": bool((ef and ac and ef - ac >= 10)
                                or (_f(fila.get("NCONST_VAL")) or 0) > 0),
        "nota": ("El ano efectivo (EFF_YR_BLT) es la evidencia objetiva de "
                 "rehab que PAPA no publica en web. Una brecha grande contra "
                 "el ano real, o NCONST_VAL > 0, es senal catastral de obra."),
    }

    dato_live = trae_live(folio, args.county, intentos) if args.con_vigencia else None
    salida["vigencia"] = validar_vigencia_roll(folio, fila, meta, dato_live)
    if salida["vigencia"]["estado"] in ("superado", "discrepante"):
        salida["requiere_navegador"] = (salida["vigencia"]["usar"] == "live"
                                        and not dato_live)

    salida["intentos"] = intentos
    print(json.dumps(salida, ensure_ascii=False, indent=2, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
