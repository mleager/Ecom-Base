#!/bin/sh
set -eu
export PGPASSWORD="$POSTGRES_PASSWORD"
psql --no-psqlrc --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set migrator_password="$MIGRATOR_PASSWORD" --set app_password="$APP_DB_PASSWORD" <<'SQL'
CREATE ROLE ecom_migrator LOGIN PASSWORD :'migrator_password';
CREATE ROLE ecom_app LOGIN PASSWORD :'app_password';
ALTER DATABASE ecom OWNER TO ecom_migrator;
REVOKE ALL ON DATABASE ecom FROM PUBLIC;
GRANT CONNECT ON DATABASE ecom TO ecom_app;
ALTER SCHEMA public OWNER TO ecom_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO ecom_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ecom_migrator IN SCHEMA public
  GRANT SELECT ON TABLES TO ecom_app;
SQL

