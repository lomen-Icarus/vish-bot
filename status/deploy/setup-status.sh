#!/usr/bin/env bash
# Страница статуса бота — https://status.secretvish.ru: дорожная карта обновлений,
# ревью и технический долг. Статичные файлы на этом VPS, бот и записывалку не трогает.
#
# Один раз (сертификат — через сайт, HTTP-01, как у parlament. и calendar.):
#   1. A-запись status.secretvish.ru → IP этого VPS (77.91.92.142), у регистратора IHOR;
#   2. мёрж в main с изменениями в status/ — сайт приедет в /opt/vish-status/app;
#   3. под root:  bash /opt/vish-status/app/deploy/setup-status.sh
# Повторный запуск безопасен: свежий сертификат не перевыпускается, конфиг пишется заново.
# Дальше каждое обновление выкладывает workflow «Status site» (update-status.sh).
set -euo pipefail

NAME="${STATUS_NAME:-status.secretvish.ru}"
VPS_IP="${VPS_IP:-77.91.92.142}"
SRC="$(cd "$(dirname "$0")/.." && pwd)/site"
SITE=/var/www/vish-status
CONF=/etc/nginx/conf.d/vish-status.conf
CERTS=/etc/nginx/vish-certs
WEBROOT=/var/www/vish-acme
# Хеш единственного встроенного скрипта страницы (класс .js до отрисовки), для CSP.
JS_HASH="sha256-/x7W7R75k8Roq0WaVRQX9blP4OufE5xbAdzklGxsgpw="

[ "$(id -u)" = 0 ] || { echo "Запусти под root" >&2; exit 1; }
command -v nginx >/dev/null || { echo "Нет nginx — его ставит recorder/deploy/setup-front.sh" >&2; exit 1; }
command -v certbot >/dev/null || { echo "Нет certbot — его ставит recorder/deploy/setup-front.sh" >&2; exit 1; }
[ -f "$SRC/index.html" ] || { echo "Нет $SRC/index.html — выкладка сайта ещё не приехала?" >&2; exit 1; }

# Файлы: собираем рядом и подменяем одним переименованием.
mkdir -p "$WEBROOT" "$CERTS"
rm -rf "$SITE.new"
cp -a "$SRC" "$SITE.new"
chmod -R a+rX "$SITE.new"
rm -rf "$SITE.old"
[ -d "$SITE" ] && mv "$SITE" "$SITE.old"
mv "$SITE.new" "$SITE"
rm -rf "$SITE.old"

# IPv4 имени в публичном DNS (как видят телефоны и Let's Encrypt); пусто — не резолвится.
public_ip() {
  curl -fsS -m 10 "https://dns.google/resolve?name=$1&type=A" 2>/dev/null | grep -o '"data":"[0-9.]*"' | head -1 | cut -d'"' -f4 || true
}
is_here() {
  local ip="$1" own
  [ -n "$ip" ] || return 1
  [ "$ip" = "$VPS_IP" ] && return 0
  for own in $(hostname -I 2>/dev/null); do [ "$own" = "$ip" ] && return 0; done
  return 1
}
have_cert() { [ -s "$CERTS/$NAME.crt" ] && [ -s "$CERTS/$NAME.key" ]; }

# with_tls=0 — только порт 80 (файлы проверки Let's Encrypt), 1 — весь сайт.
write_conf() {
  local with_tls="$1"
  {
cat <<EOF
# Создано status/deploy/setup-status.sh — правки руками перезапишутся при следующем запуске.
server {
    listen 80;
    server_name $NAME;
    location /.well-known/acme-challenge/ { root $WEBROOT; }
    location / { return 301 https://$NAME\$request_uri; }
}
EOF
    if [ "$with_tls" = 1 ]; then cat <<EOF

server {
    listen 443 ssl;
    server_name $NAME;
    ssl_certificate     $CERTS/$NAME.crt;
    ssl_certificate_key $CERTS/$NAME.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    root $SITE;
    index index.html;
    charset utf-8;
    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self' '$JS_HASH'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" always;

    location = / {
        add_header Cache-Control "no-cache" always;
        add_header X-Content-Type-Options nosniff always;
        add_header Referrer-Policy strict-origin-when-cross-origin always;
        add_header Content-Security-Policy "default-src 'self'; script-src 'self' '$JS_HASH'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" always;
        try_files /index.html =404;
    }
    # Стили, скрипт и данные меняются с каждой выкладкой — без долгого кеша.
    location ~ ^/(site\\.css|app\\.js|data/) {
        add_header Cache-Control "no-cache" always;
        add_header X-Content-Type-Options nosniff always;
        try_files \$uri =404;
    }
    location ~ ^/(fonts|images)/ {
        add_header Cache-Control "public, max-age=2592000" always;
        add_header X-Content-Type-Options nosniff always;
        try_files \$uri =404;
    }
    location / { try_files \$uri =404; }
}
EOF
    fi
  } > "$CONF.new"
  cp -a "$CONF" "$CONF.bak" 2>/dev/null || true
  mv "$CONF.new" "$CONF"
  if ! nginx -t 2>&1; then
    echo "Конфиг nginx не прошёл проверку — возвращаю прежний" >&2
    if [ -f "$CONF.bak" ]; then mv "$CONF.bak" "$CONF"; else rm -f "$CONF"; fi
    return 1
  fi
  systemctl reload nginx
}

# Сертификат: есть и свежий (больше 30 дней) — не трогаем; certbot продлит его сам.
if ! have_cert || ! openssl x509 -checkend 2592000 -noout -in "$CERTS/$NAME.crt" >/dev/null 2>&1; then
  ip="$(public_ip "$NAME")"
  if ! is_here "$ip"; then
    echo "⏳ $NAME → ${ip:-не резолвится}, а не этот VPS ($VPS_IP). Заведи A-запись $NAME → $VPS_IP и запусти скрипт снова" >&2
    exit 1
  fi
  write_conf 0 || exit 1
  echo "Сертификат $NAME (через сайт)…"
  if certbot certonly --non-interactive --agree-tos --register-unsafely-without-email \
      --webroot -w "$WEBROOT" --keep-until-expiring --cert-name "$NAME" -d "$NAME" \
      --deploy-hook "systemctl reload nginx"; then
    ln -sfn "/etc/letsencrypt/live/$NAME/fullchain.pem" "$CERTS/$NAME.crt"
    ln -sfn "/etc/letsencrypt/live/$NAME/privkey.pem" "$CERTS/$NAME.key"
  else
    echo "⚠️ Сертификат $NAME не выпустился: Let's Encrypt не забрал файл с http://$NAME/.well-known/acme-challenge/ — проверь A-запись и порт 80. Повторять — не чаще раза в час" >&2
    exit 1
  fi
fi
write_conf 1 || exit 1

# Проверка через этот VPS, не дожидаясь чужих DNS-кешей.
sleep 1
page="$(curl -sS -m 20 --resolve "$NAME:443:127.0.0.1" "https://$NAME/" | grep -o '<title>[^<]*</title>' || true)"
data="$(curl -sS -m 20 -o /dev/null -w '%{http_code}' --resolve "$NAME:443:127.0.0.1" "https://$NAME/data/roadmap.json" || true)"
if [ -n "$page" ] && [ "$data" = 200 ]; then
  echo "OK https://$NAME/ — $page, roadmap.json 200"
else
  echo "❌ https://$NAME/ — страница: ${page:-нет}, roadmap.json $data. Лог: tail -20 /var/log/nginx/error.log" >&2
  exit 1
fi
