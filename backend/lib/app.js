import crypto from 'node:crypto';
import { RequestLimiter } from './limits.js';
import { VertexError } from './vertex.js';

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest();
}

function safeEqual(left, right) {
  return crypto.timingSafeEqual(sha256(left), sha256(right));
}

function sendJson(res, status, body, extraHeaders = {}) {
  if (res.writableEnded || res.destroyed) {
    return;
  }
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(payload));
  for (const [key, value] of Object.entries(extraHeaders)) {
    res.setHeader(key, value);
  }
  res.end(payload);
}

function resolveCors(req, config) {
  const origin = req.headers.origin;
  if (config.allowedOrigins.includes('*')) {
    return { allowed: true, header: '*' };
  }
  if (!origin) {
    return { allowed: true, header: null };
  }
  if (config.allowedOrigins.includes(origin)) {
    return { allowed: true, header: origin };
  }
  return { allowed: false, header: null };
}

function applyCors(req, res, config) {
  const cors = resolveCors(req, config);
  if (cors.header) {
    res.setHeader('Access-Control-Allow-Origin', cors.header);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  return cors.allowed;
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(Object.assign(new Error('request body too large'), { code: 'too_large' }));
        return;
      }
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        reject(Object.assign(new Error('invalid JSON body'), { code: 'invalid_json' }));
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        reject(Object.assign(new Error('JSON body must be an object'), { code: 'invalid_json' }));
        return;
      }
      resolve(parsed);
    });
    req.on('error', reject);
  });
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}

function vertexErrorResponse(error) {
  switch (error.kind) {
    case 'blocked':
      return { status: 422, body: { error: 'blocked', message: '内容被 Google 安全策略拦截' } };
    case 'truncated':
      return { status: 422, body: { error: 'output_truncated', message: '模型输出被截断且没有可用正文' } };
    case 'timeout':
      return { status: 504, body: { error: 'timeout', message: '等待 Vertex 响应超时' } };
    case 'auth':
      return { status: 500, body: { error: 'backend_auth_failed', message: '后端无法获取 Google 访问令牌' } };
    default:
      return { status: 502, body: { error: 'upstream_error', message: 'Vertex 返回错误' } };
  }
}

export function createApp({ config, vertex, now = Date.now, logger = console }) {
  if (typeof vertex !== 'function') {
    throw new Error('createApp requires a vertex function');
  }
  const limiter = new RequestLimiter(config, now);
  const log = (line) => {
    try {
      (logger.info ?? logger.log)?.call(logger, JSON.stringify(line));
    } catch {
      // Logging must never break a response.
    }
  };

  return async function handler(req, res) {
    const requestId = crypto.randomUUID();
    const startedAt = now();
    const path = (() => {
      try {
        return new URL(req.url, 'http://localhost').pathname;
      } catch {
        return req.url;
      }
    })();
    let errorCode = '';

    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const originAllowed = applyCors(req, res, config);
    if (!originAllowed) {
      errorCode = 'origin_not_allowed';
      sendJson(res, 403, { error: errorCode, message: '来源不在白名单内', requestId });
      log({ requestId, method: req.method, path, status: 403, ms: now() - startedAt, code: errorCode });
      return;
    }

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.method === 'GET' && path === '/health') {
      sendJson(res, 200, { ok: true, service: 'st-vertex-polish', requestId });
      log({ requestId, method: req.method, path, status: 200, ms: now() - startedAt });
      return;
    }

    const authorization = req.headers.authorization;
    const bearer = typeof authorization === 'string' ? /^Bearer\s+(.+)$/i.exec(authorization) : null;
    const provided = bearer ? bearer[1].trim() : '';
    if (!provided || !safeEqual(provided, config.accessToken)) {
      errorCode = 'unauthorized';
      sendJson(res, 401, { error: errorCode, message: '访问口令无效', requestId });
      log({ requestId, method: req.method, path, status: 401, ms: now() - startedAt, code: errorCode });
      return;
    }

    if (path === '/api/models') {
      if (req.method !== 'GET') {
        errorCode = 'method_not_allowed';
        sendJson(res, 405, { error: errorCode, message: 'Use GET', requestId }, { Allow: 'GET, OPTIONS' });
        log({ requestId, method: req.method, path, status: 405, ms: now() - startedAt, code: errorCode });
        return;
      }
      sendJson(res, 200, {
        models: config.availableModels,
        defaultModel: config.model,
        location: config.location,
        requestId,
      });
      log({ requestId, method: req.method, path, status: 200, ms: now() - startedAt });
      return;
    }

    if (path !== '/api/polish') {
      errorCode = 'not_found';
      sendJson(res, 404, { error: errorCode, message: 'Not found', requestId });
      log({ requestId, method: req.method, path, status: 404, ms: now() - startedAt, code: errorCode });
      return;
    }

    if (req.method !== 'POST') {
      errorCode = 'method_not_allowed';
      sendJson(res, 405, { error: errorCode, message: 'Use POST', requestId }, { Allow: 'POST, OPTIONS' });
      log({ requestId, method: req.method, path, status: 405, ms: now() - startedAt, code: errorCode });
      return;
    }

    const contentType = String(req.headers['content-type'] ?? '');
    if (!contentType.toLowerCase().startsWith('application/json')) {
      errorCode = 'invalid_request';
      sendJson(res, 415, { error: errorCode, message: 'Content-Type must be application/json', requestId });
      log({ requestId, method: req.method, path, status: 415, ms: now() - startedAt, code: errorCode });
      return;
    }

    let body;
    try {
      body = await readJsonBody(req, config.maxBodyBytes);
    } catch (error) {
      const status = error?.code === 'too_large' ? 413 : 400;
      errorCode = error?.code === 'too_large' ? 'too_large' : 'invalid_request';
      sendJson(res, status, {
        error: errorCode,
        message: status === 413 ? '请求体过大' : '请求体不是有效 JSON 对象',
        requestId,
      });
      log({ requestId, method: req.method, path, status, ms: now() - startedAt, code: errorCode });
      return;
    }

    const systemInstruction = body.systemInstruction;
    const prompt = body.prompt;
    if (typeof prompt !== 'string' || !prompt.trim()) {
      errorCode = 'invalid_request';
      sendJson(res, 400, { error: errorCode, message: 'prompt 不能为空', requestId });
      log({ requestId, method: req.method, path, status: 400, ms: now() - startedAt, code: errorCode });
      return;
    }
    if (systemInstruction !== undefined && typeof systemInstruction !== 'string') {
      errorCode = 'invalid_request';
      sendJson(res, 400, { error: errorCode, message: 'systemInstruction 必须是字符串', requestId });
      log({ requestId, method: req.method, path, status: 400, ms: now() - startedAt, code: errorCode });
      return;
    }

    const requestedModel = typeof body.model === 'string' && body.model.trim()
      ? body.model.trim()
      : config.model;
    if (!/^[a-z0-9._-]{2,100}$/i.test(requestedModel)) {
      errorCode = 'invalid_request';
      sendJson(res, 400, { error: errorCode, message: 'model 名称无效', requestId });
      log({ requestId, method: req.method, path, status: 400, ms: now() - startedAt, code: errorCode });
      return;
    }

    const totalChars = prompt.length + (typeof systemInstruction === 'string' ? systemInstruction.length : 0);
    if (totalChars > config.maxInputChars) {
      errorCode = 'too_large';
      sendJson(res, 413, {
        error: errorCode,
        message: `输入约 ${totalChars} 字符，超过上限 ${config.maxInputChars}`,
        requestId,
      });
      log({ requestId, method: req.method, path, status: 413, ms: now() - startedAt, code: errorCode });
      return;
    }

    const quota = limiter.take();
    if (!quota.ok) {
      errorCode = quota.reason;
      const status = 429;
      const retryAfter = quota.reason === 'rate_limited'
        ? Math.max(1, Math.ceil((quota.retryAfterMs ?? 1000) / 1000))
        : 3600;
      sendJson(
        res,
        status,
        {
          error: errorCode,
          message: quota.reason === 'rate_limited' ? '请求太频繁，请稍后再试' : '已达到今日次数上限',
          requestId,
        },
        { 'Retry-After': String(retryAfter) },
      );
      log({ requestId, method: req.method, path, status, ms: now() - startedAt, code: errorCode });
      return;
    }

    const generationConfig = {
      temperature: clampNumber(body.temperature, 0, 2, 1),
      topP: clampNumber(body.topP, 0, 1, 1),
      maxOutputTokens: Math.round(clampNumber(body.maxOutputTokens, 64, config.maxOutputTokens, config.maxOutputTokens)),
    };

    try {
      const result = await vertex({
        model: requestedModel,
        systemInstruction: typeof systemInstruction === 'string' ? systemInstruction.trim() : '',
        prompt,
        generationConfig,
      });

      sendJson(res, 200, {
        text: result.text,
        model: requestedModel,
        finishReason: result.finishReason,
        truncated: Boolean(result.truncated),
        usage: result.usage,
        requestId,
      });
      log({
        requestId,
        method: req.method,
        path,
        status: 200,
        ms: now() - startedAt,
        model: requestedModel,
        inputChars: totalChars,
        outputChars: result.text.length,
        truncated: Boolean(result.truncated),
      });
    } catch (error) {
      if (error instanceof VertexError) {
        const mapped = vertexErrorResponse(error);
        errorCode = mapped.body.error;
        sendJson(res, mapped.status, { ...mapped.body, requestId });
        log({
          requestId,
          method: req.method,
          path,
          status: mapped.status,
          ms: now() - startedAt,
          code: errorCode,
          kind: error.kind,
        });
      } else {
        errorCode = 'internal_error';
        sendJson(res, 500, { error: errorCode, message: '后端内部错误', requestId });
        log({
          requestId,
          method: req.method,
          path,
          status: 500,
          ms: now() - startedAt,
          code: errorCode,
        });
      }
    }
  };
}
