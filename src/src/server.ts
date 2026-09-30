import { connect } from './db.js';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
const config = loadConfig(); const db = connect(config.DATABASE_URL);
const server = createApp(db, {webhookSecret:config.WEBHOOK_SECRET, adminKey:config.ADMIN_KEY, graceSeconds:config.RECONCILE_GRACE_SECONDS})
  .listen(config.PORT, '0.0.0.0', () => console.log(JSON.stringify({message:'Listening',port:config.PORT})));
let closing = false;
function shutdown() {
  if (closing) return; closing = true;
  const timer = setTimeout(() => process.exit(1), 10000); timer.unref();
  server.close(() => { void db.close().then(() => {clearTimeout(timer); process.exit(0);}); });
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
