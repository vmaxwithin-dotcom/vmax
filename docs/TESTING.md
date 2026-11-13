# 测试记录

## 0.4.0 补充

48 项测试通过。新增真实 `PresetManager` 名称索引/数组与 JSON 字符串读取、预设条目开关覆盖、日夜主题切换、显式保存口令、失焦不丢口令、401 后恢复连接。仍为模拟测试，未在安卓 APK 真机验证。

测试日期：2026-11-12（Asia/Shanghai）
Node.js：v24.21.0（本机捆绑运行时）

## 已实际执行

### 1. 语法检查

对仓库内全部 `.js` 文件执行 `node --check`，全部通过。

### 2. 自动化测试

命令：

```bash
node tests/run-all.js
```

结果：

```
tests 48
pass 48
fail 0
```

分项：

| 套件 | 数量 | 覆盖内容 |
| --- | --- | --- |
| `tests/core.test.js` | 13 | 当前 swipe 取文、最新 AI 消息选择、`prompt_order` 解析、marker/空条目/禁用条目跳过、条目列表与覆盖开关、宏替换、请求拼装、输入上限、采样钳制、快照校验 |
| `tests/ui-smoke.test.js` | 1 | 假 DOM 下的扩展接线：初始化、预设/模型下拉、日夜主题、条目编辑器、润色请求、替换、撤销、迟到结果丢弃、swipe 只改当前版本、显式保存口令与 401 恢复 |
| `tests/connection.test.js` | 1 | HTTPS 与地址中嵌入秘密/参数校验 |
| `tests/presets.test.js` | 2 | 真实 name:index 映射、数组、JSON 字符串、只读克隆、管理器不可用报错 |
| `backend/test/vertex.test.js` | 8 | Vertex URL（区域 / global）、`promptFeedback` 与 `finishReason` 安全拦截、`MAX_TOKENS` 截断、请求体结构、上游 HTTP 错误、超时、token 失败 |
| `backend/test/google-auth.test.js` | 3 | `service_account` JSON 校验、RS256 JWT 签名与验签、token 缓存、OAuth 失败不泄露私钥 |
| `backend/test/config.test.js` | 3 | 默认值、来源列表解析、口令长度、数值/模型/区域校验 |
| `backend/test/app.test.js` | 17 | 健康检查、模型列表、模型覆盖、401、CORS 白名单与 `null` 来源、无效 JSON/模型、字符/字节上限、每日与间隔限流、并发额度、参数钳制、安全拦截、截断/超时/上游/认证错误映射、405、日志脱敏 |

### 3. 本环境说明

DSH 沙箱禁止 Node 测试运行器通过管道 spawn 子进程，`node --test` 会报 `spawn EPERM`。因此测试通过 `node tests/run-all.js` 在单进程内导入并执行；在普通开发机上 `npm test` 等价。

## 没有实测（不能标为通过）

以下项目需要真实环境，本开发环境不具备：

1. **真实 SillyTavern 1.19.0 页面**
   - 没有运行中的酒馆实例，无法实际点击扩展按钮、打开窗口、观察移动端 CSS。
   - 代码按 1.19.0 的 `st-context.js` 和官方扩展文档编写，但没有在浏览器里执行。
2. **真实 Vertex AI 调用**
   - 没有 Google Cloud 项目和服务账号密钥。
   - 只验证了 JWT 签名、请求体结构、响应解析和错误映射（mock）。
3. **Cloud Run 实际部署**
   - 没有执行 `gcloud run deploy`。
   - Dockerfile 和 `deploy.sh` 未在 Cloud Build 中构建。
4. **Android APK / WebView / 软键盘**
   - 没有真机。
   - `visualViewport`、`dvh`、safe-area 只做了代码层适配。
5. **Git URL 安装**
   - 没有公开仓库，也没有可用的酒馆服务端 `git`。
   - 只验证了仓库根目录存在 `manifest.json` 和 `index.js`。

## 建议用户按顺序验收

1. `GET /health` 返回 `{"ok":true}`。
2. 错误口令返回 401。
3. `backend/smoke-test.sh` 返回一段真实润色文本。
4. 酒馆扩展列表能启用“Vertex 润色”，页面出现“润色”按钮。
5. 预设下拉能列出酒馆预设。
6. 对最新 AI 回复润色，预览正常。
7. 替换后刷新聊天，内容仍在。
8. 撤销后刷新，恢复原文。
9. 切换 swipe 后，只改当前版本。
10. 请求过程中切换聊天，旧结果不落盘。
11. 手机键盘弹出后，输入框和按钮仍可操作。
12. 连续快速点击“开始润色”，只发出一次请求。

任一项失败时，请把浏览器 Console、Cloud Run 日志和请求 ID 一起记录；日志里没有聊天正文，只有请求标识和状态。
