#!/bin/sh
set -e

# Em desenvolvimento, `prisma/` vem por bind mount mas `node_modules` é um
# volume anônimo que sobrevive ao rebuild da imagem — ou seja, o client gerado
# fica velho e some com os campos novos do schema. Regerar no boot custa uns
# segundos e evita depurar um "Unknown field" que não existe no código.
if [ "$NODE_ENV" != "production" ]; then
  echo "→ regenerando o Prisma Client (dev)…"
  npx prisma generate
fi

# As migrations rodam no boot do contêiner, e não num passo manual à parte:
# assim o schema do banco nunca fica atrás da imagem que está subindo.
echo "→ aplicando migrations…"
npx prisma migrate deploy

exec "$@"
