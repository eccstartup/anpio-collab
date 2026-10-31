#!/bin/bash
# 在临时 PostgreSQL 实例上跑同一套测试。
#
# 目的是验证方言差异：命名参数编译、自增主键、事务与锁、唯一约束的报错映射。
# 所有测试文件共用同一个库，因此必须串行执行（--test-concurrency=1），
# 否则某个文件开头的 DROP SCHEMA 会把另一个文件正在用的表删掉。
# 需要本机已安装 initdb / pg_ctl / createdb（Homebrew 的 postgresql 即可）。
set -euo pipefail

# macOS 26 + 非 C locale 时，postmaster 会在启动阶段变成多线程并拒绝启动
# （"postmaster became multithreaded during startup"）。临时集群统一用 C locale。
export LC_ALL=C
export LANG=C

collab_pg_dir=$(mktemp -d /private/tmp/collab-postgres.XXXXXX)
collab_pg_port=${COLLAB_TEST_PG_PORT:-55439}

cleanup() {
  pg_ctl -D "$collab_pg_dir/data" -m immediate -w stop >/dev/null 2>&1 || true
  rm -rf "$collab_pg_dir"
}
trap cleanup EXIT

initdb -D "$collab_pg_dir/data" --auth-local=trust --auth-host=trust --no-locale -E UTF8 > "$collab_pg_dir/init.log"
pg_ctl -D "$collab_pg_dir/data" -l "$collab_pg_dir/server.log" \
  -o "-h 127.0.0.1 -k $collab_pg_dir -p $collab_pg_port" -w start >/dev/null
createdb -h 127.0.0.1 -p "$collab_pg_port" collab_test

export COLLAB_TEST_DATABASE="postgresql://127.0.0.1:$collab_pg_port/collab_test"
node --disable-warning=ExperimentalWarning --test --test-concurrency=1 tests/*.test.ts
