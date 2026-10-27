import { z } from 'zod';

const credentials = z.array(z.object({ token: z.string().min(32), ownerId: z.string().min(1).max(128) }))
  .min(1).refine(items => new Set(items.map(item => item.token)).size === items.length, 'Duplicate tokens');
export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.url().refine(value => /^postgres(ql)?:/.test(value)),
  REDIS_URL: z.url().refine(value => /^rediss?:/.test(value)),
  S3_ENDPOINT: z.url(), S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(3).default('contractiq'),
  S3_ACCESS_KEY: z.string().min(1), S3_SECRET_KEY: z.string().min(8),
  API_KEYS_JSON: z.string().transform((value, ctx) => {
    try { return JSON.parse(value) as unknown; }
    catch { ctx.addIssue({ code: 'custom', message: 'Must be JSON' }); return z.NEVER; }
  }).pipe(credentials),
  HEALTH_TIMEOUT_MS: z.coerce.number().int().min(50).max(10000).default(2000),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().max(104857600).default(20971520),
  MAX_PDF_PAGES: z.coerce.number().int().positive().max(5000).default(500),
  DOCUMENT_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  LLM_PROVIDER: z.enum(['mock', 'anthropic']).default('mock'),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
}).superRefine((config, ctx) => {
  if (config.LLM_PROVIDER === 'anthropic' && !config.ANTHROPIC_API_KEY) {
    ctx.addIssue({ code: 'custom', path: ['ANTHROPIC_API_KEY'], message: 'Required for Anthropic provider' });
  }
});
export type Config = z.infer<typeof configSchema>;
export function loadConfig(env: Record<string, string | undefined>): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid configuration: ${result.error.issues.map(i => i.path.join('.')).join(', ')}`);
  }
  return result.data;
}
