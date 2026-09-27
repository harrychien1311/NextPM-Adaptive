import { createApp } from './app';
import { env } from './config/env';
import { prisma } from './lib/prisma';
import { syncInputFieldDefinitions } from './lib/sync-input-fields';

async function main() {
  await prisma.$connect();

  // New input fields reach an existing database here, whatever launched the server. A failure is
  // logged, never fatal: an API that will not start over a missing form field helps nobody.
  try {
    const added = await syncInputFieldDefinitions(prisma);
    console.log(`[nextpm-api] input field definitions up to date${added.length ? ` — added ${added.join(', ')}` : ''}`);
  } catch (error) {
    console.error('[nextpm-api] input field sync failed — continuing', error);
  }

  const app = createApp();
  const server = app.listen(env.port, () => {
    console.log(`[nextpm-api] listening on http://localhost:${env.port} (${env.nodeEnv})`);
  });

  const shutdown = async (signal: string) => {
    console.log(`[nextpm-api] ${signal} received, shutting down`);
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(async (error) => {
  console.error('[nextpm-api] failed to start', error);
  await prisma.$disconnect();
  process.exit(1);
});
