# 按场景配置模型实施计划

**目标：** 每个账号在网页配置截图、转写回答、直接音频回答使用的模型；文字阶段分别保存 Codex/Claude 的模型 ID，音频阶段使用百炼 API。用户已确认标准 CLI 不承担音频识别。

**架构：** 账号默认值、会话配置、任务快照分层保存。空文字模型表示使用服务端/CLI 默认值；自定义 ID 只作为子进程参数或供应商请求字段，不能改变程序路径、密钥和 API 基址。录音中的模型变更需暂停，沿用 config_version 使在途触发失效。旧数据库自动迁移，旧客户端继续可用。

**技术栈：** Node.js、SQLite、React、Electron、Codex app-server/exec、Claude stream-json、百炼 WebSocket。

1. 服务端（apps/server/src/app.mjs、db.mjs、worker.mjs、interviews.mjs、audio.mjs）：测试账号隔离、截图默认配置/覆盖、模型快照、暂停切换与每场 ASR 模型；实现 API 与迁移。
2. 执行适配（providers.mjs、text-providers.mjs、native-audio-providers.mjs、index.mjs）：先测试逐请求模型覆盖、同一 Codex 热进程不同题模型、百炼认证转发和显式用户配置加载；实现模型参数与显式音频模型允许列表。
3. 网页（apps/web/src）：截图默认配置和单次覆盖；面试 ASR 与文字模型分开，Codex/Claude 模型值独立保留；直接音频显示百炼 API；历史显示快照。构建并执行界面回归。
4. 客户端（apps/desktop）：默认跟随网页账号截图配置，离线任务固定模型；面试新会话读取完整默认值，支持单场选择。测试配置、传输与恢复。
5. 文档与集成：说明模型 ID/接口协议能力、CLI 用户认证与服务环境；执行 npm test、npm run build、浏览器与桌面相关集成测试；检查变更、提交并推送 main，更新 Windows 包。

**验证边界：** 协议夹具验证请求确实携带选定模型；真实百炼/Codex/Claude 质量、权限和首字延迟需要用户自己的服务凭据，不宣称已经实测。
