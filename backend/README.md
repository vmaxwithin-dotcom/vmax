# 后端第一阶段更新：长文本与安全诊断

本次只更新后端；前端也必须同步提高自己的输入/输出/超时限制，否则仍可能在页面端提前阻止发送。

## 默认值

- `MAX_INPUT_CHARS=100000`：`systemInstruction` 与 `prompt` 合计，按 JavaScript UTF-16 长度计数；不是模型 token 上限。
- `MAX_BODY_BYTES=1048576`：JSON 请求体最多 1 MiB。
- `MAX_OUTPUT_TOKENS=32768`：后端默认和允许配置的最高上限；客户端仍可请求更低值。
- `REQUEST_TIMEOUT_MS=180000`：等待 Vertex 响应头和完整响应体，共 180 秒（OAuth 获取另有自己的超时）。
- Cloud Run 部署脚本：300 秒服务超时、512 MiB 内存；仍为 `gemini-3.8-flash` + Vertex `global`，Cloud Run 自身仍在 `us-central1`。

这些是应用限制，**不是 Google 对每个模型的能力保证**。模型可能拒绝 32768 输出预算，或者将部分预算用于思考；应按安全诊断提示降低预算。长输入也可能超过模型上下文限制，或在输出预算内无法完整润色。不会自动分段或重试，也不会承诺不产生超时费用。

旧部署不会因为源码更新自动变更。需要从仓库根目录重新运行：

```bash
PROJECT_ID="你的项目ID" MODEL=gemini-3.8-flash VERTEX_LOCATION=global bash backend/deploy.sh
```

## 错误响应

保留旧的 `error`、`message`、`requestId`，新增 `model`、`location` 和 `diagnostics`：

```json
{
  "error": "upstream_error",
  "message": "模型或资源不存在，或项目无权访问。",
  "requestId": "...",
  "model": "gemini-3.8-flash",
  "location": "global",
  "diagnostics": {
    "source": "vertex",
    "httpStatus": 502,
    "upstreamHttpStatus": 404,
    "googleStatus": "NOT_FOUND",
    "model": "gemini-3.8-flash",
    "location": "global",
    "requestId": "...",
    "summary": "模型或资源不存在，或项目无权访问。",
    "action": "核对模型名称、global/区域和项目访问权限。"
  }
}
```

`source` 可能为 `backend`、`vertex` 或 `google_auth`。没有上游 HTTP 响应时 `upstreamHttpStatus`/`googleStatus` 为 null；网络异常的 Google 状态可能为 UNKNOWN。

Google `error.status` 只接受固定枚举，不接受任意字符串。上游 HTTP 码也只接受 100–599 的整数；未知值退回固定通用摘要。`error.message`、`error.details`、正文和原始异常不向浏览器或日志透传，避免 Google 报错回显请求正文或秘密。日志仍只包含请求标识、类别和计数元数据。启动失败也只记录固定提示，详细环境错误需自行检查配置，不打印私钥解析异常。

## 已执行验证

使用捆绑 Node v24 运行 `node test/run-all.js`：35 项通过。包括 100000 合计字符接受/100001 拒绝、32768 输出预算、默认限制、模型/位置/requestId、Google 状态白名单、拒绝泄漏原始正文/令牌、认证/配额/安全拦截/超时回归。没有实际部署 Cloud Run 或调用真实 Vertex；新限制和模型能力仍待用户部署验证。
