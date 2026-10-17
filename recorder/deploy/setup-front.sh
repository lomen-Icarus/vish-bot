#!/usr/bin/env bash
# Вход бота для людей из России — на этом VPS (Москва). Провайдеры (ТСПУ) режут
# соединения к иностранным хостингам, и встроенный браузер Telegram получал
# ERR_CONNECTION_RESET на адресе бота во Франкфурте. Здесь nginx принимает
# HTTPS на имена бота и пересылает запросы самому боту по HTTPS (с проверкой
# его сертификата). Код и база остаются на хостинге бота, меняется только
# DNS-запись имени: она указывает на этот VPS.
#
# Запуск под root:  bash /opt/vish-recorder/app/deploy/setup-front.sh
# Повторный запуск безопасен: выпущенные сертификаты не перевыпускаются,
# конфиг nginx пишется заново. Контейнер записывалки скрипт не трогает —
# запускать можно и во время вебинаров.
#
# Сертификаты (секреты — только на VPS, права 0600):
#   /root/.secrets/cloudflare.ini — токен Cloudflare (Zone → DNS → Edit):
#       dns_cloudflare_api_token = …
#     → имена из CF_NAMES (certbot, DNS-01).
#   /root/.secrets/selectel.env — сервисный пользователь Selectel (DNS actual):
#       SL_Ver=v2, SL_Login_ID, SL_Project_Name, SL_Login_Name, SL_Pswd
#     → имена из SEL_NAMES (acme.sh, DNS-01). Пока NS домена не указывают на
#       Selectel, выпуск пропускается — перезапусти скрипт позже.
# Продление — само: таймер certbot и cron acme.sh, nginx перечитывается.
set -euo pipefail

BOT_IP="${BOT_IP:-135.125.188.210}"                       # хостинг бота (OVH)
BOT_PORT="${BOT_PORT:-443}"                               # его HTTPS-порт
BOT_NAME="${BOT_NAME:-rezerve-adress.frienworld.com}"     # имя, под которым бот отвечает на хостинге
CF_NAMES="${CF_NAMES:-rezerve-adress.frienworld.com}"
SEL_NAMES="${SEL_NAMES:-calendar.secretvish.ru}"
# Старые ссылки на календарь — http, местами с портом хостинга (:40070).
LEGACY_HTTP_PORT="${LEGACY_HTTP_PORT:-40070}"
CF_INI=/root/.secrets/cloudflare.ini
SEL_ENV=/root/.secrets/selectel.env
CERTS=/etc/nginx/vish-certs
CONF=/etc/nginx/conf.d/vish-front.conf
ACME=/root/.acme.sh/acme.sh

[ "$(id -u)" = 0 ] || { echo "Запусти под root" >&2; exit 1; }

# ── 1. Порты: занятые кем-то, кроме nginx, — стоп (не ломаем чужое).
busy_by_other() {
  ss -ltnpH "sport = :$1" 2>/dev/null | grep -v nginx | grep -q .
}
for p in 80 443; do
  if busy_by_other "$p"; then
    echo "Порт $p занят не nginx — освободи его и запусти снова:" >&2
    ss -ltnp "sport = :$p" >&2
    exit 1
  fi
done
LEGACY_OK=1
if [ -n "$LEGACY_HTTP_PORT" ] && busy_by_other "$LEGACY_HTTP_PORT"; then
  echo "⚠️ Порт $LEGACY_HTTP_PORT занят — старые ссылки с этим портом через VPS работать не будут" >&2
  LEGACY_OK=0
fi

# ── 2. Пакеты.
export DEBIAN_FRONTEND=noninteractive
need=()
command -v nginx >/dev/null || need+=(nginx)
command -v certbot >/dev/null || need+=(certbot)
dpkg -s python3-certbot-dns-cloudflare >/dev/null 2>&1 || need+=(python3-certbot-dns-cloudflare)
command -v curl >/dev/null || need+=(curl)
command -v openssl >/dev/null || need+=(openssl)
# acme.sh продлевает сертификаты по cron и без crontab не ставится.
command -v crontab >/dev/null || need+=(cron)
if [ ${#need[@]} -gt 0 ]; then
  echo "Ставлю: ${need[*]}"
  apt-get update -q
  apt-get install -y "${need[@]}"
fi
systemctl enable --now nginx >/dev/null 2>&1 || true
mkdir -p "$CERTS"
chmod 700 "$CERTS"

# Делегирован ли домен на нужные NS — по публичному DNS (как видят телефоны).
# 0 — да, 1 — нет, 2 — не удалось узнать.
ns_matches() {
  local zone="$1" pattern="$2" out
  out="$(curl -fsS -m 10 "https://dns.google/resolve?name=$zone&type=NS" 2>/dev/null)" || return 2
  echo "$out" | grep -qi "$pattern" && return 0
  return 1
}
zone_of() { echo "$1" | awk -F. '{print $(NF-1)"."$NF}'; }

# ── 3. Сертификаты через Cloudflare (certbot).
HAVE=()
if [ -f "$CF_INI" ]; then
  chmod 600 "$CF_INI"
  for name in $CF_NAMES; do
    echo "Сертификат $name (Cloudflare)…"
    if certbot certonly --non-interactive --agree-tos --register-unsafely-without-email \
        --dns-cloudflare --dns-cloudflare-credentials "$CF_INI" --dns-cloudflare-propagation-seconds 30 \
        --keep-until-expiring --cert-name "$name" -d "$name" \
        --deploy-hook "systemctl reload nginx"; then
      ln -sfn "/etc/letsencrypt/live/$name/fullchain.pem" "$CERTS/$name.crt"
      ln -sfn "/etc/letsencrypt/live/$name/privkey.pem" "$CERTS/$name.key"
    else
      echo "⚠️ Сертификат $name не выпустился — проверь токен в $CF_INI (права: Zone → DNS → Edit на нужную зону)" >&2
    fi
  done
else
  echo "Нет $CF_INI — имена Cloudflare ($CF_NAMES) пропускаю"
fi

# ── 4. Сертификаты через Selectel (acme.sh, DNS actual).
if [ -f "$SEL_ENV" ]; then
  chmod 600 "$SEL_ENV"
  if [ ! -x "$ACME" ]; then
    echo "Ставлю acme.sh…"
    # Установщик и при ошибке выходит с 0 — судим по появившемуся файлу.
    curl -fsSL https://get.acme.sh | sh -s >/dev/null || true
    [ -x "$ACME" ] || { echo "acme.sh не поставился (нужен доступ к raw.githubusercontent.com)" >&2; exit 1; }
  fi
  for name in $SEL_NAMES; do
    zone="$(zone_of "$name")"
    set +e; ns_matches "$zone" "ns.selectel" ; rc=$?; set -e
    if [ "$rc" = 1 ]; then
      echo "⏳ $zone ещё не делегирован на Selectel (NS в публичном DNS другие) — $name пропускаю, запусти скрипт позже"
      continue
    fi
    echo "Сертификат $name (Selectel)…"
    set +e
    ( set -a; . "$SEL_ENV"; set +a
      "$ACME" --issue --server letsencrypt --dns dns_selectel -d "$name" --keylength ec-256 )
    rc=$?
    set -e
    # 2 — сертификат ещё свежий, перевыпуск не нужен.
    if [ "$rc" != 0 ] && [ "$rc" != 2 ]; then
      echo "⚠️ Сертификат $name не выпустился — проверь $SEL_ENV (сервисный пользователь, роль в проекте с зоной)" >&2
      continue
    fi
    "$ACME" --install-cert -d "$name" --ecc \
      --key-file "$CERTS/$name.key" --fullchain-file "$CERTS/$name.crt" \
      --reloadcmd "systemctl reload nginx" >/dev/null
  done
else
  echo "Нет $SEL_ENV — имена Selectel ($SEL_NAMES) пропускаю"
fi

for name in $CF_NAMES $SEL_NAMES; do
  [ -s "$CERTS/$name.crt" ] && [ -s "$CERTS/$name.key" ] && HAVE+=("$name")
done
[ ${#HAVE[@]} -gt 0 ] || { echo "Нет ни одного сертификата — nginx не настраиваю" >&2; exit 1; }

# ── 5. Конфиг nginx.
https_of() {  # куда отправлять с http: своё имя, если есть сертификат, иначе первое имя с сертификатом
  local n
  for n in "${HAVE[@]}"; do [ "$n" = "$1" ] && { echo "$1"; return; }; done
  echo "${HAVE[0]}"
}

{
cat <<EOF
# Создано setup-front.sh — правки руками перезапишутся при следующем запуске.
upstream vish_bot {
    server $BOT_IP:$BOT_PORT;
    keepalive 8;
}
EOF
for name in "${HAVE[@]}"; do
cat <<EOF

server {
    listen 443 ssl;
    server_name $name;
    ssl_certificate     $CERTS/$name.crt;
    ssl_certificate_key $CERTS/$name.key;
    # В блоке server, не в http: в nginx.conf Ubuntu ssl_protocols уже задан, повтор на том же уровне — ошибка.
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:vish:5m;
    ssl_session_timeout 1h;
    location / { include /etc/nginx/vish-proxy.inc; }
}
EOF
done
for name in $CF_NAMES $SEL_NAMES; do
  ports="80"
  # Старые http-ссылки календаря — только у имён Selectel (бывший основной адрес).
  case " $SEL_NAMES " in *" $name "*) [ "$LEGACY_OK" = 1 ] && [ -n "$LEGACY_HTTP_PORT" ] && ports="80 $LEGACY_HTTP_PORT";; esac
  for port in $ports; do
cat <<EOF

server {
    listen $port;
    server_name $name;
    # Хостинг бота сам продлевает свой сертификат по HTTP — пропускаем к нему.
    location /.well-known/acme-challenge/ {
        proxy_pass http://$BOT_IP;
        proxy_set_header Host \$host;
    }
    # Старые подписки на календарь и проверка живости — как раньше, по http.
    location /cal/ { include /etc/nginx/vish-proxy.inc; limit_except GET HEAD { deny all; } }
    location = /health { include /etc/nginx/vish-proxy.inc; limit_except GET HEAD { deny all; } }
    location / { return 301 https://$(https_of "$name")\$request_uri; }
}
EOF
  done
done
} > "$CONF.new"

cat > /etc/nginx/vish-proxy.inc.new <<EOF
# Создано setup-front.sh. Запрос — боту на хостинг, по HTTPS с проверкой сертификата.
proxy_pass https://vish_bot;
proxy_ssl_server_name on;
proxy_ssl_name $BOT_NAME;
proxy_ssl_verify on;
proxy_ssl_verify_depth 3;
proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;
proxy_ssl_session_reuse on;
proxy_http_version 1.1;
proxy_set_header Connection "";
proxy_set_header Host $BOT_NAME;
proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto \$scheme;
proxy_connect_timeout 15s;
proxy_send_timeout 120s;
proxy_read_timeout 120s;
# PDF от записывалки — до 38 МБ одним запросом.
client_max_body_size 50m;
proxy_request_buffering off;
EOF

# Старый конфиг — в сторону: битый новый не должен уронить работающий nginx.
cp -a "$CONF" "$CONF.bak" 2>/dev/null || true
cp -a /etc/nginx/vish-proxy.inc /etc/nginx/vish-proxy.inc.bak 2>/dev/null || true
mv "$CONF.new" "$CONF"
mv /etc/nginx/vish-proxy.inc.new /etc/nginx/vish-proxy.inc
if ! nginx -t 2>&1; then
  echo "Конфиг nginx не прошёл проверку — возвращаю прежний" >&2
  if [ -f "$CONF.bak" ]; then mv "$CONF.bak" "$CONF"; else rm -f "$CONF"; fi
  [ -f /etc/nginx/vish-proxy.inc.bak ] && mv /etc/nginx/vish-proxy.inc.bak /etc/nginx/vish-proxy.inc
  exit 1
fi
systemctl reload nginx

# Файрвол: если включён ufw — открыть порты входа.
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
  [ "$LEGACY_OK" = 1 ] && [ -n "$LEGACY_HTTP_PORT" ] && ufw allow "$LEGACY_HTTP_PORT/tcp" >/dev/null
fi

# ── 6. Проверка через этот VPS, не дожидаясь смены DNS.
sleep 1
fail=0
for name in "${HAVE[@]}"; do
  h="$(curl -sS -m 20 -o /dev/null -w '%{http_code}' --resolve "$name:443:127.0.0.1" "https://$name/health" || echo 000)"
  t="$(curl -sS -m 20 --resolve "$name:443:127.0.0.1" "https://$name/tma" | grep -o '<title>[^<]*</title>' || true)"
  if [ "$h" = 200 ] && [ -n "$t" ]; then
    echo "OK https://$name — /health 200, /tma $t"
  else
    echo "❌ https://$name — /health $h, /tma ${t:-нет страницы}. Лог: tail -20 /var/log/nginx/error.log" >&2
    fail=1
  fi
done
for name in $SEL_NAMES; do
  h="$(curl -sS -m 20 -o /dev/null -w '%{http_code}' --resolve "$name:80:127.0.0.1" "http://$name/health" || echo 000)"
  [ "$h" = 200 ] && echo "OK http://$name/health (старые ссылки)" || { echo "❌ http://$name/health — $h" >&2; fail=1; }
done
for name in $CF_NAMES $SEL_NAMES; do
  ip="$(curl -fsS -m 10 "https://dns.google/resolve?name=$name&type=A" 2>/dev/null | grep -o '"data":"[0-9.]*"' | head -1 | cut -d'"' -f4 || true)"
  echo "DNS сейчас: $name → ${ip:-не резолвится}"
done
[ "$fail" = 0 ] || exit 1
echo "Готово. Теперь A-записи имён — на IP этого VPS (облако Cloudflare — серое)."
