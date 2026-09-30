import { randomUUID } from 'node:crypto';
import type { Database } from './db.js';
export interface State { amount_minor: string; currency: string; status: string }
export interface Finding { payment_id: string; reasons: string[]; expected: State | null; actual: State | null }
export function differences(expected: State | null, actual: State | null): string[] {
  if (!expected) return ['missing_ledger'];
  if (!actual) return ['missing_webhook'];
  return (['amount_minor', 'currency', 'status'] as const).filter(field => expected[field] !== actual[field]);
}
interface Comparison { payment_id: string; expected: State | null; actual: State | null }
export async function reconcile(db: Database, graceSeconds = 30, now = new Date()) {
  const id = randomUUID(); const cutoff = new Date(now.getTime() - graceSeconds * 1000);
  return db.transaction(async sql => {
    // FULL JOIN detects missing rows on either side. Latest provider state is event-time ordered.
    // Apply the grace period to *both* source tables before forming a stable comparison.
    const result = await sql.query<Comparison>(`
      WITH recent AS (
        SELECT payment_id FROM payments WHERE updated_at > $1
        UNION SELECT payment_id FROM webhook_events WHERE received_at > $1 OR occurred_at > $1
      ), latest AS (
        SELECT DISTINCT ON (payment_id) payment_id, amount_minor, currency, status
        FROM webhook_events WHERE received_at <= $1 AND occurred_at <= $1
        ORDER BY payment_id, occurred_at DESC, event_id DESC
      ), ledger AS (SELECT * FROM payments WHERE updated_at <= $1)
      SELECT COALESCE(p.payment_id,e.payment_id) AS payment_id,
        CASE WHEN p.payment_id IS NULL THEN NULL ELSE jsonb_build_object(
          'amount_minor',p.amount_minor::text,'currency',p.currency,'status',p.status) END AS expected,
        CASE WHEN e.payment_id IS NULL THEN NULL ELSE jsonb_build_object(
          'amount_minor',e.amount_minor::text,'currency',e.currency,'status',e.status) END AS actual
      FROM ledger p FULL OUTER JOIN latest e ON p.payment_id=e.payment_id
      WHERE COALESCE(p.payment_id,e.payment_id) NOT IN (SELECT payment_id FROM recent)
      ORDER BY COALESCE(p.payment_id,e.payment_id)`, [cutoff.toISOString()]);
    const findings: Finding[] = result.rows.map(row => ({...row, reasons: differences(row.expected, row.actual)}))
      .filter(row => row.reasons.length > 0);
    await sql.query(`INSERT INTO reconciliation_runs(id,started_at,cutoff,compared_count,mismatch_count)
      VALUES($1,$2,$3,$4,$5)`, [id, now.toISOString(), cutoff.toISOString(), result.rows.length, findings.length]);
    for (const finding of findings) {
      await sql.query(`INSERT INTO reconciliation_findings(run_id,payment_id,reasons,expected,actual)
        VALUES($1,$2,$3,$4,$5)`, [id, finding.payment_id, finding.reasons, JSON.stringify(finding.expected), JSON.stringify(finding.actual)]);
    }
    return { id, cutoff: cutoff.toISOString(), compared_count: result.rows.length, mismatch_count: findings.length, findings };
  });
}
