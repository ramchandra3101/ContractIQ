import { PrismaClient } from '@contractiq/database';
import { Redis } from 'ioredis';
import { S3Client, HeadBucketCommand } from '@aws-sdk/client-s3';
import type { Config } from '@contractiq/core';
import type { Dependencies } from './app.js';

export function createDependencies(config: Config): Dependencies {
  const databaseUrl = new URL(config.DATABASE_URL);
  databaseUrl.searchParams.set('connect_timeout', '2');
  databaseUrl.searchParams.set('pool_timeout', '2');
  databaseUrl.searchParams.set('socket_timeout', '2');
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl.toString() });
  const redis = new Redis(config.REDIS_URL, {
    connectTimeout: config.HEALTH_TIMEOUT_MS, commandTimeout: config.HEALTH_TIMEOUT_MS,
    maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: true,
  });
  redis.on('error', () => { /* Health endpoint reports failure without logging credentials. */ });
  void redis.connect().catch(() => undefined);
  const s3 = new S3Client({ endpoint: config.S3_ENDPOINT, region: config.S3_REGION,
    forcePathStyle: true, maxAttempts: 1,
    credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY } });
  return {
    checks: {
      postgres: async () => { await prisma.$queryRaw`SELECT 1`; },
      redis: async () => { if (await redis.ping() !== 'PONG') throw new Error('Redis unavailable'); },
      storage: async () => { await s3.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET }), { abortSignal: AbortSignal.timeout(config.HEALTH_TIMEOUT_MS) }); },
    },
    close: async () => { redis.disconnect(); s3.destroy(); await prisma.$disconnect(); },
  };
}
