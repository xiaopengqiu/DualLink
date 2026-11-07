import { spawn } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

export class ProviderError extends Error {
  constructor(code, message) { super(message); this.name = 'ProviderError'; this.code = code; }
}

const allowedEnv = /^(PATH|Path|PATHEXT|SystemRoot|WINDIR|COMSPEC|HOME|USERPROFILE|TEMP|TMP|LANG|LC_ALL|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|http_proxy|https_proxy|all_proxy|no_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|OPENAI_API_KEY|OPENAI_BASE_URL|CODEX_API_KEY|CODEX_HOME|ANTHROPIC_API_KEY|ANTHROPIC_BASE_URL|ANTHROPIC_MODEL|CLAUDE_CONFIG_DIR|CLAUDE_CODE_OAUTH_TOKEN|AWS_REGION|AWS_DEFAULT_REGION|AWS_PROFILE|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|GOOGLE_APPLICATION_CREDENTIALS|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|CLAUDE_CODE_USE_FOUNDRY)$/;
function environment(options) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowedEnv.test(key)));
  Object.assign(env, options.extraEnv || {});
  if (options.codexHome) env.CODEX_HOME = options.codexHome;
  if (options.claudeHome) env.CLAUDE_CONFIG_DIR = options.claudeHome;
  env.NO_COLOR = '1';
  env.CLAUDE_CODE_SKIP_PROMPT_HISTORY = '1';
  return env;
}

function redact(value, env) {
  let result = String(value).replace(/\u001b\[[0-9;]*m/g, '');
  for (const [key, secret] of Object.entries(env)) {
    if (/(KEY|TOKEN|SECRET|PASSWORD)/i.test(key) && secret && secret.length > 3) result = result.split(secret).join('[redacted]');
  }
  return result.replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+[^\s]+)/g, '[redacted]').slice(0, 1200);
}

async function validateInput(input) {
  if (!['codex', 'claude'].includes(input.provider)) throw new ProviderError('INVALID_PROVIDER', '不支持的模型提供方 provider');
  if (typeof input.prompt !== 'string' || input.prompt.length > 160000) throw new ProviderError('INVALID_PROMPT', '提示词为空或超过限制');
  const job = await realpath(input.jobDir);
  if (input.imagePath === undefined || input.imagePath === null) return { job, image: null, bytes: null };
  const image = await realpath(input.imagePath).catch(() => path.resolve(input.imagePath));
  const relative = path.relative(job, image);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new ProviderError('INVALID_IMAGE_PATH', '图片必须位于当前任务目录内 (outside job rejected)');
  const bytes = await readFile(image);
  if (bytes.length > 12 * 1024 * 1024) throw new ProviderError('IMAGE_TOO_LARGE', '截图不能超过 12 MiB');
  return { job, image, bytes };
}

/** Builds arguments without a shell. Only server-controlled options select an executable. */
export async function buildInvocation(options = {}, input) {
  const { job, image, bytes } = await validateInput(input);
  const docker = options.mode === 'docker';
  const provider = input.provider;
  const imageArgument = image ? (docker ? `/job/${path.basename(image)}` : image) : null;
  let args;
  let stdin;
  if (provider === 'codex') {
    if (options.codexAppServer) {
      args = ['app-server', '--disable', 'shell_tool', '--disable', 'hooks', '--disable', 'plugins', '--disable', 'remote_plugin', '--disable', 'shell_snapshot'];
      stdin = '';
    } else {
      args = ['exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '--json', '--cd', docker ? '/job' : job];
      if (!options.codexLoadUserConfig) args.push('--ignore-user-config', '--ignore-rules');
      if (options.codexModel) args.push('--model', options.codexModel);
      if (image) args.push('--image', imageArgument);
      args.push('-'); stdin = input.prompt;
    }
  } else {
    args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', ''];
    if (options.claudeSafeMode !== false) args.push('--safe-mode');
    if (options.claudeBare) args.push('--bare');
    if (options.claudeModel) args.push('--model', options.claudeModel);
    const lower = image?.toLowerCase() || '';
    const mediaType = lower.endsWith('.jpg') || lower.endsWith('.jpeg') ? 'image/jpeg' : lower.endsWith('.webp') ? 'image/webp' : 'image/png';
    const content = [{ type: 'text', text: input.prompt }];
    if (image) content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: bytes.toString('base64') } });
    stdin = `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`;
  }
  const env = environment(options);
  if (!docker) return { command: provider === 'codex' ? options.codexBin || 'codex' : options.claudeBin || 'claude', args: [...(provider === 'codex' ? options.codexPrefixArgs || [] : options.claudePrefixArgs || []), ...args], cwd: job, stdin, env };

  const containerName = `dual-link-${randomUUID()}`;
  const uid = process.getuid?.() || 1000;
  const gid = process.getgid?.() || 1000;
  const dockerArgs = ['run', '--rm', '--init', '-i', '--name', containerName, '--user', `${uid}:${gid}`, '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=96', '--memory', options.memoryLimit || '1g', '--cpus', String(options.cpuLimit || 1), '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m', '--tmpfs', `/home/ai:rw,nosuid,nodev,size=64m,uid=${uid},gid=${gid},mode=0700`, '--workdir', '/job', '--mount', `type=bind,source=${job},target=/job,readonly`, '--env', 'HOME=/home/ai'];
  dockerArgs.push('--env', `DUALLINK_CODEX_LOAD_CONFIG=${options.codexLoadUserConfig ? '1' : '0'}`);
  // Credentials are optional explicit mounts; never mount the application data root.
  if (options.codexHome) dockerArgs.push('--mount', `type=bind,source=${path.resolve(options.codexHome)},target=/credentials/codex,readonly`);
  if (options.claudeHome) dockerArgs.push('--mount', `type=bind,source=${path.resolve(options.claudeHome)},target=/credentials/claude,readonly`);
  for (const key of Object.keys(env)) {
    if (/^(OPENAI_|CODEX_API_KEY|ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|NODE_EXTRA_CA_CERTS)/.test(key)) dockerArgs.push('--env', key);
  }
  dockerArgs.push(options.runnerImage || 'dual-link-ai:1.0.0', provider, ...args);
  return { command: options.dockerBin || 'docker', args: dockerArgs, cwd: job, stdin, env, containerName };
}

export function createCliRunner(options = {}) {
  return async function run(input) {
    if (input.signal?.aborted) throw new ProviderError('AI_CANCELLED', '任务已取消');
    const invocation = await buildInvocation(options, input);
    if (input.signal?.aborted) throw new ProviderError('AI_CANCELLED', '任务已取消');
    return new Promise((resolve, reject) => {
      let child;
      let timeout;
      let forceKill;
      let failure;
      let settled = false;
      let totalBytes = 0;
      let line = '';
      let stderr = '';
      let answer = '';
      let partial = '';
      let usage;
      const decoder = new StringDecoder('utf8');
      const fail = (code, message) => {
        if (failure) return;
        failure = new ProviderError(code, message);
        if (invocation.containerName) {
          const cleanup = spawn(invocation.command, ['rm', '-f', invocation.containerName], { stdio: 'ignore', windowsHide: true, env: invocation.env });
          cleanup.on('error', () => {});
        }
        if (child?.pid) {
          try { process.platform === 'win32' ? child.kill() : process.kill(-child.pid, 'SIGTERM'); } catch {}
          forceKill = setTimeout(() => {
            try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL'); } catch {}
          }, 800);
          forceKill.unref();
        }
      };
      const abort = () => fail('AI_CANCELLED', '任务已取消');
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(forceKill);
        input.signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve(result);
      };
      const emitDelta = delta => {
        if (typeof delta !== 'string' || !delta) return;
        partial += delta;
        try { input.onDelta?.(delta); } catch { fail('AI_CALLBACK_FAILED', '无法保存回答进度'); }
      };
      const event = value => {
        if (!value || typeof value !== 'object') return;
        if (input.provider === 'codex') {
          if (value.type === 'item.completed' && value.item?.type === 'agent_message' && value.item.phase !== 'commentary' && typeof value.item.text === 'string') answer = value.item.text;
          if (value.type === 'turn.completed') usage = value.usage;
          if (value.type === 'turn.failed' || value.type === 'error') fail('AI_PROCESS_FAILED', redact(value.error?.message || value.message || 'Codex 执行失败', invocation.env));
        } else {
          if (value.type === 'stream_event' && value.event?.type === 'content_block_delta' && value.event.delta?.type === 'text_delta') emitDelta(value.event.delta.text);
          if (value.type === 'assistant') {
            const text = value.message?.content?.filter(x => x.type === 'text').map(x => x.text || '').join('');
            if (text) answer = text;
          }
          if (value.type === 'result') {
            usage = value.usage;
            if (value.is_error || (value.subtype && value.subtype !== 'success')) fail('AI_PROCESS_FAILED', redact(value.result || value.errors?.join('; ') || 'Claude 执行失败', invocation.env));
            else if (typeof value.result === 'string') answer = value.result;
          }
        }
      };
      const parseLine = raw => {
        if (!raw.trim()) return;
        try { event(JSON.parse(raw)); } catch (error) { if (!(error instanceof SyntaxError)) fail('AI_INVALID_OUTPUT', '模型事件格式错误'); }
      };
      try {
        child = spawn(invocation.command, invocation.args, { cwd: invocation.cwd, env: invocation.env, windowsHide: true, detached: process.platform !== 'win32', shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (error) { finish(new ProviderError('AI_START_FAILED', redact(error.message, invocation.env))); return; }
      child.on('error', error => finish(new ProviderError(error.code === 'ENOENT' ? 'AI_CLI_NOT_FOUND' : 'AI_START_FAILED', error.code === 'ENOENT' ? `找不到 ${input.provider} 可执行文件，请检查服务账号的 PATH 和 CLI 配置` : redact(error.message, invocation.env))));
      child.stdout.on('data', bytes => {
        totalBytes += bytes.length;
        if (totalBytes > (options.maxOutputBytes || 8 * 1024 * 1024)) { fail('AI_OUTPUT_LIMIT', '模型输出超过限制'); return; }
        line += decoder.write(bytes);
        let newline;
        while ((newline = line.indexOf('\n')) !== -1) { parseLine(line.slice(0, newline)); line = line.slice(newline + 1); }
      });
      child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString('utf8')).slice(-16000); });
      child.stdin.on('error', () => {}); // An early CLI exit may close stdin before the prompt is written.
      child.on('close', code => {
        line += decoder.end();
        if (line) parseLine(line);
        if (failure) { finish(failure); return; }
        if (code !== 0) { finish(new ProviderError('AI_PROCESS_FAILED', `${input.provider} 执行失败 (${code})：${redact(stderr || '请检查认证、模型名称和网络连接', invocation.env)}`)); return; }
        const text = answer || partial;
        if (!text.trim()) { finish(new ProviderError('AI_EMPTY_OUTPUT', '模型没有返回回答，请检查 CLI 版本和认证状态')); return; }
        if (input.provider === 'codex' && !partial) { try { input.onDelta?.(text); } catch { finish(new ProviderError('AI_CALLBACK_FAILED', '无法保存回答进度')); return; } }
        finish(null, { answer: text, ...(usage ? { usage } : {}) });
      });
      input.signal?.addEventListener('abort', abort, { once: true });
      timeout = setTimeout(() => fail('AI_TIMEOUT', '模型处理超时，请稍后重试'), options.timeoutMs || 180000);
      child.stdin.end(invocation.stdin);
    });
  };
}
