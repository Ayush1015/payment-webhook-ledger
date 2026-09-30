import { createHmac, timingSafeEqual } from 'node:crypto';
export function signature(body: Buffer, secret: string, timestamp: number): string {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');
}
// Sign the raw bytes, not a JSON reserialization. Timestamp is authenticated too.
export function verifySignature(body: Buffer, secret: string, header: string | undefined, nowSeconds: number): boolean {
  if (!header) return false;
  const match = /^t=(\d{10}),v1=([a-f0-9]{64})$/.exec(header);
  if (!match) return false;
  const timestamp = Number(match[1]);
  if (Math.abs(nowSeconds - timestamp) > 300) return false;
  const actual = Buffer.from(match[2]!, 'hex');
  const expected = Buffer.from(signature(body, secret, timestamp), 'hex');
  return timingSafeEqual(actual, expected);
}
export function verifyAdmin(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const left = Buffer.from(actual); const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
