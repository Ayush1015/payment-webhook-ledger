import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import type { Database, Result, Sql } from '../src/db.js';
export async function database(): Promise<Database> {
  const schema = await readFile(new URL('../db/001_init.sql', import.meta.url), 'utf8');
  if (process.env.TEST_DATABASE_URL) {
    const pool = new Pool({connectionString:process.env.TEST_DATABASE_URL});
    const client = await pool.connect();
    await client.query('BEGIN');
    const ns = `test_${Math.random().toString(36).slice(2)}`;
    await client.query(`CREATE SCHEMA ${ns}`);
    await client.query(`SET search_path TO ${ns}`);
    await client.query(schema);
    const sql: Sql = {query:async <T>(text:string, values?:unknown[]) => (await client.query(text,values)) as unknown as Result<T>};
    return {...sql, transaction:async fn => fn(sql), close:async () => {await client.query('ROLLBACK'); client.release(); await pool.end();}};
  }
  const pg = new PGlite(); await pg.exec(schema);
  const sql: Sql = {query:async <T>(text:string, values?:unknown[]) => pg.query<T>(text,values)};
  return {...sql, transaction: fn => pg.transaction(async tx => fn({query:async <T>(text:string,values?:unknown[]) => tx.query<T>(text,values)})), close:() => pg.close()};
}
