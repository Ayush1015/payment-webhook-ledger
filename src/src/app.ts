import express from 'express';
import type { Database } from './db.js';
import { ConflictError, eventSchema, ingest } from './events.js';
import { verifyAdmin, verifySignature } from './signature.js';
import { reconcile } from './reconcile.js';
interface Options { webhookSecret: string; adminKey: string; graceSeconds: number; clock?: () => number }
export function createApp(db: Database, options: Options) {
  const app = express(); app.disable('x-powered-by');
  const clock = options.clock ?? Date.now;
  app.get('/health', async (_req, res) => {
    try { await db.query('SELECT 1'); res.json({ status: 'ok' }); }
    catch { res.status(503).json({ status: 'unavailable' }); }
  });
  app.post('/webhooks/payments', express.raw({type: 'application/json', limit: '64kb'}), async (req, res) => {
    if (!Buffer.isBuffer(req.body)) { res.status(415).json({error:'Use application/json'}); return; }
    if (!verifySignature(req.body, options.webhookSecret, req.get('x-webhook-signature'), Math.floor(clock()/1000))) {
      res.status(401).json({error:'Invalid or expired signature'}); return;
    }
    const key = req.get('idempotency-key');
    if (!key || !/^[a-zA-Z0-9_-]{1,128}$/.test(key)) { res.status(400).json({error:'Invalid idempotency-key'}); return; }
    let parsed: unknown;
    try { parsed = JSON.parse(req.body.toString('utf8')); } catch { res.status(400).json({error:'Invalid JSON'}); return; }
    const event = eventSchema.safeParse(parsed);
    if (!event.success) { res.status(400).json({error:'Invalid payment event', issues:event.error.issues}); return; }
    if (Date.parse(event.data.occurred_at) > clock() + 300000) { res.status(400).json({error:'Event time too far in the future'}); return; }
    try {
      const status = await ingest(db, event.data, key, req.body);
      res.status(status === 'created' ? 201 : 200).json({event_id:event.data.event_id, status});
    } catch (error) {
      if (error instanceof ConflictError) { res.status(409).json({error:error.message}); return; }
      throw error;
    }
  });
  app.use('/admin', (req, res, next) => {
    if (!verifyAdmin(req.get('x-admin-key'), options.adminKey)) { res.status(401).json({error:'Unauthorized'}); return; }
    next();
  });
  app.post('/admin/reconcile', async (_req, res) => { res.json(await reconcile(db, options.graceSeconds)); });
  app.get('/admin/runs/:id', async (req, res) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id)) { res.status(400).json({error:'Invalid run ID'}); return; }
    const run = await db.query('SELECT * FROM reconciliation_runs WHERE id=$1', [req.params.id]);
    if (!run.rows.length) { res.status(404).json({error:'Run not found'}); return; }
    const findings = await db.query('SELECT * FROM reconciliation_findings WHERE run_id=$1 ORDER BY payment_id', [req.params.id]);
    res.json({run:run.rows[0], findings:findings.rows});
  });
  app.use((error: {type?:string}, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error.type === 'entity.too.large') { res.status(413).json({error:'Payload exceeds 64kb'}); return; }
    console.error(JSON.stringify({level:'error', message:'Request failed'}));
    res.status(503).json({error:'Service unavailable, retry later'});
  });
  return app;
}
