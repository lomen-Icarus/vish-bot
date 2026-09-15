# Деплой на Pterodactyl (FrienWorld)

Сервер: панель `panel.frienworld.space`, сервер `b7f95b74`, egg **Node.js generic**, порт `srv3.frienworld.space:40070`.
Бот работает через long polling; открытый порт нужен только подписке на календарь (маленький HTTP-сервер, HTTPS не требуется).

## Что лежит на сервере

```
/home/container
├── index.js          # лаунчер: запускает dist/main.js, при Node < 22.19 скачивает портативный Node 22 в .runtime/
├── dist/             # собранный бот (npm run build)
├── package.json      # зависимости ставятся стартовым скриптом egg'а (npm install)
├── .env              # секреты, создаётся вручную в файловом менеджере панели
└── data/             # SQLite-база (vish-bot.sqlite), бэкапится копированием файла
```

Стартовая команда egg'а уже подходит: `npm install` + `node /home/container/index.js` (переменная `JS_FILE=index.js`).

## Секреты: куда что класть

| Что | Куда | Зачем |
|---|---|---|
| `BOT_TOKEN`, `ADMIN_IDS`, `MEDIA_CHAT_IDS`, `ANTHROPIC_API_KEY`, `PORTAL_LOGIN`/`PORTAL_PASSWORD`, `VK_SERVICE_TOKEN`, `NEWS_CHANNEL_IDS` | файл `/home/container/.env` (панель → Files → New file) | их читает бот при старте |
| `PTERO_API_KEY`, `PTERO_PANEL_URL`, `PTERO_SERVER_ID` | GitHub → репозиторий → Settings → Secrets and variables → Actions | автодеплой из GitHub Actions |
| токен тестового бота для разработки | окружение Claude Code → Environment variables (`BOT_TOKEN`) | живые проверки из песочницы без пересылки токена в чат |

Пример `.env` лежит в `.env.example`. Все переменные описаны там же.

## Что добавить в `.env` после обновления (раунд 3)

| Переменная | Значение | Что даёт |
|---|---|---|
| `POLL_CRON_BUSY` | `*/6 7-21 * * 1-6` | опрос портала раз в 6 минут (было 5) |
| `PUBLIC_URL` | `http://srv3.frienworld.space:40070` | кнопка «Подписка» в календаре: телефон сам обновляет расписание |
| `PORTAL_LOGIN` / `PORTAL_PASSWORD` | учётка портала | полный справочник преподавателей и их очные пары; без неё бот знает только преподавателей дистанционных пар |
| `POSTER_THEME` | `midnight` \| `editorial` \| `brutalist` \| `timeline` | оформление постеров |

Порт слушается автоматически: Pterodactyl передаёт его в `SERVER_PORT`, отдельная переменная не нужна. `PUBLIC_URL` нужен только для того, чтобы бот показал ссылку.

## Порт и подписка на календарь

Pterodactyl передаёт выделенный порт в переменной `SERVER_PORT`; бот поднимает на нём HTTP-сервер с личными лентами календаря (`/cal/<token>.ics`) и `/health`.
Чтобы в боте появилась кнопка «Подписка», в `.env` нужно добавить адрес, по которому этот порт виден снаружи: `PUBLIC_URL=http://srv3.frienworld.space:40070`.
Проверка: открыть `http://srv3.frienworld.space:40070/health` в браузере — должен вернуться JSON с `"ok":true`. Если порт снаружи закрыт, подписка не работает, файл .ics работает всегда.

## Первый запуск вручную

1. В панели создать файл `.env` по образцу `.env.example`.
2. Залить релиз: `npm run build`, затем загрузить `index.js`, `dist/`, `package.json`, `package-lock.json` и `.npmrc` с содержимым `omit=dev` (или запустить workflow `CI & Deploy` вручную: Actions → Run workflow, он собирает всё сам).
3. Нажать Start. В консоли должны появиться строки `bot authorised`, `scheduler started`, `poll finished`.
4. Написать боту `/start`, затем `/health` (для администратора) — покажет аптайм, последний опрос и калибровку недели.

## Node 18 в egg'е

Образ `ghcr.io/parkervcp/yolks:nodejs_18` слишком старый для зависимостей (undici 8 требует Node 22.19+, база данных использует встроенный `node:sqlite`).
Лаунчер `index.js` это обходит: один раз скачивает портативный Node 22 с nodejs.org в `.runtime/` и ставит зависимости им.
Лучше попросить FrienWorld добавить образ `ghcr.io/parkervcp/yolks:nodejs_22` в egg и переключиться на него — тогда обход не нужен.

Важно: контейнер FrienWorld запрещает `utime()` на файлах (ошибка `EPERM: operation not permitted, futime`), поэтому нативные модули там не собираются вообще.
В проекте их нет: SQLite встроен в Node, `@resvg/resvg-js` ставится готовым бинарником как обычный npm-пакет. Не добавляйте зависимости с `node-gyp`.

## Автодеплой

Workflow `.github/workflows/deploy.yml`: на каждый push в `main` прогоняет typecheck, тесты, сборку, затем загружает архив через Client API панели, распаковывает его в корень и перезапускает сервер.
Нужны три секрета в GitHub (см. таблицу выше). `PTERO_PANEL_URL` = `https://panel.frienworld.space`, `PTERO_SERVER_ID` = `b7f95b74`.

## Бэкап

База — один файл `data/vish-bot.sqlite` (WAL-режим, рядом могут лежать `-wal` и `-shm`). Бэкап панели («Backups», 1 слот) его покрывает; для ручной копии остановите бот или скопируйте все три файла вместе.
