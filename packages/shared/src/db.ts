import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:55432/pageblaze';

export const db = new Pool({ connectionString: databaseUrl });

export async function initDbSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS crawl_runs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      start_url TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      pages_count INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      result_json JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS crawl_pages (
      id BIGSERIAL PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES crawl_runs(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      depth INTEGER NOT NULL DEFAULT 0,
      title TEXT,
      excerpt TEXT,
      status TEXT NOT NULL DEFAULT 'done',
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (run_id, url)
    );

    CREATE TABLE IF NOT EXISTS documents (
      id BIGSERIAL PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES crawl_runs(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      title TEXT,
      excerpt TEXT,
      markdown TEXT,
      text_content TEXT,
      metadata_json JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_crawl_runs_created_at ON crawl_runs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_crawl_pages_run_id ON crawl_pages(run_id);
    CREATE INDEX IF NOT EXISTS idx_documents_run_id ON documents(run_id);
  `);
}
