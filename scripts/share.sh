#!/usr/bin/env bash
# この PC で動かしたまま、外から開ける URL を出す（Cloudflare の一時トンネル。アカウント不要・無料）。
#   bash scripts/share.sh start   … 画面を組み直し、アプリとトンネルを起動して URL を出す
#   bash scripts/share.sh status  … いまの URL と、外から開けるかを確かめる
#   bash scripts/share.sh stop    … 両方止める
# パスワードは data/share/password（無ければ作る）。ユーザー名は slidegen。
# 注意：URL は起動のたびに変わる。この PC が眠る・WSL が止まると開けなくなる。
# 文章の AI は SLIDEGEN_DEV_AI=claude-cli（この PC の claude -p）。先方の鍵を設定画面に入れればそちらを使う。
set -euo pipefail
cd "$(dirname "$0")/.."
ROOTDIR=$(pwd)
STATE="$ROOTDIR/data/share"
PORT="${PORT:-8787}"
mkdir -p "$STATE"
chmod 700 "$STATE"

stop() {
  for f in app tunnel; do
    if [ -f "$STATE/$f.pid" ]; then
      kill "$(cat "$STATE/$f.pid")" 2>/dev/null || true
      rm -f "$STATE/$f.pid"
    fi
  done
}

url() { grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$STATE/tunnel.log" 2>/dev/null | head -1; }

check() {
  local u; u=$(url)
  [ -n "$u" ] || { echo "トンネルの URL がありません"; return 1; }
  local no ok
  no=$(curl -s -o /dev/null -w '%{http_code}' -m 20 "$u/" || true)
  ok=$(curl -s -o /dev/null -w '%{http_code}' -m 20 -u "slidegen:$(cat "$STATE/password")" "$u/api/state" || true)
  echo "URL: $u"
  echo "パスワード無し: $no（401 が正しい）／パスワードあり: $ok（200 が正しい）"
  [ "$no" = 401 ] && [ "$ok" = 200 ]
}

case "${1:-start}" in
start)
  stop
  if [ ! -s "$STATE/password" ]; then
    (umask 077; head -c 18 /dev/urandom | base64 | tr -d '/+=' | head -c 20 > "$STATE/password")
  fi
  npm run app:build > "$STATE/build.log" 2>&1 || { echo "画面のビルドに失敗（$STATE/build.log）"; exit 1; }
  : > "$STATE/tunnel.log"
  setsid -f bash -c "echo \$\$ > '$STATE/tunnel.pid'; exec cloudflared tunnel --no-autoupdate --url http://127.0.0.1:$PORT" >> "$STATE/tunnel.log" 2>&1
  for _ in $(seq 1 60); do [ -n "$(url)" ] && break; sleep 1; done
  U=$(url)
  [ -n "$U" ] || { echo "トンネルの URL が出ませんでした（$STATE/tunnel.log）"; stop; exit 1; }
  H=${U#https://}
  setsid -f bash -c "echo \$\$ > '$STATE/app.pid'; cd '$ROOTDIR'; exec env HOST=127.0.0.1 PORT=$PORT SLIDEGEN_DEV_AI=claude-cli SLIDEGEN_HOSTS='$H' SLIDEGEN_PASSWORD=\"\$(cat '$STATE/password')\" npx tsx src/app/server.ts" > "$STATE/app.log" 2>&1
  for _ in $(seq 1 60); do curl -s -o /dev/null -m 3 "http://127.0.0.1:$PORT/" && break; sleep 1; done
  # トンネルの名前が引けるまで少しかかる
  for _ in $(seq 1 30); do check > /dev/null 2>&1 && break; sleep 2; done
  check
  ;;
status) check ;;
stop) stop; echo "止めました" ;;
*) echo "使い方: bash scripts/share.sh start|status|stop"; exit 1 ;;
esac
