#!/usr/bin/env bash

# Check if fixture already exists - if not, create it
fixpath=$(find .cache/fixtures/ -type d -name "ecom_fixture_*")
if [[ -n "$fixpath" ]]; then
  body=$(cat "$fixpath"/api.env | grep -i ^database | awk -F "=" '{print $2}')
  fixture=$(echo $body | awk -F "/" '{print $4}' | awk -F "?" '{print $1}')
fi

command="$1"

case "$command" in
start)
  if [[ -z "$fixture" ]]; then
    fixture=$(./scripts/dev.sh fixtures | jq -r .fixture)
    body=$(cat .cache/fixtures/"$fixture"/api.env | grep -i ^database | awk -F "=" '{print $2}')
  else
    echo "Fixture alread exists: $fixture"
    echo "Available actions for $fixture: run, stop, connect"
  fi
  ;;
run)
  ./scripts/dev.sh fixture-run "$fixture"
  ;;
stop)
  ./scripts/dev.sh fixture-remove "$fixture"
  ;;
connect)
  user=$(echo $body | awk -F "/" '{print $3}' | awk -F ":" '{print $1}')
  pw=$(echo $body | awk -F "/" '{print $3}' | awk -F ":" '{print $2}' | awk -F "@" '{print $1}')
  docker exec -it -e PGPASSWORD="$pw" ecom-postgres psql -U $user -d $fixture
  ;;
*)
  echo "Usage:"
  echo "- start   : create fixture"
  echo "- run     : fixture-run $fixture"
  echo "- stop    : fixture-remove $fixture"
  echo "- connect : exec into fixtures db"
  ;;
esac

# -- Use Bash Substrings to get values --

# DATABASE_URL=$(cat .cache/fixtures/"$fixture"/api.env | grep DATABASE_URL)
#
# url_body="${DATABASE_URL#postgresql://}"
# echo "URL Body: $url_body"
#
# # 4. Extract User and Password block (everything before the '@')
# user_pass_block="${url_body%%@*}"
# echo "User Pass Block: $user_pass_block"
#
# # Isolate DB_USER (everything before the first ':')
# DB_USER="${user_pass_block%%:*}"
# echo "DB User: $DB_USER"
#
# # Isolate DB_PASSWORD (everything after the first ':')
# DB_PASSWORD="${user_pass_block#*:}"
# echo "DB Password: $DB_PASSWORD"
#
# # 5. Extract Database Name
# # First, remove everything up to the host-to-database slash '/'
# # Result: ecom_fixture_b376986ca0e6b300?sslmode=disable
# db_block="${url_body#*/}"
# echo "DB Block: $db_block"
#
# # Strip away any URL query parameters (everything from '?' onwards)
# DB_NAME="${db_block%%\?*}"
# echo "DB Name: $DB_NAME"
