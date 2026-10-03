#!/bin/zsh
set -euo pipefail

if [[ "$#" -ne 2 ]]; then
  print -u2 "Usage: service-wrapper.sh <node> <repository>"
  exit 64
fi

node_bin="$1"
repository="$2"
support="$HOME/Library/Application Support/Roundhouse"
runtime_env="$support/neon.env"

if [[ -e "$runtime_env" ]]; then
  if [[ ! -f "$runtime_env" || -L "$runtime_env" ]]; then
    print -u2 "Roundhouse runtime environment must be a regular file."
    exit 78
  fi
  if [[ "$(/usr/bin/stat -f '%u' "$runtime_env")" != "$EUID" ]]; then
    print -u2 "Roundhouse runtime environment must be owned by the service user."
    exit 78
  fi
  case "$(/usr/bin/stat -f '%Lp' "$runtime_env")" in
    400|600) ;;
    *)
      print -u2 "Roundhouse runtime environment must have mode 400 or 600."
      exit 78
      ;;
  esac
  set -a
  source "$runtime_env"
  set +a
  unset DATABASE_URL_UNPOOLED NEON_BRANCH
fi

exec "$node_bin" "$repository/src/server/app-server.js"
