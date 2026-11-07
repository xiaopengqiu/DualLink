#!/usr/bin/env bash
# Run from the extracted source directory. Existing /etc/dual-link.env is kept.
set -euo pipefail
# sudo or an explicit env PATH may omit the system administration tools.
export PATH="${PATH:+$PATH:}/usr/local/sbin:/usr/sbin:/sbin"
umask 077
if [[ ${EUID} -ne 0 ]]; then
  printf '%s\n' '请使用 sudo bash deploy/install.sh http://公网IP:3000 [native|docker]'
  exit 1
fi
ADDRESS=${1:-}
CLI_MODE=${2:-docker}
if [[ "$CLI_MODE" != native && "$CLI_MODE" != docker ]]; then
  printf '%s\n' '第二个参数只能是 native 或 docker。'
  exit 1
fi
for command_name in node npm tar systemctl useradd runuser install id chown chmod; do
  command -v "$command_name" >/dev/null || { printf '缺少依赖：%s\n' "$command_name"; exit 1; }
done
node -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<14))process.exit(1)' || { printf '%s\n' '需要 Node.js 22.14 或更新版本。'; exit 1; }
if [[ "$CLI_MODE" == docker ]]; then
  command -v docker >/dev/null || { printf '%s\n' 'docker 模式需要先安装并启动 Docker Engine，见 docs/DEPLOYMENT.md。'; exit 1; }
  docker info >/dev/null
fi
SOURCE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
SETTINGS=$(node --input-type=module - "$SOURCE_DIR" "$ADDRESS" <<'NODE'
import { pathToFileURL } from 'node:url';
const {deploymentSettings}=await import(pathToFileURL(process.argv[2]+'/apps/server/src/service-config.mjs'));
try { const c=deploymentSettings(process.argv[3]); console.log([c.origin,c.host,c.port,c.secureCookies,c.trustProxy].join('\n')); }
catch(e) { console.error(e.message);process.exit(1); }
NODE
) || exit 1
mapfile -t VALUES <<< "$SETTINGS"
SERVICE_ORIGIN=${VALUES[0]}
SERVICE_HOST=${VALUES[1]}
SERVICE_PORT=${VALUES[2]}
SERVICE_SECURE=${VALUES[3]}
SERVICE_PROXY=${VALUES[4]}
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
HOST=$SERVICE_HOST
PORT=$SERVICE_PORT
PUBLIC_ORIGIN=$SERVICE_ORIGIN
DATA_DIR=/var/lib/dual-link/data
SECURE_COOKIES=$SERVICE_SECURE
TRUST_PROXY=$SERVICE_PROXY
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
INTERVIEW_DEFAULT_MODE=transcript
INTERVIEW_AUDIO_WINDOW_SECONDS=120
INTERVIEW_CODEX_TRANSPORT=app-server
INTERVIEW_REASONING_EFFORT=low
INTERVIEW_TEXT_MODEL=qwen-flash
INTERVIEW_MAX_OUTPUT_TOKENS=1800
# INTERVIEW_TEXT_API_KEY=
# INTERVIEW_TEXT_BASE_URL=https://YOUR_WORKSPACE.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
OMNI_MODEL=qwen3.8-omni-flash-realtime
# Optional independent native audio credentials; default uses DASHSCOPE variables.
# OMNI_API_KEY=
# OMNI_WORKSPACE_ID=
# OMNI_REGION=cn-beijing
# OMNI_MODELS=qwen3.8-omni-flash-realtime,qwen3.5-omni-flash-realtime
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
printf '%s\n' '3. 按 docs/DEPLOYMENT.md 配置对应端口的安全组；HTTPS 模式再配置代理。'
printf '%s\n' '4. sudo systemctl start dual-link'

printf "服务地址：%s\n已有配置保留，请核对 HOST/PORT/PUBLIC_ORIGIN/SECURE_COOKIES/TRUST_PROXY。\n" "$SERVICE_ORIGIN"
