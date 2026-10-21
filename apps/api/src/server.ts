import { loadConfig } from '@contractiq/core';
import { buildApp } from './app.js';
import { createDependencies } from './dependencies.js';

const config = loadConfig(process.env);
const app = buildApp(config, createDependencies(config));
let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const deadline = setTimeout(() => process.exit(1), 10000).unref();
    void app.close().then(() => { clearTimeout(deadline); }, () => { process.exitCode = 1; });
  });
}
try { await app.listen({ port: config.PORT, host: config.HOST }); }
catch { app.log.error('API startup failed'); await app.close(); process.exitCode = 1; }
