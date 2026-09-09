import 'dotenv/config';

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 4000),
  corsOrigin: (process.env.CORS_ORIGIN ?? 'http://localhost:5173').split(','),
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET', 'dev-secret'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '12h',
  uploadDir: process.env.UPLOAD_DIR ?? './storage/uploads',
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB ?? 20),
  maxFilesPerGroup: Number(process.env.MAX_FILES_PER_GROUP ?? 2),
  ai: {
    provider: (process.env.AI_PROVIDER ?? 'mock') as 'mock' | 'anthropic',
    anthropicKey: process.env.ANTHROPIC_API_KEY ?? '',
    model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
  },
  isProd: process.env.NODE_ENV === 'production',
};
