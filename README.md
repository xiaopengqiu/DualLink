# 双端互联 · Dual Link

下载客户端、完整源码包与编译后的网页：[v1.3.1 发布页面](https://github.com/xiaopengqiu/DualLink/releases/tag/v1.3.1)。编译产物通过 GitHub Releases 分发；Git 仓库保存源码，依赖通过 `npm ci` 安装。

自托管的 Windows → iPad 截图与实时语音问答工具。PC 快捷键截图或采集会议/麦克风声音，Linux 服务结合当前账号的 Prompt、知识库和会话历史生成回答，iPad 网页显示并保存结果。当前版本 **1.3.1**。

管理员可在网页「账号设置 → 模型与接口配置」为截图、转写问答、语音识别及音频直答分别配置模型、接口和 API Key；普通账号与设备直接继承，无权修改。

1.3 新增[按场景配置执行方式和模型](docs/MODEL_CONFIGURATION.md)：截图与面试各自保存 Codex/Claude 模型，语音识别与音频理解分别配置百炼 API 模型；每次任务保留模型快照。

新增：支持按账号配置音频直答／转写后回答，默认用 Ctrl+Alt+Enter 手动触发，详见 [双模式指南](docs/DUAL_MODES_GUIDE.md)。

## 包含的功能

- Windows 托盘客户端：配对码和二维码、全屏/框选截图、显示器选择、快捷键设置、待传队列、失败重试、可选开机启动。
- 平板网站：登录、实时截图与回答、手动上传、模型/Prompt 切换、分析/取消/重试、历史记录。
- 账号隔离：管理员创建账号、禁用账号、重置密码、每日任务限额；各账号独立管理设备、Prompt 和知识文件。
- 知识库：TXT、Markdown、PDF、DOCX 私有上传、文字提取与有预算的相关片段检索。
- 可靠传输：一次性配对、短期 WebSocket 票据、重连拉取、图片和任务幂等、同网 WebRTC 与云端回退。
- 持久化任务：SQLite 队列、重启恢复、执行超时、取消、错误反馈；真实 CLI 调用，不内置模拟回答。
- 实时语音：Windows 双轨采集、百炼流式识别、未定稿修订、自动/手动提问、流式建议、全场历史和导出；支持 Codex / Claude / 百炼文本模型。
- 面试上下文：本人实际发言与 AI 建议分开保存，相关知识、近期原文和更早相关摘录共同参与回答；断线本地缓存和独立补传。

## 本地启动

需要 Node.js **22.14 或更新版本**，以及能正常认证并处理图片的 Codex CLI 或 Claude Code。首次安装需要联网。

```powershell
npm ci
Copy-Item .env.example .env
npm run build
npm run admin -- --email you@example.com --name 管理员
npm start
```

管理员命令会通过终端读取密码，不提供默认账号密码。打开 `http://localhost:3000` 登录。另开终端启动客户端：

```powershell
npm run desktop
```

客户端云服务地址填 `http://localhost:3000`，然后在网站「设备」页输入客户端显示的配对码。支持公网 `http://IP:端口` 和 HTTPS。仅有公网 IP 时见 [HTTP 部署步骤](docs/HTTP_DEPLOYMENT.md)。

开发前端可另运行 `npm run dev:web`（Vite 代理 API 和 WebSocket 到本地 3000 端口）；此时把 `.env` 的 `PUBLIC_ORIGIN` 改为实际 Vite 地址（默认 `http://127.0.0.1:5173`），然后重启后端并通过该地址访问，以通过来源校验。后端热重载用 `npm run dev`。

## 打包 Windows 客户端

在 Windows x64 机器执行：

```powershell
npm run package:win
```

输出位于 `release/windows/`，包含安装版、免安装版和解包目录。安装包没有代码签名证书，Windows 可能显示未知发布者提示。可以配置自己的签名后重新打包。

## 部署阿里云 Linux

完整步骤见 [部署指南](docs/DEPLOYMENT.md)。推荐专用 Linux 服务账号＋systemd＋Caddy HTTPS。可复用服务器上已安装的 CLI，但须确认服务账号可以执行它们、读到自己的认证信息，并访问模型服务。

语音需额外配置服务端 `DASHSCOPE_API_KEY`、`DASHSCOPE_WORKSPACE_ID` 和匹配的地域；已有 CLI 不提供语音识别能力。配置和使用见 [实时语音指南](docs/VOICE_GUIDE.md)。

```bash
# 在已安装 Node.js 22.14+、Docker Engine 的服务器，进入源码目录：
sudo bash deploy/install.sh assistant.example.com docker
```

该脚本安装文件和 systemd 服务，**不会自动启动服务或修改现有反向代理**。按脚本提示配置认证、创建管理员、核对 HTTP 端口或配置 HTTPS 后启动。已有 CLI 的个人部署可将第二个参数改为 `native`。

## 验证和源码交付

```powershell
npm test
npm run build
npm run test:e2e
npm run test:desktop
npm run test:voice
npm run test:modes
npm run package:win
npm run release:source
```

自动化测试使用临时数据库和测试子进程验证流程，不消耗模型额度；真实云端 CLI 认证和实际 iPad Safari 仍需按部署指南验收。

更多说明：[使用指南](docs/USER_GUIDE.md)、[实时语音指南](docs/VOICE_GUIDE.md)、[部署指南](docs/DEPLOYMENT.md)、[接口契约](docs/CONTRACT.md)、[语音契约](docs/VOICE-CONTRACT.md)、[验证记录](docs/VERIFICATION.md)。
