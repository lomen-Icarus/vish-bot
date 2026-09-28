# Chromium уже внутри образа playwright — отдельно ставить не нужно. Версия
# образа ОБЯЗАНА совпадать с playwright-core в package.json: каждая версия
# ищет браузер своей ревизии, и с чужой записывалка не запустит Chromium.
# В образе 1.63 — Node 24 (undici требует Node ≥ 22.19).
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app

# Сначала все зависимости вместе с dev (TypeScript), собираем, потом убираем
# dev. NODE_ENV=production раньше сборки нельзя: npm тогда пропускал
# typescript, и npx подтягивал чужой пакет «tsc» — образ не собирался.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json && npm prune --omit=dev
ENV NODE_ENV=production

VOLUME ["/app/data"]
CMD ["node", "dist/main.js"]
