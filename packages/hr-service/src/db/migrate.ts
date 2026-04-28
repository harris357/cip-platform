import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL_HR'];
  if (!url) throw new Error('DATABASE_URL_HR is required');

  const client = new Client({ connectionString: url });
  await client.connect();

  try {
    // Bootstrap the tracking table directly — structural DDL, no tenant context needed
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        migration   TEXT        PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const allFiles = await readdir(MIGRATIONS_DIR);
    const sqlFiles = allFiles.filter(f => f.endsWith('.sql')).sort();

    const { rows } = await client.query<{ migration: string }>(
      'SELECT migration FROM schema_migrations',
    );
    const applied = new Set(rows.map(r => r.migration));

    for (const file of sqlFiles) {
      if (applied.has(file)) {
        console.log(`[skip]  ${file}`);
        continue;
      }

      console.log(`[apply] ${file}`);
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf-8');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (migration) VALUES ($1)',
          [file],
        );
        await client.query('COMMIT');
        console.log(`[done]  ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${String(err)}`);
      }
    }

    console.log('All migrations applied.');
  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
