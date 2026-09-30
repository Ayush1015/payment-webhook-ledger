import pg from 'pg';
export interface Result<T> { rows: T[]; rowCount?: number | null }
export interface Sql { query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<Result<T>> }
export interface Database extends Sql { transaction<T>(fn: (sql: Sql) => Promise<T>): Promise<T>; close(): Promise<void> }
export function connect(url: string): Database {
  const pool = new pg.Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 5000 });
  return {
    query: async <T>(text: string, values?: unknown[]) => (await pool.query(text, values)) as unknown as Result<T>,
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    },
    close: () => pool.end(),
  };
}
