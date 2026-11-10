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
