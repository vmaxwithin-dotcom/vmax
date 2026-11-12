# Android 部署指南（Cloud Shell + 酒馆 APK）

这份指南假设你只有一台 Android 手机，通过浏览器操作 Google Cloud Shell，酒馆运行在一个包装了 SillyTavern 网页的 APK 里。

目标：

1. 在 Google Cloud 建好后端；
2. 把服务账号 JSON 放进 Secret Manager；
3. 部署 Cloud Run；
4. 让酒馆通过 Git URL 安装扩展；
5. 在酒馆里完成一次润色、替换和撤销。

> 命令里的 `$PROJECT_ID`、`$POLISH_TOKEN` 等是变量。每开一个新的 Cloud Shell 标签页，变量都会丢失，需要重新 `export`。重要的值请存进密码管理器。

> **想少填命令？** 如果项目已经绑定结算，并且你不打算手工管理服务账号，可以先按第 7 节上传 ZIP 并解压，然后跳过第 3–6 节的手动命令，直接运行 `PROJECT_ID="你的项目ID" bash backend/setup.sh`。脚本会自动创建服务账号、密钥、Secret、访问口令并部署 Cloud Run。下面的手动步骤仍然保留，便于排错或使用已有密钥。

---

## 0. 先确认酒馆的安装方式

这决定扩展怎么装：

| APK 的形态 | 扩展安装方式 |
| --- | --- |
| APK 只是 WebView，打开一个远程酒馆地址 | 在酒馆网页里用 Git URL 安装；扩展装在远程服务器上 |
| APK 自带 Node/SillyTavern，本地运行 | 酒馆的“安装扩展”需要服务端有 `git`；没有就手动复制扩展目录 |
| 酒馆跑在电脑/ NAS 上，手机只是访问 | 和远程酒馆一样，在网页里装 |

先在酒馆里打开 **Extensions** 页面，看看有没有 **Install Extension** 输入框。有就优先用 Git URL；没有或安装报错，再用文末的“手动安装”兜底。

---

## 1. 创建项目并确认账单

1. 手机浏览器打开 <https://console.cloud.google.com/>。
2. 顶部项目选择器 → **新建项目**，记下项目 ID（不是项目名称）。
3. 左侧 **结算** → 关联一个结算账号。没有结算账号时，Vertex AI 通常无法调用。
4. 记下项目 ID，后面所有命令都用它：

```bash
export PROJECT_ID="你的项目ID"
gcloud config set project "$PROJECT_ID"
```

检查：

```bash
gcloud config get-value project
```

应输出你的项目 ID。

---

## 2. 打开 Cloud Shell

手机浏览器访问：

<https://shell.cloud.google.com/>

首次会提示授权，点允许。Cloud Shell 自带 `gcloud`、`git`、`unzip`、`openssl`。

手机上的小技巧：

- 横屏使用，终端更宽；
- Cloud Shell 右上角有“在专用窗口打开”；
- 复制命令后，在终端里长按粘贴；
- 命令很长时，先粘贴到 Cloud Shell 的编辑器（铅笔图标），确认无误再运行。

---

## 3. 启用 API

```bash
gcloud services enable \
  aiplatform.googleapis.com \
  secretmanager.googleapis.com \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com
```

第一次启用可能要一两分钟。失败时通常是：

- 项目 ID 写错；
- 没有结算账号；
- 当前 Google 账号没有该项目的 Owner/Editor 权限。

---

## 4. 创建服务账号并取得 JSON 密钥

### 4.1 创建服务账号

```bash
gcloud iam service-accounts create st-vertex-polish \
  --display-name="ST Vertex Polish"
```

如果提示服务账号已存在，直接继续下一步即可。

只授予调用 Vertex 的权限：

```bash
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:st-vertex-polish@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/aiplatform.user"
```

Cloud Run 会用同一个服务账号读取 Secret Manager，再给它最小读取权限：

```bash
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:st-vertex-polish@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

### 4.2 生成 JSON 密钥（推荐，不经过手机文件）

```bash
gcloud iam service-accounts keys create /tmp/sa.json \
  --iam-account="st-vertex-polish@$PROJECT_ID.iam.gserviceaccount.com"
```

检查类型：

```bash
python3 -c "import json;print(json.load(open('/tmp/sa.json'))['type'])"
```

必须输出 `service_account`。

### 4.3 如果你已经有 JSON 密钥

在 Cloud Shell 右上角菜单（三个点）→ **上传** → 选择手机里的 `sa.json`。上传后会落在当前目录。

然后确认：

```bash
ls -l sa.json
python3 -c "import json;print(json.load(open('sa.json'))['type'])"
```

> 不要把 `sa.json` 提交到 GitHub，也不要发到聊天软件。Cloud Shell 的主目录会跨会话保留，用完请删除上传的密钥文件。

---

## 5. 把密钥放进 Secret Manager

```bash
gcloud secrets create vertex-sa-key --replication-policy=automatic
gcloud secrets versions add vertex-sa-key --data-file=/tmp/sa.json
```

如果 `create` 提示 secret 已存在，跳过 `create`，直接执行 `versions add`。

如果你用的是上传的 `sa.json`，把最后一行改成：

```bash
gcloud secrets versions add vertex-sa-key --data-file=sa.json
```

删除临时密钥文件：

```bash
rm -f /tmp/sa.json
```

确认：

```bash
gcloud secrets versions list vertex-sa-key
```

应看到一个 `ENABLED` 版本。

---

## 6. 生成私人访问口令

```bash
POLISH_TOKEN="$(openssl rand -base64 48)"
printf '%s' "$POLISH_TOKEN" | gcloud secrets create polish-access-token --data-file=-
echo "$POLISH_TOKEN"
```

如果 secret 已存在，改用：

```bash
printf '%s' "$POLISH_TOKEN" | gcloud secrets versions add polish-access-token --data-file=-
```

立刻把输出的口令存进密码管理器。后面酒馆扩展里要填它。

检查长度至少 16 字符；`openssl rand -base64 48` 生成的口令足够长。

> 口令只用于你的扩展访问后端，不是 Google 账号密码。泄露后更换 Secret Manager 版本并重新部署即可。

---

## 7. 把源码放到 Cloud Shell

### 方式 A：从 GitHub 克隆（如果你已经把仓库推上去）

```bash
git clone https://github.com/你的用户名/st-vertex-polish.git
cd st-vertex-polish
```

### 方式 B：上传 ZIP（完全在手机上操作时更现实）

1. 在电脑或手机上准备好仓库 ZIP；
2. Cloud Shell 右上角菜单 → **上传** → 选择 ZIP；
3. 解压：

```bash
unzip -q st-vertex-polish.zip
cd st-vertex-polish
```

确认根目录有 `manifest.json`：

```bash
ls -1
```

应该能看到 `manifest.json`、`index.js`、`style.css`、`backend/`、`README.md`。

---

## 8. 部署 Cloud Run

在仓库根目录执行：

```bash
PROJECT_ID="$PROJECT_ID" bash backend/deploy.sh
```

脚本会：

- 再启用一次所需 API；
- 检查两个 Secret 是否存在；
- 用 `backend/` 构建镜像；
- 部署为 Cloud Run 服务；
- 强制 `--max-instances=1 --concurrency=1`；
- 挂载 `/secrets/sa.json`；
- 输出服务 URL。

成功时最后会打印：

```
Backend URL: https://st-vertex-polish-xxxxx-uc.a.run.app
```

把它记下来。

### 8.1 冒烟测试

```bash
export BACKEND_URL="https://....run.app"
curl -fsS "$BACKEND_URL/health"
```

应返回类似：

```json
{"ok":true,"service":"st-vertex-polish","requestId":"..."}
```

再测一次真实润色（会消耗一次 Vertex 调用）：

```bash
BACKEND_URL="$BACKEND_URL" POLISH_TOKEN="$POLISH_TOKEN" bash backend/smoke-test.sh
```

返回 `"text": "..."` 就说明服务账号、Secret、项目、模型、区域全部打通。

如果失败，先看第 12 节。

---

## 9. 把扩展发布成 Git 仓库

酒馆的 Git URL 安装要求服务器能 `git clone` 一个仓库，并且仓库根目录有 `manifest.json`。

### 9.1 在 GitHub 创建仓库

手机浏览器打开 <https://github.com/new>，创建一个空仓库，例如 `st-vertex-polish`。不要勾选自动生成 README。

### 9.2 从 Cloud Shell 推送

在 Cloud Shell 的仓库目录里（如果你是用 `git clone` 下来的，跳过 `git init` 和 `remote add`）：

```bash
git init
git config user.name "你的名字"
git config user.email "你的邮箱"
git add .
git commit -m "Vertex polish extension"
git branch -M main
git remote add origin https://github.com/你的用户名/st-vertex-polish.git
git push -u origin main
```

推送时会要求 GitHub 用户名和密码。**GitHub 不接受账号密码**，需要 Personal Access Token：

1. GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)；
2. Generate new token，勾选 `repo`；
3. 复制 token，在 `git push` 的 Password 提示处粘贴。

> 不要把 token 写进 `git remote` 的 URL 后提交到任何地方。推送完成后可以执行 `history -c` 清掉当前会话历史。

### 9.3 私有仓库

酒馆服务器无法登录你的 GitHub 私有仓库，因此 Git URL 安装会失败。要么把仓库设为 Public，要么手动安装（见第 11 节）。

---

## 10. 在酒馆里安装扩展

1. 打开酒馆。
2. 进入 **Extensions**。
3. 找到 **Install Extension**。
4. 粘贴：

```text
https://github.com/你的用户名/st-vertex-polish
```

5. 点 **Install**，等待酒馆 `git clone`。
6. 安装完成后，在扩展列表里启用 **Vertex 润色**。
7. 刷新酒馆页面。

成功标志：页面右下角出现 **润色** 按钮。

如果安装按钮转圈或报错：

- 酒馆服务端没有 `git`；
- 服务器访问不了 GitHub（网络问题）；
- 仓库根目录没有 `manifest.json`；
- 仓库是私有的。

先换公开仓库；仍然不行就手动安装。

---

## 11. 配置与第一次润色

1. 点 **润色** 按钮。
2. 展开 **连接设置**：
   - 后端地址：第 8 步的 `Backend URL`；
   - 访问口令：第 6 步的 `POLISH_TOKEN`。
3. 点 **刷新**，确认下拉框里出现你酒馆里的预设名称。
4. 选择预设；或在“自定义润色要求”里写：

```text
更口语化，保留第二人称和所有细节，不要新增剧情。
```

5. 在酒馆里让 AI 生成一条回复。
6. 点 **开始润色**。
7. 检查“原文”和“润色结果”。
8. 点 **替换当前回复**。
9. 刷新聊天页面，确认替换已保存。
10. 再点 **撤销上次替换**，确认能恢复。

### 验证 swipe

1. 对同一条 AI 回复切换一个 swipe；
2. 打开润色窗口，顶部应显示“版本 2/3”之类的信息；
3. 润色后替换，只应改当前 swipe；
4. 切回旧 swipe，旧内容不应被改。

### 验证过期保护

1. 点“开始润色”；
2. 在请求返回前切换聊天或切换 swipe；
3. 结果应被丢弃，或替换按钮拒绝执行。

---

## 12. 失败后的恢复

### 12.1 部署失败

先看错误类型：

```bash
gcloud run services list
gcloud builds list --limit=5
```

常见原因：

- `PERMISSION_DENIED`：当前账号没有 Cloud Run/Cloud Build 权限；
- `Billing disabled`：项目没有结算账号；
- `Secret ... not found`：第 5、6 步没做完；
- `container failed to start`：看日志：

```bash
gcloud run services logs read st-vertex-polish --region us-central1 --limit=50
```

### 12.2 服务起来了但 500 `backend_auth_failed`

- Secret 是否挂载在 `/secrets/sa.json`；
- 服务账号 JSON 的 `type` 是否 `service_account`；
- 项目是否启用了 `aiplatform.googleapis.com`；
- 服务账号是否有 `roles/aiplatform.user`。

查看当前配置：

```bash
gcloud run services describe st-vertex-polish \
  --region us-central1 \
  --format="yaml(spec.template.spec.containers[0].env,spec.template.spec.volumes)"
```

### 12.3 404 / `upstream_error`

模型或区域不可用。先换区域：

```bash
gcloud run services update st-vertex-polish \
  --region us-central1 \
  --update-env-vars GOOGLE_CLOUD_LOCATION=global
```

再换模型：

```bash
gcloud run services update st-vertex-polish \
  --region us-central1 \
  --update-env-vars VERTEX_MODEL=gemini-3.7-flash
```

如果模型在 Model Garden 里明明可用，但 `v1` 返回 404，再试 `v1beta1`：

```bash
gcloud run services update st-vertex-polish \
  --region us-central1 \
  --update-env-vars VERTEX_API_VERSION=v1beta1
```

每次 update 都会创建新 revision，旧 revision 可回滚。

### 12.4 403 `origin_not_allowed`

默认 `ALLOWED_ORIGINS=*` 不会出现这个问题。如果你改过白名单：

- WebView 从 `file://` 加载时 Origin 是 `null`；
- 从本地 asset 加载时可能是 `https://appassets.androidplatform.net`；
- 远程酒馆则是酒馆的域名。

最简单的恢复：

```bash
gcloud run services update st-vertex-polish \
  --region us-central1 \
  --update-env-vars ALLOWED_ORIGINS='*'
```

CORS 只控制浏览器来源，真正的安全边界是访问口令。

### 12.5 401

- 口令前后有空格；
- Secret 更新了但没重新部署；
- 扩展里填的是旧口令。

重新部署让新 secret 版本生效：

```bash
gcloud run services update st-vertex-polish --region us-central1
```

### 12.6 手机键盘挡住窗口

先收起键盘；窗口本身已使用 `dvh` 和 `visualViewport` 自适应。若 APK 的 WebView 关闭了视口缩放，仍可能异常，属于 APK 层问题。

---

## 13. 费用提醒

- 在 Google Cloud **结算 → 预算和提醒** 里设置一个低金额预算（例如 5 美元），开启邮件提醒。
- 后端的 `DAILY_LIMIT=100` 是应用层计数，不是账单硬上限。
- Cloud Run 缩容到 0，但构建、Secret 访问和 Vertex token 仍会产生费用。
- 不用时可以把 Cloud Run 服务删掉，或把 `DAILY_LIMIT` 调到 1。

---

## 14. 手动安装扩展（Git URL 不可用时）

酒馆的 Git URL 安装依赖服务端 `git` 和网络。如果 APK 里的酒馆没有这些，可以手动放文件：

1. 把 `st-vertex-polish` 整个文件夹（不是 ZIP）放到酒馆的：
   ```
   SillyTavern/public/scripts/extensions/third-party/st-vertex-polish/
   ```
2. 确认 `manifest.json` 就在这个文件夹的第一层，和 `index.js` 同级。
3. 重启酒馆，进入 **Extensions**，启用 **Vertex 润色**，刷新页面。
4. 以后更新扩展时，用新版本覆盖这个文件夹。

如果酒馆跑在远程服务器，需要通过服务器的文件管理/SSH 上传；如果酒馆跑在 APK 内部，目录位置由 APK 决定，可能需要文件管理器或 root 权限。这种情况下 Git URL 安装通常更省事。

---

## 15. 安全清单

- [ ] `sa.json` 只在 Secret Manager，不在 GitHub、聊天记录、手机相册。
- [ ] 服务账号只有 `roles/aiplatform.user` 和 `roles/secretmanager.secretAccessor`。
- [ ] 访问口令保存在密码管理器，不写在 README。
- [ ] 仓库不要提交 `.env`、`sa.json`、token。
- [ ] 公共设备上不要勾选“在本设备记住口令”。
- [ ] 怀疑口令泄露时：新增 Secret 版本 → 重新部署 → 旧口令立即失效。
- [ ] 遵守 Vertex AI 使用政策；安全拦截不是“可以绕过”的错误。
