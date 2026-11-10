#!/usr/bin/env bash
# Deployment verification (Milestone 16, task 5). Runs against its own Compose
# project, ecom-deploy-verify, with new volumes that are removed at the end, so
# the everyday ecom-deploy data and the development database are never touched.
#
#   bash scripts/deploy-verify.sh        # or: bash scripts/dev.sh deploy-verify
#   KEEP=1 bash scripts/deploy-verify.sh # leave the project running for inspection
#   TRACE=1 bash scripts/deploy-verify.sh # keep a Playwright trace of a failed journey
#
# On any failure, the API log is saved to .cache/deploy-verify/api.log before
# the project is removed.
#
# Checks: readiness over HTTPS; a headless Chromium journey (account sign-in,
# a mailed verification link, account checkout, guest checkout accepted and
# rejected, mailed guest order links); reconcile --dry-run and --apply on a
# stranded order inside the deployment; a full restart keeping the data; and
# telemetry exported only when configured.
#
# Requirements: Docker, Go, Node 24.20.0 with frontend dependencies and
# Playwright Chromium, .cache/certs from certs.sh and the files from
# init-deploy-env. Ports 8443, 8025 and 55432 must be free.

set -euo pipefail

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}
pass() { printf 'PASS: %s\n' "$1"; }

project_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
cd -- "$project_root"
export GOTOOLCHAIN=local

project=ecom-deploy-verify
origin=https://localhost:8443
mail_url=http://127.0.0.1:8025
product_id=d0000000-0000-4000-8000-000000000001
base=(-p "$project" -f compose.deploy.yaml -f compose.deploy.verify.yaml)
telemetry=(-p "$project" -f compose.deploy.yaml -f compose.deploy.verify.yaml -f compose.deploy.telemetry.yaml --profile telemetry)
compose() { docker compose "${base[@]}" "$@"; }

for file in .env.postgres .env.migrate .env.deploy; do
  [[ -f $file ]] || fail "$file is missing; run: bash scripts/dev.sh init-deploy-env"
done
for file in ca.pem server.pem server.key postgres.pem postgres.key mail.pem mail.key; do
  [[ -f .cache/certs/$file ]] || fail 'Local certificates are missing; run bash scripts/certs.sh'
done
for port in 8443 8025 55432; do
  if ss -ltn "sport = :$port" | grep -q LISTEN; then
    fail "port $port is in use; stop serve-https or the ecom-deploy profile (bash scripts/dev.sh deploy-down) first"
  fi
done
node_bin="$HOME/.nvm/versions/node/v24.20.0/bin"
[[ -x $node_bin/node ]] && export PATH="$node_bin:$PATH"
[[ $(node --version 2>/dev/null) == v24.20.0 ]] || fail 'Node 24.20.0 is required for the browser journey.'
[[ -d frontend/node_modules ]] || fail 'Install frontend dependencies first: cd frontend && npm ci --strict-peer-deps'

# Role passwords come from .env.postgres without being printed. They are hex,
# so they need no URL encoding.
read_setting() {
  local name=$1 line
  while IFS= read -r line; do
    [[ $line == "$name="* ]] && { printf '%s' "${line#*=}"; return 0; }
  done <.env.postgres
  fail "$name missing from .env.postgres"
}
host_url() {
  printf 'postgresql://%s:%s@localhost:55432/ecom?sslmode=verify-full&sslrootcert=%s' "$1" "$2" "$project_root/.cache/certs/ca.pem"
}
migrator_url=$(host_url ecom_migrator "$(read_setting MIGRATOR_PASSWORD)")
app_url=$(host_url ecom_app "$(read_setting APP_DB_PASSWORD)")

diagnostics=$project_root/.cache/deploy-verify
cleanup() {
  local status=$?
  if ((status != 0)); then
    mkdir -p "$diagnostics"
    docker compose "${telemetry[@]}" logs --no-color --timestamps api migrate >"$diagnostics/api.log" 2>&1 || true
    printf 'Diagnostics: %s (API and migrate logs%s)\n' "$diagnostics" "$([[ ${TRACE:-} == 1 ]] && printf ', Playwright trace of a failed test')" >&2
  fi
  if [[ ${KEEP:-} == 1 ]]; then
    printf 'KEEP=1: project %s left running; remove with docker compose -p %s -f compose.deploy.yaml down -v\n' "$project" "$project" >&2
  else
    docker compose "${telemetry[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT

sql() {
  compose exec -T postgres sh -c 'PGPASSWORD="$MIGRATOR_PASSWORD" psql -X -q -v ON_ERROR_STOP=1 -U ecom_migrator -d ecom -tA' <<<"$1"
}
probe() { curl -s --cacert .cache/certs/ca.pem -o /dev/null -w '%{http_code}' "$origin$1"; }
json_field() { python3 -c "import json,sys; print(json.loads(sys.argv[1]).get(sys.argv[2]))" "$1" "$2"; }
summary_of() { grep '"event":"summary"' <<<"$1" | tail -1; }

# 1. Start on new volumes.
docker compose "${telemetry[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
ECOM_REVISION=$(git rev-parse HEAD) compose up -d --build --wait --wait-timeout 180 >/dev/null 2>&1 \
  || { compose logs --no-color migrate api 2>&1 | tail -20 >&2; fail 'deployment did not become ready'; }
migrate_summary=$(summary_of "$(compose logs --no-log-prefix migrate)")
[[ $(json_field "$migrate_summary" applied) == 13 && $(json_field "$migrate_summary" version) == 13 ]] \
  || fail "migrate summary: $migrate_summary"
[[ $(docker inspect -f '{{.State.ExitCode}}' "$(compose ps -aq migrate)") == 0 ]] || fail 'migrate did not exit 0'
pass 'empty volumes: migrate exited 0 after applying 13 migrations, then the API started'

# 2. Readiness over HTTPS, verified against the local CA.
[[ $(probe /health/live) == 200 && $(probe /health/ready) == 200 ]] || fail 'readiness over HTTPS'
pass '/health/live and /health/ready return 200 over HTTPS (chain verified with ca.pem)'

# 3. Seed one product as the schema owner.
sql "INSERT INTO products(id,sku,name,description,image_url,unit_price_cents,is_active) VALUES('$product_id','DEPLOY-LAMP','Deployment Check Lamp','Seeded by deploy-verify.sh','$origin/fixtures/v1/lamp.svg',2500,true);
INSERT INTO inventory(product_id,quantity_on_hand) VALUES('$product_id',50);" >/dev/null
pass 'seeded one product with 50 units'

# 4. Browser journey. Docker's new veth and bridge interfaces keep "tentative"
#    IPv6 addresses (duplicate address detection) for about a second after the
#    containers start. When they settle, Chromium reports a network change and
#    aborts in-flight requests (net::ERR_NETWORK_CHANGED), so wait for them first.
settle_network() {
  local deadline=$((SECONDS + 10))
  command -v ip >/dev/null || return 0
  while ip -o -6 addr show tentative 2>/dev/null | awk '$2 ~ /^(veth|br-)/ {found = 1} END {exit !found}'; do
    if ((SECONDS >= deadline)); then
      printf 'note: Docker interfaces still have tentative IPv6 addresses after 10 s; continuing\n' >&2
      return 0
    fi
    sleep 0.2
  done
}
settle_network
customer_email="deploy-$(openssl rand -hex 4)@example.test"
customer_password=$(openssl rand -hex 16)
trace_env=()
[[ ${TRACE:-} == 1 ]] && trace_env=("DEPLOY_TRACE_DIR=$diagnostics/playwright")
(
  cd frontend
  DEPLOY_ORIGIN=$origin DEPLOY_MAIL_URL=$mail_url DEPLOY_PRODUCT_ID=$product_id \
    DEPLOY_EMAIL=$customer_email DEPLOY_PASSWORD=$customer_password \
    env "${trace_env[@]}" taskset -c 0-7,10-31 npx playwright test -c playwright.deploy.config.ts
) || fail 'browser journey'
pass 'headless Chromium journey: sign-in, mailed verification link, account checkout, guest acceptance and rejection, mailed guest order links'

# 5. Reconcile inside the deployment.
strand=$(DEPLOYCHECK_APP_URL=$app_url DEPLOYCHECK_MIGRATOR_URL=$migrator_url DEPLOYCHECK_EMAIL=$customer_email \
  go test -tags deploycheck -count=1 -v -run '^TestStrandOrder$' ./backend/internal/deploycheck 2>&1) || { printf '%s\n' "$strand" >&2; fail 'could not create a stranded order'; }
order_id=$(grep -oE 'order_id=[0-9a-f-]{36}' <<<"$strand" | cut -d= -f2)
[[ -n $order_id ]] || fail 'stranded order ID missing'
dry=$(compose run --rm --no-deps -T api reconcile --dry-run 2>/dev/null) || fail 'reconcile --dry-run exited nonzero'
grep -q "\"event\":\"candidate\".*\"$order_id\"\|\"$order_id\".*\"event\":\"candidate\"" <<<"$dry" || fail "dry-run did not list the stranded order: $(summary_of "$dry")"
[[ $(sql "SELECT status FROM orders WHERE id='$order_id'") == pending_payment ]] || fail 'dry-run changed the order'
applied=$(compose run --rm --no-deps -T api reconcile --apply 2>/dev/null) || fail 'reconcile --apply exited nonzero'
[[ $(json_field "$(summary_of "$applied")" settled) == 1 ]] || fail "apply summary: $(summary_of "$applied")"
[[ $(sql "SELECT status FROM orders WHERE id='$order_id'") == confirmed ]] || fail 'stranded order was not confirmed'
again=$(compose run --rm --no-deps -T api reconcile --dry-run 2>/dev/null) || fail 'second dry-run exited nonzero'
[[ $(json_field "$(summary_of "$again")" visited) == 0 ]] || fail "second dry-run still found work: $(summary_of "$again")"
pass 'reconcile in the deployment: --dry-run listed the stranded order unchanged, --apply settled it (confirmed), a second dry-run found nothing'

# 6. Restart the whole profile.
counts="SELECT (SELECT count(*) FROM users)||'/'||(SELECT count(*) FROM orders)||'/'||(SELECT count(*) FROM products)"
before=$(sql "$counts")
compose down >/dev/null 2>&1
compose up -d --wait --wait-timeout 180 >/dev/null 2>&1 || fail 'restart did not become ready'
after=$(sql "$counts")
[[ $before == "$after" ]] || fail "data changed across restart: $before -> $after"
[[ $(json_field "$(summary_of "$(compose logs --no-log-prefix migrate)")" applied) == 0 ]] || fail 'migrate reapplied after restart'
login=$(curl -s --cacert .cache/certs/ca.pem -o /dev/null -w '%{http_code}' -H "Origin: $origin" -H 'X-CSRF-Protection: 1' -H 'Content-Type: application/json' \
  --data-binary @- "$origin/api/v1/auth/login" <<<"{\"email\":\"$customer_email\",\"password\":\"$customer_password\"}")
[[ $login == 200 && $(probe /health/ready) == 200 ]] || fail 'sign-in or readiness after restart'
pass "full restart kept the data (users/orders/products $after), migrate applied 0, the customer still signs in"

# 7. Telemetry: off by default, exported when configured.
traffic() {
  local i
  for i in 1 2 3; do probe /api/v1/products >/dev/null; probe "/api/v1/products/$product_id" >/dev/null; done
}
docker compose "${telemetry[@]}" up -d --wait collector >/dev/null 2>&1 || fail 'collector did not start'
traffic
sleep 12
off_log=$(docker compose "${telemetry[@]}" logs --no-log-prefix collector 2>&1)
! grep -q 'Span #' <<<"$off_log" || fail 'spans arrived while telemetry was unset'
! grep -q 'http_server_request_duration_seconds' <<<"$off_log" || fail 'metrics were scraped while METRICS_ADDR was unset'
! compose logs --no-log-prefix api | grep -q 'telemetry configured' || fail 'API logged telemetry configured while unset'
pass 'telemetry unset: no telemetry configured log, no spans received, no metrics scraped'

docker compose "${telemetry[@]}" up -d --wait --wait-timeout 180 >/dev/null 2>&1 || fail 'API with telemetry did not become ready'
docker compose "${telemetry[@]}" logs --no-log-prefix api | grep -q 'telemetry configured' || fail 'API did not log telemetry configured'
traffic
sleep 12
on_log=$(docker compose "${telemetry[@]}" logs --no-log-prefix collector 2>&1)
grep -q 'Name *: GET /api/v1/products' <<<"$on_log" || fail 'no GET /api/v1/products span reached the collector'
grep -q 'http_server_request_duration_seconds' <<<"$on_log" || fail 'collector did not scrape the metrics listener'
grep -q 'ecom_orders_created_total' <<<"$on_log" || fail 'business counters missing from the scrape'
! grep -q "$customer_email" <<<"$on_log" || fail 'customer email appeared in telemetry'
pass 'telemetry set: request spans exported over OTLP and METRICS_ADDR scraped by the collector, with no customer email in the output'

printf 'All deployment checks passed (project %s, commit %s).\n' "$project" "$(git rev-parse --short HEAD)"
