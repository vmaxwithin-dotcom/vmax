# 0.3.2 修复与验证

## 确认的错误

旧版假设 `chatCompletionSettings.presets` 是预设集合，测试也造了同样的字段。这不符合 SillyTavern 1.19.0 实际结构，导致测试通过却无法读取用户预设。现改用 `context.getPresetManager('openai').getPresetList()` 的 `presets` 与 `preset_names`，只读克隆，不应用/切换主聊天预设；点击润色再次读取。

口令流程原先失焦即清空，反馈不清楚。现提供显式“保存连接配置”，不自动清空输入，验证直接使用当前输入值；拉取过程中禁用相关按钮，15 秒超时，401/网络/取消均显示状态。不能据此断言用户之前的 401 全由此造成；若新版本仍 401，需要核对 Secret Manager 中口令和当前 Cloud Run revision 使用的 secret 版本。

预设刷新有读取中/成功/错误状态；替换、撤销异常进入界面提示，不再成为未处理的 Promise。

## 实际读取的来源

- [SillyTavern 1.19.0 preset-manager.js](https://github.com/SillyTavern/SillyTavern/blob/1.19.0/public/scripts/preset-manager.js)，Git blob `18196ad4ec2419b393b188c11384013b18449ae1`：getPresetList 531–587 行，getCompletionPresetByName 757–778 行。openai 使用 presets 数组和 name:index 映射；getPresetSettings 不是任意已存预设的读取替代。
- [ST-YaKit-chat 润色生成器](https://github.com/git-yafaya/ST-YaKit-chat/blob/8e61a8df058c67471db7ab3c0fe1e52cc1f4d586/src/features/polish/generate.js)：任务快照、内容与指令分离、取消及状态处理。
- [ST-YaKit-chat assistant-prompts](https://github.com/git-yafaya/ST-YaKit-chat/blob/8e61a8df058c67471db7ab3c0fe1e52cc1f4d586/src/shared/assistant-prompts.js)：正文事实与格式保留、参考材料边界。
- [ST-YaKit-chat preset store](https://github.com/git-yafaya/ST-YaKit-chat/blob/8e61a8df058c67471db7ab3c0fe1e52cc1f4d586/src/features/presets/store.js)：它此处的 presets 是插件自有集合，不可直接当酒馆聊天补全预设读取接口。

该参考仓库 tree 中没有 LICENSE，GitHub license API 返回 404；本次只研究机制，没有复制其实现或提示词。不能据此声称已经审查该仓库所有文件。

## 验证范围

执行 `node tests/run-all.js`，46 项测试通过。新增真实形状的 name:index、名称数组、JSON 字符串、快照隔离；UI 模拟涵盖输入/失焦/显式保存、401、恢复连接成功、按钮忙碌恢复。JS 语法检查通过。

没有真实酒馆浏览器/安卓 APK 或用户 Google 凭据，不能标记实机通过。此前测试数量不是实际兼容性的充分证明。

## 更新

本次只需更新 GitHub 扩展源码并在酒馆更新到 0.3.2；不需要部署 Cloud Run 或新建密钥。

1. 上传完整版本 ZIP 到 Cloud Shell，解压到临时目录后覆盖 `~/st-vertex-polish/`，保留 `.git`。
2. `node tests/run-all.js` 确认通过后提交并 git push。
3. 酒馆更新扩展、刷新，确认 0.3.2。
4. 在口令框粘贴 Secret Manager 的 `polish-access-token`，点击保存，然后验证。不要把秘密粘到聊天或截图。
5. 刷新预设，应列出酒馆已保存的聊天补全预设。

模型列表仍是后端预置列表，不是 Google 实时模型目录；预设 marker/动态世界书等限制仍在，未声称全量复刻主聊天生成。
