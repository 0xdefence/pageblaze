import 'dotenv/config';
import { db, runMigrations } from '../packages/shared/src/db.ts';

(async () => {
  try {
    await runMigrations();
    console.log('migrations_applied');
  } catch (err) {
    console.error('migration_failed', err);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
