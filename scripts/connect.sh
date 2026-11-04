#!/usr/bin/env bash

_get_pw_cur() {
  grep -E "^POSTGRES_PASSWORD" .env | awk -F "=" '{print $2}'
}

_get_pw_root() {
  grep -E "^POSTGRES_PASSWORD" ../.env | awk -F "=" '{print $2}'
}

_get_container() {
  # docker ps | awk 'NR==2 {print $12}'
  docker ps --format json | jq -r .Names
}

_get_fixture() {
  # find .cache/fixtures/ -type d -name "ecom_fixture_*" | awk -F "/" '{print $3}'
  find .cache/fixtures/ -type d -name "ecom_fixture_*" # returns ./cache/fixtures/ecom_fixture_...
}

command="$1"

case "$command" in
fix)
  fixpath=$(_get_fixture)
  if [[ -n "$fixpath" ]]; then
    body=$(cat "$fixpath"/api.env | grep -i ^database | awk -F "=" '{print $2}')
    user=$(echo $body | awk -F "/" '{print $3}' | awk -F ":" '{print $1}')
    name=$(echo $body | awk -F "/" '{print $4}' | awk -F "?" '{print $1}')
    fixpw=$(echo $body | awk -F "/" '{print $3}' | awk -F ":" '{print $2}' | awk -F "@" '{print $1}')

    docker exec -it -e PGPASSWORD="$fixpw" $(_get_container) psql -U $user -d $name
  else
    echo "No fixture database is running. Check .cache/fixtures to ensure it exists"
  fi

  ;;
"")
  pw=$(_get_pw_cur)
  if [[ -z "$pw" ]]; then
    pw=$(_get_pw_root)
  fi

  docker exec -it -e PGPASSWORD="$pw" $(_get_container) psql -U postgres -d ecom
  ;;
esac

# main() {
#   local fixpath=$(_get_fixture)
#   if [[ -n "$fixpath" ]]; then
#     local body=$(cat "$fixpath"/api.env | grep -i ^database | awk -F "=" '{print $2}')
#     local user=$(echo $body | awk -F "/" '{print $3}' | awk -F ":" '{print $1}')
#     local name=$(echo $body | awk -F "/" '{print $4}' | awk -F "?" '{print $1}')
#     local fixpw=$(echo $body | awk -F "/" '{print $3}' | awk -F ":" '{print $2}' | awk -F "@" '{print $1}')
#
#     docker exec -it -e PGPASSWORD="$fixpw" $(_get_container) psql -U $user -d $name
#     return 0
#
#   else
#
#     local pw=$(_get_pw_cur)
#     if [[ -z "$pw" ]]; then
#       pw=$(_get_pw_root)
#     fi
#
#     docker exec -it -e PGPASSWORD="$pw" $(_get_container) psql -U postgres -d ecom
#   fi
# }
#
# main
# # when using args
# main "$@"
