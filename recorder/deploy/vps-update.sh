#!/usr/bin/env bash
# Обновление записывалки на VPS. Запускает GitHub Actions по SSH после каждого
# мёржа в main (шаг «Deploy recorder to the VPS»), можно и руками:
#   bash vps-update.sh /tmp/recorder-src.tar.gz
# Только пересоздать контейнер из уже собранного образа (после правки .env):
#   bash vps-update.sh --recreate
# Нужно один раз: Docker на сервере и файл $RECORDER_DIR/.env (по образцу
# recorder/.env.example, значения без кавычек — docker их не снимает).
set -euo pipefail

DIR="${RECORDER_DIR:-/opt/vish-recorder}"
RECREATE=0
[ "${1:-}" = "--recreate" ] && RECREATE=1
ARCHIVE="${1:-/tmp/recorder-src.tar.gz}"
NAME=vish-recorder
IMAGE=vish-recorder:latest

[ -f "$DIR/.env" ] || { echo "Нет $DIR/.env — положи его по образцу recorder/.env.example и запусти деплой снова" >&2; exit 1; }
[ "$RECREATE" = 1 ] || [ -f "$ARCHIVE" ] || { echo "Нет архива с кодом: $ARCHIVE" >&2; exit 1; }
# Шаблон VPS склонирован с другой машины: grub-pc помнит диск, которого здесь
# нет, его настройка падает, и с ней падает любой apt. Загрузчик уже стоит
# (система грузится), поэтому пакету достаточно ответить «продолжать без
# установки GRUB» — на диск ничего не пишется. Правильно поставить GRUB на
# свой диск можно потом: dpkg-reconfigure grub-pc.
fix_grub_pc() {
  dpkg --audit 2>/dev/null | grep -q grub-pc || return 1
  echo "grub-pc недонастроен (в debconf чужой диск) — отмечаю «без установки GRUB» и повторяю dpkg --configure -a"
  printf 'grub-pc grub-pc/install_devices multiselect\ngrub-pc grub-pc/install_devices_empty boolean true\n' | debconf-set-selections
  dpkg --configure -a
}

# Docker ставится сам официальным скриптом: это единственное, что нужно на
# чистом сервере, и забывать этот шаг руками — обычное дело.
if ! command -v docker >/dev/null; then
  echo "Docker не установлен — ставлю…"
  export DEBIAN_FRONTEND=noninteractive
  # Шаблоны хостингов приезжают с недоделанной установкой пакетов, и тогда
  # любой apt падает с «dpkg returned an error code (1)». Сначала доделываем
  # её, и всё — с видимым выводом: скрипт get.docker.com ошибки прячет.
  dpkg --configure -a || fix_grub_pc || echo "dpkg --configure -a не прошёл — см. выше, какой пакет" >&2
  apt-get -f install -y || true
  apt-get update -q || { echo "apt-get update не прошёл: проверь /etc/apt/sources.list и выход в интернет с VPS" >&2; exit 1; }
  apt-get install -y ca-certificates curl || { echo "apt не может поставить пакеты — ошибка выше. Обычно помогает на VPS: dpkg --configure -a; apt-get -f install; потом деплой снова" >&2; exit 1; }
  curl -fsSL https://get.docker.com | sh || { echo "Docker не поставился: см. вывод выше, поставь руками и запусти деплой снова" >&2; exit 1; }
fi
systemctl is-active --quiet docker 2>/dev/null || systemctl start docker 2>/dev/null || true
docker info >/dev/null 2>&1 || { echo "Docker установлен, но не запущен (docker info не отвечает): systemctl status docker" >&2; exit 1; }

# Собираем рядом, пока старая версия работает: сломанная сборка её не трогает.
if [ "$RECREATE" = 1 ]; then
  docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "Образа $IMAGE нет — сначала обычный деплой" >&2; exit 1; }
else
  rm -rf "$DIR/app.new"
  mkdir -p "$DIR/app.new" "$DIR/data"
  tar -xzf "$ARCHIVE" -C "$DIR/app.new"
  docker build -t "$IMAGE" "$DIR/app.new"
  rm -rf "$DIR/app"
  mv "$DIR/app.new" "$DIR/app"
  rm -f "$ARCHIVE"
  # Страница «Кворум» (setup-quorum.sh): если она заведена — свежие index.html,
  # totals.json и anthem.mp3 с каждым деплоем. Не вышло — записывалку это не останавливает.
  QUORUM_CONF=/etc/nginx/conf.d/vish-quorum.conf
  if [ -f "$QUORUM_CONF" ] && [ -d "$DIR/app/deploy/quorum" ]; then
    if ! grep -q "quorum/anthem.mp3" "$QUORUM_CONF"; then
      # Конфиг nginx ещё без гимна — один раз переписываем его тем же setup-quorum.sh.
      bash "$DIR/app/deploy/setup-quorum.sh" || echo "⚠️ setup-quorum.sh не прошёл (см. выше) — запусти руками" >&2
    fi
    install -m 644 "$DIR/app/deploy/quorum/index.html" "$DIR/app/deploy/quorum/totals.json" "$DIR/app/deploy/quorum/anthem.mp3" /var/www/vish-quorum/quorum/ \
      && echo "Страница «Кворум» обновлена" || echo "⚠️ Страница «Кворум» не обновилась (см. выше)" >&2
  fi
fi

# Свои флаги docker run (например, --add-host, пока у домена бота лежит DNS) —
# в $DIR/docker.extra одной строкой: так они переживают каждый деплой.
EXTRA=()
# «|| true»: без перевода строки в конце (или в пустом файле) read возвращает 1,
# и set -e молча обрывал деплой между сборкой и запуском контейнера.
[ -f "$DIR/docker.extra" ] && { read -r -a EXTRA < "$DIR/docker.extra" || true; }

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --restart unless-stopped --init \
  ${EXTRA[@]+"${EXTRA[@]}"} \
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
