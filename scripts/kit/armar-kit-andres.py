#!/usr/bin/env python3
"""Arma el kit del PC ejecutor de Andres (instalar o actualizar) con las versiones actuales.

    python scripts/kit/armar-kit-andres.py

Toma: los scripts del ejecutor de este repo, el Intake Service, "0. Base formatos" (la misma selección de archivos que ya tenía el
kit anterior, con sus versiones actuales), los paquetes .skill de Tier 1 y Tier 2, y la guía de instalación. Escribe
<Claude Code>\\Kit PC ejecutor\\Kit-PC-Andres.zip (reemplaza al anterior: no quedan kits viejos).
"""
import os
import sys
import zipfile

HOME = os.path.expanduser("~")
CC = os.path.join(HOME, "OneDrive", "Documents", "1. Proyecto Real State US", "Claude Code")
KITDIR = os.path.join(CC, "Kit PC ejecutor")
ZIP = os.path.join(KITDIR, "Kit-PC-Andres.zip")
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BASE = os.path.join(HOME, "OneDrive", "Documents", "4. Ejecucion de procesos", "1. Underwriting", "0. Base formatos")
INTAKE = os.path.join(CC, "Intake Service")
SKILLS = [os.path.join(HOME, "OneDrive", "Documents", "1. Proyecto Real State US", d) for d in ("Skills Underwriting Propiedades", "Skills Underwriting Terrenos")]
EXCLUIR = (".bak", ".pyc", ".log", ".intake_token", ".project_dir")


def main():
    if not os.path.exists(ZIP):
        sys.exit("Falta el kit anterior: de él se toma la lista de archivos de '0. Base formatos'")
    previo = zipfile.ZipFile(ZIP)
    manifiesto = [n for n in previo.namelist() if n.startswith("0. Base formatos/") and not n.endswith("/") and not n.endswith(EXCLUIR)]
    previo.close()
    entradas = {}  # nombre en el zip -> ruta o bytes
    faltan = []
    for n in manifiesto:
        if n.endswith("datos-estado.ruta.txt"):
            continue  # el de Andres lo escribe el instalador (su rol vive en su propio proyecto)
        ruta = os.path.join(BASE, *n.split("/")[1:])
        (entradas.__setitem__(n, ruta) if os.path.exists(ruta) else faltan.append(n))
    for f in ("README.md", "control_excel.py", "form.html", "iniciar_local.ps1", "server.py"):
        entradas[f"Intake Service/{f}"] = os.path.join(INTAKE, f)
    for f in ("tier1-runner.ps1", "subir-informe.ps1", "instalar-ejecutor.ps1"):
        entradas[f"scripts/{f}"] = os.path.join(REPO, "scripts", f)
    paquetes = {}
    for d in SKILLS:
        for f in os.listdir(d):
            if f.endswith(".skill"):
                paquetes[f] = os.path.join(d, f)
    if "tier1-v2-propiedades.skill" not in paquetes:
        sys.exit("Falta tier1-v2-propiedades.skill: correr python skills/empaquetar.py tier1-v2-propiedades <carpeta de skills>")
    for f, ruta in paquetes.items():
        entradas[f"Skills Underwriting/{f}"] = ruta
    entradas["INSTALACION-PC-ANDRES.md"] = os.path.join(REPO, "scripts", "kit", "INSTALACION-PC-ANDRES.md")
    entradas["LEEME.txt"] = os.path.join(REPO, "scripts", "kit", "LEEME.txt")
    sin = [n for n, r in entradas.items() if not os.path.exists(r)]
    if sin or faltan:
        sys.exit(f"Faltan archivos: {sin + faltan}")
    tmp = ZIP + ".nuevo"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for n, r in sorted(entradas.items()):
            z.write(r, n)
    os.replace(tmp, ZIP)
    print(f"{ZIP}: {len(entradas)} archivos, {os.path.getsize(ZIP) / 1e6:.1f} MB; paquetes .skill: {', '.join(sorted(paquetes))}")


if __name__ == "__main__":
    main()
