# 客户端一键升级（1.4.0 起）

## 使用

1. 在 Windows 客户端打开「偏好设置 → 客户端更新」。
2. 点击「一键升级」，客户端检查新版、下载并校验，空闲时安装并重启。也可以分别使用「检查更新」「下载更新」。
3. 若有面试、截图或音频回补任务，一键升级只下载，不会中断任务。结束并保存面试、等待上传完成后，点击「安装并重启」。
4. 安装版运行新版安装程序；便携版退出后替换原 EXE，再启动新版。

「启动时检查更新」默认开启，只检查一次，不自动下载或安装。可以在偏好设置关闭。不支持的开发模式只显示说明，不能执行安装。检查或下载失败时会显示错误，可联网后重试；不会执行校验失败的文件。

配对、快捷键、模型偏好和本地缓存保存在用户数据目录，升级不删除这些数据。便携版保留原文件名，并在同目录保留 `.duallink-update-*.previous.exe` 备份；替换/启动失败时帮助进程尝试恢复旧版。目录不可写、磁盘不足或帮助进程不能启动时，当前客户端继续运行。已退出后帮助进程失败，可在用户数据的 `updates/install-*/status.json` 查看结果，必要时将备份恢复为原文件名再启动。

1.3.x 及更早客户端没有更新入口，需要手动下载并安装最新1.5.2一次，以后即可在客户端升级。1.4.1增加系统代理支持；1.4.0若遇到GitHub下载超时，可手动安装最新版。云端服务和iPad网页不由PC升级器部署；1.5.2多图问答应先按[升级步骤](SCREENSHOT_BATCHES.md)更新服务器，再升级PC并刷新iPad网页。

## 下载来源与校验

升级器固定访问公开仓库 `xiaopengqiu/DualLink` 的 GitHub Releases，只接受稳定版本，不降级。安装版和便携版分别下载匹配的 Windows x64 EXE，使用同一版本的 SHA256SUMS 文件验证大小与摘要，安装前再次校验。云服务地址和网页不能修改升级下载源。

1.4.1起通过Electron原生网络栈读取系统代理，逐跳检查GitHub/CDN重定向；不需要在网页填写代理或密钥。

服务器支持 HTTP + 公网IP + 端口，这与客户端升级下载的 HTTPS 连接独立。客户端电脑必须能访问 GitHub API、GitHub Releases 及其下载CDN；GitHub不可达或访问频率受限时，请稍后重试或从发布页手动下载安装。当前安装包未配置 Windows 代码签名；SHA-256用于完整性检查，不等同于独立的发布者数字签名。

## 发布新版本

统一更新根目录、三个工作区 package.json 和 package-lock.json 的版本。Windows构建环境执行：

构建机需要 .NET Framework 自带的 `csc.exe`，`prepackage:win` 会编译无窗口升级启动器并加入安装包；终端用户无需编译器。Linux云端只部署服务和网页，不执行这个Windows打包步骤。

```bash
npm ci
npm run build
npm run package:win
npm run release:assets
```

`release:assets` 打包源码与编译网页，并为四个文件生成 `release/SHA256SUMS-版本.txt`。GitHub Releases 应使用 `v版本` 标签，取消草稿状态，并上传：

- `DualLink-版本-x64-setup.exe`
- `DualLink-版本-x64-portable.exe`
- `DualLink-source-版本.zip`
- `DualLink-web-版本.zip`
- `SHA256SUMS-版本.txt`

校验文件中的 EXE 名称必须与发布资产完全一致。不要只推送main：没有稳定Release及匹配文件，客户端无法下载新版。不要覆盖已发布版本的安装包，修复应使用新版本号。
