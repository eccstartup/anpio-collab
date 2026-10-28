#!/bin/bash
set -euo pipefail
collab_pg_dir=$(mktemp -d /private/tmp/collab-postgres.XXXXXX)
collab_pg_port=${COLLAB_TEST_PG_PORT:-55439}
cleanup() {
  pg_ctl -D "$collab_pg_dir/data" -m immediate -w stop >/dev/null 2>&1 || true
  rm -rf "$collab_pg_dir"
}
trap cleanup EXIT
initdb -D "$collab_pg_dir/data" --auth-local=trust --auth-host=trust --no-locale -E UTF8 > "$collab_pg_dir/init.log"
pg_ctl -D "$collab_pg_dir/data" -l "$collab_pg_dir/server.log" -o "-h 127.0.0.1 -k $collab_pg_dir -p $collab_pg_port" -w start >/dev/null
createdb -h 127.0.0.1 -p "$collab_pg_port" collab_test
export COLLAB_TEST_DATABASE="postgresql://127.0.0.1:$collab_pg_port/collab_test"
node --test tests-ts/*.test.ts
