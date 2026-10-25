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
#     → имена из SEL_NAMES (acme.sh, DNS-01), если NS домена — Selectel.
#   Домен не у Selectel (или нет selectel.env) — имя из SEL_NAMES выпускается
#   через сайт (certbot, HTTP-01): Let's Encrypt забирает файл с этого VPS.
#   Для этого A-запись имени уже должна указывать сюда (VPS_IP); пока не
#   указывает — имя пропускается. Здесь порядок обратный DNS-01: сначала
#   A-запись, потом скрипт, и до «OK» HTTPS по этому имени не работает.
# Продление — само: таймер certbot и cron acme.sh, nginx перечитывается.
set -euo pipefail

VPS_IP="${VPS_IP:-77.91.92.142}"                          # этот VPS — для проверки A-записи перед HTTP-01
BOT_IP="${BOT_IP:-135.125.188.210}"                       # хостинг бота (OVH)
BOT_PORT="${BOT_PORT:-443}"                               # его HTTPS-порт
BOT_NAME="${BOT_NAME:-rezerve-adress.frienworld.com}"     # имя, под которым бот отвечает на хостинге
# Обход HTTPS хостинга: «IP:порт» самого бота (Pterodactyl → Network), например
# BOT_HTTP=135.125.188.210:48505. Нужен, когда HTTPS хостинга ведёт не туда
# (так было 24.10.2026: порт сервера сменился с 40070 на 48505, а HTTPS хостинга
# остался на старом). Участок VPS → бот тогда идёт по HTTP без шифрования —
# держать так, только пока хостинг не перенаправит свой HTTPS. Задавать при
# каждом запуске скрипта: без переменной конфиг вернётся к HTTPS хостинга.
BOT_HTTP="${BOT_HTTP:-}"
CF_NAMES="${CF_NAMES:-rezerve-adress.frienworld.com}"
SEL_NAMES="${SEL_NAMES:-calendar.secretvish.ru}"
# Старые ссылки на календарь — http, местами с портом хостинга (:40070).
LEGACY_HTTP_PORT="${LEGACY_HTTP_PORT:-40070}"
CF_INI=/root/.secrets/cloudflare.ini
SEL_ENV=/root/.secrets/selectel.env
CERTS=/etc/nginx/vish-certs
CONF=/etc/nginx/conf.d/vish-front.conf
PROXY_INC=/etc/nginx/vish-proxy.inc
ACME=/root/.acme.sh/acme.sh
WEBROOT=/var/www/vish-acme   # файлы проверки HTTP-01

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
mkdir -p "$CERTS" "$WEBROOT"
chmod 700 "$CERTS"

# Файрвол: если включён ufw — открыть порты входа (до выпуска: HTTP-01 идёт на 80).
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
  [ "$LEGACY_OK" = 1 ] && [ -n "$LEGACY_HTTP_PORT" ] && ufw allow "$LEGACY_HTTP_PORT/tcp" >/dev/null
fi

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

# ── 4. Сертификаты через Selectel (acme.sh, DNS actual). Домен не у Selectel,
# нет selectel.env или выпуск не удался — имя уходит на выпуск через сайт (шаг 6).
HTTP_TODO=()
for name in $SEL_NAMES; do
  if [ ! -f "$SEL_ENV" ]; then
    echo "Нет $SEL_ENV — $name выпущу через сайт"
    HTTP_TODO+=("$name")
    continue
  fi
  zone="$(zone_of "$name")"
  set +e; ns_matches "$zone" "ns.selectel" ; rc=$?; set -e
  if [ "$rc" = 1 ]; then
    echo "$zone не у Selectel (NS в публичном DNS другие) — $name выпущу через сайт"
    HTTP_TODO+=("$name")
    continue
  fi
  chmod 600 "$SEL_ENV"
  if [ ! -x "$ACME" ]; then
    echo "Ставлю acme.sh…"
    # Установщик и при ошибке выходит с 0 — судим по появившемуся файлу.
    curl -fsSL https://get.acme.sh | sh -s >/dev/null || true
    [ -x "$ACME" ] || { echo "acme.sh не поставился (нужен доступ к raw.githubusercontent.com)" >&2; exit 1; }
  fi
  echo "Сертификат $name (Selectel)…"
  set +e
  ( set -a; . "$SEL_ENV"; set +a
    "$ACME" --issue --server letsencrypt --dns dns_selectel -d "$name" --keylength ec-256 )
  rc=$?
  set -e
  # 2 — сертификат ещё свежий, перевыпуск не нужен.
  if [ "$rc" != 0 ] && [ "$rc" != 2 ]; then
    echo "⚠️ Сертификат $name через Selectel не выпустился (проверь $SEL_ENV) — пробую через сайт" >&2
    HTTP_TODO+=("$name")
    continue
  fi
  "$ACME" --install-cert -d "$name" --ecc \
    --key-file "$CERTS/$name.key" --fullchain-file "$CERTS/$name.crt" \
    --reloadcmd "systemctl reload nginx" >/dev/null
done

have_cert() { [ -s "$CERTS/$1.crt" ] && [ -s "$CERTS/$1.key" ]; }
collect_have() {
  HAVE=()
  for name in $CF_NAMES $SEL_NAMES; do have_cert "$name" && HAVE+=("$name"); done
  return 0
}

# IPv4 имени в публичном DNS (как видят телефоны и Let's Encrypt); пусто — не резолвится.
public_ip() {
  curl -fsS -m 10 "https://dns.google/resolve?name=$1&type=A" 2>/dev/null | grep -o '"data":"[0-9.]*"' | head -1 | cut -d'"' -f4 || true
}
# Указывает ли A-запись на этот VPS: VPS_IP или один из адресов интерфейсов.
is_here() {
  local ip="$1" own
  [ -n "$ip" ] || return 1
  [ "$ip" = "$VPS_IP" ] && return 0
  for own in $(hostname -I 2>/dev/null); do [ "$own" = "$ip" ] && return 0; done
  return 1
}

# ── 5. Конфиг nginx (функция: при выпуске через сайт пишется дважды — до и после).
https_of() {  # куда отправлять с http: своё имя, если есть сертификат, иначе первое имя с сертификатом
  local n
  for n in "${HAVE[@]}"; do [ "$n" = "$1" ] && { echo "$1"; return; }; done
  echo "${HAVE[0]:-$1}"
}

write_nginx() {
{
cat <<EOF
# Создано setup-front.sh — правки руками перезапишутся при следующем запуске.
upstream vish_bot {
    server ${BOT_HTTP:-$BOT_IP:$BOT_PORT};
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
    location / { include $PROXY_INC; }
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
    # Проверка HTTP-01: свой файл (сертификат этого VPS) — отсюда, остальное —
    # хостингу бота: он сам продлевает свой сертификат по HTTP.
    location /.well-known/acme-challenge/ {
        root $WEBROOT;
        try_files \$uri @acme_bot;
    }
    location @acme_bot {
        proxy_pass http://$BOT_IP;
        proxy_set_header Host \$host;
    }
    # Старые подписки на календарь и проверка живости — как раньше, по http.
    location /cal/ { include $PROXY_INC; limit_except GET HEAD { deny all; } }
    location = /health { include $PROXY_INC; limit_except GET HEAD { deny all; } }
    location / { return 301 https://$(https_of "$name")\$request_uri; }
}
EOF
  done
done
} > "$CONF.new"

if [ -n "$BOT_HTTP" ]; then
cat > "$PROXY_INC.new" <<EOF
# Создано setup-front.sh (BOT_HTTP=$BOT_HTTP). Запрос — боту прямо на его порт, по HTTP:
# обход HTTPS хостинга, пока тот ведёт не туда. Без шифрования — временно.
proxy_pass http://vish_bot;
proxy_http_version 1.1;
proxy_set_header Connection "";
proxy_set_header Host \$host;
proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto \$scheme;
proxy_connect_timeout 15s;
proxy_send_timeout 120s;
proxy_read_timeout 120s;
# PDF от записывалки — до 38 МБ одним запросом.
client_max_body_size 50m;
proxy_request_buffering off;
EOF
else
cat > "$PROXY_INC.new" <<EOF
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
fi

# Старый конфиг — в сторону: битый новый не должен уронить работающий nginx.
cp -a "$CONF" "$CONF.bak" 2>/dev/null || true
cp -a "$PROXY_INC" "$PROXY_INC.bak" 2>/dev/null || true
mv "$CONF.new" "$CONF"
mv "$PROXY_INC.new" "$PROXY_INC"
if ! nginx -t 2>&1; then
  echo "Конфиг nginx не прошёл проверку — возвращаю прежний" >&2
  if [ -f "$CONF.bak" ]; then mv "$CONF.bak" "$CONF"; else rm -f "$CONF"; fi
  [ -f "$PROXY_INC.bak" ] && mv "$PROXY_INC.bak" "$PROXY_INC"
  return 1
fi
systemctl reload nginx
}

# ── 6. Сертификаты через сайт (certbot, HTTP-01): Let's Encrypt забирает файл
# проверки по http://имя/.well-known/acme-challenge/ — значит, имя уже должно
# указывать на этот VPS. Не указывает — пропускаем: каждая неудачная проверка
# тратит лимит Let's Encrypt (5 в час на имя).
collect_have
PENDING=()
for name in "${HTTP_TODO[@]}"; do
  # Свежий сертификат от acme.sh (обычный файл, не ссылка certbot) — не трогаем.
  if have_cert "$name" && [ ! -L "$CERTS/$name.crt" ] && openssl x509 -checkend 2592000 -noout -in "$CERTS/$name.crt" >/dev/null 2>&1; then
    continue
  fi
  ip="$(public_ip "$name")"
  if ! is_here "$ip"; then
    echo "⏳ $name → ${ip:-не резолвится}, а не этот VPS ($VPS_IP) — переведи A-запись сюда и запусти скрипт снова"
    continue
  fi
  PENDING+=("$name")
done
if [ ${#PENDING[@]} -gt 0 ]; then
  # Файлы проверки должен отдавать уже nginx этого VPS — пишем конфиг до выпуска.
  write_nginx || exit 1
  for name in "${PENDING[@]}"; do
    echo "Сертификат $name (через сайт)…"
    if certbot certonly --non-interactive --agree-tos --register-unsafely-without-email \
        --webroot -w "$WEBROOT" --keep-until-expiring --cert-name "$name" -d "$name" \
        --deploy-hook "systemctl reload nginx"; then
      ln -sfn "/etc/letsencrypt/live/$name/fullchain.pem" "$CERTS/$name.crt"
      ln -sfn "/etc/letsencrypt/live/$name/privkey.pem" "$CERTS/$name.key"
    else
      echo "⚠️ Сертификат $name не выпустился: Let's Encrypt не забрал файл с http://$name/.well-known/acme-challenge/ — проверь, что A-запись → $VPS_IP и порт 80 открыт снаружи. Повторять — не чаще раза в час" >&2
    fi
  done
fi

collect_have
[ ${#HAVE[@]} -gt 0 ] || { echo "Нет ни одного сертификата — nginx не настраиваю" >&2; exit 1; }
write_nginx || exit 1

# ── 7. Проверка через этот VPS, не дожидаясь смены DNS.
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
  ip="$(public_ip "$name")"
  echo "DNS сейчас: $name → ${ip:-не резолвится}"
done
[ "$fail" = 0 ] || exit 1
echo "Готово. Теперь A-записи имён — на IP этого VPS (облако Cloudflare — серое)."
