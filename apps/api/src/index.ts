import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { closePool, getPool, withClient } from './db/index.js';
import { prepareDatabase } from './db/safety.js';
import { deleteExpiredBuckets } from './auth/rateLimit.js';
import { deleteExpiredSessions } from './auth/session.js';

async function main() {
  const config = loadConfig();
  // Fail-closed gate: unsafe DB role, schema not at this build's version, or
  // RLS not intact => the process exits before listening (in production).
  const { applied } = await prepareDatabase(getPool(), {
    production: config.nodeEnv === 'production',
    migrateOnBoot: config.migrateOnBoot,
    warn: (msg) => console.warn(msg),
  });
  const app = await buildApp();
  if (applied.length) app.log.info({ applied }, 'migrations applied');

  const sweep = () =>
    withClient(async (client) => {
      await deleteExpiredBuckets(client, config.loginRateLimitWindowSeconds);
      await deleteExpiredSessions(client);
    }).catch((err) => app.log.warn({ err }, 'expired-row sweep failed'));
  await sweep();
  const sweeper = setInterval(sweep, 60 * 60 * 1000);
  sweeper.unref();

  const shutdown = async (signal: string) => {
    clearInterval(sweeper);
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await closePool();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.port, host: config.host });
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await closePool().catch(() => undefined);
  process.exit(1);
});
