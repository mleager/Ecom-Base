#!/usr/bin/env bash
# psql into the development database (ecom) as the postgres superuser, inside
# the development PostgreSQL container. Any arguments go to psql:
#
#   scripts/connect.sh                                   interactive session
#   scripts/connect.sh -c 'select count(*) from users'   one query
#
# Fixture databases: scripts/fixture.sh psql. The release deployment's
# database: see HOW_TO.md (The release image).

set -euo pipefail

source "$(dirname -- "${BASH_SOURCE[0]}")/lib/common.sh"

[[ -f $env_file ]] || fail '.env is missing; run: bash scripts/dev.sh init-env'
load_environment_file "$env_file"
require_setting POSTGRES_PASSWORD
compose_psql postgres ecom "$POSTGRES_PASSWORD" "$@"
