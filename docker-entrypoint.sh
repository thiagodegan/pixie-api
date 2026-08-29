#!/bin/sh
set -e

# As migrations rodam no boot do contêiner, e não num passo manual à parte:
# assim o schema do banco nunca fica atrás da imagem que está subindo.
echo "→ aplicando migrations…"
npx prisma migrate deploy

exec "$@"
