#!/bin/sh
# db-bootstrap init container (postgres:16-alpine, as root). First container
# of every API task; migrate and api start only after it exits 0.
#
# 1. Writes the files the later containers need to the task's shared volume,
#    owned by the image's nonroot user 65532:
#      /shared/certs/rds-ca.pem   regional RDS CA bundle (sslrootcert)
#      /shared/certs/mail-ca.pem  CA that signed the Mailpit certificate (SSL_CERT_FILE)
#      /shared/certs/server.pem   the API's internal TLS certificate (ALB re-encrypts to it)
#      /shared/certs/server.key
# 2. Applies the role SQL from infrastructure/postgres/init.sh, adapted for RDS:
#    the master user is rds_superuser, not a superuser, so it must be a member
#    of ecom_migrator before it can hand the database and schema to it. Every
#    statement is idempotent and passwords are (re)set each run, so it is safe
#    on every task start and after a secret rotation. An advisory lock
#    serialises concurrent tasks.
set -eu

umask 077
install -d -o 65532 -g 65532 -m 0755 /shared/certs

wget -q -T 20 -O /tmp/rds-ca.pem "$RDS_CA_BUNDLE_URL"
grep -q 'BEGIN CERTIFICATE' /tmp/rds-ca.pem
install -o 65532 -g 65532 -m 0444 /tmp/rds-ca.pem /shared/certs/rds-ca.pem

printf '%s\n' "$MAIL_CA_CERT" >/tmp/mail-ca.pem
install -o 65532 -g 65532 -m 0444 /tmp/mail-ca.pem /shared/certs/mail-ca.pem

printf '%s\n' "$API_TLS_CERT" >/tmp/server.pem
install -o 65532 -g 65532 -m 0444 /tmp/server.pem /shared/certs/server.pem

printf '%s\n' "$API_TLS_KEY" >/tmp/server.key
install -o 65532 -g 65532 -m 0400 /tmp/server.key /shared/certs/server.key
rm -f /tmp/server.key

export PGHOST="$DB_HOST" PGPORT="$DB_PORT" PGDATABASE="$DB_NAME" PGUSER="$DB_MASTER_USER"
export PGPASSWORD="$MASTER_PASSWORD" PGSSLMODE=verify-full PGSSLROOTCERT=/shared/certs/rds-ca.pem
export PGCONNECT_TIMEOUT=10

psql --no-psqlrc --quiet --set ON_ERROR_STOP=1 \
  --set master_user="$DB_MASTER_USER" --set database_name="$DB_NAME" \
  --set migrator_password="$MIGRATOR_PASSWORD" --set app_password="$APP_DB_PASSWORD" <<'SQL'
SELECT pg_advisory_lock(hashtext('ecom-db-bootstrap'));

SELECT 'CREATE ROLE ecom_migrator'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ecom_migrator') \gexec
SELECT 'CREATE ROLE ecom_app'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ecom_app') \gexec

ALTER ROLE ecom_migrator LOGIN PASSWORD :'migrator_password';
ALTER ROLE ecom_app LOGIN PASSWORD :'app_password';

-- RDS: the master user needs membership to transfer ownership.
GRANT ecom_migrator TO :"master_user";

ALTER DATABASE :"database_name" OWNER TO ecom_migrator;
REVOKE ALL ON DATABASE :"database_name" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"database_name" TO ecom_app;
ALTER SCHEMA public OWNER TO ecom_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO ecom_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ecom_migrator IN SCHEMA public
  GRANT SELECT ON TABLES TO ecom_app;

SELECT pg_advisory_unlock(hashtext('ecom-db-bootstrap'));
SQL

echo 'db-bootstrap: certificates written and roles in place'
