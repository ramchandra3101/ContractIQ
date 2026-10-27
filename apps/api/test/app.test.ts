import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../../packages/core/src/index.js';
import { buildApp, type Dependencies } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

const token = 'test-token-with-at-least-thirty-two-characters';
const env = {
  DATABASE_URL: 'postgresql://user:password@localhost/test', REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000', S3_ACCESS_KEY: 'test', S3_SECRET_KEY: 'test-password',
  API_KEYS_JSON: JSON.stringify([{ token, ownerId: 'owner-a' }]), LOG_LEVEL: 'silent', HEALTH_TIMEOUT_MS: '50',
};
const apps: FastifyInstance[] = [];
function setup(overrides: Partial<Dependencies['checks']> = {}): FastifyInstance {
  const app = buildApp(loadConfig(env), { checks: {
    postgres: async () => {}, redis: async () => {}, storage: async () => {}, ...overrides,
  }, close: async () => {} });
  apps.push(app);
  return app;
}
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
describe('health', () => {
  it('liveness does not depend on infrastructure', async () => {
    const postgres = vi.fn().mockRejectedValue(new Error('secret connection string'));
    const response = await setup({ postgres }).inject('/health/live');
    expect(response.statusCode).toBe(200); expect(postgres).not.toHaveBeenCalled();
  });
  it('reports readiness for all dependencies', async () => {
    const response = await setup().inject('/health/ready');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready', dependencies: { postgres: true, redis: true, storage: true } });
  });
  it('returns 503 without leaking dependency errors', async () => {
    const response = await setup({ storage: async () => { throw new Error('secret'); } }).inject('/health/ready');
    expect(response.statusCode).toBe(503); expect(response.body).not.toContain('secret');
    expect(response.json().dependencies.storage).toBe(false);
  });
  it('bounds a hanging dependency', async () => {
    const response = await setup({ postgres: () => new Promise(() => {}) }).inject('/health/ready');
    expect(response.statusCode).toBe(503);
  });
});
describe('security and errors', () => {
  it('requires authentication outside health routes', async () => {
    const response = await setup().inject('/api/v1/documents');
    expect(response.statusCode).toBe(401); expect(response.json().error.code).toBe('UNAUTHORIZED');
  });
  it('binds validated tokens to the configured owner', async () => {
    const app = setup(); app.get('/owner', async req => ({ ownerId: req.ownerId }));
    const response = await app.inject({ url: '/owner', headers: { authorization: `Bearer ${token}` } });
    expect(response.json()).toEqual({ ownerId: 'owner-a' });
  });
  it('rejects an incorrect token and prefix', async () => {
    for (const authorization of [`Bearer ${token}x`, `Basic ${token}`]) {
      expect((await setup().inject({ url: '/unknown', headers: { authorization } })).statusCode).toBe(401);
    }
  });
  it('uses consistent errors and server generated request IDs', async () => {
    const response = await setup().inject({ url: '/missing', headers: { authorization: `Bearer ${token}`, 'x-request-id': 'untrusted' } });
    expect(response.statusCode).toBe(404); expect(response.json().error.requestId).not.toBe('untrusted');
    expect(response.headers['x-request-id']).toBe(response.json().error.requestId);
  });
  it('does not leak internal error messages', async () => {
    const app = setup(); app.get('/fail', () => { throw new Error('sensitive document text'); });
    const response = await app.inject({ url: '/fail', headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(500); expect(response.body).not.toContain('sensitive');
  });
  it.each([
    ['bad tokens', 'Bearer wrong-token'],
    ['authenticated unknown routes', `Bearer ${token}`],
  ])('rate limits %s before authentication and routing', async (_label, authorization) => {
    const app = setup();
    const codes = [];
    for (let i = 0; i < 121; i++) codes.push((await app.inject({ url: '/api/v1/documents', headers: { authorization } })).statusCode);
    expect(new Set(codes.slice(0, 120)).has(429)).toBe(false);
    const limited = await app.inject({ url: '/api/v1/documents', headers: { authorization } });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('RATE_LIMITED');
    expect(limited.headers['x-request-id']).toBe(limited.json().error.requestId);
  });
  it('closes owned dependency resources', async () => {
    const close = vi.fn(async () => {});
    const app = buildApp(loadConfig(env), { checks: { postgres: async () => {}, redis: async () => {}, storage: async () => {} }, close });
    await app.ready(); await app.close(); expect(close).toHaveBeenCalledOnce();
  });
});
describe('configuration', () => {
  it('defaults to mock without a paid key', () => { expect(loadConfig(env).LLM_PROVIDER).toBe('mock'); });
  it.each([{ PORT: '0' }, { DATABASE_URL: 'https://wrong' }, { API_KEYS_JSON: '{}' }, { API_KEYS_JSON: 'invalid' }, { LLM_PROVIDER: 'anthropic' }, { LLM_PROVIDER: 'openai' }, { MAX_UPLOAD_BYTES: '-1' }])('rejects invalid config: %j', override => {
    expect(() => loadConfig({ ...env, ...override })).toThrow('Invalid configuration');
  });
  it('does not leak secrets in config errors', () => {
    expect(() => loadConfig({ ...env, DATABASE_URL: 'secret-value' })).toThrow('Invalid configuration: DATABASE_URL');
  });
});
