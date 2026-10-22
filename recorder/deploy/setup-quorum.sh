#!/usr/bin/env bash
# Открытая страница «Кворум» — https://parlament.secretvish.ru/quorum: сколько
# студентов каждой группы ВИШ уже в боте. Страница — статичный файл на этом
# VPS (recorder/deploy/quorum/), числа «в боте» она раз в минуту берёт у бота:
# /quorum/live.json здесь пересылается боту на /quorum.json тем же путём, что и
# вход для России (setup-front.sh: upstream vish_bot и vish-proxy.inc).
#
# Порядок (сертификат — через сайт, HTTP-01, как у calendar.secretvish.ru):
#   1. A-запись parlament.secretvish.ru → IP этого VPS (77.91.92.142);
#   2. под root:  bash /opt/vish-recorder/app/deploy/setup-quorum.sh
# Повторный запуск безопасен: свежий сертификат не перевыпускается, конфиг
# пишется заново. Контейнер записывалки и конфиг setup-front.sh не трогает.
# Дальше index.html и totals.json обновляет сам деплой записывалки (vps-update.sh).
set -euo pipefail

NAME="${QUORUM_NAME:-parlament.secretvish.ru}"
VPS_IP="${VPS_IP:-77.91.92.142}"
SRC="$(cd "$(dirname "$0")" && pwd)/quorum"
SITE=/var/www/vish-quorum
CONF=/etc/nginx/conf.d/vish-quorum.conf
FRONT=/etc/nginx/conf.d/vish-front.conf
PROXY_INC=/etc/nginx/vish-proxy.inc
CERTS=/etc/nginx/vish-certs
WEBROOT=/var/www/vish-acme

[ "$(id -u)" = 0 ] || { echo "Запусти под root" >&2; exit 1; }
if [ ! -f "$FRONT" ] || [ ! -f "$PROXY_INC" ] || ! grep -q "upstream vish_bot" "$FRONT"; then
  echo "Нет входа для России ($FRONT, $PROXY_INC) — сначала bash $(dirname "$0")/setup-front.sh" >&2
  exit 1
fi
[ -f "$SRC/index.html" ] && [ -f "$SRC/totals.json" ] || { echo "Нет $SRC/index.html или totals.json — деплой записывалки ещё не приехал?" >&2; exit 1; }
command -v certbot >/dev/null || { echo "Нет certbot — его ставит setup-front.sh" >&2; exit 1; }

mkdir -p "$SITE/quorum" "$WEBROOT" "$CERTS"
install -m 644 "$SRC/index.html" "$SRC/totals.json" "$SITE/quorum/"
[ -f "$SRC/anthem.mp3" ] && install -m 644 "$SRC/anthem.mp3" "$SITE/quorum/"

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

# with_tls=0 — только порт 80 (файлы проверки Let's Encrypt), 1 — вся страница.
write_conf() {
  local with_tls="$1"
  {
cat <<EOF
# Создано setup-quorum.sh — правки руками перезапишутся при следующем запуске.
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
    charset utf-8;
    add_header X-Content-Type-Options nosniff always;

    location = / { return 302 /quorum; }
    location = /quorum/ { return 301 /quorum; }
    location = /quorum {
        add_header Cache-Control "no-cache" always;
        add_header X-Content-Type-Options nosniff always;
        try_files /quorum/index.html =404;
    }
    location = /quorum/totals.json {
        add_header Cache-Control "no-cache" always;
        add_header X-Content-Type-Options nosniff always;
        try_files \$uri =404;
    }
    # Гимн при открытии страницы (тихий, играет один раз — см. index.html).
    location = /quorum/anthem.mp3 {
        add_header Cache-Control "public, max-age=86400" always;
        add_header X-Content-Type-Options nosniff always;
        try_files \$uri =404;
    }
    # Числа «в боте» — у самого бота (по 30 секунд кеша там же).
    location = /quorum/live.json {
        limit_except GET HEAD { deny all; }
        rewrite ^ /quorum.json break;
        include $PROXY_INC;
    }
    location / { return 404; }
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

# Сертификат: есть и свежий (больше 30 дней) — не трогаем; certbot сам продлит его таймером.
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
page="$(curl -sS -m 20 --resolve "$NAME:443:127.0.0.1" "https://$NAME/quorum" | grep -o '<title>[^<]*</title>' || true)"
live="$(curl -sS -m 20 -o /dev/null -w '%{http_code}' --resolve "$NAME:443:127.0.0.1" "https://$NAME/quorum/live.json" || true)"
totals="$(curl -sS -m 20 -o /dev/null -w '%{http_code}' --resolve "$NAME:443:127.0.0.1" "https://$NAME/quorum/totals.json" || true)"
if [ -n "$page" ] && [ "$live" = 200 ] && [ "$totals" = 200 ]; then
  echo "OK https://$NAME/quorum — $page, live.json 200, totals.json 200"
else
  echo "❌ https://$NAME/quorum — страница: ${page:-нет}, live.json $live, totals.json $totals. live.json 404 — у бота ещё нет /quorum.json (не выложен). Лог: tail -20 /var/log/nginx/error.log" >&2
  exit 1
fi
