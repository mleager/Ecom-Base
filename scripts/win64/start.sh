#!/usr/bin/env bash

set -euo pipefail

echo "---- Start Docker Desktop and local Docker Compose stack ----"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="$PROJECT_ROOT/compose.yml"

echo "  -- Starting Docker Desktop --"

if ! docker desktop start 2>/dev/null; then
  echo "    [-] Error: Failed to invoke Docker Desktop executable." >&2
  exit 1
else
  echo "    [+] Docker Desktop started..."
fi

echo "  ...Waiting for Docker daemon to become responsive..."
MAX_ATTEMPTS=30
ATTEMPT=0
READY=false

while [ "$ATTEMPT" -lt "$MAX_ATTEMPTS" ]; do
  if docker info >/dev/null 2>&1; then
    READY=true
    break
  fi
  ATTEMPT=$((ATTEMPT + 1))
  sleep 1
done

if [ "$READY" = false ]; then
  echo "    [-] Error: Docker daemon failed to start within ${MAX_ATTEMPTS} seconds." >&2
  exit 1
else
  echo "    [+] Docker is ready."
fi

echo "  -- Initializing containers --"
if ! docker compose up -d; then
  echo "    [-] Error: docker compose up failed." >&2
  exit 1
fi

echo "* Infrastructure started successfully."

# ---- ORIGINAL ----
#
# if ! docker desktop start; then
#   echo "docker desktop failed to start..."
#   return 1
# fi
#
# sleep 1
#
# if ! docker compose up -d; then
#   echo "docker compose up failed..."
# fi
#
#
