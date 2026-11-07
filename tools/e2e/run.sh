#!/bin/sh
# Abnahmelauf gegen ein echtes Yuvomi. Aufruf aus dem Repository:
#   YUVOMI_DIR=~/src/yuvomi sh tools/e2e/run.sh
# Startet Yuvomi (Port 3201) mit frischer Datenbank und KidsStar im Modulordner,
# davor den KidsStar-Dienst (Port 3200) als Eingang, und spielt alle Phasen durch.
set -e
REPO=$(cd "$(dirname "$0")/../.." && pwd)
YUVOMI_DIR=${YUVOMI_DIR:?YUVOMI_DIR auf einen Yuvomi-Checkout mit node_modules setzen}
W=$(mktemp -d)
trap 'kill $YPID $KPID 2>/dev/null || true' EXIT
mkdir -p "$W/data" "$W/modules" "$W/ks-data" "$W/backups"
cp -r "$REPO/module" "$W/modules/kidsstar"

start_yuvomi() {
  (cd "$YUVOMI_DIR" && SESSION_SECRET=e2e-only-secret-0123456789abcdefghijklmnopqrstuvwxyz \
    DB_PATH="$W/data/yuvomi.db" MODULES_DIR="$W/modules" BACKUP_DIR="$W/backups" PORT=3201 \
    NODE_ENV=production SESSION_SECURE=false TRUST_PROXY=loopback node server/index.js > "$W/yuvomi.log" 2>&1) &
  YPID=$!
  for i in $(seq 1 60); do curl -sf http://127.0.0.1:3201/health >/dev/null && return; sleep 1; done
  echo "Yuvomi startet nicht"; cat "$W/yuvomi.log"; exit 1
}
start_kidsstar() {
  PORT=3200 DATA_DIR="$W/ks-data" YUVOMI_URL=http://127.0.0.1:3201 YUVOMI_API_TOKEN_FILE="$W/token" \
    node "$REPO/sidecar/src/main.js" >> "$W/ks.log" 2>&1 &
  KPID=$!
  for i in $(seq 1 20); do curl -sf http://127.0.0.1:3200/api/extensions/kidsstar/health >/dev/null && return; sleep 0.5; done
  echo "KidsStar startet nicht"; cat "$W/ks.log"; exit 1
}

start_yuvomi
node "$REPO/tools/e2e/e2e.mjs" 3201 setup "$W/token"
start_kidsstar
node "$REPO/tools/e2e/e2e.mjs" 3200 flow "$W/state.json"
node "$REPO/tools/e2e/e2e.mjs" 3200 disable "$W/state.json"
kill $KPID; sleep 1; start_kidsstar
node "$REPO/tools/e2e/e2e.mjs" 3200 persist "$W/state.json" 10
DATA_DIR="$W/ks-data" node "$REPO/sidecar/src/backup.js" backup "$W/ks-backup"
node "$REPO/tools/e2e/e2e.mjs" 3200 spend "$W/state.json"
kill $KPID; sleep 1
DATA_DIR="$W/ks-data" node "$REPO/sidecar/src/backup.js" restore "$W/ks-backup"
start_kidsstar
node "$REPO/tools/e2e/e2e.mjs" 3200 persist "$W/state.json" 10
echo "Abnahmelauf bestanden ($W)"
