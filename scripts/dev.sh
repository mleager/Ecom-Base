#!/usr/bin/env bash

set -euo pipefail

# Setup, the main application, tests and the release deployment. Fixture
# databases are in scripts/fixture.sh; psql into the development database with
# scripts/connect.sh. Every command is listed in HOW_TO.md.

source "$(dirname -- "${BASH_SOURCE[0]}")/lib/common.sh"

usage() {
  printf 'Usage: %s <init-env|init-deploy-env|deploy|deploy-down|deploy-verify|database|database-tls|migrate|status|generate|run|serve-https|test|integration|database-tls-check|check> [--race]\n       %s reconcile [--dry-run|--apply] [--limit N]\nFixture databases: scripts/fixture.sh\n' "$0" "$0" >&2
  exit 2
}

[[ $# -ge 1 ]] || usage
action=$1
race=false
reconcile_args=()
case $action in
fixtures | fixtures-https | fixture-check | fixture-run | fixture-remove)
  fail "Fixture commands moved to scripts/fixture.sh (create, list, check, run, serve, psql, remove); see HOW_TO.md." ;;
esac
if [[ $action == reconcile ]]; then
  shift
  reconcile_args=("$@")
elif [[ $action == serve-https && $# -eq 2 ]]; then
  fail 'To serve a fixture over HTTPS, use: scripts/fixture.sh serve <id>'
elif [[ $# -gt 2 ]]; then
  usage
elif [[ $# -eq 2 ]]; then
  case $2 in
  --race | -Race | -r) race=true ;;
  *) usage ;;
  esac
fi

case $action in
init-env | init-deploy-env | deploy | deploy-down | deploy-verify | database | database-tls | migrate | status | generate | run | serve-https | reconcile | test | integration | database-tls-check | check) ;;
*) usage ;;
esac
if [[ $race == true && $action != test && $action != integration ]]; then
  fail '--race is supported only for test and integration.'
fi

cd -- "$project_root"
use_local_go

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

# Per-service env files for the Milestone 16 Compose deployment profile. The
# deployment has its own database volume, so every secret is new and
# independent of .env. Paths and host names are as seen inside the containers:
# the database service is "postgres", the mail-capture service is "mail", and
# certificates from .cache/certs are mounted read-only at /certs.
if [[ $action == init-deploy-env ]]; then
  for deploy_file in .env.postgres .env.migrate .env.deploy; do
    [[ ! -e $deploy_file ]] || fail "$deploy_file already exists; no deployment env file was changed."
  done
  command -v openssl >/dev/null || fail 'openssl is required to generate deployment secrets.'
  postgres_password=$(openssl rand -hex 32)
  migrator_password=$(openssl rand -hex 32)
  app_password=$(openssl rand -hex 32)
  jwt_secret=$(openssl rand -base64 32)
  smtp_password=$(openssl rand -hex 24)
  # Hex passwords need no URL encoding.
  database_options='sslmode=verify-full&sslrootcert=/certs/ca.pem'
  umask 077
  (
    set -C
    cat >.env.postgres <<EOF_POSTGRES
# PostgreSQL service (deployment profile). Bootstraps the roles on an empty volume.
POSTGRES_PASSWORD=$postgres_password
MIGRATOR_PASSWORD=$migrator_password
APP_DB_PASSWORD=$app_password
EOF_POSTGRES
    cat >.env.migrate <<EOF_MIGRATE
# migrate job (deployment profile): schema owner credentials, used only here.
APP_ENV=production
DATABASE_URL=postgresql://ecom_migrator:$migrator_password@postgres:5432/ecom?$database_options
EOF_MIGRATE
    cat >.env.deploy <<EOF_DEPLOY
# api service (deployment profile): runtime credentials, production mode.
APP_ENV=production
HTTP_ADDR=0.0.0.0:8443
FRONTEND_ORIGIN=https://localhost:8443
DATABASE_URL=postgresql://ecom_app:$app_password@postgres:5432/ecom?$database_options
JWT_SECRET_BASE64=$jwt_secret
TLS_CERT_FILE=/certs/server.pem
TLS_KEY_FILE=/certs/server.key
# Production requires SMTP. "mail" is the local capture container; nothing
# leaves the host. The local CA replaces the system roots so its certificate
# verifies.
MAIL_MODE=smtp
SMTP_HOST=mail
SMTP_PORT=1025
SMTP_TLS_MODE=starttls
SMTP_USERNAME=ecom
SMTP_PASSWORD=$smtp_password
MAIL_FROM=no-reply@example.test
SSL_CERT_FILE=/certs/ca.pem
# Telemetry stays off unless these are set (backend/OBSERVABILITY_CONTRACT.md).
# METRICS_ADDR=0.0.0.0:9464
# OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318
EOF_DEPLOY
  ) || fail 'Could not create the deployment env files; remove any partial file before retrying.'
  printf '%s\n' 'Created ignored .env.postgres, .env.migrate and .env.deploy (mode 0600) with new random secrets.'
  exit 0
fi

if [[ -f $env_file ]]; then load_environment_file "$env_file"; fi

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

case $action in
init-env) fail 'init-env must be handled before loading environment.' ;;
deploy)
  # Deployment profile (M16): the application image in production mode.
  for deploy_file in .env.postgres .env.migrate .env.deploy; do
    [[ -f $deploy_file ]] || fail "$deploy_file is missing; run: bash scripts/dev.sh init-deploy-env"
  done
  for cert_file in ca.pem server.pem server.key postgres.pem postgres.key mail.pem mail.key; do
    [[ -f .cache/certs/$cert_file ]] || fail 'Local certificates are missing; run bash scripts/certs.sh first.'
  done
  if [[ -n ${ECOM_IMAGE:-} ]]; then
    # A prebuilt image, such as ecom:1.0.0 from release-evidence.sh or a
    # name@digest: run it as it is, never rebuild or retag it.
    docker image inspect "$ECOM_IMAGE" >/dev/null 2>&1 || fail "Image $ECOM_IMAGE is not present; build or pull it first."
    docker compose -f compose.deploy.yaml up -d --no-build --wait --wait-timeout 180
  else
    ECOM_REVISION=$(git rev-parse HEAD 2>/dev/null || printf unknown)
    export ECOM_REVISION ECOM_VERSION="${ECOM_VERSION:-dev}"
    docker compose -f compose.deploy.yaml up -d --build --wait --wait-timeout 180
  fi
  printf '%s\n' 'Deployment ready: https://localhost:8443 (trust .cache/certs/ca.pem); captured mail: http://localhost:8025' >&2
  ;;
deploy-verify)
  # Owned verification project with new volumes, removed afterwards (task 5).
  exec bash scripts/deploy-verify.sh
  ;;
deploy-down)
  # Stops and removes the containers; the database volume is kept.
  docker compose -f compose.deploy.yaml down
  ;;
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
serve-https)
  # The development database; scripts/fixture.sh serve uses a fixture instead.
  require_setting APP_DB_PASSWORD
  database_url ecom_app "$APP_DB_PASSWORD"
  export DATABASE_URL="$database_url_result"
  serve_https_api
  ;;
reconcile)
  require_setting APP_DB_PASSWORD
  database_url ecom_app "$APP_DB_PASSWORD"
  export DATABASE_URL="$database_url_result"
  go run ./backend/cmd/reconcile "${reconcile_args[@]}"
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
  # Reachable known vulnerabilities fail the check; it queries vuln.go.dev, so it needs network access.
  command -v govulncheck >/dev/null || fail 'govulncheck is required: go install golang.org/x/vuln/cmd/govulncheck@v1.9.0'
  govulncheck ./...
  go test ./...
  ;;
*) usage ;;
esac
