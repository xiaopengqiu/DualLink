#!/usr/bin/env bash
# Run from the extracted source directory. Existing /etc/dual-link.env is kept.
set -euo pipefail
umask 077
if [[ ${EUID} -ne 0 ]]; then
  printf '%s\n' '请使用 sudo bash deploy/install.sh your-domain.example [native|docker]'
  exit 1
fi
DOMAIN=${1:-}
CLI_MODE=${2:-docker}
if [[ ! "$DOMAIN" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]]; then
  printf '%s\n' '请提供已解析到此服务器的域名，例如 assistant.example.com。'
  exit 1
fi
if [[ "$CLI_MODE" != native && "$CLI_MODE" != docker ]]; then
  printf '%s\n' '第二个参数只能是 native 或 docker。'
  exit 1
fi
for command_name in node npm tar systemctl; do
  command -v "$command_name" >/dev/null || { printf '缺少依赖：%s\n' "$command_name"; exit 1; }
done
node -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<14))process.exit(1)' || { printf '%s\n' '需要 Node.js 22.14 或更新版本。'; exit 1; }
if [[ "$CLI_MODE" == docker ]]; then
  command -v docker >/dev/null || { printf '%s\n' 'docker 模式需要先安装并启动 Docker Engine，见 docs/DEPLOYMENT.md。'; exit 1; }
  docker info >/dev/null
fi
SOURCE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
APP_DIR=/opt/dual-link
id duallink >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/dual-link --shell /bin/bash duallink
install -d -m 750 -o duallink -g duallink "$APP_DIR" /var/lib/dual-link/data
install -d -m 700 -o duallink -g duallink /var/lib/dual-link/.codex /var/lib/dual-link/.claude
if [[ "$SOURCE_DIR" != "$APP_DIR" ]]; then
  tar --exclude='./node_modules' --exclude='*/node_modules' --exclude='./release' --exclude='./.git' --exclude='./data' --exclude='./.local' --exclude='./.env' -C "$SOURCE_DIR" -cf - . | tar -C "$APP_DIR" -xf -
fi
chown -R duallink:duallink "$APP_DIR"
cd "$APP_DIR"
runuser -u duallink -- env HOME=/var/lib/dual-link ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
runuser -u duallink -- env HOME=/var/lib/dual-link npm run build
if [[ "$CLI_MODE" == docker ]]; then
  usermod -aG docker duallink
  docker build -f deploy/ai-runner.Dockerfile -t dual-link-ai:1.0.0 .
fi
if [[ ! -f /etc/dual-link.env ]]; then
  cat > /etc/dual-link.env <<EOF
HOST=127.0.0.1
PORT=3000
PUBLIC_ORIGIN=https://$DOMAIN
DATA_DIR=/var/lib/dual-link/data
SECURE_COOKIES=true
TRUST_PROXY=1
DEFAULT_PROVIDER=codex
WORKER_CONCURRENCY=1
AI_TIMEOUT_MS=180000
CLI_MODE=$CLI_MODE
CODEX_BIN=codex
CLAUDE_BIN=claude
CODEX_HOME=/var/lib/dual-link/.codex
CLAUDE_CONFIG_DIR=/var/lib/dual-link/.claude
CODEX_LOAD_USER_CONFIG=false
CLAUDE_SAFE_MODE=true
AI_RUNNER_IMAGE=dual-link-ai:1.0.0
# Enable voice with a key and workspace from the same Model Studio region.
# DASHSCOPE_API_KEY=
# DASHSCOPE_WORKSPACE_ID=
ASR_REGION=cn-beijing
ASR_MODEL=qwen-audio-3.1-asr-flash-streaming
ASR_MAX_SESSION_MINUTES=120
ASR_DAILY_MINUTES=480
AUDIO_RETENTION_DAYS=7
AUDIO_MAX_USER_BYTES=536870912
INTERVIEW_AI_TIMEOUT_MS=90000
INTERVIEW_CONTEXT_CHARS=40000
INTERVIEW_AUTO_DEBOUNCE_MS=800
INTERVIEW_DEFAULT_PROVIDER=codex
INTERVIEW_CODEX_TRANSPORT=app-server
INTERVIEW_REASONING_EFFORT=low
INTERVIEW_TEXT_MODEL=qwen-flash
INTERVIEW_MAX_OUTPUT_TOKENS=1800
# INTERVIEW_TEXT_API_KEY=
# INTERVIEW_TEXT_BASE_URL=https://YOUR_WORKSPACE.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
EOF
  chmod 640 /etc/dual-link.env
  chown root:duallink /etc/dual-link.env
fi
install -m 644 deploy/dual-link.service /etc/systemd/system/dual-link.service
systemctl daemon-reload
systemctl enable dual-link
printf '\n%s\n' '应用已安装，尚未启动。请依次完成：'
printf '%s\n' '1. 编辑 /etc/dual-link.env 配置 AI 凭据，或为 duallink 用户登录 CLI。'
printf '%s\n' '2. 创建管理员：sudo -u duallink -H node --env-file=/etc/dual-link.env /opt/dual-link/apps/server/src/admin.mjs --email YOUR_EMAIL --name 管理员'
printf '%s\n' '3. 按 docs/DEPLOYMENT.md 配置 Caddy HTTPS 和阿里云安全组。'
printf '%s\n' '4. sudo systemctl start dual-link'
