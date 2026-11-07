#!/usr/bin/env bash
# Create a local certificate authority and server certificates for HTTPS
# development (Milestone 14). Output goes to the ignored .cache/certs/.
#
#   ca.pem / ca.key              local CA (trust ca.pem only; keep ca.key private)
#   server.pem / server.key      API: localhost, 127.0.0.1, ::1
#   postgres.pem / postgres.key  database: localhost, postgres, 127.0.0.1
#
# The script never overwrites files. If the full set already exists it only
# verifies it. To regenerate, remove .cache/certs/ deliberately and rerun.

set -euo pipefail

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

[[ $# -eq 0 ]] || fail "Usage: $0 (no arguments)"
command -v openssl >/dev/null || fail 'openssl is required.'

project_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
cert_dir="$project_root/.cache/certs"
files=(ca.pem ca.key server.pem server.key postgres.pem postgres.key)

ca_days=3650
# Browsers reject leaf certificates valid for more than 398 days.
leaf_days=397

verify_set() {
  local leaf
  for leaf in server postgres; do
    openssl verify -CAfile "$cert_dir/ca.pem" "$cert_dir/$leaf.pem" >/dev/null 2>&1 \
      || fail "$cert_dir/$leaf.pem does not verify against ca.pem; remove $cert_dir and rerun."
    # The key must match the certificate.
    [[ $(openssl pkey -in "$cert_dir/$leaf.key" -pubout 2>/dev/null) == "$(openssl x509 -in "$cert_dir/$leaf.pem" -noout -pubkey 2>/dev/null)" ]] \
      || fail "$cert_dir/$leaf.key does not match $leaf.pem; remove $cert_dir and rerun."
  done
}

print_paths() {
  local file
  for file in "${files[@]}"; do
    printf '%s\n' "$cert_dir/$file"
  done
}

present=0
for file in "${files[@]}"; do
  [[ -e $cert_dir/$file ]] && present=$((present + 1))
done

if ((present == ${#files[@]})); then
  verify_set
  printf '%s\n' 'Certificates already exist and verify:'
  print_paths
  exit 0
fi
((present == 0)) || fail "$cert_dir is incomplete; remove it deliberately and rerun."

umask 077
mkdir -p -- "$cert_dir"
chmod 700 -- "$cert_dir"

work=$(mktemp -d "$cert_dir/.work.XXXXXX")
trap 'rm -rf -- "$work"' EXIT

new_key() {
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$1" 2>/dev/null
}

# Certificate authority.
new_key "$work/ca.key"
openssl req -x509 -new -key "$work/ca.key" -sha256 -days "$ca_days" \
  -subj '/O=Commerce Lab (local development)/CN=Commerce Lab Local CA' \
  -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -addext 'subjectKeyIdentifier=hash' \
  -out "$work/ca.pem" 2>/dev/null

issue_leaf() {
  local name=$1 common_name=$2 subject_alt_names=$3
  new_key "$work/$name.key"
  openssl req -new -key "$work/$name.key" \
    -subj "/O=Commerce Lab (local development)/CN=$common_name" \
    -out "$work/$name.csr" 2>/dev/null
  printf '%s\n' \
    'basicConstraints=critical,CA:FALSE' \
    'keyUsage=critical,digitalSignature' \
    'extendedKeyUsage=serverAuth' \
    'subjectKeyIdentifier=hash' \
    'authorityKeyIdentifier=keyid' \
    "subjectAltName=$subject_alt_names" >"$work/$name.ext"
  openssl x509 -req -in "$work/$name.csr" -CA "$work/ca.pem" -CAkey "$work/ca.key" \
    -CAcreateserial -CAserial "$work/ca.srl" -sha256 -days "$leaf_days" \
    -extfile "$work/$name.ext" -out "$work/$name.pem" 2>/dev/null
}

issue_leaf server localhost 'DNS:localhost,IP:127.0.0.1,IP:::1'
issue_leaf postgres localhost 'DNS:localhost,DNS:postgres,IP:127.0.0.1'

# Move into place only after everything succeeded, without overwriting.
for file in "${files[@]}"; do
  mv -n -- "$work/$file" "$cert_dir/$file"
  [[ ! -e $work/$file ]] || fail "Refusing to overwrite $cert_dir/$file."
done
chmod 600 -- "$cert_dir"/*.key
chmod 644 -- "$cert_dir"/*.pem

verify_set
printf '%s\n' 'Created local certificates:'
print_paths
printf '%s\n' 'Trust only ca.pem. Keep ca.key private; anyone with it can create certificates your browser trusts.'
