#!/bin/sh
set -e

echo "[entrypoint] applying schema to the database"
# db push is used instead of "migrate deploy" because the repository ships the
# schema without a migration history. Generate migrations with
# "npx prisma migrate dev" locally and switch this line to "migrate deploy"
# once prisma/migrations exists.
npx prisma db push --skip-generate --accept-data-loss

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
