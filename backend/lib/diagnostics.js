// Only fixed enums and fixed descriptions leave this module. Never expose a
// Google message/details object, which may echo submitted text or credentials.
const GOOGLE_STATUSES = new Set([
  'INVALID_ARGUMENT', 'UNAUTHENTICATED', 'PERMISSION_DENIED', 'NOT_FOUND',
  'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION', 'DEADLINE_EXCEEDED',
  'UNAVAILABLE', 'INTERNAL', 'UNKNOWN', 'CANCELLED', 'OUT_OF_RANGE',
  'UNIMPLEMENTED', 'ALREADY_EXISTS', 'ABORTED', 'DATA_LOSS',
]);
const HTTP_STATUS_MAP = { 400: 'INVALID_ARGUMENT', 401: 'UNAUTHENTICATED', 403: 'PERMISSION_DENIED', 404: 'NOT_FOUND', 429: 'RESOURCE_EXHAUSTED', 500: 'INTERNAL', 503: 'UNAVAILABLE', 504: 'DEADLINE_EXCEEDED' };
const HELP = {
  INVALID_ARGUMENT: ['Google 拒绝了请求参数。', '检查模型支持的输出上限和采样参数；32768 是应用上限，不保证模型支持。'],
  UNAUTHENTICATED: ['Google 认证失败。', '检查服务账号密钥是否有效或已被撤销。'],
  PERMISSION_DENIED: ['Google 拒绝访问。', '检查 Vertex API、项目结算和服务账号权限。'],
  NOT_FOUND: ['模型或资源不存在，或项目无权访问。', '核对模型名称、global/区域和项目访问权限。'],
  RESOURCE_EXHAUSTED: ['Google 配额或速率不足。', '检查项目配额和账单；不要连续自动重试。'],
  DEADLINE_EXCEEDED: ['Google 请求超时。', '缩短输入，或稍后手动重试；超时请求仍可能计费。'],
  UNAVAILABLE: ['Google 服务暂不可用。', '稍后手动重试；不要假定上一次请求未计费。'],
  FAILED_PRECONDITION: ['Google 当前无法执行此请求。', '检查模型、项目配置和结算状态。'],
};
export function safeGoogleStatus(value, httpStatus) {
  return GOOGLE_STATUSES.has(value) ? value : HTTP_STATUS_MAP[httpStatus] || 'UNKNOWN';
}
export function safeUpstreamHttpStatus(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
}
export function upstreamDiagnostic(httpStatus, googleStatus) {
  const status = safeUpstreamHttpStatus(httpStatus);
  const code = safeGoogleStatus(googleStatus, status);
  const [summary, action] = HELP[code] || ['Google 返回上游错误。', '使用请求标识排查；原始上游消息已隐藏以保护正文和秘密。'];
  return { upstreamHttpStatus: status, googleStatus: code, summary, action };
}
