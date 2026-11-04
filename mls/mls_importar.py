#!/usr/bin/env python3
"""Importa las exportaciones semanales de Matrix (Beaches MLS, formato DataMaster_CSV) a una base local.

Uso:
    python mls_importar.py "C:\\MLS-semanal\\2026-11-09"            # todos los .zip/.csv de la carpeta
    python mls_importar.py archivo.zip --etiqueta oportunidades      # una exportación

- Acepta el .zip que baja Matrix (un CSV + una foto por propiedad) o el CSV suelto.
- Guarda en C:\\MLS-semanal\\mls.db (tabla `listado`: una fila por propiedad y semana, para ver cambios de precio entre
  semanas) y la foto principal en C:\\MLS-semanal\\fotos\\<MLS#>.jpg. Nada sale de este PC.
- Cada importación queda en `importaciones` (archivo, etiqueta, filas, fecha). Importar dos veces el mismo archivo no duplica.
"""
import argparse
import csv
import datetime as dt
import hashlib
import io
import os
import re
import sqlite3
import sys
import zipfile

RAIZ = os.environ.get("MLS_SEMANAL", r"C:\MLS-semanal")
DB = os.path.join(RAIZ, "mls.db")
FOTOS = os.path.join(RAIZ, "fotos")

COLS = [("mls_id", "TEXT"), ("snapshot", "TEXT"), ("estado", "TEXT"), ("direccion", "TEXT"), ("ciudad", "TEXT"), ("zip", "TEXT"), ("condado", "TEXT"),
        ("folio", "TEXT"), ("subdivision", "TEXT"), ("beds", "REAL"), ("baths", "REAL"), ("sqft", "REAL"), ("lote_sqft", "REAL"), ("anio", "INTEGER"),
        ("precio_lista", "REAL"), ("precio_cierre", "REAL"), ("fecha_lista", "TEXT"), ("fecha_cierre", "TEXT"), ("fecha_pendiente", "TEXT"),
        ("fecha_retirada", "TEXT"), ("fecha_vencida", "TEXT"), ("dom", "INTEGER"), ("comentarios", "TEXT"), ("techo", "TEXT"), ("ventanas", "TEXT"),
        ("interior", "TEXT"), ("exterior", "TEXT"), ("condiciones_especiales", "TEXT"), ("impuesto_anual", "REAL"), ("hoa", "REAL"), ("fotos_n", "INTEGER"),
        ("piscina", "TEXT"), ("etiqueta", "TEXT"), ("foto", "TEXT")]

MAPA = {  # columna de Matrix -> campo (la primera columna con ese nombre manda; Matrix repite algunas)
    "Listing #": "mls_id", "Mls Status": "estado", "Address": "direccion", "City": "ciudad", "Postal Code": "zip", "County Or Parish": "condado",
    "Parcel Number": "folio", "Subdivision Name": "subdivision", "Bedrooms Total": "beds", "Living Area": "sqft", "Lot Size Area": "lote_sqft",
    "Year Built": "anio", "List Price": "precio_lista", "Close Price": "precio_cierre", "List Date": "fecha_lista", "Close Date": "fecha_cierre",
    "Pending Date": "fecha_pendiente", "Withdrawn Date": "fecha_retirada", "Expiration Date": "fecha_vencida", "DOM": "dom", "Public Remarks": "comentarios",
    "Roof": "techo", "Window Features": "ventanas", "Interior Features": "interior", "Exterior Features": "exterior",
    "Special Listing Conditions": "condiciones_especiales", "Tax Annual Amount": "impuesto_anual", "Association Fee": "hoa", "Photos Count": "fotos_n",
    "Pool Features": "piscina",
}


def num(v):
    v = re.sub(r"[^\d.\-]", "", str(v or ""))
    try:
        return float(v) if v not in ("", "-", ".") else None
    except ValueError:
        return None


def fecha(v):
    m = re.match(r"\s*(\d{1,2})/(\d{1,2})/(\d{4})", str(v or ""))
    return f"{m.group(3)}-{int(m.group(1)):02d}-{int(m.group(2)):02d}" if m else None


def abrir_db():
    os.makedirs(RAIZ, exist_ok=True)
    con = sqlite3.connect(DB)
    con.execute(f"CREATE TABLE IF NOT EXISTS listado ({', '.join(f'{c} {t}' for c, t in COLS)}, PRIMARY KEY (mls_id, snapshot))")
    con.execute("CREATE INDEX IF NOT EXISTS ix_listado_zip ON listado (zip, estado)")
    con.execute("CREATE INDEX IF NOT EXISTS ix_listado_folio ON listado (folio)")
    con.execute("CREATE TABLE IF NOT EXISTS importaciones (sha1 TEXT PRIMARY KEY, archivo TEXT, etiqueta TEXT, snapshot TEXT, filas INTEGER, importado_en TEXT)")
    return con


def filas_csv(texto):
    lector = csv.reader(io.StringIO(texto))
    cab = next(lector)
    idx = {}
    for i, c in enumerate(cab):
        c = c.strip()
        if c in MAPA and MAPA[c] not in idx:
            idx[MAPA[c]] = i
    full, half = (cab.index("Full Baths") if "Full Baths" in cab else None), (cab.index("Half Baths") if "Half Baths" in cab else None)
    for r in lector:
        if not r or not r[0].strip():
            continue
        d = {k: (r[i].strip() if i < len(r) else "") for k, i in idx.items()}
        d["baths"] = (num(r[full]) or 0) + 0.5 * (num(r[half]) or 0) if full is not None else None
        yield d


def importar(ruta, etiqueta="", snapshot=None, con=None):
    con = con or abrir_db()
    datos = open(ruta, "rb").read()
    sha = hashlib.sha1(datos).hexdigest()
    if con.execute("SELECT 1 FROM importaciones WHERE sha1=?", (sha,)).fetchone():
        return {"archivo": os.path.basename(ruta), "filas": 0, "omitido": "ya importado"}
    snap = snapshot or dt.date.fromtimestamp(os.path.getmtime(ruta)).isoformat()
    fotos = {}
    if ruta.lower().endswith(".zip"):
        z = zipfile.ZipFile(io.BytesIO(datos))
        nombre = next(n for n in z.namelist() if n.lower().endswith(".csv"))
        texto = z.read(nombre).decode("utf-8-sig", "replace")
        os.makedirs(FOTOS, exist_ok=True)
        for n in z.namelist():
            if n.lower().endswith((".jpg", ".jpeg", ".png")):
                destino = os.path.join(FOTOS, os.path.basename(n))
                if not os.path.exists(destino):
                    open(destino, "wb").write(z.read(n))
                fotos[os.path.splitext(os.path.basename(n))[0]] = destino
    else:
        texto = datos.decode("utf-8-sig", "replace")
    n = 0
    for d in filas_csv(texto):
        reg = {c: None for c, _ in COLS}
        for k, v in d.items():
            reg[k] = v if k not in ("beds", "sqft", "lote_sqft", "anio", "precio_lista", "precio_cierre", "dom", "impuesto_anual", "hoa", "fotos_n", "baths") else num(v)
        for k in ("fecha_lista", "fecha_cierre", "fecha_pendiente", "fecha_retirada", "fecha_vencida"):
            reg[k] = fecha(reg[k])
        reg["anio"] = int(reg["anio"]) if reg["anio"] else None
        reg["zip"] = (reg["zip"] or "")[:5]
        reg["snapshot"], reg["etiqueta"], reg["foto"] = snap, etiqueta, fotos.get(reg["mls_id"])
        con.execute(f"INSERT OR REPLACE INTO listado ({', '.join(reg)}) VALUES ({', '.join('?' * len(reg))})", list(reg.values()))
        n += 1
    con.execute("INSERT INTO importaciones VALUES (?,?,?,?,?,?)", (sha, os.path.basename(ruta), etiqueta, snap, n, dt.datetime.now().isoformat(timespec="seconds")))
    con.commit()
    return {"archivo": os.path.basename(ruta), "filas": n, "snapshot": snap, "etiqueta": etiqueta}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ruta", help="carpeta con las exportaciones o un archivo .zip/.csv")
    ap.add_argument("--etiqueta", default="", help="oportunidades | motivados | cerradas | comparables (por defecto, el nombre del archivo)")
    ap.add_argument("--snapshot", help="fecha de la exportación AAAA-MM-DD (por defecto, la del archivo)")
    a = ap.parse_args()
    archivos = [os.path.join(a.ruta, f) for f in sorted(os.listdir(a.ruta)) if f.lower().endswith((".zip", ".csv"))] if os.path.isdir(a.ruta) else [a.ruta]
    con = abrir_db()
    for f in archivos:
        et = a.etiqueta or re.sub(r"[^a-z]+", "-", os.path.splitext(os.path.basename(f))[0].lower()).strip("-")
        print(importar(f, et, a.snapshot, con))
    print("total en la base:", con.execute("SELECT COUNT(*) FROM listado").fetchone()[0])
    resumen(con)


def resumen(con):
    """Qué falta para trabajar: códigos postales con oportunidades pero sin ventas cerradas recientes, y qué hay de nuevo."""
    ult = con.execute("SELECT MAX(snapshot) FROM listado WHERE estado IN ('Active','Coming Soon')").fetchone()[0]
    if not ult:
        return
    act = con.execute("SELECT COUNT(*) FROM listado WHERE snapshot=? AND estado IN ('Active','Coming Soon')", (ult,)).fetchone()[0]
    previo = con.execute("SELECT MAX(snapshot) FROM listado WHERE snapshot<? AND estado IN ('Active','Coming Soon')", (ult,)).fetchone()[0]
    nuevas = con.execute("SELECT COUNT(*) FROM listado a WHERE a.snapshot=? AND a.estado IN ('Active','Coming Soon') AND NOT EXISTS (SELECT 1 FROM listado b WHERE b.mls_id=a.mls_id AND b.snapshot<?)", (ult, ult)).fetchone()[0] if previo else act
    cortes = con.execute("SELECT COUNT(*) FROM listado a JOIN listado b ON b.mls_id=a.mls_id AND b.snapshot=? WHERE a.snapshot=? AND a.precio_lista<b.precio_lista", (previo, ult)).fetchone()[0] if previo else 0
    print(f"Activas en {ult}: {act} ({nuevas} nuevas, {cortes} con rebaja desde {previo or 'la exportación anterior'})")
    sin = [z for z, in con.execute("""SELECT a.zip FROM listado a WHERE a.snapshot=? AND a.estado IN ('Active','Coming Soon') AND a.zip<>''
        GROUP BY a.zip HAVING (SELECT COUNT(*) FROM listado c WHERE c.zip=a.zip AND c.estado='Closed' AND c.fecha_cierre>=date('now','-180 day'))<10 ORDER BY COUNT(*) DESC""", (ult,))]
    if sin:
        print("Códigos postales sin historial de ventas (exportar D con estos):", ", ".join(sin))


if __name__ == "__main__":
    main()
