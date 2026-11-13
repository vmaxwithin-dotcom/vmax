# 润色助手 0.6.0

## 界面

只保留魔法棒菜单入口，名称改为润色助手。标题“润色助手”按钮返回正文；右上角齿轮进入连接/酒馆预设/提示词设置。正文不再作为第四个设置分页。

移除诊断复制按钮、英文装饰小字、发送请求预览、差异高亮/比较基准、收起按钮；正文仅显示原文与可编辑结果。结果最近5版保存在页面内存，刷新丢失，复制结果可备份。日夜切换保留。

“自定义收藏”改称添加模型/移除模型，仅代表保存模型名，不保证模型可用。

## 提示词预设

可新建、命名、保存、改名、删除多套润色提示词。旧自定义要求自动迁移为“原有润色要求”。正文顶部可以即时切换提示词，编辑按钮进入设置。编辑文本后需点保存才更新命名预设，未保存编辑仍用于当前请求；切换预设会载入另一套内容。本次补充要求和继续修改要求不存入命名预设。

## API支持

1. Vertex AI 原生 generateContent，沿用服务账号JSON/OAuth。
2. OpenAI兼容非流式 Chat Completions：POST /chat/completions，system/user messages、temperature、top_p、max_tokens。仅支持文本 content；不支持 Responses、工具、多模态、流式、必须用max_completion_tokens的模型或供应商专有参数。

界面选择接口格式；前端仍只持有后端私人口令。OpenAI上游地址/密钥只配置在Cloud Run环境/Secret Manager。后端只使用服务器配置的HTTPS域名，禁止客户端指定上游URL/密钥、禁止重定向。使用第三方OpenAI兼容服务时，正文和提示词会交给该供应商；不保证其隐私和安全，也不代表它是Google官方接口。

### 配置OpenAI兼容服务

先更新并部署源码（现有deploy.sh仍按Vertex配置）。随后设置额外配置。将API密钥上传到Secret Manager，命名例如openai-api-key，并授予现有Cloud Run服务账号secretAccessor。不要把密钥放到命令历史、Git仓库或聊天。

```bash
gcloud run services update st-vertex-polish --region us-central1 --project galvanic-axle-514506-v9 --update-secrets OPENAI_API_KEY=openai-api-key:latest --update-env-vars '^|^OPENAI_BASE_URL=https://api.openai.com/v1|OPENAI_MODELS=你的模型ID'
```

OPENAI_BASE_URL填写供应商的API基础地址（通常以/v1结尾），不带/chat/completions；OPENAI_MODELS多个模型用逗号分隔。示例域名为OpenAI官方，第三方须替换为其提供的HTTPS基础地址。

如只使用Vertex，不设置上述变量即可。选择OpenAI但后端未配置会明确报错。模型“拉取”取后端配置列表，不是远程查询供应商/models目录。

## 验证

59项模拟/本地HTTP测试通过；OpenAI适配器请求结构、上游路由、namespaced模型、错误不回显正文/密钥、提示词增改、正文快捷选择、移除控件均有断言。JS语法检查通过。没有真实酒馆/Android视觉验收或真实OpenAI/Google凭据调用，不能声称实机通过。

OpenAI地址仅限受信任的管理员配置；域名解析仍由运行环境处理，并非通用隔离代理。所有提供方共用限流计数。5版是页面内存上限，不是云端永久记录。
