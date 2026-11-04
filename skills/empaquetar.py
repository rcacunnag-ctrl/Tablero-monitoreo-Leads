#!/usr/bin/env python3
"""Empaqueta un skill de skills/<nombre>/ como <nombre>.skill (zip con la carpeta raíz <nombre>/) y lo copia a las carpetas indicadas.

    python skills/empaquetar.py tier1-v2-propiedades "<carpeta destino>" [...]
"""
import os
import shutil
import sys
import zipfile

nombre, destinos = sys.argv[1], sys.argv[2:]
raiz = os.path.join(os.path.dirname(os.path.abspath(__file__)), nombre)
tmp = os.path.join(os.environ.get("TEMP", "."), f"{nombre}.skill")
with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
    for d, dirs, files in os.walk(raiz):
        dirs[:] = [x for x in dirs if x != "__pycache__"]
        for f in files:
            if f.endswith((".pyc", ".bak")):
                continue
            p = os.path.join(d, f)
            z.write(p, os.path.join(nombre, os.path.relpath(p, raiz)).replace(os.sep, "/"))
for d in destinos:
    os.makedirs(d, exist_ok=True)
    shutil.copy(tmp, d)
    print("copiado a", d)
print(f"{nombre}.skill: {os.path.getsize(tmp) / 1024:.0f} KB")
