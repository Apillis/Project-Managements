import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { makeKeys, signJwt } from '../scripts/gen-keys.mjs';

const decode = (s) => JSON.parse(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());

test('anon and service keys are HS256 JWTs signed with JWT_SECRET', () => {
  const k = makeKeys(1_700_000_000);
  for (const [key, role] of [['ANON_KEY', 'anon'], ['SERVICE_ROLE_KEY', 'service_role']]) {
    const [h, b, s] = k[key].split('.');
    assert.deepEqual(decode(h), { alg: 'HS256', typ: 'JWT' });
    assert.equal(decode(b).role, role);
    assert.ok(decode(b).exp > 1_700_000_000 + 9 * 365 * 24 * 3600);
    const expect = createHmac('sha256', k.JWT_SECRET).update(`${h}.${b}`).digest('base64url');
    assert.equal(s, expect);
  }
  assert.ok(k.JWT_SECRET.length >= 32);
  assert.notEqual(makeKeys().JWT_SECRET, k.JWT_SECRET);
});

test('signJwt is deterministic for the same input', () => {
  assert.equal(signJwt({ a: 1 }, 's'), signJwt({ a: 1 }, 's'));
});
