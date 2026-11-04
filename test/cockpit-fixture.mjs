// A stand-in Cockpit for tests: an Ed25519 key, its published key set, and
// launch tickets signed the way TSS-Dashboard signs them (apps/api/src/launch.ts).

import crypto from 'node:crypto';
import { createMessageVerifier, createTicketVerifier } from '../lib/cockpit.js';

export const COCKPIT = 'https://cockpit.test';

export function fakeCockpit(audience, { url = COCKPIT, now = () => Date.now() } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const kid = 'test-key';
  const jwk = publicKey.export({ format: 'jwk' });
  let keyFetches = 0;
  const fetchImpl = async (u) => {
    keyFetches++;
    if (u !== `${url}/.well-known/jwks.json`) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ keys: [{ ...jwk, kid, alg: 'EdDSA', use: 'sig' }] }) };
  };
  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');

  function ticket(over = {}, { key = privateKey, headOver = {} } = {}) {
    const iat = Math.floor(now() / 1000);
    const claims = {
      iss: url, aud: audience, sub: 'u-dana', name: 'Dana', email: 'dana@example.org',
      org: { id: 'org-a', name: 'Org A' }, role: 'program_manager', permissions: ['use'],
      iat, nbf: iat, exp: iat + 120, jti: crypto.randomUUID(), ...over,
    };
    const head = b64({ alg: 'EdDSA', typ: 'JWT', kid, ...headOver });
    const body = b64(claims);
    const sig = crypto.sign(null, Buffer.from(`${head}.${body}`), key).toString('base64url');
    return `${head}.${body}.${sig}`;
  }

  // A server-to-server message, signed the way appLink.ts signs one.
  function message(use, over = {}, opts = {}) {
    return ticket({ sub: 'cockpit', use, name: undefined, email: undefined, role: undefined, permissions: undefined, ...over }, opts);
  }

  return {
    ticket,
    message,
    verifyTicket: createTicketVerifier({ audience, url, fetchImpl, now }),
    verifyMessage: (use) => createMessageVerifier({ audience, use, url, fetchImpl, now }),
    keyFetches: () => keyFetches,
  };
}
