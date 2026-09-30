import { z } from 'zod';
const schema = z.object({
  DATABASE_URL: z.url(), WEBHOOK_SECRET: z.string().min(24), ADMIN_KEY: z.string().min(24),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  RECONCILE_INTERVAL_MS: z.coerce.number().int().min(1000).default(60000),
  RECONCILE_GRACE_SECONDS: z.coerce.number().int().min(0).max(86400).default(30),
});
export const loadConfig = () => schema.parse(process.env);
