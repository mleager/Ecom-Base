# Shared helpers for scripts/dev.sh, scripts/fixture.sh and scripts/connect.sh.
# Source it; it only defines variables and functions and changes no shell
# options or directories:
#
#   source "$(dirname -- "${BASH_SOURCE[0]}")/lib/common.sh"
#   cd -- "$project_root"

project_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
env_file="$project_root/.env"
# Local HTTPS run mode (dev.sh serve-https, fixture.sh create --https and serve).
https_address=127.0.0.1:8443
https_origin=https://localhost:8443

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

# Go always runs with the pinned local toolchain and a project build cache.
use_local_go() {
  export GOTOOLCHAIN=local
  export GOCACHE="$project_root/.cache/go-build"
}

# Exports plain KEY=value lines; no shell evaluation or expansion.
load_environment_file() {
  local line
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line%$'\r'}
    if [[ $line =~ ^[[:space:]]*$ || $line =~ ^[[:space:]]*# ]]; then
      continue
    fi
    if [[ ! $line =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]]; then
      fail 'Invalid .env entry: use plain KEY=value syntax.'
    fi
    export "${BASH_REMATCH[1]}=${BASH_REMATCH[2]}"
  done <"$1"
}

require_setting() {
  local name=$1
  [[ -n ${!name:-} ]] || fail "Missing $name; run init-env or provide an explicit process setting."
}

encode_uri_component() {
  local LC_ALL=C value=$1 char escaped i
  encoded=''
  for ((i = 0; i < ${#value}; i++)); do
    char=${value:i:1}
    case $char in
    [a-zA-Z0-9._~-]) encoded+=$char ;;
    *)
      printf -v escaped '%%%02X' "'$char"
      encoded+=$escaped
      ;;
    esac
  done
}

# Sets database_url_result to a loopback URL for the development database.
database_url() {
  local user=$1 password=$2 port=${POSTGRES_PORT:-5432}
  [[ $port =~ ^[0-9]{1,5}$ ]] || fail 'POSTGRES_PORT must be 1-65535.'
  ((10#$port >= 1 && 10#$port <= 65535)) || fail 'POSTGRES_PORT must be 1-65535.'
  encode_uri_component "$password"
  printf -v database_url_result 'postgresql://%s:%s@127.0.0.1:%s/ecom?sslmode=disable' "$user" "$encoded" "$port"
}

# psql inside the development PostgreSQL container: compose_psql <user> <database> <password> [psql args...]
# The password reaches the container through the environment, never the command line.
compose_psql() {
  local user=$1 database=$2 tty=()
  export PGPASSWORD=$3
  shift 3
  [[ -f $env_file ]] || fail '.env is missing; run: bash scripts/dev.sh init-env'
  [[ -t 0 && -t 1 ]] || tty=(-T)
  docker compose --env-file "$env_file" -f "$project_root/compose.yaml" exec "${tty[@]}" -e PGPASSWORD \
    postgres psql -U "$user" -d "$database" "$@"
}

# Builds the same-origin frontend, then serves it and the API on
# https://localhost:8443 in local mode. The caller sets DATABASE_URL and the
# other API settings first; these override HTTP_ADDR, FRONTEND_ORIGIN, TLS and
# STATIC_DIR.
serve_https_api() {
  local cert_file
  for cert_file in ca.pem server.pem server.key; do
    [[ -f $project_root/.cache/certs/$cert_file ]] || fail 'Local certificates are missing; run bash scripts/certs.sh first.'
  done
  command -v npm >/dev/null || fail 'npm is required to build the frontend.'
  [[ -d $project_root/frontend/node_modules ]] || fail 'Install frontend dependencies first: cd frontend && npm ci --strict-peer-deps'
  (cd -- "$project_root/frontend" && npm run --silent build:same-origin) || fail 'Frontend build failed.'
  export APP_ENV=local HTTP_ADDR="$https_address" FRONTEND_ORIGIN="$https_origin" \
    TLS_CERT_FILE="$project_root/.cache/certs/server.pem" TLS_KEY_FILE="$project_root/.cache/certs/server.key" \
    STATIC_DIR="$project_root/frontend/dist"
  printf '%s\n' \
    "Serving $https_origin (trust .cache/certs/ca.pem in your browser). Press Ctrl+C to stop." \
    "Open exactly $https_origin. Any other address for this server, such as https://${https_address}," \
    "fails the API origin check: pages load, but sign-in, the cart and checkout stay disabled." >&2
  cd -- "$project_root"
  go run ./backend/cmd/api
}
