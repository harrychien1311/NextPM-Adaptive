/**
 * Re-seeds the input field definitions only (`npm run db:seed:inputs`) — how a field added to
 * `src/data/input-schemas.ts` reaches a database that already holds projects, without the full seed
 * (which rebuilds the demo data). Upserts on (projectType, key), so it is safe to run repeatedly and
 * never touches a project's values: an existing project simply gains the new, empty field.
 */
import { PrismaClient, type ProjectType } from '@prisma/client';
import { INPUT_SCHEMAS } from '../src/data/input-schemas';

const prisma = new PrismaClient();

async function main() {
  let created = 0;
  for (const [type, fields] of Object.entries(INPUT_SCHEMAS) as [ProjectType, typeof INPUT_SCHEMAS.SI][]) {
    for (const [index, field] of fields.entries()) {
      const existing = await prisma.inputFieldDefinition.findUnique({
        where: { projectType_key: { projectType: type, key: field.key } },
      });
      await prisma.inputFieldDefinition.upsert({
        where: { projectType_key: { projectType: type, key: field.key } },
        create: {
          projectType: type,
          key: field.key,
          label: field.label,
          fieldType: field.fieldType,
          options: field.options ?? [],
          required: field.required ?? false,
          domain: field.domain,
          signalKey: field.signalKey ?? field.key,
          order: index,
        },
        update: {
          label: field.label,
          options: field.options ?? [],
          required: field.required ?? false,
          domain: field.domain,
          order: index,
          signalKey: field.signalKey ?? field.key,
        },
      });
      if (!existing) {
        created += 1;
        console.log(`  + ${type} · ${field.label}`);
      }
    }
  }
  console.log(`Input field definitions up to date — ${created} added.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
