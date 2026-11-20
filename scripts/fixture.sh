#!/usr/bin/env bash
# Fixture databases: disposable demo data with 36 products and three accounts,
# kept apart from the development database (docs/frontend/FIXTURES.md).
# Every command is listed in HOW_TO.md.

set -euo pipefail

source "$(dirname -- "${BASH_SOURCE[0]}")/lib/common.sh"

usage() {
  cat >&2 <<'EOF'
Usage: scripts/fixture.sh <command> [id]

  create [--https]        Create a fixture and print its ID (--https: for https://localhost:8443)
  list                    List the fixtures in .cache/fixtures
  check [id]              Verify the fixture's ownership, schema and private files
  run [id]                Run the API against the fixture over HTTP (frontend: cd frontend && npm run dev)
  serve [id]              Build the frontend and serve both on https://localhost:8443
  psql [id] [psql args]   Open psql on the fixture database as its runtime role
  remove [id] [--yes]     Drop the fixture database and delete its private files

[id] is a full fixture ID or a unique prefix, such as 5d5e. Without one, the
only fixture is used; when there are several, you choose from a list.
Sign-in emails and passwords: .cache/fixtures/<id>/bundle.json (keep private).
EOF
  exit 2
}

fixtures_dir="$project_root/.cache/fixtures"
id_pattern='^ecom_fixture_[a-f0-9]{16}$'

# A fixture is complete when all three private files exist.
fixture_complete() {
  local dir=$fixtures_dir/$1
  [[ -f $dir/metadata.json && -f $dir/bundle.json && -f $dir/api.env ]]
}

fixture_origin() {
  local line
  line=$(grep -m1 '^FRONTEND_ORIGIN=' "$fixtures_dir/$1/api.env" 2>/dev/null) || true
  printf '%s' "${line#FRONTEND_ORIGIN=}"
}

# Prints the chosen fixture ID. $1: optional full ID or unique prefix.
pick_fixture() {
  local want=${1:-} dir id choices=()
  for dir in "$fixtures_dir"/ecom_fixture_*/; do
    id=$(basename -- "$dir")
    [[ $id =~ $id_pattern ]] && fixture_complete "$id" || continue
    [[ -z $want || $id == "$want"* || $id == "ecom_fixture_$want"* ]] || continue
    choices+=("$id  $(fixture_origin "$id")")
  done
  case ${#choices[@]} in
  0) fail "No fixture${want:+ matches $want}; create one with: scripts/fixture.sh create" ;;
  1)
    printf '%s\n' "${choices[0]%% *}"
    return
    ;;
  esac
  [[ -t 0 ]] || fail "Several fixtures${want:+ match $want}; pass an ID: $(printf '%s ' "${choices[@]%% *}")"
  PS3='Fixture number: '
  select id in "${choices[@]}"; do # the menu and prompt go to stderr
    if [[ -n $id ]]; then
      printf '%s\n' "${id%% *}"
      return
    fi
  done
  fail 'No fixture chosen.'
}

# The fixtures tool connects to the local server with the bootstrap roles from .env.
use_fixture_tool() {
  [[ -f $env_file ]] || fail '.env is missing; run: bash scripts/dev.sh init-env'
  load_environment_file "$env_file"
  require_setting POSTGRES_PASSWORD
  require_setting MIGRATOR_PASSWORD
  require_setting APP_DB_PASSWORD
  database_url postgres "$POSTGRES_PASSWORD"
  export ECOM_TEST_ADMIN_URL="$database_url_result"
  export ECOM_TEST_MIGRATOR_PASSWORD="$MIGRATOR_PASSWORD"
  export ECOM_TEST_APP_PASSWORD="$APP_DB_PASSWORD"
  use_local_go
  cd -- "$project_root"
}

[[ $# -ge 1 ]] || usage
command=$1
shift

case $command in
create)
  https=false
  case "$#:${1:-}" in
  0:) ;;
  1:--https) https=true ;;
  *) usage ;;
  esac
  use_fixture_tool
  if $https; then
    # Image URLs and the fixture's api.env use the HTTPS origin, not .env's.
    export HTTP_ADDR="$https_address" FRONTEND_ORIGIN="$https_origin"
  fi
  output=$(go run ./backend/cmd/fixtures create)
  printf '%s\n' "$output"
  if [[ $output =~ \"fixture\":\"(ecom_fixture_[a-f0-9]{16})\" ]]; then
    id=${BASH_REMATCH[1]}
    if $https; then
      printf 'Created %s. Serve it with: scripts/fixture.sh serve %s\n' "$id" "${id#ecom_fixture_}" >&2
    else
      printf 'Created %s. Run it with: scripts/fixture.sh run %s\n' "$id" "${id#ecom_fixture_}" >&2
    fi
  fi
  ;;
list)
  [[ $# -eq 0 ]] || usage
  found=false
  for dir in "$fixtures_dir"/ecom_fixture_*/; do
    [[ -d $dir ]] || continue
    found=true
    id=$(basename -- "$dir")
    if fixture_complete "$id"; then
      printf '%s  %s\n' "$id" "$(fixture_origin "$id")"
    else
      printf '%s  incomplete (missing private files)\n' "$id"
    fi
  done
  $found || printf 'No fixtures. Create one with: scripts/fixture.sh create\n' >&2
  ;;
check)
  [[ $# -le 1 ]] || usage
  id=$(pick_fixture "${1:-}")
  use_fixture_tool
  go run ./backend/cmd/fixtures check "$id"
  ;;
run)
  [[ $# -le 1 ]] || usage
  id=$(pick_fixture "${1:-}")
  use_fixture_tool
  go run ./backend/cmd/fixtures check "$id"
  load_environment_file "$fixtures_dir/$id/api.env"
  printf 'Running the API for %s on %s; open %s (cd frontend && npm run dev). Ctrl+C to stop.\n' \
    "$id" "$HTTP_ADDR" "$FRONTEND_ORIGIN" >&2
  go run ./backend/cmd/api
  ;;
serve)
  [[ $# -le 1 ]] || usage
  id=$(pick_fixture "${1:-}")
  use_fixture_tool
  go run ./backend/cmd/fixtures check "$id"
  load_environment_file "$fixtures_dir/$id/api.env"
  if [[ $FRONTEND_ORIGIN != "$https_origin" ]]; then
    printf '%s\n' "Note: this fixture was created for $FRONTEND_ORIGIN, so its product images will not load here. Use scripts/fixture.sh create --https for HTTPS fixtures." >&2
  fi
  serve_https_api
  ;;
psql)
  want=''
  if [[ $# -gt 0 && $1 != -* ]]; then
    want=$1
    shift
  fi
  id=$(pick_fixture "$want")
  line=$(grep -m1 '^DATABASE_URL=' "$fixtures_dir/$id/api.env") || fail "$id has no DATABASE_URL in api.env."
  [[ ${line#DATABASE_URL=} =~ ^postgres(ql)?://([^:/@]+):([^@]*)@[^/]+/([^?]+) ]] ||
    fail "Could not read the database URL of $id."
  user=${BASH_REMATCH[2]} password=${BASH_REMATCH[3]} database=${BASH_REMATCH[4]}
  printf -v password '%b' "${password//%/\\x}" # undo URL encoding
  compose_psql "$user" "$database" "$password" "$@"
  ;;
remove)
  want='' yes=false
  for arg in "$@"; do
    case $arg in
    --yes) yes=true ;;
    -*) usage ;;
    *)
      [[ -z $want ]] || usage
      want=$arg
      ;;
    esac
  done
  id=$(pick_fixture "$want")
  if ! $yes; then
    [[ -t 0 ]] || fail "Not a terminal; to remove $id without asking, add --yes."
    read -r -p "Remove $id? Its database and private files are deleted. [y/N] " answer
    [[ $answer == [yY] || $answer == [yY][eE][sS] ]] || fail 'Nothing removed.'
  fi
  use_fixture_tool
  go run ./backend/cmd/fixtures remove "$id"
  ;;
-h | --help | help) usage ;;
*) usage ;;
esac
