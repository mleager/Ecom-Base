#!/usr/bin/env bash

set -euo pipefail

echo "---- Stop Docker Desktop and local Docker Compose stack ----"
echo ""

# /c/Users/mark/Documents/Coding/Mentor/Projects/E-Commerce/scripts
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# /c/Users/mark/Documents/Coding/Mentor/Projects/E-Commerce
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
# /c/Users/mark/Documents/Coding/Mentor/Projects/E-Commerce/compose.yaml
COMPOSE_FILE="$PROJECT_ROOT/compose.yaml"

# C:\Users\mark\Documents\Coding\Mentor\Projects\E-Commerce\compose.yaml
p=$(docker compose ls | grep -i running | awk '{print $3}')
# /c/Users/mark/Documents/Coding/Mentor/Projects/E-Commerce/compose.yaml
path=$(cygpath "$p")

# # if [[ "$path" == "$COMPOSE_FILE" ]]; then
#   echo "path is to the compose file"
#   echo "$path == $COMPOSE_FILE"
# else
#   echo "path is NOT to the compose file"
#   echo "$path != $COMPOSE_FILE"
# fi

if [[ "$path" != "$COMPOSE_FILE" ]]; then
  echo "* Local Compose file is not running."
else
  echo "  -- Stoping local Compose stack --"
  if ! docker compose -f "$path" down; then
    echo "    [-] Error: Local Compose failed to close..."
    echo ""
  else
    echo "    [+] Local Docker Compose stack stopped..."
    echo ""
  fi
fi

is_active=$(tasklist 2>/dev/null | grep -i docker)

if [[ -n "$is_active" ]]; then
  echo "  -- Stoping Docker Desktop --"
  if ! docker desktop stop >/dev/null 2>&1; then
    echo "    [-] Error: Docker failed to stop..."
  else
    echo "    [+] Stopping Docker Desktop..."
  fi

  echo "  ...Waiting for background engine processes to spin down..."
  sleep 3

  echo "  ...Cleaning up Docker WSL distributions..."
  wsl --shutdown
  # wsl --terminate docker-desktop >/dev/null 2>&1

  echo "  [+] Docker WSL stopped."
else
  echo "* Docker Desktop process is not running."
fi

# ---- ORIGIANL ----
#
#local is_active=$(tasklist 2>/dev/null | grep -i docker)
#if [[ -n "$is_active" ]]; then
#  docker compose down
#  sleep 1
#  docker desktop stop
#  sleep 1
#  wsl --shutdown
#else
#  echo "docker isn't running..."
#fi
