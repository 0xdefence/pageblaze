import fs from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:55432/pageblaze';
const migrationsDir = process.env.DB_MIGRATIONS_DIR || path.resolve(process.cwd(), 'db/migrations');

export const db = new Pool({ connectionString: databaseUrl });

export async function runMigrations() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  let files: string[] = [];
  try {
    files = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  } catch {
    throw new Error(`migrations_dir_not_found:${migrationsDir}`);
  }

  for (const file of files) {
    const id = file.replace(/\.sql$/, '');
    const already = await db.query('SELECT 1 FROM _migrations WHERE id=$1', [id]);
    if (already.rowCount) continue;

    const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations (id) VALUES ($1)', [id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

export async function verifySchema() {
  const required = [
    'crawl_runs',
    'crawl_pages',
    'documents',
    'seo_issues',
    'recommendations',
    'visual_snapshots',
    'visual_diffs',
  ];

  const res = await db.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public' AND table_name = ANY($1::text[])`,
    [required]
  );
  const found = new Set(res.rows.map((r: any) => r.table_name));
  const missing = required.filter((t) => !found.has(t));
  if (missing.length) {
    throw new Error(`schema_not_migrated: missing tables ${missing.join(', ')}; run npm run db:migrate`);
  }
}
