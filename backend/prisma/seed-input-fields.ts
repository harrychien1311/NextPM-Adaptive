/**
 * Re-seeds the input field definitions only (`npm run db:seed:inputs`). The API also does this on
 * every start (`src/lib/sync-input-fields.ts`), so this is for running it by hand — against a
 * database whose API is not running, or to see what would be added.
 */
import { PrismaClient } from '@prisma/client';
import { syncInputFieldDefinitions } from '../src/lib/sync-input-fields';

const prisma = new PrismaClient();

syncInputFieldDefinitions(prisma)
  .then((added) => {
    for (const entry of added) console.log(`  + ${entry}`);
    console.log(`Input field definitions up to date — ${added.length} added.`);
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
