# macOS 远程构建简明步骤

这份文档用于发给远程协作者，让对方在 macOS 机器上构建 Jarvis 安装包。更完整的排障说明见 `docs/mac-build.md`。

## 1. 准备环境

需要一台 macOS 机器，并安装：

- Node.js 与 npm
- Xcode Command Line Tools
- git

先检查：

```bash
node --version
npm --version
git --version
xcode-select -p
xcrun --sdk macosx swiftc --version
```

如果缺少 Xcode Command Line Tools：

```bash
xcode-select --install
```

## 2. 拉取代码

```bash
git clone <repo-url> jarvis
cd jarvis
git status --short --branch
git log -1 --oneline
```

确认当前分支和提交是要构建的版本。

## 3. 安装依赖

```bash
npm install
```

如果是 Apple Silicon 机器，建议确认 Node 架构：

```bash
node -p "process.arch"
file "$(which node)"
```

不要混用 Rosetta x64 shell 和原生 arm64 shell 安装依赖。

## 4. 构建 macOS 安装包

构建 arm64 和 x64 两个 DMG：

```bash
npm run build:mac
```

只构建 Apple Silicon：

```bash
npm run build:mac:arm64
```

只构建 Intel：

```bash
npm run build:mac:x64
```

注意：`npm run build:mac:universal-speech` 只构建 universal 语音 helper，不会生成完整 app 或 DMG。

## 5. 查找产物

构建产物在：

```text
dist/
```

常见文件名：

```text
Jarvis-<version>-mac-arm64.dmg
Jarvis-<version>-mac-x64.dmg
*.blockmap
latest-mac.yml
```

查看：

```bash
ls -lh dist
```

## 6. 验证产物

如果同时构建了 arm64 和 x64：

```bash
npm run smoke:mac-artifacts
```

该命令会检查 DMG、`Jarvis.app`、app 可执行文件架构、macOS 语音 helper 架构和 `better-sqlite3` 原生模块架构。

## 7. 发回给维护者

请提供：

```bash
git log -1 --oneline
ls -lh dist
```

并发送 `dist/` 下生成的 `.dmg` 文件。

如果构建失败，请发送：

- 失败命令；
- 完整错误日志；
- `node --version`；
- `npm --version`；
- `node -p "process.platform + ' ' + process.arch"`；
- `xcode-select -p`；
- `xcrun --sdk macosx swiftc --version`。

## 8. 注意事项

- 不要删除用户数据目录：`~/Library/Application Support/Jarvis`。
- 不要提交或发送本地 `.env`、API key、Provider 配置、`voice/*.json`。
- 没有 Developer ID 签名和 Apple 公证时，macOS 可能提示“无法验证开发者”；这通常是分发签名问题，不等于构建失败。
- `dist/` 可以清理后重建；用户数据目录不要作为构建排障步骤删除。
