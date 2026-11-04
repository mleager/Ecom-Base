#!/usr/bin/env bash

if ! docker info >/dev/null 2>&1; then
  echo "docker isn't running..."
  exit 1
fi

pid=$(tasklist 2>/dev/null | grep -i docker | head -n 1 | awk '{print $2}')
if [[ -n "$pid" ]]; then
  echo "docker PID: $pid"
  echo ""
fi

mapfile -t running_containers < <(docker ps --format '{{.Names}}')

if [[ ${#running_containers[@]} -eq 0 ]]; then
  echo "no running containers..."
else
  echo "running containers:"
  echo "-------------------"
  for container in "${running_containers[@]}"; do
    echo "- $container"
  done
fi
