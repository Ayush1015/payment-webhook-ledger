import { readFile } from 'node:fs/promises';
import { connect } from './db.js';
import { loadConfig } from './config.js';
const db = connect(loadConfig().DATABASE_URL);
try { await db.query(await readFile(new URL('../db/001_init.sql', import.meta.url), 'utf8')); console.log('Schema ready'); }
finally { await db.close(); }
