#!/usr/bin/env bash

set -euo pipefail

usage() {
  printf 'Usage: %s <init-env|database|database-tls|migrate|status|generate|run|fixtures|test|integration|database-tls-check|check> [--race]\n       %s reconcile [--dry-run|--apply] [--limit N]\n       %s <fixture-check|fixture-run|fixture-remove> <fixture-name>\n' "$0" "$0" "$0" >&2
  exit 2
}

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

[[ $# -ge 1 ]] || usage
action=$1
race=false
reconcile_args=()
fixture_name=''
if [[ $action == reconcile ]]; then
  shift
  reconcile_args=("$@")
elif [[ $action == fixture-check || $action == fixture-run || $action == fixture-remove ]]; then
  [[ $# -eq 2 && $2 =~ ^ecom_fixture_[a-f0-9]{16}$ ]] || usage
  fixture_name=$2
elif [[ $# -gt 2 ]]; then
  usage
elif [[ $# -eq 2 ]]; then
  case $2 in
  --race | -Race | -r) race=true ;;
  *) usage ;;
  esac
fi

case $action in
init-env | database | database-tls | migrate | status | generate | run | reconcile | fixtures | fixture-check | fixture-run | fixture-remove | test | integration | database-tls-check | check) ;;
*) usage ;;
esac
if [[ $race == true && $action != test && $action != integration ]]; then
  fail '--race is supported only for test and integration.'
fi

project_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
cd -- "$project_root"
export GOTOOLCHAIN=local
export GOCACHE="$project_root/.cache/go-build"
env_file="$project_root/.env"

if [[ $action == init-env ]]; then
  [[ ! -e $env_file ]] || fail '.env already exists; it will not be overwritten.'
  [[ -f .env.example ]] || fail '.env.example missing from project root.'
  command -v openssl >/dev/null || fail 'openssl is required to generate local secrets.'
  postgres_password=$(openssl rand -hex 32)
  migrator_password=$(openssl rand -hex 32)
  app_password=$(openssl rand -hex 32)
  jwt_secret=$(openssl rand -base64 32)
  umask 077
  (
    set -C
    while IFS= read -r line || [[ -n $line ]]; do
      line=${line%$'\r'}
      case $line in
      POSTGRES_PASSWORD=*) line="POSTGRES_PASSWORD=$postgres_password" ;;
      MIGRATOR_PASSWORD=*) line="MIGRATOR_PASSWORD=$migrator_password" ;;
      APP_DB_PASSWORD=*) line="APP_DB_PASSWORD=$app_password" ;;
      JWT_SECRET_BASE64=*) line="JWT_SECRET_BASE64=$jwt_secret" ;;
      esac
      printf '%s\n' "$line"
    done <.env.example >"$env_file"
  ) || fail 'Could not create .env.'
  printf '%s\n' 'Created ignored .env with independent random local secrets.'
  exit 0
fi

load_environment_file() {
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
if [[ -f $env_file ]]; then load_environment_file "$env_file"; fi

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

database_url() {
  local user=$1 password=$2 port=${POSTGRES_PORT:-5432}
  [[ $port =~ ^[0-9]{1,5}$ ]] || fail 'POSTGRES_PORT must be 1-65535.'
  ((10#$port >= 1 && 10#$port <= 65535)) || fail 'POSTGRES_PORT must be 1-65535.'
  encode_uri_component "$password"
  printf -v database_url_result 'postgresql://%s:%s@127.0.0.1:%s/ecom?sslmode=disable' "$user" "$encoded" "$port"
}

file_hash() {
  local result
  if command -v sha256sum >/dev/null; then
    result=$(sha256sum "$1")
  elif command -v shasum >/dev/null; then
    result=$(shasum -a 256 "$1")
  else
    fail 'sha256sum or shasum is required for check.'
  fi
  file_hash_result=${result%% *}
}

if [[ $action == fixtures || $action == fixture-check || $action == fixture-run || $action == fixture-remove ]]; then
  require_setting POSTGRES_PASSWORD
  require_setting MIGRATOR_PASSWORD
  require_setting APP_DB_PASSWORD
  database_url postgres "$POSTGRES_PASSWORD"
  export ECOM_TEST_ADMIN_URL="$database_url_result"
  export ECOM_TEST_MIGRATOR_PASSWORD="$MIGRATOR_PASSWORD"
  export ECOM_TEST_APP_PASSWORD="$APP_DB_PASSWORD"
fi

case $action in
init-env) fail 'init-env must be handled before loading environment.' ;;
database)
  require_setting POSTGRES_PASSWORD
  require_setting MIGRATOR_PASSWORD
  require_setting APP_DB_PASSWORD
  [[ -f $env_file ]] || fail '.env is required for Docker Compose; run init-env.'
  docker compose --env-file "$env_file" -f compose.yaml up -d --wait --pull never postgres
  ;;
database-tls)
  require_setting POSTGRES_PASSWORD
  require_setting MIGRATOR_PASSWORD
  require_setting APP_DB_PASSWORD
  [[ -f $env_file ]] || fail '.env is required for Docker Compose; run init-env.'
  # Check first: Docker would create missing bind-mount sources as directories.
  for cert_file in ca.pem postgres.pem postgres.key; do
    [[ -f .cache/certs/$cert_file ]] || fail 'Local certificates are missing; run bash scripts/certs.sh first.'
  done
  docker compose --env-file "$env_file" -f compose.yaml -f compose.tls.yaml up -d --wait --pull never postgres
  ;;
migrate)
  require_setting MIGRATOR_PASSWORD
  database_url ecom_migrator "$MIGRATOR_PASSWORD"
  export GOOSE_DRIVER=postgres GOOSE_DBSTRING="$database_url_result"
  goose -env=none -dir backend/migrations up
  ;;
status)
  require_setting MIGRATOR_PASSWORD
  database_url ecom_migrator "$MIGRATOR_PASSWORD"
  export GOOSE_DRIVER=postgres GOOSE_DBSTRING="$database_url_result"
  goose -env=none -dir backend/migrations status
  goose -env=none -dir backend/migrations version
  ;;
generate)
  sqlc generate
  ;;
run)
  require_setting APP_DB_PASSWORD
  database_url ecom_app "$APP_DB_PASSWORD"
  export DATABASE_URL="$database_url_result"
  go run ./backend/cmd/api
  ;;
reconcile)
  require_setting APP_DB_PASSWORD
  database_url ecom_app "$APP_DB_PASSWORD"
  export DATABASE_URL="$database_url_result"
  go run ./backend/cmd/reconcile "${reconcile_args[@]}"
  ;;
fixtures)
  go run ./backend/cmd/fixtures create
  ;;
fixture-check)
  go run ./backend/cmd/fixtures check "$fixture_name"
  ;;
fixture-remove)
  go run ./backend/cmd/fixtures remove "$fixture_name"
  ;;
fixture-run)
  go run ./backend/cmd/fixtures check "$fixture_name"
  load_environment_file ".cache/fixtures/$fixture_name/api.env"
  go run ./backend/cmd/api
  ;;
test)
  if [[ $race == true ]]; then
    go test -race ./...
  else
    go test ./...
  fi
  ;;
database-tls-check)
  require_setting APP_DB_PASSWORD
  [[ -f .cache/certs/ca.pem ]] || fail 'Local certificates are missing; run bash scripts/certs.sh first.'
  database_url ecom_app "$APP_DB_PASSWORD"
  export ECOM_DB_TLS=1 ECOM_TEST_TLS_URL="$database_url_result" ECOM_TEST_DB_CA="$project_root/.cache/certs/ca.pem"
  go test -tags=integration -count=1 -v -run '^TestDatabaseTLS$' ./backend/internal/platform/integration/
  ;;
integration)
  require_setting POSTGRES_PASSWORD
  require_setting MIGRATOR_PASSWORD
  require_setting APP_DB_PASSWORD
  database_url postgres "$POSTGRES_PASSWORD"
  export ECOM_TEST_ADMIN_URL="$database_url_result"
  export ECOM_TEST_MIGRATOR_PASSWORD="$MIGRATOR_PASSWORD"
  export ECOM_TEST_APP_PASSWORD="$APP_DB_PASSWORD"
  if [[ $race == true ]]; then
    go test -race -tags=integration -count=1 -v ./...
  else
    go test -tags=integration -count=1 ./...
  fi
  ;;
check)
  unformatted=$(gofmt -l backend fixtures)
  [[ -z $unformatted ]] || fail 'Run gofmt on backend Go files.'
  sqlc vet
  shopt -s nullglob
  generated_before=(backend/internal/db/sqlc/*.go)
  hashes_before=()
  for file in "${generated_before[@]}"; do
    file_hash "$file"
    hashes_before+=("$file_hash_result")
  done
  sqlc generate
  generated_after=(backend/internal/db/sqlc/*.go)
  [[ ${#generated_after[@]} -eq ${#generated_before[@]} ]] || fail 'sqlc output changed; review and commit regenerated files.'
  for ((i = 0; i < ${#generated_after[@]}; i++)); do
    [[ ${generated_after[i]} == "${generated_before[i]}" ]] || fail 'sqlc output changed; review and commit regenerated files.'
    file_hash "${generated_after[i]}"
    [[ $file_hash_result == "${hashes_before[i]}" ]] || fail 'sqlc output changed; review and commit regenerated files.'
  done
  goose -env=none -dir backend/migrations validate
  go vet ./...
  go test ./...
  ;;
*) usage ;;
esac
