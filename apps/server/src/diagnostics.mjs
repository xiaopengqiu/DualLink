import { spawn } from 'node:child_process';

function versionCheck(command, args, timeoutMs = 5000) {
  return new Promise(resolve => {
    let child, output = '', finished = false;
    const finish = result => { if (finished) return; finished = true; clearTimeout(timer); resolve(result); };
    const timer = setTimeout(() => { child?.kill(); finish({ available: false, error: '版本检查超时，请检查可执行文件是否可正常启动' }); }, timeoutMs);
    try { child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { finish({ available: false, error: '无法启动可执行文件' }); return; }
    child.stdout.on('data', bytes => { output = (output + bytes.toString()).slice(0, 2000); });
    child.on('error', error => finish({ available: false, error: error.code === 'ENOENT' ? '未找到可执行文件，请检查服务账号 PATH 或配置绝对路径' : '可执行文件无法启动，请检查权限' }));
    child.on('close', code => finish(code === 0 ? { available: true, version: output.match(/\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?/)?.[0] || '已安装（没有返回版本号）' } : { available: false, error: '版本检查失败，请检查安装、权限或镜像是否存在' }));
  });
}

export async function diagnose(options = {}) {
  const mode = options.mode || 'native'; const results = {};
  const uid = process.getuid?.() || 1000, gid = process.getgid?.() || 1000;
  await Promise.all(['codex', 'claude'].map(async provider => {
    results[provider] = mode === 'docker'
      ? await versionCheck(options.dockerBin || 'docker', ['run', '--rm', '--pull', 'never', '--user', `${uid}:${gid}`, '--network', 'none', '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m', '--tmpfs', `/home/ai:rw,nosuid,nodev,size=64m,uid=${uid},gid=${gid},mode=0700`, '--env', 'HOME=/home/ai', options.runnerImage || 'dual-link-ai:1.0.0', provider, '--version'])
      : await versionCheck(provider === 'codex' ? options.codexBin || 'codex' : options.claudeBin || 'claude', ['--version']);
  }));
  return { mode, providers: results, checkedAt: new Date().toISOString(), note: '仅检查程序版本；认证和模型可用性需提交真实截图验证。' };
}
