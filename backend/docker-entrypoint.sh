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

# Input field definitions on every boot. A field added to src/data/input-schemas.ts (Contract type
# was the first) otherwise never reaches a database that already holds data, because the full seed
# above runs only on an empty one — so the deployed app showed no such field. It upserts on
# (projectType, key) and never touches a project's values, so running it each time is safe.
echo "[entrypoint] syncing input field definitions"
npx tsx prisma/seed-input-fields.ts || echo "[entrypoint] input field sync failed — continuing"

echo "[entrypoint] starting api"
exec "$@"
