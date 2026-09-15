/**
 * Loads the customer reference library from `data/raw`.
 *
 * Separate from `seed.ts` on purpose: the demo accounts and project workspaces are throwaway
 * fixtures, whereas these are real customer documents. They are seeded from files rather than
 * from inline data so the checklist rows always come from the same parser the upload endpoint
 * uses — if the parser regresses, seeding shows it.
 *
 *   npm run db:seed:customers
 *
 * Re-running replaces what it seeded: each customer is reset to exactly the files listed here,
 * so the script is safe to run repeatedly and never stacks duplicate versions.
 *
 * **Local development only.** It reads `data/raw`, which is outside the backend Docker build
 * context and so is not in the API image, and it copies files into `UPLOAD_DIR` on whatever
 * machine runs it — in Docker that directory is a named volume the host cannot write to. Running
 * this against a containerised API would leave rows pointing at files the container cannot see
 * (the download endpoint says so explicitly rather than failing opaquely). Against a
 * containerised or deployed API, upload through the Customer library screen instead: that is the
 * product's own path, and it is the same parser either way.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { parseChecklist } from '../src/lib/checklist-parser';
import { parseTemplate } from '../src/lib/pptx-template';
import { env } from '../src/config/env';

const prisma = new PrismaClient();

const RAW_DIR = path.resolve(__dirname, '../../data/raw');

interface SeedCustomer {
  key: string;
  name: string;
  /** Every spelling a PM might type into the project's free-text Customer field. */
  aliases: string[];
  checklist?: { name: string; file: string };
  templates?: { documentType: string; file: string }[];
}

const CUSTOMERS: SeedCustomer[] = [
  {
    key: 'LGCNS',
    name: 'LG CNS',
    aliases: ['LGCNS', 'LG CNS', 'GDC', 'LG CNS GDC'],
    checklist: { name: 'GDC Project Checklist', file: '7. GDC_project_체크리스트_1.8.xlsx' },
  },
  {
    key: 'SKAX',
    name: 'SK AX',
    aliases: ['SKAX', 'SK AX', 'SK C&C', 'SKCC', 'AGS'],
    checklist: { name: 'AGS Operational Readiness Checklist', file: 'AGS Operational Readiness Checklist.docx' },
    templates: [{ documentType: 'Kickoff Deck', file: 'SKAX_[ProjectName]_Kickoff_Template_20260619.pptx' }],
  },
];

const MIME: Record<string, string> = {
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** Copies the source file into the upload store under a stable, ASCII-safe key. */
async function store(fileName: string, prefix: string): Promise<Buffer> {
  const buffer = await fs.readFile(path.join(RAW_DIR, fileName));
  await fs.mkdir(env.uploadDir, { recursive: true });
  await fs.writeFile(path.join(env.uploadDir, prefix), buffer);
  return buffer;
}

async function main() {
  for (const seed of CUSTOMERS) {
    // Start clean so re-running never stacks versions of the same file.
    await prisma.customer.deleteMany({ where: { key: seed.key } });
    const customer = await prisma.customer.create({
      data: { key: seed.key, name: seed.name, aliases: seed.aliases },
    });
    console.log(`\n${customer.key}  ${customer.name}  ·  aliases: ${customer.aliases.join(', ')}`);

    if (seed.checklist) {
      const storageKey = `seed-${seed.key}-checklist${path.extname(seed.checklist.file)}`;
      const buffer = await store(seed.checklist.file, storageKey);
      const parsed = await parseChecklist(buffer, seed.checklist.file);
      await prisma.customerChecklist.create({
        data: {
          customerId: customer.id,
          name: seed.checklist.name,
          sourceFile: seed.checklist.file,
          storageKey,
          mimeType: MIME[path.extname(seed.checklist.file).toLowerCase()] ?? 'application/octet-stream',
          version: 1,
          active: true,
          parseNote: parsed.note,
          items: { create: parsed.items },
        },
      });
      console.log(`   checklist  ${seed.checklist.file}`);
      console.log(`              ${parsed.note}`);
    }

    for (const template of seed.templates ?? []) {
      const storageKey = `seed-${seed.key}-${template.documentType.replace(/\W+/g, '-')}${path.extname(template.file)}`;
      const buffer = await store(template.file, storageKey);
      const parsed = await parseTemplate(buffer, template.file);
      await prisma.customerTemplate.create({
        data: {
          customerId: customer.id,
          documentType: template.documentType,
          fileType: parsed.fileType,
          sourceFile: template.file,
          storageKey,
          mimeType: MIME[path.extname(template.file).toLowerCase()] ?? 'application/octet-stream',
          version: 1,
          active: true,
          placeholders: parsed.placeholders as unknown as object,
          parseNote: parsed.note,
        },
      });
      console.log(`   template   ${template.documentType} — ${template.file}`);
      console.log(`              ${parsed.note}`);
    }
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
