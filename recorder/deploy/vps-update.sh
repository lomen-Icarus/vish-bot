#!/usr/bin/env bash
# Обновление записывалки на VPS. Запускает GitHub Actions по SSH после каждого
# мёржа в main (шаг «Deploy recorder to the VPS»), можно и руками:
#   bash vps-update.sh /tmp/recorder-src.tar.gz
# Нужно один раз: Docker на сервере и файл $RECORDER_DIR/.env (по образцу
# recorder/.env.example, значения без кавычек — docker их не снимает).
set -euo pipefail

DIR="${RECORDER_DIR:-/opt/vish-recorder}"
ARCHIVE="${1:-/tmp/recorder-src.tar.gz}"
NAME=vish-recorder
IMAGE=vish-recorder:latest

[ -f "$DIR/.env" ] || { echo "Нет $DIR/.env — положи его по образцу recorder/.env.example и запусти деплой снова" >&2; exit 1; }
[ -f "$ARCHIVE" ] || { echo "Нет архива с кодом: $ARCHIVE" >&2; exit 1; }
# Docker ставится сам официальным скриптом: это единственное, что нужно на
# чистом сервере, и забывать этот шаг руками — обычное дело.
if ! command -v docker >/dev/null; then
  echo "Docker не установлен — ставлю (curl -fsSL https://get.docker.com | sh)…"
  curl -fsSL https://get.docker.com | sh || { echo "Docker не поставился: см. вывод выше, поставь руками и запусти деплой снова" >&2; exit 1; }
fi
systemctl is-active --quiet docker 2>/dev/null || systemctl start docker 2>/dev/null || true
docker info >/dev/null 2>&1 || { echo "Docker установлен, но не запущен (docker info не отвечает): systemctl status docker" >&2; exit 1; }

# Собираем рядом, пока старая версия работает: сломанная сборка её не трогает.
rm -rf "$DIR/app.new"
mkdir -p "$DIR/app.new" "$DIR/data"
tar -xzf "$ARCHIVE" -C "$DIR/app.new"
docker build -t "$IMAGE" "$DIR/app.new"
rm -rf "$DIR/app"
mv "$DIR/app.new" "$DIR/app"
rm -f "$ARCHIVE"

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --restart unless-stopped --init \
  --env-file "$DIR/.env" \
  -v "$DIR/data:/app/data" \
  --log-opt max-size=10m --log-opt max-file=3 \
  "$IMAGE" >/dev/null
docker image prune -f >/dev/null 2>&1 || true

# Упала сразу (нет учётки в .env и т. п.) — деплой красный, причина в логе.
# Смотрим и на перезапуски: с --restart упавший контейнер тут же поднимается
# снова и между падениями выглядит «работающим».
sleep 10
running="$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null || echo false)"
restarts="$(docker inspect -f '{{.RestartCount}}' "$NAME" 2>/dev/null || echo 0)"
if [ "$running" != "true" ] || [ "$restarts" != "0" ]; then
  echo "Записывалка не запустилась:" >&2
  docker logs --tail 30 "$NAME" >&2 || true
  exit 1
fi
echo "Записывалка запущена:"
docker logs --tail 10 "$NAME"
