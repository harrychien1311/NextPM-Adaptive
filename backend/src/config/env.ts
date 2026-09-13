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
    // Current-generation default. Override with ANTHROPIC_MODEL to pin a different model.
    // `||` rather than `??` on purpose: a variable set to an empty string (which is what an
    // unset `${ANTHROPIC_MODEL:-}` in docker-compose produces) must fall back, not send "".
    model: process.env.ANTHROPIC_MODEL || 'claude-opus-5',
    /**
     * How hard the model thinks before answering. The API's own default is `high`; we send
     * `medium` deliberately — on this workload the reasoning is only ~14-27% of the output
     * tokens, so `high` buys little and costs more.
     *
     * `off` omits the parameter entirely. Needed if ANTHROPIC_MODEL is ever pointed at a model
     * that rejects `effort` (Haiku 4.5 and older Sonnet), where sending it would 400 the request
     * and silently drop the app back to the mock writer.
     */
    effort: process.env.AI_EFFORT || 'medium',
  },
  isProd: process.env.NODE_ENV === 'production',
};
