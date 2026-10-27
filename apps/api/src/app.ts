import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { Config } from '@contractiq/core';

export interface Dependencies {
  checks: Record<'postgres' | 'redis' | 'storage', () => Promise<void>>;
  close(): Promise<void>;
}
declare module 'fastify' {
  interface FastifyRequest { ownerId: string | null }
}
function hash(value: string): Buffer { return createHash('sha256').update(value).digest(); }
async function boundedCheck(check: () => Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([Promise.resolve().then(check), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Dependency timeout')), timeoutMs);
    })]);
    return true;
  } catch { return false; }
  finally { clearTimeout(timer); }
}
export function buildApp(config: Config, deps: Dependencies): FastifyInstance {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL, redact: ['req.headers.authorization', 'req.headers.cookie'],
      serializers: { req: req => ({ method: req.method, id: req.id }) } },
    bodyLimit: config.MAX_UPLOAD_BYTES,
    requestTimeout: 30000, connectionTimeout: 10000,
    genReqId: () => randomUUID(),
    // Never log raw URLs, headers, body, or dependency error messages.
    disableRequestLogging: true,
  });
  app.decorateRequest('ownerId', null);
  const keys = config.API_KEYS_JSON.map(key => ({ digest: hash(key.token), ownerId: key.ownerId }));
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
  });
  // global: true attaches route-level hooks, which run after the auth hook, so 401s and 404s
  // were never counted. An app-level hook registered before auth limits every request.
  app.register(rateLimit, { global: false, max: 120, timeWindow: '1 minute' });
  app.after(() => { app.addHook('onRequest', app.rateLimit()); app.addHook('onRequest', authenticate); });
  async function authenticate(request: FastifyRequest, reply: FastifyReply) {
    const path = request.url.split('?')[0];
    if (path === '/health/live' || path === '/health/ready') return;
    const auth = request.headers.authorization;
    const digest = hash(auth?.startsWith('Bearer ') ? auth.slice(7) : '');
    let ownerId: string | null = null;
    for (const key of keys) if (timingSafeEqual(digest, key.digest)) ownerId = key.ownerId;
    if (!ownerId) return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Valid bearer token required', requestId: request.id } });
    request.ownerId = ownerId;
  }
  app.setErrorHandler((error, request, reply) => {
    const statusCode = error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
    const status = typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500 ? statusCode : 500;
    request.log.warn({ statusCode: status, requestId: request.id }, 'Request failed');
    const code = status === 413 ? 'PAYLOAD_TOO_LARGE' : status === 429 ? 'RATE_LIMITED' : status === 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST';
    reply.code(status).send({ error: { code, message: status === 500 ? 'Internal server error' : 'Request rejected', requestId: request.id } });
  });
  app.setNotFoundHandler((request, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found', requestId: request.id } }));
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    const entries = await Promise.all(Object.entries(deps.checks).map(async ([name, check]) => [name, await boundedCheck(check, config.HEALTH_TIMEOUT_MS)] as const));
    const ready = entries.every(([, ok]) => ok);
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', dependencies: Object.fromEntries(entries) });
  });
  app.addHook('onClose', () => deps.close());
  return app;
}
