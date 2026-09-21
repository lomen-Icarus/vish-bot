# Chromium уже внутри образа playwright — отдельно ставить не нужно.
FROM mcr.microsoft.com/playwright:v1.50.0-noble

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm install --no-audit --no-fund typescript@5 && npx tsc -p tsconfig.json && npm prune --omit=dev

VOLUME ["/app/data"]
CMD ["node", "dist/main.js"]
