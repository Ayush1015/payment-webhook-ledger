import { describe, expect, it } from 'vitest';
import { signature, verifyAdmin, verifySignature } from '../src/signature.js';
const body = Buffer.from('{"amount_minor":100}'); const secret = 'a-secret-long-enough-for-tests'; const now = 1790750000;
describe('signature verification', () => {
  const header = `t=${now},v1=${signature(body,secret,now)}`;
  it('accepts authentic exact bytes', () => expect(verifySignature(body,secret,header,now)).toBe(true));
  it('rejects mutated payload', () => expect(verifySignature(Buffer.from('{}'),secret,header,now)).toBe(false));
  it('rejects wrong secret', () => expect(verifySignature(body,'other-secret',header,now)).toBe(false));
  it('rejects stale and future signatures', () => {
    expect(verifySignature(body,secret,header,now+301)).toBe(false);
    expect(verifySignature(body,secret,header,now-301)).toBe(false);
  });
  it.each([undefined,'','t=nope,v1=aaa',`t=${now},v1=${'g'.repeat(64)}`,`${header},v1=aaa`])('rejects malformed %s', h => expect(verifySignature(body,secret,h,now)).toBe(false));
  it('checks admin key', () => {expect(verifyAdmin('correct','correct')).toBe(true); expect(verifyAdmin('wrong','correct')).toBe(false); expect(verifyAdmin(undefined,'correct')).toBe(false);});
});
