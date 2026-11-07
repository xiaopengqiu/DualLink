# 公网 IP + HTTP + 端口部署（1.1.1）

支持直接填写 `http://公网IP:端口`。不需要域名、证书或 Caddy。HTTP 不提供 TLS 加密，登录凭据、截图和音频会经过明文连接；HTTPS 仍可选。

以 `203.0.113.8` 和端口 `3000` 为示例，执行时换成自己的公网 IP。使用 admin 用户和 sudo 即可，后台仍以 duallink 用户运行。

```bash
cd /opt/dual-link-src/DualLink
sudo git fetch origin --tags
sudo git checkout v1.2.0
sudo bash deploy/install.sh http://203.0.113.8:3000 native
```

首次安装自动生成下面这些配置。升级会保留已有环境文件，必须手动核对：

```bash
sudoedit /etc/dual-link.env
```

```ini
HOST=0.0.0.0
PORT=3000
PUBLIC_ORIGIN=http://203.0.113.8:3000
SECURE_COOKIES=false
TRUST_PROXY=0
CLI_MODE=native
```

PUBLIC_ORIGIN 必须与 PC/iPad 实际访问地址一致，包括协议和端口，不包含路径。不要填写服务器的内网 IP。阿里云公网 IP 通过 NAT 映射时，HOST 仍填 0.0.0.0，不直接绑定公网 IP。IPv6 直连时脚本使用 `::`。

在阿里云安全组及已启用的系统防火墙中开放 TCP 3000（或你选择的端口）。直接访问此端口不需要开放 80/443。建议使用 1024 以上的空闲端口；若选择低端口，需额外为 systemd 配置绑定权限。

按 [部署指南](DEPLOYMENT.md) 为 duallink 配置 Codex/Claude 程序路径和认证，按 [语音指南](VOICE_GUIDE.md) 填写百炼 Key、业务空间 ID 和地域。这些步骤与 HTTP/HTTPS 无关。

首次创建管理员（已有管理员则跳过）：

```bash
sudo -u duallink -H node --env-file=/etc/dual-link.env \
  /opt/dual-link/apps/server/src/admin.mjs \
  --email you@example.com --name 管理员
sudo systemctl restart dual-link
sudo systemctl status dual-link --no-pager
curl -fsS http://127.0.0.1:3000/api/health
```

然后 iPad 浏览器和 1.2.0 PC 客户端均填写 `http://203.0.113.8:3000`，登录、配对并测试截图及语音。HTTP 自动使用 `ws://` 进行实时同步和语音上传。语音从 PC 本地采集，不需要网页申请麦克风权限。部分浏览器在公网 HTTP 下限制 WebRTC 或剪贴板，截图会走云端上传，回答可以手动选择复制。

排查连接：

```bash
sudo ss -lntp | grep ':3000'
sudo journalctl -u dual-link -n 100 --no-pager
```

若服务器健康检查正常但外部打不开，核对公网 IP、端口、安全组和防火墙。若登录后立刻退出，核对 SECURE_COOKIES=false；若报来源错误，核对 PUBLIC_ORIGIN 是否与实际访问地址完全一致。
