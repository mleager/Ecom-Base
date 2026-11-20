#!/usr/bin/env bash
# Release image and evidence (Milestone 16, task 6). Builds the application
# image from the committed tree only (git archive HEAD), checks it, and prints
# the evidence as Markdown: identity, image, base images, versions and tools.
# It never reads .env files, certificates or fixture bundles.
#
#   bash scripts/release-evidence.sh 1.0.0                # print to stdout
#   bash scripts/release-evidence.sh 1.0.0 evidence.md    # or write a file
#
# VARIANT (default base) names the build: the image is ecom-<variant>:<version>
# (published as ghcr.io/mleager/ecom-<variant>). A fault variant must also set
# DESCRIPTION to say what is broken on purpose. It refuses to replace an
# existing ecom-<variant>:<version> tag.
#
# Everything (the image and the recorded versions) comes from the commit, so
# uncommitted changes are never in it; the script warns when there are any.
# Run the image with ECOM_IMAGE=ecom-base:<version> bash scripts/dev.sh deploy.

set -euo pipefail

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

project_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
cd -- "$project_root"
export GOTOOLCHAIN=local

version=${1:-}
output=${2:-}
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'usage: release-evidence.sh <major.minor.patch> [output.md]'
dirty=false
[[ -z $(git status --porcelain) ]] || dirty=true
node_bin="$HOME/.nvm/versions/node/v24.20.0/bin"
[[ -x $node_bin/node ]] && export PATH="$node_bin:$PATH"

variant=${VARIANT:-base}
[[ $variant =~ ^[a-z][a-z0-9-]*$ ]] || fail 'VARIANT must be lowercase letters, digits and hyphens'
[[ $variant == base || -n ${DESCRIPTION:-} ]] || fail 'a fault variant needs DESCRIPTION saying what is broken on purpose'
build_args=(--build-arg "VERSION=$version" --build-arg "VARIANT=$variant")
[[ -n ${DESCRIPTION:-} ]] && build_args+=(--build-arg "DESCRIPTION=$DESCRIPTION")

commit=$(git rev-parse HEAD)
image=ecom-$variant:$version
# A rebuild gets a new image ID (builds are not bit-for-bit reproducible), so
# an existing release tag is never replaced: its recorded evidence would lie.
if existing=$(docker image inspect -f '{{.Id}}' "$image" 2>/dev/null); then
  fail "$image already exists ($existing); to build it again, first run: docker image rm $image"
fi
work=$(mktemp -d)
containers=()
cleanup() {
  local status=$?
  ((${#containers[@]})) && docker rm -f "${containers[@]}" >/dev/null 2>&1
  rm -rf -- "$work"
  exit "$status"
}
trap cleanup EXIT

# 1. Build from the committed tree. Untracked and ignored files (.env*,
#    .cache, node_modules) are not in the archive at all.
mkdir "$work/context"
git archive --format=tar HEAD | tar -x -C "$work/context"
printf 'Building %s from %s...\n' "$image" "${commit:0:12}" >&2
docker build "${build_args[@]}" --build-arg "REVISION=$commit" -t "$image" "$work/context" >"$work/build.log" 2>&1 \
  || { tail -30 "$work/build.log" >&2; fail 'image build failed'; }

# 2. Check the image: user, labels, and nothing added beyond the binaries,
# dist and the public Amazon RDS CA bundle (M17).
inspect() { docker image inspect -f "$1" "$image"; }
image_id=$(inspect '{{.Id}}')
user=$(inspect '{{.Config.User}}')
label() { inspect "{{index .Config.Labels \"org.opencontainers.image.$1\"}}"; }
[[ $user == 65532:65532 ]] || fail "image user is $user, expected 65532:65532"
[[ $(label revision) == "$commit" && $(label version) == "$version" ]] || fail 'revision or version label does not match'
[[ $(inspect '{{index .Config.Labels "io.github.mleager.ecom.variant"}}') == "$variant" && $(label title) == "ecom-$variant" ]] \
  || fail 'variant or title label does not match'
[[ $(label source) == https://github.com/mleager/Ecom-Base ]] || fail 'source label does not name the repository'
size_mb=$(inspect '{{.Size}}' | awk '{printf "%.1f", $1 / 1000000}')
runtime_base=$(grep -m1 -oE '^FROM gcr\.io/distroless/[^ ]+' "$work/context/Dockerfile" | cut -d' ' -f2)
[[ $(label base.digest) == "${runtime_base#*@}" ]] || fail 'base.digest label does not match the Dockerfile'
file_list() {
  local id
  id=$(docker create "$1" /nonexistent)
  containers+=("$id")
  docker export "$id" | tar -t | sed 's:/$::' | sort
}
file_list "$runtime_base" >"$work/base.txt"
file_list "$image" >"$work/image.txt"
comm -13 "$work/base.txt" "$work/image.txt" >"$work/added.txt"
unexpected=$(grep -vE '^(usr/local|usr/local/bin|usr/local/bin/(api|migrate|reconcile|maintain|db-bootstrap)|app|app/dist(/.*)?|etc|etc/ssl|etc/ssl/rds|etc/ssl/rds/global-bundle\.pem)$' "$work/added.txt" || true)
[[ -z $unexpected ]] || fail "unexpected files in the image: $(head -5 <<<"$unexpected" | tr '\n' ' ')"
# The RDS bundle holds only public CA certificates.
secrets=$(grep -v '^etc/ssl/rds/global-bundle\.pem$' "$work/added.txt" |
  grep -iE '(^|/)\.env|\.pem$|\.key$|(^|/)\.cache(/|$)|(^|/)\.git(/|$)|node_modules|catalog\.v[0-9]+\.json|\.map$' || true)
[[ -z $secrets ]] || fail "secret or development files in the image: $(head -5 <<<"$secrets" | tr '\n' ' ')"
dist_files=$(grep -cE '^app/dist/.+\.[a-z0-9]+$' "$work/added.txt")
docker run --rm "$image" reconcile --help >/dev/null 2>&1 || fail 'reconcile --help did not run in the image'
docker run --rm "$image" maintain --help >/dev/null 2>&1 || fail 'maintain --help did not run in the image'
docker run --rm "$image" db-bootstrap --help >/dev/null 2>&1 || fail 'db-bootstrap --help did not run in the image'
# The runtime user must be able to read the RDS CA bundle: with it, parsing a
# verify-full configuration succeeds and the run fails only at connecting.
bundle_check=$(docker run --rm -e APP_ENV=production -e DB_HOST=127.0.0.1 -e DB_PORT=1 -e DB_NAME=ecom \
  -e DB_USER=check -e DB_PASSWORD=check-password-0001 -e DB_SSLROOTCERT=/etc/ssl/rds/global-bundle.pem \
  -e MIGRATOR_PASSWORD=check-password-0002 -e APP_DB_PASSWORD=check-password-0003 "$image" db-bootstrap 2>&1 || true)
[[ $bundle_check == *'could not connect to PostgreSQL'* ]] || fail "RDS CA bundle not usable by the runtime user: $bundle_check"

# 3. Versions recorded in the committed source.
cd -- "$work/context"
migrations=$(find backend/migrations -maxdepth 1 -name '*.sql' | wc -l)
min_schema=$(grep -oE 'MinSchemaVersion( int64)? *= *[0-9]+' backend/internal/platform/database/database.go | grep -oE '[0-9]+$')
openapi=$(grep -m1 -E '^  version:' docs/api/openapi.yaml | awk '{print $2}')
fixture=$(python3 -c 'import json; print(json.load(open("fixtures/catalog.v1.json"))["version"])')
contract=$(grep -m1 -oE 'Contract version [0-9]+' docs/updated/backend/OBSERVABILITY_CONTRACT.md | grep -oE '[0-9]+$')
go_directive=$(awk '$1 == "go" {print $2; exit}' go.mod)
for value in "$min_schema" "$openapi" "$fixture" "$contract" "$go_directive"; do
  [[ -n $value ]] || fail 'could not read a version from the committed source'
done

# 4. Tools on the build host.
cd -- "$project_root"
os_name=$(. /etc/os-release && printf '%s' "$PRETTY_NAME")
playwright=$(cd frontend && npx --no-install playwright --version 2>/dev/null || printf 'not installed')
row() { printf '| %s | %s |\n' "$1" "$2"; }

{
  printf '## Release %s (%s)\n\n' "$version" "ecom-$variant"
  printf 'Generated by `bash scripts/release-evidence.sh %s` on %s.\n\n' "$version" "$(date -u +%Y-%m-%dT%H:%MZ)"
  printf '| Item | Value |\n|---|---|\n'
  row 'Source commit' "\`$commit\`$($dirty && printf ' (working tree had uncommitted changes, not in the image)')"
  row 'Image tag (local)' "\`$image\`"
  row 'Image ID (config digest)' "\`$image_id\`"
  row 'Image size' "$size_mb MB"
  row 'Runs as' "\`$user\`"
  row 'Contents added to the base' "\`/usr/local/bin/{api,migrate,reconcile,maintain,db-bootstrap}\`, \`/app/dist\` ($dist_files files), \`/etc/ssl/rds/global-bundle.pem\` (public RDS CAs); no \`.env\`, key, private certificate, \`.cache\`, \`.git\`, \`node_modules\`, fixture bundle or source map"
  row 'Labels' "\`version=$(label version)\`, \`variant=$variant\`, \`revision=$(label revision | cut -c1-12)…\`, \`source\` names the GitHub repository, \`base.digest\` matches the runtime base"
  row 'Description' "$(label description)"
  row 'Schema' "$migrations migrations; readiness minimum version $min_schema"
  row 'OpenAPI' "$openapi"
  row 'Fixture data' "version $fixture"
  row 'Observability contract' "version $contract"
  row 'Go directive (go.mod)' "$go_directive"
  printf '\n### Base and service images\n\n| Use | Reference |\n|---|---|\n'
  while read -r _ ref _ stage; do
    row "build: \`${stage:-runtime}\`" "\`$ref\`"
  done < <(grep -E '^FROM ' "$work/context/Dockerfile")
  while read -r _ ref; do
    row 'Compose service' "\`$ref\`"
  done < <(grep -E '^ +image: [a-z]' "$work/context/compose.deploy.yaml" | sort -u)
  printf '\n### Build host tools\n\n| Tool | Version |\n|---|---|\n'
  row 'OS / kernel' "$os_name / $(uname -r)"
  row 'Docker Engine' "$(docker version -f '{{.Server.Version}}')"
  row 'Buildx' "$(docker buildx version | awk '{print $2}')"
  row 'Compose' "$(docker compose version --short)"
  row 'Go' "$(go version | awk '{print $3}')"
  row 'Node / npm' "$(node --version) / $(npm --version)"
  row 'Playwright' "$playwright"
  row 'goose' "$(goose -version 2>&1 | awk '{print $3}')"
  row 'sqlc' "$(sqlc version)"
  row 'govulncheck' "$(govulncheck -version 2>&1 | awk '/Scanner/ {print $2}')"
  row 'OpenSSL' "$(openssl version | awk '{print $2}')"
  row 'Git' "$(git --version | awk '{print $3}')"
} >"${output:-/dev/stdout}"
printf 'PASS: %s built from %s and checked (user 65532, labels, contents).\n' "$image" "${commit:0:12}" >&2
! $dirty || printf 'Note: the working tree has uncommitted changes; they are not in the image or the evidence.\n' >&2
