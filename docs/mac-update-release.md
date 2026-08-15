# macOS 更新版本发布

macOS 更新同时发布两个独立架构：

- `x64`：Intel Mac
- `arm64`：Apple Silicon（M 系列）

发布脚本只在 macOS 上运行，通过 SSH 别名 `xiaobailong-update-hk` 连接香港更新服务器。OSS AccessKey 保存在服务器上，Mac 本机不需要保存阿里云密钥。

## 一条命令完成构建和上传

确认 `package.json` 中的版本号已经递增，然后执行：

```bash
npm run release:mac
```

该命令会：

1. 清空旧 `dist/`，分别准备并审计 x64、arm64 原生依赖；
2. 从最深层 Mach-O、dylib、framework、helper app 开始逐层签名，所有 Developer ID 签名显式使用 secure timestamp、Hardened Runtime 和对应 entitlements；
3. 分别提交 app 公证并 staple，再构建、签名、提交和 staple 最终 DMG；
4. 对最终 DMG 和 ZIP 重新生成 blockmap，保证 blockmap、大小和 SHA-512 都对应 staple 后的最终文件；
5. 构建 x64 和 arm64 的 DMG、ZIP、DMG blockmap、ZIP blockmap；
6. 对两个架构运行 codesign、secure timestamp、Hardened Runtime、entitlements、全量 Mach-O 架构、公证票据、stapler、Gatekeeper、blockmap 冒烟检查；
7. 分别计算 ZIP 和 DMG 的 SHA-512 与文件大小，生成 x64、arm64 的 `latest-mac.yml`；
8. 将文件传到香港服务器的临时目录，并执行现有的远端原子发布与回读校验。

真正上传前，终端会要求输入本次版本号确认。

## 只上传已经构建好的产物

如果 `dist/` 已经包含两个架构的完整产物：

```bash
npm run upload:mac
```

预期文件为：

```text
dist/Bailongma-<version>-mac-x64.dmg
dist/Bailongma-<version>-mac-x64.dmg.blockmap
dist/Bailongma-<version>-mac-x64.zip
dist/Bailongma-<version>-mac-x64.zip.blockmap
dist/Bailongma-<version>-mac-arm64.dmg
dist/Bailongma-<version>-mac-arm64.dmg.blockmap
dist/Bailongma-<version>-mac-arm64.zip
dist/Bailongma-<version>-mac-arm64.zip.blockmap
```

不要直接上传 `dist/latest-mac.yml`。连续构建两个架构时，这个文件只代表最后构建的架构；发布脚本会为两个架构重新生成正确的独立清单。

不要复用或手工修补旧 `dist/` 产物。任何对 app、ZIP、DMG 的重新签名、公证或 staple 都会改变最终字节；此后必须重新生成相应 blockmap 和发布清单哈希。正式构建拒绝 `BAILONGMA_CODESIGN_TIMESTAMP=none`。

默认公证凭据只通过 macOS Keychain profile `BailongmaNotary` 使用。脚本不会读取或向 Release Console 返回钥匙串密码、App 专用密码或 API 私钥。

构建会先并行提交 x64、arm64 app，等待 Apple 接受并 staple 后再生成 DMG/ZIP；随后并行提交两个 DMG，最终统一 staple 并重建 blockmap。若 Apple 在上传完成、Submission 已进入 `In Progress` 后出现连接超时，脚本会按 Submission ID 回查并继续等待，不会产生重复提交。Apple 队列未返回终态时，产物不得发布。

## 正式签名前的本地检查

构建 hook 会自动执行等价检查；手工排查时可对解包后的 app 执行：

```bash
codesign --verify --deep --strict --verbose=4 "/path/to/Bailongma.app"
codesign --display --verbose=4 "/path/to/Bailongma.app/Contents/MacOS/Bailongma"
```

每个嵌套 Mach-O 还会单独检查 `Timestamp=`、`flags=...runtime`、Developer Team `XD5VMPN37G` 和单一目标架构。`--deep` 只用于最终验证，不用于签名。

## 只做本地检查

不会连接服务器，也不会上传：

```bash
npm run upload:mac:dry-run
```

## 可选参数

只发布某个架构：

```bash
npm run upload:mac -- --arch=arm64
npm run upload:mac -- --arch=x64
```

非默认 SSH 别名：

```bash
npm run upload:mac -- --host=<ssh-alias>
```

自动化环境跳过人工确认：

```bash
npm run upload:mac -- --yes
```

带版本号的文件按 immutable 缓存策略发布，因此同一版本禁止重复发布，也不支持覆盖。
如产物有误，必须递增 `package.json` 版本号后重新构建发布。

## 发布路径

```text
stable/mac/x64/
stable/mac/arm64/
```

每个目录都有独立的 `latest-mac.yml`。带新更新请求头的客户端会下载 OSS 短时签名地址；尚未升级的旧客户端暂时从香港兼容源站下载。

## Bailongma Release Console（本地 Web UI）

在项目根目录运行：

```bash
npm run release:ui
```

命令会启动只监听 `127.0.0.1` 随机端口的本地 Node.js 服务，并用默认浏览器打开 Bailongma Release Console。关闭页面不会终止后端正在维护的任务；停止终端中的服务才会结束控制台。

控制台提供：

- SSH、香港健康检查、OSS 网关、下载域名 HTTPS、Git 与远端版本状态；
- 直接扫描固定项目 `dist/` 中 x64、arm64 的八个文件并计算 SHA-512，不经过浏览器上传；
- CPU 架构、codesign、Developer Team、Hardened Runtime、entitlements、公证票据、stapler、Gatekeeper 与 blockmap 独立检查；
- 两个架构各自的 `latest-mac.yml` 预览，以及 `5 / 10 / 25 / 50 / 100` 灰度比例；
- dry-run、正式发布计划、SSE 进度、脱敏日志和用户目录中的发布历史。

### 推荐操作顺序

1. 刷新系统状态并确认远端版本可读；
2. 确认八个产物完整，运行“完整检查”；
3. 填写 release notes、架构与灰度比例，生成发布计划；
4. 先运行“只做 Dry Run”；
5. 正式 stable 发布前再次核对计划，勾选确认框，并手动输入完整版本号。

某个架构首次发布时，远端对应的 `latest-mac.yml` 尚不存在。只有控制台明确收到 404 时，版本门禁才显示“首次发布”并允许通过；网络超时、鉴权失败或清单损坏仍显示“远端状态未知”并阻止 stable 发布。

正式 stable 发布会在后端重新检查版本号和所有 stable 门禁。Apple 公证、`xcrun stapler validate` 或 Gatekeeper 任一未通过时，dry-run 和测试构建仍可运行，但 stable 发布会被后端拒绝。“构建并上传”会先调用现有 `scripts/build-mac.mjs`，之后仍使用与 CLI 相同的发布 engine。

控制台默认禁止 CORS，校验 Host、Origin 和随机会话令牌，不提供任意命令或任意上传路径。浏览器不会收到 SSH 配置、OSS AccessKey、证书私钥或 OSS 签名 URL。发布历史保存在：

```text
~/Library/Application Support/Bailongma Release Console/releases/
```

测试控制台安全边界与共享发布 engine：

```bash
npm run release:ui:test
```

灰度比例只控制新清单向符合灰度条件的客户端提供当前版本。将清单重新指向旧版本不等于完整回滚；已经安装坏版本的客户端通常需要发布一个更高版本的热修复。
