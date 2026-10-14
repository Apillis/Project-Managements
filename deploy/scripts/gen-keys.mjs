#!/usr/bin/env node
// Generates fresh secrets for supabase/.env (never keep the demo defaults!):
//   node gen-keys.mjs >> /opt/apillis-pm/supabase/.env.secrets
import { createHmac, randomBytes } from 'node:crypto';

const b64url = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
export function signJwt(payload, secret) {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(createHmac('sha256', secret).update(`${head}.${body}`).digest());
  return `${head}.${body}.${sig}`;
}
export function makeKeys(now = Math.floor(Date.now() / 1000)) {
  const jwtSecret = randomBytes(32).toString('hex');
  const exp = now + 10 * 365 * 24 * 3600;
  return {
    POSTGRES_PASSWORD: randomBytes(18).toString('hex'),
    JWT_SECRET: jwtSecret,
    ANON_KEY: signJwt({ role: 'anon', iss: 'supabase', iat: now, exp }, jwtSecret),
    SERVICE_ROLE_KEY: signJwt({ role: 'service_role', iss: 'supabase', iat: now, exp }, jwtSecret),
    DASHBOARD_PASSWORD: randomBytes(12).toString('hex'),
    SECRET_KEY_BASE: randomBytes(48).toString('hex'),
    VAULT_ENC_KEY: randomBytes(16).toString('hex'),
    LOGFLARE_PUBLIC_ACCESS_TOKEN: randomBytes(16).toString('hex'),
    LOGFLARE_PRIVATE_ACCESS_TOKEN: randomBytes(16).toString('hex'),
  };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  for (const [k, v] of Object.entries(makeKeys())) console.log(`${k}=${v}`);
}
