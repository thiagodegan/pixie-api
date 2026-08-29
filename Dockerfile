# ---------------------------------------------------------------------------
# pixie-api — build multi-stage.
#
# Base Debian slim (não Alpine) porque o Prisma engine e o @node-rs/argon2
# distribuem binários pré-compilados para glibc; em musl a imagem tem que
# compilar tudo do zero.
# ---------------------------------------------------------------------------

FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

# Alvo de desenvolvimento: código montado por bind mount, tsx em watch.
FROM node:24-bookworm-slim AS dev
WORKDIR /app
ENV NODE_ENV=development
ENV TZ=America/Sao_Paulo
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npm", "run", "dev"]

FROM node:24-bookworm-slim AS build
WORKDIR /app
# openssl também aqui: sem ele o Prisma detecta a versão errada ao gerar o
# client e o engine não carrega no runtime.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV TZ=America/Sao_Paulo

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*

# --chown é essencial: o `prisma migrate deploy` do entrypoint precisa escrever
# em node_modules/@prisma para validar os engines, e o processo não roda como
# root. Sem isto o contêiner entra em loop de restart no boot.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER node
EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--", "docker-entrypoint.sh"]
CMD ["node", "dist/src/index.js"]
