#!/bin/sh
# Aplica las migraciones versionadas y arranca el servidor.
# Si la base se creó con versiones anteriores (prisma db push), Prisma responde P3005:
# en ese caso se marca 0_init como ya aplicada (baseline) y se continúa con las siguientes.
set -e
export PRISMA_HIDE_UPDATE_MESSAGE=1

if ! output=$(npx prisma migrate deploy 2>&1); then
  echo "$output"
  if echo "$output" | grep -q "P3005"; then
    echo "[I-API] Base creada con db push: se registra la migración inicial como aplicada (baseline)."
    npx prisma migrate resolve --applied 0_init
    npx prisma migrate deploy
  else
    exit 1
  fi
else
  echo "$output"
fi

exec node --max-old-space-size=384 dist/server.js
