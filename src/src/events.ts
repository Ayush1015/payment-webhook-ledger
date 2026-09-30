import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Sql } from './db.js';
export const eventSchema = z.object({
  event_id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  payment_id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  amount_minor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  currency: z.string().regex(/^[A-Z]{3}$/),
  status: z.enum(['captured', 'failed', 'refunded']),
  occurred_at: z.iso.datetime({ offset: true }),
}).strict();
export type PaymentEvent = z.infer<typeof eventSchema>;
export class ConflictError extends Error {}
export async function ingest(sql: Sql, event: PaymentEvent, key: string, raw: Buffer): Promise<'created' | 'duplicate'> {
  const hash = createHash('sha256').update(raw).digest('hex');
  const inserted = await sql.query<{ event_id: string }>(
    `INSERT INTO webhook_events(event_id,idempotency_key,body_hash,payment_id,amount_minor,currency,status,occurred_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING event_id`,
    [event.event_id, key, hash, event.payment_id, event.amount_minor, event.currency, event.status, event.occurred_at],
  );
  if (inserted.rows.length) return 'created';
  // Check both unique identities. A reused key or event ID with changed bytes is a conflict.
  const previous = await sql.query<{ event_id: string; idempotency_key: string; body_hash: string }>(
    'SELECT event_id,idempotency_key,body_hash FROM webhook_events WHERE event_id=$1 OR idempotency_key=$2', [event.event_id, key],
  );
  if (previous.rows.length === 1 && previous.rows[0]!.event_id === event.event_id &&
      previous.rows[0]!.idempotency_key === key && previous.rows[0]!.body_hash === hash) return 'duplicate';
  throw new ConflictError('Event ID or idempotency key already used for a different request');
}
