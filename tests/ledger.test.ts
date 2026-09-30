import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/db.js';
import { database } from './helpers.js';
import { ConflictError, eventSchema, ingest, type PaymentEvent } from '../src/events.js';
import { differences, reconcile } from '../src/reconcile.js';
let db: Database;
const event: PaymentEvent = {event_id:'evt_1',payment_id:'pay_1',amount_minor:5000,currency:'INR',status:'captured',occurred_at:'2026-09-01T00:00:00Z'};
const raw = Buffer.from(JSON.stringify(event));
beforeEach(async () => {db=await database();},30000); afterEach(async () => {await db.close();});
async function expected(id='pay_1',amount=5000,currency='INR',status='captured') {
  await db.query('INSERT INTO payments(payment_id,amount_minor,currency,status,updated_at) VALUES($1,$2,$3,$4,$5)',[id,amount,currency,status,'2026-09-01T00:00:00Z']);
}
async function webhook(e=event,key=e.event_id) {return ingest(db,e,key,Buffer.from(JSON.stringify(e)));}
describe('durable idempotency', () => {
  it('persists once and recognizes retry',async () => {
    expect(await ingest(db,event,'key_1',raw)).toBe('created');
    expect(await ingest(db,event,'key_1',raw)).toBe('duplicate');
    expect((await db.query('SELECT * FROM webhook_events')).rows).toHaveLength(1);
  });
  it('rejects changed body under same identities',async () => {await ingest(db,event,'key_1',raw); await expect(ingest(db,{...event,amount_minor:1},'key_1',Buffer.from('{}'))).rejects.toBeInstanceOf(ConflictError);});
  it('rejects reused event ID with another key',async () => {await webhook(); await expect(webhook(event,'key_2')).rejects.toBeInstanceOf(ConflictError);});
  it('rejects reused key with another event ID',async () => {await webhook(event,'key_1'); await expect(webhook({...event,event_id:'evt_2'},'key_1')).rejects.toBeInstanceOf(ConflictError);});
  it('rejects negative, fractional or unsafe amounts and unknown fields', () => {
    for (const amount of [-1,0.2,Number.MAX_SAFE_INTEGER+1]) expect(eventSchema.safeParse({...event,amount_minor:amount}).success).toBe(false);
    expect(eventSchema.safeParse({...event,unexpected:true}).success).toBe(false);
  });
});
describe('reconciliation', () => {
  it('matches equivalent states and persists run',async () => {await expected(); await webhook(); const result=await reconcile(db,0,new Date('2030-01-01')); expect(result.mismatch_count).toBe(0); expect(result.compared_count).toBe(1); expect((await db.query('SELECT * FROM reconciliation_runs')).rows).toHaveLength(1);});
  it('flags missing sides and all changed fields',async () => {
    await expected(); await webhook({...event,amount_minor:100,currency:'USD',status:'failed'});
    await expected('pay_missing'); await webhook({...event,event_id:'evt_orphan',payment_id:'pay_orphan'});
    const result=await reconcile(db,0,new Date('2030-01-01'));
    expect(result.findings.map(f=>f.reasons)).toEqual([['amount_minor','currency','status'],['missing_webhook'],['missing_ledger']]);
    expect((await db.query('SELECT * FROM reconciliation_findings')).rows).toHaveLength(3);
  });
  it('chooses event time, not delivery order',async () => {
    await expected('pay_1',5000,'INR','refunded');
    await webhook({...event,event_id:'evt_new',status:'refunded',occurred_at:'2026-09-02T00:00:00Z'});
    await webhook();
    expect((await reconcile(db,0,new Date('2030-01-01'))).mismatch_count).toBe(0);
  });
  it('uses a deterministic ID tie break',async () => {await expected('pay_1',5000,'INR','refunded'); await webhook(); await webhook({...event,event_id:'evt_z',status:'refunded'}); expect((await reconcile(db,0,new Date('2030-01-01'))).mismatch_count).toBe(0);});
  it('excludes rows inside grace window',async () => {await expected(); await webhook(); await db.query("UPDATE payments SET updated_at='2026-09-02T00:00:00Z'"); await db.query("UPDATE webhook_events SET received_at='2026-09-02T00:00:00Z'"); expect((await reconcile(db,30,new Date('2026-09-02T00:00:10Z'))).compared_count).toBe(0);});
  it('defers a whole payment when only one source changed recently',async () => {
    await expected(); await webhook();
    await db.query("UPDATE webhook_events SET received_at='2026-09-02T00:00:00Z'");
    expect((await reconcile(db,30,new Date('2026-09-02T00:00:10Z'))).compared_count).toBe(0);
  });
  it('reports empty run without inventing mismatches',async () => expect((await reconcile(db,0)).compared_count).toBe(0));
  it('compares bigint strings without precision loss',()=>expect(differences({amount_minor:'9007199254740993',currency:'USD',status:'captured'},{amount_minor:'9007199254740992',currency:'USD',status:'captured'})).toEqual(['amount_minor']));
});
