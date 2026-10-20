#!/usr/bin/env bash
# Administra los buzones de correo que alimentan el tablero (se corre en el servidor, desde ~/monitor).
#   ./scripts/correo.sh listar
#   ./scripts/correo.sh agregar     (pide servidor, usuario y contraseña; esta no se muestra ni queda en el historial)
#   ./scripts/correo.sh quitar <usuario|número>
# Edita el .env (EMAIL_*, EMAIL_2_* ... EMAIL_9_*) y reinicia el monitor. No toca los correos del buzón.
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE="${ENV_FILE:-.env}"
[ -f "$ENV_FILE" ] || { echo "No existe $ENV_FILE"; exit 1; }
SUFIJOS=("" _2 _3 _4 _5 _6 _7 _8 _9)

valor() { grep -E "^EMAIL$1_$2=" "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '"' || true; }
ocupado() { [ -n "$(valor "$1" HOST)" ] || [ -n "$(valor "$1" USER)" ]; }

listar() {
  local n=0 hay=0
  for s in "${SUFIJOS[@]}"; do
    n=$((n + 1))
    if ocupado "$s"; then
      hay=1
      puerto="$(valor "$s" PORT)"; solo="$(valor "$s" SOLO_NUEVOS)"
      echo "$n) $(valor "$s" USER) @ $(valor "$s" HOST):${puerto:-993}  contraseña: $([ -n "$(valor "$s" PASS)" ] && echo puesta || echo FALTA)  solo-nuevos: ${solo:-no}"
    fi
  done
  [ "$hay" = 1 ] || echo "No hay cuentas de correo configuradas."
}

reiniciar() { docker compose up -d --no-build 2>&1 | tail -1; }

quitar_sufijo() {
  local s="$1"
  sed -i -E "/^EMAIL${s}_(HOST|PORT|USER|PASS|SOLO_NUEVOS)=/d" "$ENV_FILE"
}

# Índice (0-8) de la primera cuenta libre o de la cuenta pedida por número o usuario; vacío si no hay
buscar_libre() { for i in "${!SUFIJOS[@]}"; do ocupado "${SUFIJOS[$i]}" || { echo "$i"; return; }; done; }
buscar_cuenta() {
  for i in "${!SUFIJOS[@]}"; do
    s="${SUFIJOS[$i]}"
    if ocupado "$s" && { [ "$1" = "$((i + 1))" ] || [ "$1" = "$(valor "$s" USER)" ]; }; then echo "$i"; return; fi
  done
}

case "${1:-}" in
  listar) listar ;;
  agregar)
    i="$(buscar_libre)"
    [ -n "$i" ] || { echo "Ya hay 9 cuentas (el máximo)."; exit 1; }
    s="${SUFIJOS[$i]}"
    read -rp "Servidor IMAP (ej. mail.midominio.com): " host
    read -rp "Usuario (dirección completa): " usuario
    read -rsp "Contraseña (no se muestra): " clave; echo
    read -rp "¿Importar los correos que ya hay en el buzón? (s/N): " imp
    [ -n "$host" ] && [ -n "$usuario" ] && [ -n "$clave" ] || { echo "Faltan datos."; exit 1; }
    case "$clave" in *\"*) echo 'La contraseña no puede contener comillas dobles (").'; exit 1;; esac
    cp "$ENV_FILE" "$ENV_FILE.bak-correo"
    {
      printf 'EMAIL%s_HOST=%s\nEMAIL%s_USER=%s\nEMAIL%s_PASS="%s"\n' "$s" "$host" "$s" "$usuario" "$s" "$clave"
      case "$imp" in s|S|si|SI|sí) ;; *) printf 'EMAIL%s_SOLO_NUEVOS=true\n' "$s";; esac
    } >> "$ENV_FILE"
    echo "Cuenta agregada."; reiniciar; listar ;;
  quitar)
    [ -n "${2:-}" ] || { echo "Uso: correo.sh quitar <usuario|número>"; exit 1; }
    i="$(buscar_cuenta "$2")"
    [ -n "$i" ] || { echo "No encontré esa cuenta."; listar; exit 1; }
    cp "$ENV_FILE" "$ENV_FILE.bak-correo"
    quitar_sufijo "${SUFIJOS[$i]}"
    echo "Cuenta quitada (los correos del buzón no se tocan; los leads que ya entraron se quedan)."; reiniciar; listar ;;
  *) echo "Uso: correo.sh listar | agregar | quitar <usuario|número>"; exit 1 ;;
esac
