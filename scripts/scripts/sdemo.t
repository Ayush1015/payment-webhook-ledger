// Uses fake local data only. Run after starting the API; never against a real payments database.
import { readFile } from 'node:fs/promises';
import { connect } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { signature } from '../src/signature.js';
const config=loadConfig(); const db=connect(config.DATABASE_URL);
const base=process.env.API_URL ?? 'http://localhost:3000';
try {
  await db.query(await readFile(new URL('../db/001_init.sql',import.meta.url),'utf8'));
  const id=`demo_${Date.now()}`;
  const stamp=new Date(Date.now()-3600000).toISOString();
  await db.query(`INSERT INTO payments(payment_id,amount_minor,currency,status,updated_at)
    VALUES($1,5000,'INR','captured',$3),($2,9000,'INR','captured',$3)`,[`${id}_match`,`${id}_mismatch`,stamp]);
  for (const [label,amount] of [['match',5000],['mismatch',8000]] as const) {
    const event={event_id:`evt_${id}_${label}`,payment_id:`${id}_${label}`,amount_minor:amount,currency:'INR',status:'captured',occurred_at:stamp};
    const body=Buffer.from(JSON.stringify(event)); const t=Math.floor(Date.now()/1000);
    const headers={'content-type':'application/json','idempotency-key':event.event_id,'x-webhook-signature':`t=${t},v1=${signature(body,config.WEBHOOK_SECRET,t)}`};
    for (let attempt=0;attempt<2;attempt++) {
      const response=await fetch(`${base}/webhooks/payments`,{method:'POST',headers,body});
      console.log(`${label} attempt ${attempt+1}: ${response.status}`,await response.text());
      if (!response.ok) throw new Error('Demo webhook rejected');
    }
  }
  console.log(`Waiting ${config.RECONCILE_GRACE_SECONDS+1}s for grace period...`);
  await new Promise(resolve=>setTimeout(resolve,(config.RECONCILE_GRACE_SECONDS+1)*1000));
  const response=await fetch(`${base}/admin/reconcile`,{method:'POST',headers:{'x-admin-key':config.ADMIN_KEY}});
  if (!response.ok) throw new Error(`Reconciliation failed: ${response.status}`);
  console.log(JSON.stringify(await response.json(),null,2));
} finally {await db.close();}
