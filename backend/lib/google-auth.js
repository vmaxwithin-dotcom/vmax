import crypto from 'node:crypto';
import fs from 'node:fs';

const TOKEN_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const TOKEN_REFRESH_MARGIN_MS = 60_000;

export function loadServiceAccount({ credentialsPath = '', credentialsJson = '' } = {}) {
  let raw = credentialsJson;
  if (!raw) {
    const path = credentialsPath || '/secrets/sa.json';
    if (!fs.existsSync(path)) {
      throw new Error(`Service account JSON not found at ${path}. Set GOOGLE_APPLICATION_CREDENTIALS.`);
    }
    raw = fs.readFileSync(path, 'utf8');
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch {
    throw new Error('Service account JSON is not valid JSON');
  }

  if (serviceAccount?.type !== 'service_account') {
    throw new Error('Service account JSON must have type "service_account"');
  }
  for (const field of ['client_email', 'private_key']) {
    if (typeof serviceAccount[field] !== 'string' || !serviceAccount[field]) {
      throw new Error(`Service account JSON is missing ${field}`);
    }
  }
  return serviceAccount;
}

function base64url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

/**
 * Minimal OAuth 2.0 service-account flow using the JSON key directly.
 * This is the grant described by Google's "OAuth 2.0 for service accounts"
 * documentation and needs no third-party runtime dependency.
 */
export function createTokenProvider(serviceAccount, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (!serviceAccount?.client_email || !serviceAccount?.private_key) {
    throw new Error('createTokenProvider requires client_email and private_key');
  }
  const tokenUri = 'https://oauth2.googleapis.com/token';
  if (serviceAccount.token_uri && serviceAccount.token_uri !== tokenUri) {
    throw new Error('Only the official Google OAuth token endpoint is allowed');
  }
  let cached = null;
  let inflight = null;

  async function requestToken() {
    const issuedAt = Math.floor(now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    if (serviceAccount.private_key_id) {
      header.kid = serviceAccount.private_key_id;
    }
    const claims = {
      iss: serviceAccount.client_email,
      scope: TOKEN_SCOPE,
      aud: tokenUri,
      iat: issuedAt,
      exp: issuedAt + 3600,
    };
    const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
    const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), serviceAccount.private_key);
    const assertion = `${unsigned}.${signature.toString('base64url')}`;

    const response = await fetchImpl(tokenUri, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!response.ok || typeof body?.access_token !== 'string') {
      const reason = typeof body?.error === 'string' ? `: ${body.error}` : '';
      throw new Error(`OAuth token request failed (HTTP ${response.status})${reason}`);
    }
    const expiresIn = Number(body.expires_in);
    cached = {
      token: body.access_token,
      expiresAt: now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000,
    };
    return cached;
  }

  return async function getAccessToken() {
    if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > now()) {
      return cached.token;
    }
    if (!inflight) {
      inflight = requestToken().finally(() => {
        inflight = null;
      });
    }
    const result = await inflight;
    return result.token;
  };
}
