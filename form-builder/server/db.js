import { AsyncLocalStorage } from "node:async_hooks";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || "postgres://icph:password@localhost:5432/icph"
});
const transactionClient = new AsyncLocalStorage();

// Runs on the surrounding transaction when there is one.
export function query(text, params) {
  return (transactionClient.getStore() || pool).query(text, params);
}

export async function withTransaction(work) {
  if (transactionClient.getStore()) return work();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await transactionClient.run(client, work);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// Applies server/migrations/*.sql in name order, each once.
export async function migrate() {
  const client = await pool.connect();
  try {
    // Serialises concurrent server starts against the same database.
    await client.query("SELECT pg_advisory_lock(727001)");
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const applied = new Set((await client.query("SELECT name FROM schema_migrations")).rows.map((row) => row.name));
    const names = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
    for (const name of names) {
      if (applied.has(name)) continue;
      const sql = await readFile(path.join(migrationsDir, name), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw new Error(`Database migration ${name} failed: ${error.message}`);
      }
      console.log(`Applied database migration ${name}`);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(727001)").catch(() => {});
    client.release();
  }
}
