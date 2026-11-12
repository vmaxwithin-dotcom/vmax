# Vertex 润色 · SillyTavern 扩展

在酒馆里打开一个小窗口，选择酒馆已有的聊天补全预设，填写自己的润色要求，调用你自己 Google Cloud 项目里的 Vertex AI，润色**最新一条 AI 回复的当前 swipe**，预览后替换，并支持一次撤销。

Google 服务账号 JSON 只放在独立后端（Cloud Run + Secret Manager），不会进入浏览器。

---

## 功能

- 酒馆页面内的悬浮按钮和小窗口，适配手机宽度与软键盘。
- 直接读取酒馆的聊天补全预设，扩展内独立选择，不影响酒馆当前使用的预设。
- 可保存的自定义润色要求；与预设风格冲突时，自定义要求优先。
- 只润色最新一条 AI 回复的当前 swipe 版本；发送前固定快照。
- 请求期间禁止重复点击；切换聊天、切换 swipe、编辑或删除消息会作废旧结果。
- 原文 / 结果纯文本预览，确认后写回酒馆并保存；支持一次撤销。
- 后端校验访问口令、来源、输入长度、模型参数、调用间隔和每日次数。
- Google 安全过滤保持开启；拦截时返回明确原因，不自动重试。

## 架构

```
Android APK / 手机浏览器
└── SillyTavern 页面
    └── 本扩展（index.js）
          │  HTTPS + Authorization: Bearer <私人访问口令>
          ▼
    Cloud Run 后端（backend/）
          ├── Secret Manager 挂载 sa.json
          └── Vertex AI generateContent（官方 REST API）
```

服务账号密钥、Google OAuth 访问令牌只存在于后端进程内。扩展只持有访问后端的私人口令。

## 兼容性

| 项目 | 值 |
| --- | --- |
| SillyTavern 基准 | **1.19.0**（2026-09-14 发布） |
| 源码提交 | `7e8663cd9c184a550b37238218bdd32c6efc68e9`（tag `1.19.0`） |
| 扩展最低客户端版本 | 1.13.0（按 `getContext` / `APP_READY` 接口推断，未逐版本实测） |
| 核实日期 | 2026-11-12（Asia/Shanghai） |
| 核实来源 | GitHub Releases API、`public/scripts/st-context.js`、官方扩展文档、`default/content/presets/openai/Default.json` |

扩展只使用 `SillyTavern.getContext()` 暴露的公开接口，不直接 import 酒馆内部模块，降低版本升级时的破坏面。主要依赖：

- `context.chatCompletionSettings`（即 `oai_settings`）读取预设；
- `context.substituteParams` 处理宏；
- `context.chat`、`context.saveChat`、`context.updateMessageBlock` 读写消息；
- `context.eventSource` / `context.eventTypes` 监听聊天与消息事件。

如果某个版本没有 `chatCompletionSettings`，扩展会回退到 `POST /api/settings/get`。

## 目录

```
st-vertex-polish/
├── manifest.json          # 酒馆扩展清单（仓库根目录，可直接用 Git URL 安装）
├── index.js               # 扩展入口（ES module）
├── style.css
├── src/core.js            # 纯函数：目标选择、预设拼装、请求组装、快照校验
├── backend/
│   ├── server.js          # HTTP 服务入口
│   ├── lib/config.js      # 环境变量校验
│   ├── lib/google-auth.js # 服务账号 JSON → OAuth access token
│   ├── lib/vertex.js      # Vertex generateContent 调用与响应归一化
│   ├── lib/limits.js      # 间隔 / 每日次数
│   ├── lib/app.js         # 路由、认证、CORS、错误映射
│   ├── Dockerfile
│   ├── setup.sh           # 一键建资源并部署
│   ├── deploy.sh
│   └── smoke-test.sh
├── tests/                 # 扩展纯函数、UI 接线与后端测试
└── docs/ANDROID.md        # Android + Cloud Shell 部署指南
```

> 仓库根目录同时是酒馆扩展目录。`backend/` 只是同一仓库里的后端源码，酒馆会忽略它。

---

## 快速开始

完整手机操作步骤见 [docs/ANDROID.md](docs/ANDROID.md)。

### 最快路径：一条命令

适合全新的 Google Cloud 项目、还没有手动建过服务账号和 Secret 的情况。

1. 把 `st-vertex-polish.zip` 上传到 Cloud Shell，解压并进入目录：
   ```bash
   unzip -q st-vertex-polish.zip
   cd st-vertex-polish
   ```
2. 如果你已经有 `sa.json`，把它放在 `st-vertex-polish/` 目录里（或设置 `SA_FILE=../sa.json`）；没有就跳过，脚本会新建密钥。
3. 运行：
   ```bash
   PROJECT_ID="你的项目ID" bash backend/setup.sh
   ```
   脚本会自动启用 API、创建服务账号、授予 `aiplatform.user` 和 `secretmanager.secretAccessor`、生成 JSON 密钥、写入 Secret Manager、生成访问口令并部署 Cloud Run。
4. 记下最后打印的 **Backend URL** 和 **Access token**。
5. 把仓库推上 GitHub，按“安装扩展”一节安装，填这两个值即可。

如果项目里已经手动建过服务账号/Secret，或组织禁止创建密钥，按下面的手动分步执行。

### 手动分步（可选）

#### 1. 准备 Google Cloud

在 <https://console.cloud.google.com/> 创建或选择项目，绑定结算账号，然后启用 API：

```bash
export PROJECT_ID="你的项目ID"
gcloud config set project "$PROJECT_ID"
gcloud services enable \
  aiplatform.googleapis.com \
  secretmanager.googleapis.com \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com
```

创建专用服务账号并只授予 Vertex 调用权限：

```bash
gcloud iam service-accounts create st-vertex-polish \
  --display-name="ST Vertex Polish"
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:st-vertex-polish@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/aiplatform.user"
```

Cloud Run 用同一个服务账号读取 Secret Manager，再授予最小读取权限：

```bash
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:st-vertex-polish@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

#### 2. 把 JSON 密钥放进 Secret Manager

如果你已经有 `sa.json`（`type` 必须是 `service_account`），在 Cloud Shell 上传后执行：

```bash
gcloud secrets create vertex-sa-key --replication-policy=automatic
gcloud secrets versions add vertex-sa-key --data-file=sa.json
```

如果提示 secret 已存在，跳过 `create`，直接执行 `versions add`。

没有现成密钥时，可以在 Cloud Shell 里直接生成，避免把密钥下载到手机：

```bash
gcloud iam service-accounts keys create /tmp/sa.json \
  --iam-account="st-vertex-polish@$PROJECT_ID.iam.gserviceaccount.com"
gcloud secrets create vertex-sa-key --replication-policy=automatic
gcloud secrets versions add vertex-sa-key --data-file=/tmp/sa.json
rm -f /tmp/sa.json
```

生成私人访问口令并存入 Secret Manager：

```bash
POLISH_TOKEN="$(openssl rand -base64 48)"
printf '%s' "$POLISH_TOKEN" | gcloud secrets create polish-access-token --data-file=-
echo "$POLISH_TOKEN"   # 立刻保存到密码管理器
```

#### 3. 部署后端

在仓库根目录执行：

```bash
PROJECT_ID="$PROJECT_ID" bash backend/deploy.sh
```

脚本会部署到 Cloud Run，并强制 `--max-instances=1 --concurrency=1`（额度计数器按单实例设计）。完成后会输出 `Backend URL`。

冒烟测试：

```bash
BACKEND_URL="https://....run.app" POLISH_TOKEN="$POLISH_TOKEN" bash backend/smoke-test.sh
```

#### 4. 安装扩展

把整个仓库推送到 GitHub（**公开仓库**；私有仓库酒馆无法认证，只能手动安装），然后在酒馆：

**Extensions → Install Extension → 粘贴 Git URL → Install → 启用 → 刷新页面**。

如果 APK 里的酒馆服务端没有 `git`，或 Git URL 安装失败，可手动把仓库根目录复制到：

```
SillyTavern/public/scripts/extensions/third-party/st-vertex-polish/
```

再刷新酒馆。

#### 5. 配置

点页面右下角的 **润色** 按钮：

1. 展开“连接设置”，填 Cloud Run 的 `Backend URL` 和访问口令。
2. 点“刷新”，选择要套用的酒馆预设；也可以选“不使用预设”。
3. 填写自定义润色要求（可留空）。
4. 点“开始润色”，检查原文/结果，点“替换当前回复”。

口令默认只保存在当前页面会话（`sessionStorage`）。勾选“在本设备记住口令”才会写入 `localStorage`，公共设备上不要勾。

---

## 预设是怎么读取的

数据来源：`SillyTavern.getContext().chatCompletionSettings`（即 `oai_settings`），失败时回退 `POST /api/settings/get`。

对 `presets[名称]` 执行：

1. 优先使用 `prompt_order`：
   - 群聊找 `character_id: 100001`；
   - 当前角色有专属顺序时用角色 id；
   - 否则用默认 `100000`。
2. 按 `order` 数组顺序逐条取 `prompts` 中同 `identifier` 的条目。
3. 跳过 `enabled: false`、`marker: true`、内容为空的条目。
4. 用 `context.substituteParams()` 替换 `{{char}}`、`{{user}}` 等酒馆宏。
5. 所有保留条目按顺序拼成一段 system instruction。

采样参数映射：

| 酒馆预设 | Vertex `generationConfig` | 说明 |
| --- | --- | --- |
| `temperature` | `temperature` | 限制在 0–2 |
| `top_p` | `topP` | 限制在 0–1 |
| `openai_max_tokens` / `max_tokens` | `maxOutputTokens` | 限制 256–8192，长回复会自动抬高预算 |
| `frequency_penalty` / `presence_penalty` | 不支持 | Vertex Gemini 没有对应字段，直接丢弃 |

### 已知限制（故意不做“假兼容”）

- `marker: true` 的占位条目（世界书、角色描述、角色性格、场景、示例对话、聊天历史等）会被**跳过**；它们不是静态文本，强行拼会拼错。
- 世界书注入、STscript、正则、快速回复、外部扩展依赖不会执行。
- 预设里 user/assistant 角色的条目会被统一并入 system instruction，不保留多轮角色边界。
- 只发送最新一条 AI 回复，不自动附带前文上下文。
- 预设里的 `{{lastMessage}}` 宏会被移除，避免正文被重复发送；其他宏交给酒馆的 `substituteParams` 处理。
- 预设 + 任务指令 + 自定义要求 + 正文合计超过 20,000 字符时，请求前直接报错，不会静默截断。

窗口里的“预设条目 N 条，跳过 M 条；发送 X 字符”就是用来核对这件事的。

---

## 使用与状态

- **目标**：聊天数组里最后一条非 user、非 system 的消息；使用它当前的 `swipe_id` 和对应 swipe 文本。
- **快照**：点击润色时记录聊天 id、消息索引、swipe、原文、`send_date`、角色名。
- **替换前**：重新核对快照；聊天切换、消息删除、原文变化、swipe 切换都会拒绝写入。
- **撤销**：只保留一次；撤销前再次核对当前文本是否仍等于刚写入的润色结果，避免覆盖你后续的手动编辑。
- **并发**：请求期间按钮禁用；新请求会中止旧请求；切换聊天/开始新生成会作废旧结果；关闭窗口会取消进行中的请求，但保留已生成、待替换的结果。
- **保存**：调用酒馆的 `saveChat()`；保存失败会回滚内存中的修改并提示。

---

## 后端

### API

`POST /api/polish`

```http
Authorization: Bearer <POLISH_ACCESS_TOKEN>
Content-Type: application/json

{
  "systemInstruction": "...",
  "prompt": "...",
  "temperature": 0.8,
  "topP": 0.9,
  "maxOutputTokens": 1024
}
```

成功：

```json
{
  "text": "润色后的正文",
  "model": "gemini-3.5-flash",
  "finishReason": "STOP",
  "truncated": false,
  "usage": { "totalTokenCount": 1234 },
  "requestId": "..."
}
```

错误统一带 `error`、`message`、`requestId`：

| HTTP | `error` | 含义 |
| --- | --- | --- |
| 401 | `unauthorized` | 口令缺失或错误 |
| 403 | `origin_not_allowed` | 来源不在 `ALLOWED_ORIGINS` |
| 413 | `too_large` | 请求体或输入字符超限 |
| 422 | `blocked` | Google 安全策略拦截 |
| 422 | `output_truncated` | 输出被截断且没有正文 |
| 429 | `rate_limited` / `daily_limit` | 调用太频繁 / 今日次数用完 |
| 502 | `upstream_error` | Vertex 返回错误 |
| 504 | `timeout` | 等待 Vertex 超时 |

`GET /health` 返回 `{ "ok": true }`，不需要口令，方便 Cloud Run 探活。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `POLISH_ACCESS_TOKEN` | 必填 | 至少 16 字符 |
| `GOOGLE_CLOUD_PROJECT` | 服务账号 JSON 的 `project_id` | 项目 ID |
| `GOOGLE_CLOUD_LOCATION` | `us-central1` | 区域；也支持 `global` |
| `VERTEX_MODEL` | `gemini-3.5-flash` | 必须是项目和区域里可用的模型 |
| `VERTEX_API_VERSION` | `v1` | 可选 `v1` / `v1beta1` / `v1p1`；新模型在 `v1` 不可用时试 `v1beta1` |
| `ALLOWED_ORIGINS` | `*` | 逗号分隔；WebView 的 `file://` 来源是 `null` |
| `MAX_INPUT_CHARS` | `20000` | system + prompt 合计字符上限 |
| `MAX_OUTPUT_TOKENS` | `8192` | 生成上限，同时限制客户端请求值 |
| `DAILY_LIMIT` | `100` | 每 UTC 日预占的调用次数；失败的上游调用也计数，避免重试刷额度 |
| `MIN_INTERVAL_MS` | `3000` | 两次调用最小间隔 |
| `REQUEST_TIMEOUT_MS` | `60000` | 等待 Vertex 的超时 |
| `GOOGLE_APPLICATION_CREDENTIALS` | `/secrets/sa.json` | 服务账号 JSON 路径 |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | 空 | 直接内联 JSON，仅本地调试用 |
| `PORT` | `8080` | Cloud Run 注入 |

模型、区域和 API 生命周期会变化。部署前请在 Model Garden 确认 `gemini-3.5-flash` 在你选择的区域可用；如果返回模型不存在，改成你项目里可用的模型（例如 `gemini-3.7-flash`），或把区域设为 `global` 再试。

---

## 费用与安全

### 费用边界

- **Vertex AI**：按输入/输出 token 计费，模型和区域不同价格不同。
- **Cloud Run**：缩容到 0；个人使用通常落在免费额度内，但请求、CPU、内存和出站流量仍可能产生费用。
- **Secret Manager**：按 secret 版本和访问次数计费。
- **Cloud Build / Artifact Registry**：`--source` 部署会用到，通常有免费额度。

后端的“每日 100 次”只是应用层计数器，**不是账单硬上限**。请在 Google Cloud 设置预算提醒；赠送金额的适用范围请以自己的结算页面为准。

### 访问口令

- 后端只接受 `Authorization: Bearer`，不使用 URL 查询参数，避免口令进入访问日志。
- 口令至少 16 字符，建议 `openssl rand -base64 48`。
- 更换口令：新增 Secret Manager 版本后重新部署，旧口令立即失效。
- 扩展页面、APK 宿主或恶意扩展理论上都能读到页面里的口令。它只能降低误用，不能替代 Google 账号安全。

### 服务账号

- 建议专用服务账号，只给 `roles/aiplatform.user`。
- JSON 密钥不会进入前端、镜像、日志或错误响应。
- 密钥是长期凭据，建议定期轮换；更高安全要求可改用 Workload Identity Federation（本版本未实现）。
- “官方 API + 安全过滤开启”不能保证 Google 账号永不受限；请遵守 Vertex AI 使用政策。

### 日志

后端只记录 `requestId`、方法、路径、状态码、耗时、模型、输入/输出字符数、错误类别。**不记录聊天正文、完整提示词、访问口令或 Google 令牌。**

---

## 排错

| 现象 | 排查 |
| --- | --- |
| 401 | 口令前后有空格；Secret Manager 里的值与扩展里填的不一致；改过 secret 但没重新部署 |
| 403 `origin_not_allowed` | 把 `ALLOWED_ORIGINS` 设为 `*`，或把 WebView 的实际 Origin（常见是 `null`）加入白名单 |
| 404 / `upstream_error` | 模型或区域不对；换 `VERTEX_MODEL` / `GOOGLE_CLOUD_LOCATION`，确认 Model Garden 可用 |
| 422 `blocked` | Google 安全过滤拦截；修改内容或提示词，不要自动重试 |
| 429 | 等 `MIN_INTERVAL_MS`，或次日再试；重启 Cloud Run 会重置内存计数 |
| 500 `backend_auth_failed` | Secret 没挂载到 `/secrets/sa.json`；服务账号 JSON 不是 `service_account`；项目未启用 Vertex API |
| 504 | 输入太长或模型太慢；缩短正文/预设，或换更快的模型 |
| 预设下拉为空 | 酒馆当前版本没有 `chatCompletionSettings`，且 `/api/settings/get` 失败；确认已登录、扩展已启用 |
| Git URL 安装失败 | 酒馆服务端没有 `git` 或访问不了 GitHub；改用手动复制目录 |
| 手机键盘挡住窗口 | 窗口用 `dvh` + `visualViewport` 兜底；仍异常时先收起键盘再操作 |

---

## 测试

本仓库自带 42 个 Node 测试，不依赖真实 Google 凭据：

```bash
node tests/run-all.js
```

覆盖：

- 目标消息与 swipe 选择；
- 预设 `prompt_order`、启用状态、marker、宏替换；
- 请求拼装、输入上限、采样参数钳制；
- 快照校验（文本 / swipe / 日期 / 角色名）；
- 扩展 UI 接线（假 DOM）：初始化、润色、替换、撤销、迟到结果丢弃、swipe 只改当前版本；
- 服务账号 JSON 校验、JWT 签名、token 缓存；
- 后端配置校验、认证、CORS（含 `null` 来源）、输入上限、每日/间隔限流、并发额度、安全拦截、截断、超时、上游错误、日志脱敏。

详细结果和**未验证项**见 [docs/TESTING.md](docs/TESTING.md)。

> 当前开发环境没有可运行的 SillyTavern 实例，也没有 Google 凭据，因此真实酒馆 UI、真实 Vertex 调用、Cloud Run 实际部署和 Android 真机键盘行为**尚未实测**。交付说明不会把它们标成“通过”。

---

## 许可证

MIT。只使用了 SillyTavern 的公开运行时接口，没有复制参考插件的代码。
