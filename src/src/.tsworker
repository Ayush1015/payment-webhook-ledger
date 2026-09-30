import { connect } from './db.js';
import { loadConfig } from './config.js';
import { reconcile } from './reconcile.js';
const config = loadConfig(); const db = connect(config.DATABASE_URL);
let stopped = false; let timer: NodeJS.Timeout | undefined;
async function tick() {
  try {
    const run = await reconcile(db, config.RECONCILE_GRACE_SECONDS);
    console.log(JSON.stringify({message:'Reconciled', id:run.id, compared:run.compared_count, mismatches:run.mismatch_count}));
  } catch { console.error(JSON.stringify({level:'error',message:'Reconciliation failed; next scheduled run will retry'})); }
  if (!stopped) timer = setTimeout(() => {void tick();}, config.RECONCILE_INTERVAL_MS);
  else await db.close();
}
function stop() { stopped = true; if (timer) {clearTimeout(timer); void db.close();} }
process.on('SIGTERM',stop); process.on('SIGINT',stop);
await tick();
