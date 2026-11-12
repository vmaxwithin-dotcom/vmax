const DEFAULTS = Object.freeze({
  port: 8080,
  location: 'global',
  model: 'gemini-3.8-flash',
  apiVersion: 'v1',
  availableModels: [
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-2.5-flash',
    'gemini-2.5-pro',
  ],
  maxInputChars: 20000,
  maxOutputTokens: 8192,
  dailyLimit: 100,
  minIntervalMs: 3000,
  requestTimeoutMs: 60000,
  maxBodyBytes: 262144,
});

function readInt(env, name, fallback, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function loadConfig(env = process.env) {
  const accessToken = String(env.POLISH_ACCESS_TOKEN ?? '').trim();
  if (accessToken.length < 16) {
    throw new Error('POLISH_ACCESS_TOKEN must be set and at least 16 characters long');
  }

  const project = String(env.GOOGLE_CLOUD_PROJECT ?? '').trim();
  if (project && !/^[a-z0-9:.-]+$/i.test(project)) {
    throw new Error('GOOGLE_CLOUD_PROJECT contains unsupported characters');
  }

  const location = String(env.GOOGLE_CLOUD_LOCATION ?? DEFAULTS.location).trim();
  if (!/^(global|[a-z0-9-]+)$/.test(location)) {
    throw new Error('GOOGLE_CLOUD_LOCATION must be "global" or a region such as us-central1');
  }

  const model = String(env.VERTEX_MODEL ?? DEFAULTS.model).trim();
  if (!/^[a-z0-9._-]+$/i.test(model)) {
    throw new Error('VERTEX_MODEL contains unsupported characters');
  }

  const availableModels = String(env.AVAILABLE_MODELS ?? DEFAULTS.availableModels.join(','))
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
  if (availableModels.length === 0) {
    throw new Error('AVAILABLE_MODELS must contain at least one model id');
  }
  for (const availableModel of availableModels) {
    if (!/^[a-z0-9._-]{2,100}$/i.test(availableModel)) {
      throw new Error(`AVAILABLE_MODELS contains an invalid model id: ${availableModel}`);
    }
  }
  if (!availableModels.includes(model)) {
    availableModels.unshift(model);
  }

  const apiVersion = String(env.VERTEX_API_VERSION ?? DEFAULTS.apiVersion).trim();
  if (!/^v1(beta1|p1)?$/.test(apiVersion)) {
    throw new Error('VERTEX_API_VERSION must be v1, v1beta1 or v1p1');
  }

  const allowedOrigins = String(env.ALLOWED_ORIGINS ?? '*')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);

  return {
    port: readInt(env, 'PORT', DEFAULTS.port, 1, 65535),
    accessToken,
    project,
    location,
    model,
    availableModels,
    apiVersion,
    allowedOrigins: allowedOrigins.length > 0 ? allowedOrigins : ['*'],
    maxInputChars: readInt(env, 'MAX_INPUT_CHARS', DEFAULTS.maxInputChars, 100, 100000),
    maxOutputTokens: readInt(env, 'MAX_OUTPUT_TOKENS', DEFAULTS.maxOutputTokens, 64, 8192),
    dailyLimit: readInt(env, 'DAILY_LIMIT', DEFAULTS.dailyLimit, 1, 10000),
    minIntervalMs: readInt(env, 'MIN_INTERVAL_MS', DEFAULTS.minIntervalMs, 0, 60000),
    requestTimeoutMs: readInt(env, 'REQUEST_TIMEOUT_MS', DEFAULTS.requestTimeoutMs, 1000, 300000),
    maxBodyBytes: readInt(env, 'MAX_BODY_BYTES', DEFAULTS.maxBodyBytes, 1024, 10 * 1024 * 1024),
    credentialsPath: String(env.GOOGLE_APPLICATION_CREDENTIALS ?? '').trim(),
    credentialsJson: String(env.GOOGLE_SERVICE_ACCOUNT_JSON ?? '').trim(),
  };
}

export { DEFAULTS };
