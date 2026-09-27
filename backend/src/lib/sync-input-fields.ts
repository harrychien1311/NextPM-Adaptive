/**
 * Upserts every input field definition from `data/input-schemas.ts`, on (projectType, key).
 *
 * Run when the API starts, so a field added to the schema (Contract type was the first) reaches
 * every database however the server is launched — the Docker entrypoint used to do it, but a
 * deployment started with `npm run start` (Render's native runtime) never ran the entrypoint, and the
 * deployed app simply had no such field. Idempotent, and it never touches a project's values: an
 * existing project just gains the new, empty field. `npm run db:seed:inputs` runs the same thing.
 */
import type { PrismaClient, ProjectType } from '@prisma/client';
import { INPUT_SCHEMAS } from '../data/input-schemas';

export async function syncInputFieldDefinitions(prisma: PrismaClient): Promise<string[]> {
  const added: string[] = [];
  for (const [type, fields] of Object.entries(INPUT_SCHEMAS) as [ProjectType, typeof INPUT_SCHEMAS.SI][]) {
    const existing = new Set(
      (await prisma.inputFieldDefinition.findMany({ where: { projectType: type }, select: { key: true } })).map((row) => row.key),
    );
    for (const [index, field] of fields.entries()) {
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
      if (!existing.has(field.key)) added.push(`${type} · ${field.label}`);
    }
  }
  return added;
}
