#!/usr/bin/env python3
"""
Resuelve donde vive `datos-estado/` (el rol estatal de Florida indexado).

Por que no esta dentro de "0. Base formatos"
--------------------------------------------
La base pesa ~820 MB y los .zip otros ~95 MB. "0. Base formatos" la sincroniza
OneDrive, asi que tenerla ahi significaba subir ~900 MB en cada reconstruccion
del indice, sin ganar nada: son datos derivados y reproducibles, no formatos.
Se movio a %LOCALAPPDATA%, que no se sincroniza.

Orden de resolucion
-------------------
CONFIGURACION EXPLICITA -- manda aunque la carpeta no exista todavia:
  1. variable de entorno  UW_DATOS_ESTADO
  2. archivo puntero      0. Base formatos/datos-estado.ruta.txt
                          (una linea con la ruta absoluta; admite %VARIABLES% y ~)

DESCUBRIMIENTO -- gana la primera que exista:
  3. por defecto          %LOCALAPPDATA%/underwriting-rol/datos-estado
  4. heredado             0. Base formatos/datos-estado

Si 1 o 2 apuntan a una carpeta que no existe, se devuelve esa ruta igual y el
script avisa "falta el indice, corre construir_indice_rol.py". Caer en silencio
a otra carpeta seria peor: uno creeria estar consultando una base y estaria
leyendo otra. El paso 4 esta para que nada se rompa si alguien restaura la
carpeta vieja o trabaja en una maquina donde nunca se movio.

Uso:
    from rutas_rol import dir_datos_estado, ruta_db, ruta_meta
    python rutas_rol.py          # imprime que ruta se esta usando y por que
"""

import os
import sys

BASE_FORMATOS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUNTERO = os.path.join(BASE_FORMATOS, "datos-estado.ruta.txt")
HEREDADO = os.path.join(BASE_FORMATOS, "datos-estado")
NOMBRE_DB = "rol_fl_2026P.db"


def _por_defecto():
    local = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~/.local/share")
    return os.path.join(local, "underwriting-rol", "datos-estado")


def _lee_puntero():
    if not os.path.exists(PUNTERO):
        return None
    with open(PUNTERO, encoding="utf-8") as fh:
        for linea in fh:
            linea = linea.strip()
            if linea and not linea.startswith("#"):
                return os.path.expanduser(os.path.expandvars(linea))
    return None


def dir_datos_estado(con_origen=False):
    """Devuelve la carpeta de datos-estado. No la crea.
    Con con_origen=True devuelve (ruta, de_donde_salio).

    Una configuracion EXPLICITA manda aunque la carpeta no exista todavia. Si
    alguien fija UW_DATOS_ESTADO o escribe el puntero, ignorarlo en silencio
    porque esa ruta aun no existe seria hacerle creer que trabaja contra una
    base y estar leyendo otra. Cuando la ruta explicita no existe, quien llama
    se entera por el mensaje normal de "falta el indice".
    Los pasos 3 y 4 si son descubrimiento: ahi gana la primera que exista."""
    env = os.environ.get("UW_DATOS_ESTADO")
    if env:
        ruta = os.path.expanduser(os.path.expandvars(env))
        origen = "variable de entorno UW_DATOS_ESTADO (explicita)"
        if not os.path.isdir(ruta):
            origen += " -- OJO: esa carpeta no existe"
        return (ruta, origen) if con_origen else ruta

    pun = _lee_puntero()
    if pun:
        origen = f"archivo puntero {os.path.basename(PUNTERO)} (explicito)"
        if not os.path.isdir(pun):
            origen += " -- OJO: esa carpeta no existe"
        return (pun, origen) if con_origen else pun

    # Tier 1-V2: ProgramData va antes que LOCALAPPDATA. Los procesos que arranca el ejecutor (PowerShell de la Store)
    # no ven AppData\Local\underwriting-rol, y ahí el skill decía "roll not indexed" (2026-11-04).
    for ruta, origen in ((os.path.join(os.environ.get("PROGRAMDATA", r"C:\ProgramData"), "underwriting-rol", "datos-estado"),
                          "ProgramData (visible para el ejecutor)"),
                         (_por_defecto(), "ruta por defecto en LOCALAPPDATA"),
                         (HEREDADO, "carpeta heredada dentro de 0. Base formatos")):
        if os.path.isdir(ruta):
            return (ruta, origen) if con_origen else ruta

    ruta = _por_defecto()
    return (ruta, "no existe todavia; se creara aqui") if con_origen else ruta


def ruta_db():
    return os.path.join(dir_datos_estado(), NOMBRE_DB)


def ruta_meta():
    return os.path.join(dir_datos_estado(), "_meta.json")


def ruta_raw():
    return os.path.join(dir_datos_estado(), "raw")


def main():
    ruta, origen = dir_datos_estado(con_origen=True)
    print(f"datos-estado : {ruta}")
    print(f"resuelto por : {origen}")
    print(f"existe       : {os.path.isdir(ruta)}")
    for nombre, p in (("db", ruta_db()), ("meta", ruta_meta()), ("raw", ruta_raw())):
        if os.path.exists(p):
            tam = (os.path.getsize(p) / 1e6 if os.path.isfile(p)
                   else sum(os.path.getsize(os.path.join(p, f))
                            for f in os.listdir(p)) / 1e6)
            print(f"  {nombre:4s} {tam:8.1f} MB  {p}")
        else:
            print(f"  {nombre:4s} {'-':>8s}     {p}  (falta)")
    print(f"\nsincronizado por OneDrive: "
          f"{'SI -- conviene moverlo' if 'OneDrive' in ruta else 'no'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
