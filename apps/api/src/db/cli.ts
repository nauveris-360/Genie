import { getPool, closePool } from './index.js';
import { migrateUp, migrateDown } from './migrate.js';

async function main() {
  const direction = process.argv[2];
  const pool = getPool();
  try {
    if (direction === 'up') {
      const { applied } = await migrateUp(pool);
      if (applied.length === 0) {
        console.log('Database already up to date.');
      } else {
        console.log(`Applied: ${applied.join(', ')}`);
      }
    } else if (direction === 'down') {
      const { rolledBack } = await migrateDown(pool);
      console.log(rolledBack ? `Rolled back: ${rolledBack}` : 'No migrations to roll back.');
    } else {
      console.error('Usage: migrate.ts <up|down>');
      process.exitCode = 1;
    }
  } finally {
    await closePool();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
