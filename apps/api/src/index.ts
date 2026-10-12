import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { closePool, getPool } from './db/index.js';
import { migrateUp } from './db/migrate.js';

async function main() {
  const config = loadConfig();
  const { applied } = await migrateUp(getPool());
  const app = await buildApp();
  if (applied.length) app.log.info({ applied }, 'migrations applied');

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await closePool();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.port, host: config.host });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
