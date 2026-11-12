#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
container="database-isolation-${RANDOM}-$$"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
# A disposable local-only password, no published ports or persistent volumes.
docker run -d --name "$container" -e POSTGRES_PASSWORD=local-isolation-test-only postgis/postgis:17-3.5-alpine >/dev/null
ready=false
for _ in {1..60}; do
  if docker exec "$container" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
if [[ "$ready" != true ]]; then echo 'PostGIS did not become ready' >&2; exit 1; fi
for db in fresh existing; do
  docker exec "$container" createdb -U postgres "$db"
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" < tests/database/fixture.sql
  if [[ "$db" == existing ]]; then
    docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" -c 'create extension if not exists postgis with schema public'
  fi
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" < supabase/migrations/20261112000000_database_isolation.sql
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" < supabase/seed.sql
  docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" < tests/database/isolation.sql
done
echo 'Database isolation tests passed in fresh and existing PostGIS schemas.'
