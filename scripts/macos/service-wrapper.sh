#!/bin/zsh
set -euo pipefail

if [[ "$#" -ne 2 ]]; then
  print -u2 "Usage: service-wrapper.sh <node> <repository>"
  exit 64
fi

node_bin="$1"
repository="$2"
support="$HOME/Library/Application Support/Roundhouse"
relay_env="$support/relay.env"
export ROUNDHOUSE_STORAGE_MODE="local"
export ROUNDHOUSE_RELAY_CA_CERT_FILE="$support/aiven-project-ca.pem"

if [[ -e "$relay_env" ]]; then
  if [[ ! -f "$relay_env" || -L "$relay_env" || "$(stat -f '%u' "$relay_env")" != "$EUID" ]]; then
    print -u2 "Roundhouse relay environment must be a regular file owned by the service user."
    exit 78
  fi
  case "$(stat -f '%Lp' "$relay_env")" in
    400|600) ;;
    *) print -u2 "Roundhouse relay environment must have mode 400 or 600."; exit 78 ;;
  esac
  set -a
  source "$relay_env"
  set +a
fi

if [[ -f "$support/authority.enabled" ]]; then
  if [[ -z "${ROUNDHOUSE_RELAY_DATABASE_URL:-}" || ! -f "$support/aiven-project-ca.pem" ]]; then
    print -u2 "Cloud authority lacks database URL or trusted CA."
    exit 78
  fi
  export ROUNDHOUSE_STORAGE_MODE="postgresql"
  export DATABASE_URL="$ROUNDHOUSE_RELAY_DATABASE_URL"
  export ROUNDHOUSE_AUTHORITY_CA_CERT_FILE="$support/aiven-project-ca.pem"
else
  # Pre-cutover mode never accidentally connects to legacy Neon.
  unset DATABASE_URL DATABASE_URL_UNPOOLED NEON_BRANCH
fi

exec "$node_bin" "$repository/src/server/app-server.js"
