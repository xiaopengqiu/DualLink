# 阿里云 Linux 部署指南

仅有公网 IP 时，按 [HTTP + IP + 端口部署](HTTP_DEPLOYMENT.md) 操作；下文为可选 HTTPS 域名方案。1.1.1 起安装脚本支持完整 http(s) 服务地址。

适用单台 Linux ECS/VPS。推荐 Ubuntu 22.04/24.04 或 Debian 12，Node.js 22.14+，可用域名。数据保存在服务器磁盘，不需要额外购买数据库。使用 Docker 时需要给任务容器留出内存；先以并发 1 验收再调整。

## 1. 准备域名和网络

1. 将域名 A/AAAA 记录解析到服务器公网地址；只配置实际可用的地址。
2. 阿里云安全组开放 TCP 80、443；SSH 端口限制为你的管理来源。不要把应用的 3000 端口直接开放到公网。
3. 在服务器按实际部署地区和域名要求完成必要的域名配置。确认服务器能够访问你所用的模型服务，且 CLI 能成功认证。
4. 安装 Node.js 22.14+（[Node.js 官方下载](https://nodejs.org/en/download)）、[Docker Engine](https://docs.docker.com/engine/install/) 和 [Caddy](https://caddyserver.com/docs/install)。如果只供自己使用且要直接复用宿主机 CLI，可先不用 Docker。

```bash
node --version
npm --version
docker version
```

## 2. 上传源码并安装

上传 `release/DualLink-source-1.5.3.zip`，解压到临时目录，在源码根目录运行：

```bash
sudo bash deploy/install.sh assistant.example.com docker
```

脚本会：创建 `duallink` 服务用户；复制应用到 `/opt/dual-link`；安装锁定依赖、构建网页；准备 `/var/lib/dual-link/data`；构建独立任务镜像 `dual-link-ai:1.0.0`；安装 `dual-link.service`；首次生成 `/etc/dual-link.env`。已有配置保留，服务不自动启动。

个人部署可选：

```bash
sudo bash deploy/install.sh assistant.example.com native
```

`native` 直接运行服务账号下的 CLI，适合个人受信任使用。多账号服务建议 `docker`，每次只挂载当前任务目录，避免 AI 读取别人的资料。宿主机服务用户加入 Docker 组具有高权限，勿将该账号提供给普通网站用户。

## 3. 配置模型认证

管理员可在网站「账号设置 → 模型与接口配置」统一配置各模式的模型、API Key、接口及百炼业务空间和地域，所有普通账号自动继承。未在网页填写的项目继续使用服务器环境或服务账号 CLI 登录。网页密钥加密存入数据目录，备份时须连同 `DATA_DIR/.ai-settings.key` 一起保留。

基础部署及可选的服务器默认配置：

```bash
sudoedit /etc/dual-link.env
```

关键项目：

```ini
HOST=127.0.0.1
PORT=3000
PUBLIC_ORIGIN=https://assistant.example.com
DATA_DIR=/var/lib/dual-link/data
SECURE_COOKIES=true
TRUST_PROXY=1
CLI_MODE=docker
AI_RUNNER_IMAGE=dual-link-ai:1.0.0
WORKER_CONCURRENCY=1
AI_TIMEOUT_MS=180000
DEFAULT_PROVIDER=codex
```

推荐通过服务端 API 凭据认证，例如按需设置 `CODEX_API_KEY` / `OPENAI_API_KEY` 和 `ANTHROPIC_API_KEY`。未配置的模型仍可显示在选择列表中，但调用会返回明确错误；先选已配置成功的一种。凭据仅保存在服务器环境文件中，不出现在网页、安装包和源码归档里。

**已有 CLI 不等于服务账号已登录。** 例如你原来用 root 登录 Codex，`duallink` 不会自动拥有 root 的登录状态。不要把整个 root 家目录挂进应用或任务容器。

### native 模式复用现有安装

确认 Node 和 CLI 安装在服务可见的系统路径，并写完整路径：

```ini
CODEX_BIN=/usr/local/bin/codex
CLAUDE_BIN=/usr/local/bin/claude
CODEX_HOME=/var/lib/dual-link/.codex
CLAUDE_CONFIG_DIR=/var/lib/dual-link/.claude
```

systemd 配置中的 `ProtectHome=true` 会隐藏 `/home` 和 `/root`。如果现有 Node 或 CLI 位于这些目录（包括 nvm 安装），仅填写绝对路径仍无法执行；应在 `/usr/local` 等系统路径重新安装可供服务账号使用的版本。不要放宽家目录权限。以专用账号完成官方 CLI 认证：

```bash
sudo -u duallink -H /usr/local/bin/codex login
sudo -u duallink -H /usr/local/bin/claude auth login
```

认证过程按 CLI 提示操作。也可以直接使用环境变量提供的 API 凭据，无需交互登录。Claude 默认使用安全模式并关闭内建工具和 MCP；旧版本不认识参数时应升级。任务镜像锁定 Codex `0.167.0`、Claude Code `2.1.319`。

Claude CLI 已连接兼容的第三方供应商时，优先把它实际依赖的服务端变量写入 `/etc/dual-link.env`：`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL`、可选的 `ANTHROPIC_MODEL` 及 `ANTHROPIC_DEFAULT_HAIKU_MODEL` / `SONNET` / `OPUS` 映射。不要打印真实值，也不要提交环境文件。`CLAUDE_MODEL` 或账号/会话选择的模型会作为 `--model` 显式覆盖供应商默认映射；留空才使用 CLI 默认。

默认 `CLAUDE_LOAD_USER_CONFIG=false`，因此不会加载项目设置。确需复用经过审查的服务账号 Claude 用户设置时才改为 `true`；只复制必要配置到 `/var/lib/dual-link/.claude`，不要挂载完整个人家目录、不要放宽 `ProtectHome`，也不要传入 `CLAUDE_CODE_SUBAGENT_MODEL`。任务仍使用空工具、严格空 MCP、无会话持久化和安全模式。变量存在只说明配置已读取，最终必须以 `duallink` 身份发起一次真实纯文本请求，才能验证端点、认证和模型名均有效。

`CODEX_LOAD_USER_CONFIG=false` 默认忽略用户自定义 Codex 配置和规则，只执行受控问答。若你依赖已有配置中的自定义提供方，可显式设为 `true`，并审查所加载配置；API 基址等环境配置也必须在服务账号下验证。模型名称可用 `CODEX_MODEL` / `CLAUDE_MODEL` 指定，留空使用 CLI 默认。

如现有 CLI 过旧，可按官方 npm 包在系统路径安装本项目验证的版本：`npm install --global @openai/codex@0.167.0 @anthropic-ai/claude-code@2.1.319`。升级后应重新验证认证和带图调用。

### docker 模式的凭据

API 环境凭据会按白名单传入任务容器。也支持把指定的 `CODEX_HOME` / `CLAUDE_CONFIG_DIR` 只读挂载为凭据来源；入口脚本只复制认证/配置文件到容器临时内存家目录。CLI 的缓存和写入在任务结束后消失，用户知识库根目录不会被挂载。

如果只使用 API key，可去掉未创建的认证目录变量。使用登录凭据时先创建对应目录并确保归属 `duallink`。临时容器内刷新的登录凭据不会写回宿主机，因此长期无人值守服务更适合可轮换的 API 凭据。

网站的账号与 AI 供应商账号是两层。若向其他用户提供 Claude 服务，请采用其官方允许的 API 认证方式；不要将个人 claude.ai 订阅做成多人共享额度池。[Claude 官方说明](https://code.claude.com/docs/en/agent-sdk/overview)

### 实时语音与1.2双模式配置

音频直答模型、后台转写开关及账号默认配置见 [双模式指南](DUAL_MODES_GUIDE.md)。首次使用请给百炼Key开通音频模型权限；音频直答不复用 Codex/Claude 登录。

语音识别额外使用百炼流式服务，密钥不下发到客户端。将 `DASHSCOPE_API_KEY`、`DASHSCOPE_WORKSPACE_ID` 和匹配的 `ASR_REGION` 写入 `/etc/dual-link.env`。完整模板、回答模型选项、热进程与保留策略见 [实时语音指南](VOICE_GUIDE.md)。旧配置文件升级时会保留，须手动加入语音项。原始音频默认保留 7 天；数据库历史另行保存。

Codex 面试热进程的临时任务位于 `DATA_DIR/jobs/warm`，以便独立 Docker 任务能挂载到；仍只挂载当前运行目录。截图任务不复用面试进程。

## 4. 创建管理员

```bash
sudo -u duallink -H node --env-file=/etc/dual-link.env \
  /opt/dual-link/apps/server/src/admin.mjs \
  --email you@example.com --name 管理员
```

按终端提示输入密码。无默认账号、无公开注册入口。登录后在网站「账号管理」中创建其他用户。自动化环境可临时设置 `DUALLINK_ADMIN_PASSWORD`，创建后立即移除；不要长期放在服务配置或命令参数中。

忘记管理员密码时，运行同一条命令并增加 `--reset-password`，重新输入新密码；相关登录和设备配对会被撤销，需要重新登录、配对。

## 5. 配置 HTTPS

如果服务器已有 Nginx/Caddy，添加一个域名的反向代理到 `127.0.0.1:3000`，保留 WebSocket Upgrade。若使用 Caddy，将以下内容合并进 `/etc/caddy/Caddyfile`，不要覆盖已有站点：

```caddy
assistant.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3000
}
```

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo systemctl start dual-link
sudo systemctl status dual-link --no-pager
curl -fsS http://127.0.0.1:3000/api/health
```

Caddy 在域名解析正确、80/443 可达的条件下自动管理证书，并代理 WebSocket。[自动 HTTPS](https://caddyserver.com/docs/automatic-https)、[反向代理](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)

## 6. 验收

1. iPad 打开 `https://assistant.example.com` 登录，确认无证书错误。
2. Windows 安装客户端，服务地址填同一个 HTTPS 地址。客户端产生配对码；在 iPad「设备」页批准。
3. 在「Prompt」修改回答风格；上传一份包含特定内容的 TXT/MD 知识文件。
4. PC 截图，确认 iPad 出现图片、任务状态和真实模型回答，参考资料来源可查看。
5. 切换 Codex / Claude 分别测试。失败时查看网站错误和 `journalctl -u dual-link -n 100 --no-pager`；核对服务用户认证、模型名称和网络。
6. iPad 锁屏后再截图，稍后打开网站确认云端结果仍保留。
7. 同一 Wi-Fi 测试局域网优先；断开直连或切换网络，确认自动回退云端。公网 IP 相同不能证明直连可用。
8. 创建第二个账号，确认无法查看第一个账号的截图、设备、Prompt 和知识文件。
9. 配置语音后在客户端开始测试录音，确认会议/本人两轨、实时建议、暂停继续、尾句、断线补传和全场导出。按 [语音验收步骤](VOICE_GUIDE.md#上线验收) 测量真实设备和模型延迟。

## 7. 备份、升级和恢复

简单一致备份：短暂停服务后，把整个数据目录和环境配置备份到你控制的安全位置。

```bash
sudo systemctl stop dual-link
sudo tar -czf /root/dual-link-backup-$(date +%Y%m%d-%H%M%S).tar.gz \
  /var/lib/dual-link/data /etc/dual-link.env
sudo systemctl start dual-link
```

备份包含截图、知识库、账号数据库、面试记录/音频和密钥，必须妥善保管。恢复时停止服务，恢复到相同位置并将数据归属设为 `duallink:duallink` 后再启动。

升级前先备份，停止服务，从新源码执行安装脚本（配置保留），再启动并验收。若更换 AI CLI 版本，修改 `deploy/ai-runner.Dockerfile` 中版本号并重新构建镜像。勿在应用运行中只复制 SQLite 主文件而漏掉 WAL。

## 可选：Docker Compose 个人部署

源码根目录准备 `.env`，至少设置生产 `PUBLIC_ORIGIN`、`SECURE_COOKIES=true`、`TRUST_PROXY=1` 和模型 API 凭据。Compose 的应用容器自带两个 CLI，使用持久数据卷，宿主机仍由 Caddy 代理。

```bash
docker compose -f deploy/compose.yaml up -d --build
docker compose -f deploy/compose.yaml exec app node apps/server/src/admin.mjs --email you@example.com --name 管理员
```

此配置将 API 和 AI Worker 放在同一个容器中，属于个人简化方案。它不会继承宿主机已安装 CLI 的登录状态；多用户隔离推荐上面的 systemd＋独立任务容器方案。
