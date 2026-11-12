import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createTokenProvider, loadServiceAccount } from '../lib/google-auth.js';

function makeServiceAccount() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    serviceAccount: {
      type: 'service_account',
      project_id: 'demo-project',
      private_key_id: 'kid-1',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      client_email: 'polish@demo-project.iam.gserviceaccount.com',
      token_uri: 'https://oauth2.googleapis.com/token',
    },
    publicKey,
  };
}

function decodeBase64Url(value) {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

test('loadServiceAccount validates JSON credentials', () => {
  assert.throws(() => loadServiceAccount({ credentialsJson: 'not json' }), /valid JSON/);
  assert.throws(
    () => loadServiceAccount({ credentialsJson: JSON.stringify({ type: 'authorized_user' }) }),
    /service_account/,
  );

  const { serviceAccount } = makeServiceAccount();
  const loaded = loadServiceAccount({ credentialsJson: JSON.stringify(serviceAccount) });
  assert.equal(loaded.client_email, serviceAccount.client_email);
});

test('createTokenProvider signs a JWT, caches the token and reuses it', async () => {
  const { serviceAccount, publicKey } = makeServiceAccount();
  const calls = [];
  const provider = createTokenProvider(serviceAccount, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ access_token: 'access-1', expires_in: 3600 }), { status: 200 });
    },
  });

  assert.equal(await provider(), 'access-1');
  assert.equal(await provider(), 'access-1');
  assert.equal(calls.length, 1);

  const params = new URLSearchParams(calls[0].init.body.toString());
  assert.equal(params.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const assertion = params.get('assertion');
  const [headerPart, claimPart, signaturePart] = assertion.split('.');
  const header = JSON.parse(decodeBase64Url(headerPart));
  const claims = JSON.parse(decodeBase64Url(claimPart));
  assert.equal(header.alg, 'RS256');
  assert.equal(header.kid, 'kid-1');
  assert.equal(claims.iss, serviceAccount.client_email);
  assert.equal(claims.aud, serviceAccount.token_uri);
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/cloud-platform');

  const verified = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${headerPart}.${claimPart}`),
    publicKey,
    Buffer.from(signaturePart.replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
  );
  assert.equal(verified, true);
});

test('createTokenProvider propagates OAuth failures without leaking the key', async () => {
  const { serviceAccount } = makeServiceAccount();
  const provider = createTokenProvider(serviceAccount, {
    fetchImpl: async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
  });
  await assert.rejects(() => provider(), /invalid_grant/);
  await assert.rejects(() => provider(), error => !String(error.message).includes('PRIVATE KEY'));
});
