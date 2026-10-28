#!/usr/bin/env bash
#
# 本地启动协作平台。
#
#   bash scripts/dev.sh            # 默认 8790 端口、./collab.sqlite3
#   PORT=8800 bash scripts/dev.sh  # 换端口（同时跑多个实例时用）
#
# 令牌持久化在 .collab-token（已忽略），首次运行自动生成，之后一直复用——
# 否则每次重启都换令牌，浏览器里的会话会全部失效。
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${PORT:-8790}"
DB="${COLLAB_DB:-$PWD/collab.sqlite3}"
TOKEN_FILE="$PWD/.collab-token"

if [[ ! -f "$TOKEN_FILE" ]]; then
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32 > "$TOKEN_FILE"
  else
    node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))" > "$TOKEN_FILE"
  fi
  chmod 600 "$TOKEN_FILE"
  echo "已生成新令牌: $TOKEN_FILE"
fi
TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "端口 $PORT 已被占用，先停掉它：lsof -ti tcp:$PORT | xargs kill" >&2
  exit 1
fi

cat <<INFO
数据库: $DB
登录令牌: $TOKEN
INFO

# 首次启动的库是空的，顺手写入演示数据；已有数据时 seed 会按标题跳过。
if [[ ! -f "$DB" ]]; then
  echo "新建数据库，启动后写入演示数据…"
  SEED_AFTER_START=1
fi

PORT="$PORT" COLLAB_DB="$DB" COLLAB_BOOTSTRAP_TOKEN="$TOKEN" npm start &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT INT TERM

if [[ "${SEED_AFTER_START:-0}" == "1" ]]; then
  (
    for _ in $(seq 1 40); do
      if curl -sf -o /dev/null "http://127.0.0.1:$PORT/health"; then
        COLLAB_URL="http://127.0.0.1:$PORT" COLLAB_TOKEN="$TOKEN" npm run seed || true
        break
      fi
      sleep 0.25
    done
  ) &
fi

wait "$SERVER_PID"
