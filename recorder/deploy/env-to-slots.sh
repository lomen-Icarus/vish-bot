#!/usr/bin/env bash
# Перенести учётки студентов из .env (WEBINAR_LOGIN_2 … _9) в слоты
# (data/accounts.json): тогда они видны в боте (/slots), раз в 6 часов
# проверяются и о потере доступа приходит весть. Профиль 1 — общая учётка
# владельца — остаётся в .env.
#
#   bash /opt/vish-recorder/app/deploy/env-to-slots.sh
#
# Записывалка останавливается примерно на минуту — запускать ВНЕ ПАР: она
# держит слоты в памяти и затёрла бы перенесённое, поэтому перенос идёт при
# остановленном контейнере. Порядок: стоп → перенос (вход в кабинет под
# каждым профилем, своя группа владельца) → перенесённые профили убираются из
# .env (копия — .env.bak-…) → контейнер пересоздаётся. Не прошедший проверку
# профиль остаётся в .env как был.
set -euo pipefail

DIR="${RECORDER_DIR:-/opt/vish-recorder}"
NAME=vish-recorder
IMAGE=vish-recorder:latest
HERE="$(cd "$(dirname "$0")" && pwd)"

[ "$(id -u)" = 0 ] || { echo "Запусти под root" >&2; exit 1; }
[ -f "$DIR/.env" ] || { echo "Нет $DIR/.env" >&2; exit 1; }
docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "Образа $IMAGE нет — сначала обычный деплой" >&2; exit 1; }
if ! grep -qE '^WEBINAR_LOGIN_[2-9]=' "$DIR/.env"; then
  echo "В .env нет профилей 2…9 — переносить нечего."
  exit 0
fi

echo "Записывалка остановится примерно на минуту. Идёт пара — прерви (Ctrl+C) и запусти после."
read -r -p "Продолжить? [y/N] " ok
[ "$ok" = "y" ] || [ "$ok" = "Y" ] || { echo "Отменил."; exit 0; }

EXTRA=()
# «|| true»: без перевода строки в конце (или в пустом файле) read возвращает 1,
# и set -e молча обрывал деплой между сборкой и запуском контейнера.
[ -f "$DIR/docker.extra" ] && { read -r -a EXTRA < "$DIR/docker.extra" || true; }

docker stop "$NAME" >/dev/null 2>&1 || true
# Что бы ни случилось дальше — записывалку поднять обратно.
restarted=0
trap '[ "$restarted" = 1 ] || bash "$HERE/vps-update.sh" --recreate' EXIT
set +e
out="$(docker run --rm ${EXTRA[@]+"${EXTRA[@]}"} --env-file "$DIR/.env" -v "$DIR/data:/app/data" "$IMAGE" node dist/import-env.js 2>&1)"
set -e
echo "$out" | grep -v '^IMPORTED ' || true
nums="$(echo "$out" | sed -n 's/^IMPORTED \([2-9]\)$/\1/p' | tr '\n' ' ')"

if [ -n "${nums// /}" ]; then
  backup="$DIR/.env.bak-$(date +%Y%m%d-%H%M%S)"
  cp -p "$DIR/.env" "$backup"
  chmod 600 "$backup"
  for n in $nums; do
    sed -i -E "/^WEBINAR_(LOGIN|PASSWORD|GROUPS|AUTH)_${n}=/d" "$DIR/.env"
  done
  echo "Из .env убраны профили: ${nums}(копия прежнего .env — $backup, в ней пароли: проверь /slots в боте и удали её)."
else
  echo "Ни один профиль не перенесён — .env не трогаю."
fi

# Поднять заново той же командой, что и деплой (флаги, docker.extra, проверка запуска).
restarted=1
bash "$HERE/vps-update.sh" --recreate
echo "Готово. В боте: /slots — перенесённые группы должны быть ✅."
