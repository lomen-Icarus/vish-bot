#!/bin/bash
# Точка входа для сервера записывалки в панели Pterodactyl — как в образах
# yolks: Wings кладёт стартовую команду сервера в STARTUP (с плейсхолдерами
# {{VAR}}) и запускает контейнер от своего пользователя с домом /home/container.
cd /home/container

# В консоли панели сразу видно, чем запускаемся.
echo "node $(node -v), chromium из ${PLAYWRIGHT_BROWSERS_PATH:-/ms-playwright}"

# {{SERVER_MEMORY}} и прочие плейсхолдеры панели → переменные окружения.
MODIFIED_STARTUP=$(echo -e ${STARTUP} | sed -e 's/{{/${/g' -e 's/}}/}/g')
echo ":/home/container$ ${MODIFIED_STARTUP}"

eval ${MODIFIED_STARTUP}
