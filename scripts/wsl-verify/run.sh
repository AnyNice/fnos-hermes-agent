#!/bin/bash
# WSL 功能验证：模拟 FPK 安装/运行环境，逐项验证 admin/host/native 端点
# 用法: bash run.sh setup|start|stop|probe
set -u
BASE=/mnt/e/项目/hermes_fnos/fnos-dual-entry
T=$HOME/fnos-test
APP_DIR=$T/app
DATA_DIR=$T/home/data
VAR_DIR=$T/var

node24() {
  if [ -x $T/node24/bin/node ]; then return 0; fi
  mkdir -p $T
  echo ">>> downloading Node 24 (npmmirror, fallback nodejs.org) ..."
  curl -fSL -o $T/node.tar.xz "https://registry.npmmirror.com/-/binary/node/v24.4.1/node-v24.4.1-linux-x64.tar.xz" || \
  curl -fSL -o $T/node.tar.xz "https://nodejs.org/dist/v24.4.1/node-v24.4.1-linux-x64.tar.xz"
  tar xf $T/node.tar.xz -C $T
  mv $T/node-v24.4.1-linux-x64 $T/node24
}

setup() {
  node24
  echo "node: $($T/node24/bin/node -v)"
  echo ">>> copying app/ (303M) to $T/app ..."
  rm -rf $T/app $T/home $T/var $T/python-tmp $T/python-3.14
  mkdir -p $T/var $T/home/data $T/python-tmp
  cp -a "$BASE"/app/. $T/app/
  echo ">>> unpacking bundled CPython 3.14 (x86_64) ..."
  cp "$BASE/config/bootstrap/python/cpython-3.14-x86_64.tar.gz" $T/python-tmp/
  tar xzf $T/python-tmp/cpython-3.14-x86_64.tar.gz -C $T/python-tmp
  rm -rf $T/python-3.14
  mv $T/python-tmp/python $T/python-3.14
  echo ">>> uv venv -> $DATA_DIR/venv ..."
  uv venv --python $T/python-3.14/bin/python3.14 $DATA_DIR/venv
  echo ">>> uv pip install hermes-src[all] (tsinghua index) ..."
  UV_INDEX_URL="https://pypi.tuna.tsinghua.edu.cn/simple" \
    uv pip install --python $DATA_DIR/venv/bin/python3 -e "$APP_DIR/hermes-src[all]" 2>&1 | tail -5
  echo ">>> hermes --version ..."
  $DATA_DIR/venv/bin/hermes --version
  echo "SETUP OK"
}

start() {
  export PATH=$T/node24/bin:$DATA_DIR/venv/bin:/usr/local/bin:/usr/bin:/bin
  rm -f $APP_DIR/hermes-agent.sock
  HOME=$DATA_DIR HERMES_HOME=$DATA_DIR APP_DIR=$APP_DIR DATA_DIR=$DATA_DIR VAR_DIR=$VAR_DIR \
  MONITOR_SOCKET_PATH=$APP_DIR/hermes-agent.sock BASE_PATH="" UI_PORT=8650 \
  nohup node $APP_DIR/server/monitor.js >> $VAR_DIR/info.log 2>&1 &
  echo $! > $VAR_DIR/monitor.pid
  for i in $(seq 1 40); do [ -S $APP_DIR/hermes-agent.sock ] && break; sleep 0.5; done
  if [ -S $APP_DIR/hermes-agent.sock ]; then echo "SOCKET UP (pid $(cat $VAR_DIR/monitor.pid))"; else echo "SOCKET NOT UP"; fi
  tail -8 $VAR_DIR/info.log
}

stop() {
  [ -f $VAR_DIR/monitor.pid ] && kill $(cat $VAR_DIR/monitor.pid) 2>/dev/null
  pkill -f "node.*$APP_DIR/server/monitor.js" 2>/dev/null
  pkill -f "venv/bin/hermes (gateway|dashboard)" 2>/dev/null
  rm -f $APP_DIR/hermes-agent.sock
  echo "STOPPED"
}

probe() {
  SOCK=$APP_DIR/hermes-agent.sock
  c() { curl -s -m 30 --unix-socket $SOCK "http://host/admin$1"; echo; }
  p() { curl -s -m 30 -X POST -H 'Content-Type: application/json' -d "${2:-{}}" --unix-socket $SOCK "http://host/admin$1"; echo; }
  n() { curl -s -m 30 --unix-socket $SOCK "http://host/admin$1?profile=default"; echo; }
  echo "== 1. host/status =="; c /api/host/status
  echo "== 2. host/logs (all, 探测来源) =="; c "/api/host/logs?source=all&lines=50"
  echo "== 3. host/logs (agent 单源) =="; c "/api/host/logs?source=agent&lines=20"
  echo "== 4. start hermes backend =="; p /api/host/service/start
  sleep 10
  echo "== 5. host/status after start =="; c /api/host/status
  echo "== 6. native /api/health (dashboard 可用性) =="; n /api/native/api/health
}

case "$1" in
  setup) setup ;;
  start) start ;;
  stop)  stop ;;
  probe) probe ;;
  *) echo "usage: $0 setup|start|stop|probe"; exit 1 ;;
esac
