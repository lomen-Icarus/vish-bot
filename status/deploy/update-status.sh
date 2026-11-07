#!/usr/bin/env bash
# Выкладка страницы статуса на VPS. Запускает workflow «Status site» по SSH после
# мёржа в main с изменениями в status/, можно и руками:
#   bash update-status.sh /tmp/status-site.tar.gz
# Трогает только /opt/vish-status и /var/www/vish-status: бот и записывалка не перезапускаются,
# поэтому выкладывать можно и во время вебинара.
set -euo pipefail

DIR="${STATUS_DIR:-/opt/vish-status}"
ARCHIVE="${1:-/tmp/status-site.tar.gz}"
CONF=/etc/nginx/conf.d/vish-status.conf

[ -f "$ARCHIVE" ] || { echo "Нет архива: $ARCHIVE" >&2; exit 1; }
rm -rf "$DIR/app.new"
mkdir -p "$DIR/app.new"
tar -xzf "$ARCHIVE" -C "$DIR/app.new"
[ -f "$DIR/app.new/site/index.html" ] || { echo "В архиве нет site/index.html" >&2; exit 1; }
rm -rf "$DIR/app"
mv "$DIR/app.new" "$DIR/app"
rm -f "$ARCHIVE"

if [ -f "$CONF" ]; then
  # Сайт уже заведён: подменяем файлы тем же скриптом (он же обновит конфиг nginx).
  bash "$DIR/app/deploy/setup-status.sh"
else
  # Первый раз: без A-записи сертификат не выпустить — подсказка, но деплой не красный.
  if ! bash "$DIR/app/deploy/setup-status.sh"; then
    echo "::warning::Страница статуса ещё не заведена на VPS: A-запись status.secretvish.ru → 77.91.92.142, потом bash $DIR/app/deploy/setup-status.sh (docs/DEPLOY.md)"
  fi
fi
