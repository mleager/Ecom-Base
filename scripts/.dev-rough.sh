#!/usr/bin/env bash

# Global Safeguards: Exit immediately on errors or uninitialized variables
set -euo pipefail

# Print clean script usage instructions
usage() {
  echo "Usage: $0 <action> [--race|-r]"
  echo "Actions: init-env, database, migrate, generate, run, test, integration, check"
  exit 1
}

# Ensure at least an action argument is provided
if [[ $# -lt 1 ]]; then
  usage
fi

# Parse positional arguments
ACTION="$1"
RACE=false

# Check for trailing --race or -r switch flag
if [[ ${2:-} == "--race" || ${2:-} == "-r" ]]; then
  RACE=true
fi

# Validate Action Set
VALID_ACTIONS=("init-env" "database" "migrate" "generate" "run" "test" "integration" "check")
if [[ ! " ${VALID_ACTIONS[*]} " =~ " ${ACTION} " ]]; then
  echo "Error: Invalid action '$ACTION'."
  usage
fi

# Enforce script constraints
if [ "$RACE" = true ] && [[ "$ACTION" != "test" && "$ACTION" != "integration" ]]; then
  echo "Error: --race is supported only for test and integration."
  exit 1
fi

# Save original directory and navigate to project root (Equivalent to Push-Location / Pop-Location)
ORIGINAL_DIR=$(pwd)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cleanup() {
  cd "$ORIGINAL_DIR"
}
trap cleanup EXIT

cd "$PROJECT_ROOT"

# Set baseline Go environment toolchain variables
export GOTOOLCHAIN='local'
export GOCACHE="${PROJECT_ROOT}/.cache/go-build"
ENV_FILE="${PROJECT_ROOT}/.env"

# --- ACTION: INIT-ENV (Handled before reading current environment memory) ---
if [[ "$ACTION" == "init-env" ]]; then
  if [[ -f "$ENV_FILE" ]]; then
    echo "Error: .env already exists; it will not be overwritten."
    exit 1
  fi

  ENV_EXAMPLE="${PROJECT_ROOT}/.env.example"
  if [[ ! -f "$ENV_EXAMPLE" ]]; then
    echo "Error: .env.example missing from project root."
    exit 1
  fi

  CONTENTS=$(cat "$ENV_EXAMPLE")
  KEYS=('POSTGRES_PASSWORD' 'MIGRATOR_PASSWORD' 'APP_DB_PASSWORD' 'JWT_SECRET_BASE64')

  for key in "${KEYS[@]}"; do
    if [[ "$key" == "JWT_SECRET_BASE64" ]]; then
      VALUE=$(openssl rand -base64 32)
    else
      VALUE=$(openssl rand -hex 32 | tr 'A-Z' 'a-z')
    fi
    CONTENTS=$(echo "$CONTENTS" | sed -E "s/^${key}=.*/${key}=${VALUE}/")
  done

  echo "$CONTENTS" >"$ENV_FILE"
  echo "Created ignored .env with independent random local secrets."
  exit 0
fi

# --- LOAD ENVIRONMENT VARIABLES ---
if [[ -f "$ENV_FILE" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    line=$(echo "$line" | tr -d '\r') # Strip Windows CRLF line breaks if present
    if [[ -z "${line}" || "${line}" =~ ^[[:space:]]*# ]]; then
      continue
    fi
    if [[ ! "$line" =~ ^[A-Z][A-Z0-9_*]*=.*$ ]]; then
      echo "Error: Invalid .env entry: use plain KEY=value syntax."
      exit 1
    fi
    export "$line"
  done <"$ENV_FILE"
fi

# --- HELPER UTILITIES ---
require_setting() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "Error: Missing $name; run init-env or provide an explicit process setting."
    exit 1
  fi
  echo "${!name}"
}

database_url() {
  local user="$1"
  local password="$2"
  local port_value="${POSTGRES_PORT:-5432}"

  if [[ ! "$port_value" =~ ^[0-9]+$ ]] || [ "$port_value" -lt 1 ] || [ "$port_value" -gt 65535 ]; then
    echo "Error: POSTGRES_PORT must be 1-65535." >&2
    exit 1
  fi

  # Percent-encode special characters in the database password
  local escaped_password
  escaped_password=$(curl -s -o /dev/null -w "%{url_effective}" --url-query "=$password" "" | cut -c 3-)

  echo "postgresql://${user}:${escaped_password}@127.0.0.1:${port_value}/ecom?sslmode=disable"
}

# --- SUBCOMMAND SWITCH ROUTING ---
case "$ACTION" in
database)
  require_setting "POSTGRES_PASSWORD" >/dev/null
  require_setting "MIGRATOR_PASSWORD" >/dev/null
  require_setting "APP_DB_PASSWORD" >/dev/null
  docker compose --env-file "$ENV_FILE" -f compose.yaml up -d --wait --pull never postgres
  ;;

migrate)
  export GOOSE_DRIVER="postgres"
  export GOOSE_DBSTRING=$(database_url "ecom_migrator" "$(require_setting "MIGRATOR_PASSWORD")")
  goose -env=none -dir backend/migrations up
  ;;

generate)
  sqlc generate
  ;;

run)
  export DATABASE_URL=$(database_url "ecom_app" "$(require_setting "APP_DB_PASSWORD")")
  go run ./backend/cmd/api
  ;;

test)
  if [ "$RACE" = true ]; then
    go test -race ./...
  else
    go test ./...
  fi
  ;;

integration)
  export ECOM_TEST_ADMIN_URL=$(database_url "postgres" "$(require_setting "POSTGRES_PASSWORD")")
  export ECOM_TEST_MIGRATOR_PASSWORD=$(require_setting "MIGRATOR_PASSWORD")
  export ECOM_TEST_APP_PASSWORD=$(require_setting "APP_DB_PASSWORD")
  if [ "$RACE" = true ]; then
    go test -race -tags=integration -count=1 -v ./...
  else
    go test -tags=integration -count=1 ./...
  fi
  ;;

check)
  UNFORMATTED=$(gofmt -l backend)
  if [[ -n "$UNFORMATTED" ]]; then
    echo "Error: Run gofmt on backend Go files."
    exit 1
  fi

  sqlc vet

  declare -A BEFORE_GENERATION
  SQLC_DIR="backend/internal/db/sqlc"

  if [[ -d "$SQLC_DIR" ]]; then
    while IFS= read -r file; do
      if [[ -f "$file" ]]; then
        filename=$(basename "$file")
        hash_val=$(sha256sum "$file" | awk '{print $1}')
        BEFORE_GENERATION["$filename"]="$hash_val"
      fi
    done < <(find "$SQLC_DIR" -maxdepth 1 -type f -name "*.go")
  fi

  sqlc generate

  CURRENT_COUNT=0
  if [[ -d "$SQLC_DIR" ]]; then
    while IFS= read -r file; do
      if [[ -f "$file" ]]; then
        ((CURRENT_COUNT++))
        filename=$(basename "$file")
        hash_val=$(sha256sum "$file" | awk '{print $1}')

        if [[ -z "${BEFORE_GENERATION[$filename]:-}" ]] || [[ "${BEFORE_GENERATION[$filename]}" != "$hash_val" ]]; then
          echo "Error: sqlc output changed; review and commit regenerated files."
          exit 1
        fi
      fi
    done < <(find "$SQLC_DIR" -maxdepth 1 -type f -name "*.go")
  fi

  if [ "$CURRENT_COUNT" -ne "${#BEFORE_GENERATION[@]}" ]; then
    echo "Error: sqlc output changed; review and commit regenerated files."
    exit 1
  fi

  goose -env=none -dir backend/migrations validate
  go vet ./...
  go test ./...
  ;;
esac
