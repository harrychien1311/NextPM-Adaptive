#!/bin/sh
set -e

echo "[entrypoint] applying migrations"
# The repository now ships a real migration history (prisma/migrations), so apply it properly.
# The previous "db push --accept-data-loss" would silently drop columns and tables to make the
# database match the schema — acceptable for a throwaway dev volume, never for real data.
npx prisma migrate deploy

# Seed only an empty database, so restarting the stack never duplicates data.
COUNT=$(node -e "
const { PrismaClient } = require('@prisma/client');
new PrismaClient().user.count().then(n => { console.log(n); process.exit(0); }).catch(() => { console.log(0); process.exit(0); });
")

if [ "$COUNT" = "0" ]; then
  echo "[entrypoint] empty database, seeding demo data"
  npx tsx prisma/seed.ts
else
  echo "[entrypoint] $COUNT users already present, skipping seed"
fi

echo "[entrypoint] starting api"
exec "$@"
