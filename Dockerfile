# syntax=docker/dockerfile:1

# ---- build: compila TypeScript e remove dependências de desenvolvimento ----
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm run build && npm prune --omit=dev

# ---- runtime: imagem enxuta, usuário sem privilégios ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787
WORKDIR /app

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node config ./config

RUN mkdir -p /app/data && chown node:node /app/data

USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/src/index.js"]
