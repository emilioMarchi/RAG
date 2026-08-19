import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from './config/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.join(__dirname, 'migrations');

async function migrate() {
  // Tabla de seguimiento: cada migración se ejecuta SOLO una vez por base.
  // Sin esto, migraciones destructivas (p. ej. 007, que rellena vectores con
  // array_fill(0.0)) se re-aplicaban en cada arranque y borraban los vectores
  // reales recién ingestados.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const applied = await pool.query<{ name: string }>(
    'SELECT name FROM schema_migrations'
  );
  const appliedSet = new Set(applied.rows.map((r) => r.name));

  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  let ran = 0;
  for (const file of files) {
    if (appliedSet.has(file)) {
      console.log(`Skipping migration: ${file} (already applied)`);
      continue;
    }

    const filePath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(filePath, 'utf-8');
    console.log(`Running migration: ${file}`);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`  ✓ ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    ran += 1;
  }

  console.log(
    ran === 0 ? 'All migrations already applied.' : `All migrations completed (${ran} ran).`
  );
  await pool.end();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
