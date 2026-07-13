# macOS 构建与安装排障

本文档面向 Bailongma 的开发者和维护者，用于构建、检查和排查 macOS 桌面安装包问题。

内容基于当前项目脚本和 `package.json` 中的 `electron-builder` 配置。除共享脚本会影响 macOS 构建的部分外，本文不展开 Windows 打包流程。

## 适用范围

- 项目根目录：`/Users/xyf/code/bailongma`
- Electron 入口：`electron/main.cjs`
- 运行时路径抽象：`src/paths.js`
- macOS 语音 helper 源码：`src/voice/macos-speech.swift`
- macOS 构建包装脚本：`scripts/build-mac.mjs`
- 语音 helper 构建脚本：`scripts/build-macos-speech.mjs`
- 构建产物清理脚本：`scripts/prebuild-clean.mjs`
- macOS 产物冒烟检查：`scripts/smoke-mac-artifacts.mjs`

排障时不要删除或重置用户数据目录：

```text
/Users/xyf/Library/Application Support/Bailongma
```

仓库根目录下的 `voice/*.json` 是本地语音配置文件，已被 git 忽略。不要把这些文件内容复制到文档、issue、日志或发布说明中。

## macOS 构建产物

当前 `electron-builder` 的 macOS target 只有 DMG：

```json
"mac": {
  "target": ["dmg"],
  "category": "public.app-category.productivity",
  "artifactName": "${productName}-${version}-mac-${arch}.${ext}"
}
```

以版本 `2.1.436` 为例，预期 DMG 文件名为：

```text
dist/Bailongma-2.1.436-mac-arm64.dmg
dist/Bailongma-2.1.436-mac-x64.dmg
```

`electron-builder` 也可能写入相关元数据文件，例如：

```text
dist/*.blockmap
dist/latest-mac.yml
dist/builder-debug.yml
```

打包后的 app bundle 位于挂载后的 DMG 内：

```text
Bailongma.app
```

应用启用了 `asar: true`。以下文件需要作为可执行文件或原生模块在运行时加载，因此会被显式解包：

```text
node_modules/better-sqlite3/**
build/native-speech-recognizer
src/voice/**
```

## 环境要求

macOS 打包应在 macOS 上执行。语音 helper 构建脚本在非 macOS 上以 `--required` 调用时会退出失败，而 `scripts/build-mac.mjs` 总是使用 required 模式。

建议先确认本地工具：

```bash
node --version
npm --version
xcode-select -p
xcrun --sdk macosx swiftc --version
```

项目当前使用：

- Electron 依赖：`^33.2.0`
- macOS 构建包装脚本中的 Electron rebuild 目标版本：`33.4.11`
- `better-sqlite3`：`^12.8.0`
- `electron-builder`：`^25.1.8`
- `@electron/rebuild`：`^4.0.4`

`scripts/build-mac.mjs` 中 hardcode 了 `electronVersion = '33.4.11'`，用于 rebuild `better-sqlite3`。升级 Electron 时，需要同时检查这个值、`package.json` 和 `package-lock.json`；Electron ABI 不匹配是原生模块最常见的问题之一。

如果缺少 `xcode-select` 或 `xcrun swiftc`，安装 Xcode Command Line Tools：

```bash
xcode-select --install
```

语音 helper 的编译形式如下：

```text
xcrun --sdk macosx swiftc src/voice/macos-speech.swift \
  -target <arch>-apple-macos<deployment-target> \
  -framework Speech \
  -framework AVFoundation
```

默认部署目标为 `10.15`，由以下环境变量控制：

```bash
MACOSX_DEPLOYMENT_TARGET=10.15
```

## Apple Silicon 与 Intel 架构差异

Bailongma 当前为 Intel 和 Apple Silicon 分别构建 macOS DMG。

构建包装脚本支持的架构为：

```text
x64
arm64
```

默认 macOS 构建命令会依次构建两个架构：

```bash
npm run build:mac
```

该命令等价于：

```bash
node scripts/prebuild-clean.mjs
node scripts/build-macos-speech.mjs x64 --required
node ./node_modules/@electron/rebuild/lib/cli.js -f -w better-sqlite3 -v 33.4.11 -a x64
node ./node_modules/electron-builder/cli.js --mac dmg --x64
node scripts/build-macos-speech.mjs arm64 --required
node ./node_modules/@electron/rebuild/lib/cli.js -f -w better-sqlite3 -v 33.4.11 -a arm64
node ./node_modules/electron-builder/cli.js --mac dmg --arm64
```

项目还提供了一个只构建语音 helper 的 universal 命令：

```bash
npm run build:mac:universal-speech
```

该命令会使用 `lipo` 创建 universal 的 `build/native-speech-recognizer`，但不会打包 universal `.app` 或 universal DMG。除非后续新增独立的 universal app 打包流程，否则不要把当前项目描述为能产出 universal macOS 安装包。

在 Apple Silicon 上，要注意不要混用 Rosetta 和原生 shell。如果依赖是在转译的 x64 Node 下安装的，`node_modules` 里可能会留下 x64 原生产物。构建前建议确认当前 Node 架构：

```bash
node -p "process.arch"
file "$(which node)"
```

## 首次安装依赖

在仓库根目录执行：

```bash
npm install
```

`postinstall` 脚本会运行：

```bash
node ./node_modules/electron-builder/cli.js install-app-deps
```

它会为 Electron 安装或重建原生应用依赖。显式的 macOS 打包包装脚本仍会在每个目标架构打包前，对 `better-sqlite3` 做一次对应架构的 rebuild。

如果 install 或 postinstall 失败，先记录失败命令和平台信息：

```bash
node --version
npm --version
node -p "process.platform + ' ' + process.arch"
xcode-select -p
```

不要通过删除用户数据来修依赖问题。依赖状态位于仓库工作区，主要是 `node_modules/`，不在 Bailongma 用户数据目录中。

## 本地开发启动

开发启动和打包构建是不同流程。

从源码启动 Electron 桌面应用：

```bash
npm start
```

只启动本地后端：

```bash
npm run start:backend
```

以 watch 模式启动后端：

```bash
npm run dev
```

开发模式下，如果没有设置 `BAILONGMA_USER_DIR`，`src/paths.js` 会默认把可写数据路径指向仓库根目录。打包后的 Electron 应用中，`electron/main.cjs` 会注入：

```text
BAILONGMA_USER_DIR=<Electron app.getPath('userData')>
BAILONGMA_RESOURCES_DIR=<Electron app.getAppPath()>
```

在 macOS 上，打包应用的用户数据路径通常是：

```text
~/Library/Application Support/Bailongma
```

## macOS 打包命令

### `npm run build`

当前脚本：

```bash
npm run build
```

实际运行：

```text
node scripts/prebuild-clean.mjs
node scripts/build-macos-speech.mjs
node ./node_modules/@electron/rebuild/lib/cli.js -f -w better-sqlite3 -v 33.4.11
node ./node_modules/electron-builder/cli.js
```

在 macOS 上，该命令遵循 `electron-builder` 的当前平台行为和 `package.json` 中的 macOS target。为了得到更可重复的 macOS 发布产物，优先使用下面的显式 `build:mac:*` 脚本。

### `npm run build:mac`

```bash
npm run build:mac
```

运行 `scripts/build-mac.mjs`，流程为：

1. 通过 `scripts/prebuild-clean.mjs` 删除 `dist/`；
2. 为 `x64` 构建 Swift 语音 helper；
3. 为 Electron `33.4.11` 和 `x64` rebuild `better-sqlite3`；
4. 打包 x64 DMG；
5. 为 `arm64` 构建 Swift 语音 helper；
6. 为 Electron `33.4.11` 和 `arm64` rebuild `better-sqlite3`；
7. 打包 arm64 DMG。

### `npm run build:mac:x64`

```bash
npm run build:mac:x64
```

只构建 Intel x64 的语音 helper、原生模块和 DMG。

### `npm run build:mac:arm64`

```bash
npm run build:mac:arm64
```

只构建 Apple Silicon arm64 的语音 helper、原生模块和 DMG。

### `npm run build:mac:universal-speech`

```bash
npm run build:mac:universal-speech
```

只构建 universal 的 `build/native-speech-recognizer`。脚本会分别编译 arm64 和 x64 helper 二进制，用 `lipo` 合并，然后删除临时目录 `build/macos-speech/`。

这个命令适合验证语音 helper 在双架构下能否编译，但它不是完整的应用打包命令。

## 构建产物位置与验证

macOS 构建成功后，检查预期文件：

```bash
ls -lh dist
```

如果构建了双架构产物，运行项目已有的冒烟检查：

```bash
npm run smoke:mac-artifacts
```

该检查会使用 `hdiutil` 以只读方式挂载每个 DMG，然后验证：

- DMG 文件存在；
- 挂载镜像内存在 `Bailongma.app`；
- 存在 `Contents/Info.plist`；
- app 可执行文件是预期的单一架构；
- `build/native-speech-recognizer` 是预期的单一架构；
- `better_sqlite3.node` 是预期的单一架构；
- `better-sqlite3` 的 `test_extension.node` 没有被打进包里。

常用手动检查命令：

```bash
hdiutil attach -readonly -nobrowse dist/Bailongma-2.1.436-mac-arm64.dmg
lipo -archs "/Volumes/<mounted-volume>/Bailongma.app/Contents/MacOS/Bailongma"
lipo -archs "/Volumes/<mounted-volume>/Bailongma.app/Contents/Resources/app.asar.unpacked/build/native-speech-recognizer"
lipo -archs "/Volumes/<mounted-volume>/Bailongma.app/Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
hdiutil detach "/Volumes/<mounted-volume>"
```

请把 `2.1.436` 替换为当前 `package.json` 中的版本。

## 代码签名、公证与 Gatekeeper

当前仓库配置没有定义 Developer ID 签名或 Apple 公证流程。未签名或 ad-hoc 签名的本地构建仍然可以是有效的开发构建，但分发体验会更差。

没有 Developer ID 签名和公证时，用户可能会看到类似提示：

```text
"Bailongma.app" cannot be opened because Apple cannot check it for malicious software.
```

或：

```text
"Bailongma.app" is damaged and can't be opened. You should move it to the Trash.
```

本地测试时，要把这些 Gatekeeper 提示和构建失败区分开。一个 DMG 可以在结构上完全有效，同时仍然触发 macOS 安全提示。

开发机上常用检查命令：

```bash
spctl --assess --verbose "/Applications/Bailongma.app"
codesign --verify --deep --strict --verbose=2 "/Applications/Bailongma.app"
xattr -lr "/Applications/Bailongma.app" | rg com.apple.quarantine
```

移除 quarantine 只是本地测试绕过手段，不是发布流程：

```bash
xattr -dr com.apple.quarantine "/Applications/Bailongma.app"
```

公开分发时，应定义真实的签名和公证策略，而不是要求用户绕过 Gatekeeper。

## 常见问题排查

### 缺少 Xcode Command Line Tools

常见现象：

```text
xcrun: error: invalid active developer path
swiftc failed
```

检查：

```bash
xcode-select -p
xcrun --sdk macosx swiftc --version
```

修复：

```bash
xcode-select --install
```

### Swift 语音 helper 编译失败

helper 源码：

```text
src/voice/macos-speech.swift
```

构建输出：

```text
build/native-speech-recognizer
```

可以直接尝试编译目标架构：

```bash
node scripts/build-macos-speech.mjs arm64 --required
node scripts/build-macos-speech.mjs x64 --required
```

如果 macOS SDK 或 Swift 错误中提到 `Speech` 或 `AVFoundation`，检查 Xcode Command Line Tools 和部署目标：

```bash
MACOSX_DEPLOYMENT_TARGET=10.15 node scripts/build-macos-speech.mjs arm64 --required
```

### `better-sqlite3` ABI 或 Electron 版本不匹配

常见现象包括：原生模块是为另一个 Node/Electron module version 编译的，或加载以下文件失败：

```text
better_sqlite3.node
```

macOS 构建包装脚本只会针对目标 Electron 版本和目标架构 rebuild `better-sqlite3`：

```bash
node ./node_modules/@electron/rebuild/lib/cli.js -f -w better-sqlite3 -v 33.4.11 -a arm64
node ./node_modules/@electron/rebuild/lib/cli.js -f -w better-sqlite3 -v 33.4.11 -a x64
```

如果升级 Electron，需要同步更新 `scripts/build-mac.mjs` 里的 rebuild 目标版本，以及 `package.json` scripts 中的等价命令。

### `@electron/rebuild` 失败

先检查编译器和架构状态：

```bash
node -p "process.platform + ' ' + process.arch"
npm ls better-sqlite3 electron @electron/rebuild
xcode-select -p
```

如果问题是在 Rosetta 和原生终端之间切换后出现的，用目标架构重新安装依赖：

```bash
rm -rf node_modules
npm install
```

这只会删除仓库依赖，不会触碰：

```text
~/Library/Application Support/Bailongma
```

### Apple Silicon、Intel 与 Rosetta 架构不匹配

在 Apple Silicon 上，先确认 shell 和 Node 是原生 arm64 还是转译 x64：

```bash
uname -m
node -p "process.arch"
file "$(which node)"
```

如果需要在 Apple Silicon 上构建 x64 产物，`scripts/build-mac.mjs x64` 会要求 `@electron/rebuild` 和 `electron-builder` 产出 x64。除非准备在之后重新安装依赖，否则不要随意混用 arm64 安装的 `node_modules` 和转译的 x64 shell。

### `npm install` 或 `postinstall` 失败

项目的 `postinstall` 会运行 `electron-builder install-app-deps`。这里失败通常和原生依赖或 Electron headers 有关。

建议记录：

```bash
npm install --foreground-scripts
npm ls electron electron-builder better-sqlite3
```

然后确认 Xcode Command Line Tools 后重试。调试安装失败时，不要编辑或删除本地凭证文件。

### App 启动后找不到数据

打包后的 Electron 使用 `app.getPath('userData')`，通常应解析为：

```text
~/Library/Application Support/Bailongma
```

该目录下的重要文件和目录包括：

```text
config.json
data/jarvis.db
llm/
voice/
sandbox/
skills/
music/
logs/bailongma.log
```

不要把删除该目录作为构建排障步骤。更新或重装 app bundle 不应要求清空用户数据。

查看启动日志：

```bash
tail -n 200 "$HOME/Library/Application Support/Bailongma/logs/bailongma.log"
```

不要把配置文件中的密钥粘贴到 bug 报告中。

### 麦克风或语音权限问题

macOS app 声明了：

```text
NSMicrophoneUsageDescription
NSSpeechRecognitionUsageDescription
```

Swift helper 会单独请求 Speech 和麦克风权限。运行时错误可能包括：

```text
macOS speech recognition permission was denied
microphone permission was denied
macOS speech recognizer is unavailable
```

检查 macOS 设置：

- Privacy & Security -> Microphone
- Privacy & Security -> Speech Recognition
- Privacy & Security -> Accessibility，适用于需要自动化或 UI 控制的功能

如果本地测试时权限弹窗不再出现，只重置相关的 macOS 隐私权限条目。不要为了修复 TCC 权限状态而清空 Bailongma 用户数据。

### Gatekeeper 或 quarantine

如果 DMG 来自浏览器或聊天工具下载，macOS 可能会附加 quarantine 元数据。这和构建是否成功是两件事。

检查：

```bash
xattr -lr "/Applications/Bailongma.app" | rg com.apple.quarantine
spctl --assess --verbose "/Applications/Bailongma.app"
```

仅本地开发测试时可使用：

```bash
xattr -dr com.apple.quarantine "/Applications/Bailongma.app"
```

正式发布应使用 Developer ID 签名和 Apple 公证。

### 清理 `dist/` 与重新构建

`scripts/prebuild-clean.mjs` 会在新构建前移除输出目录：

```bash
node scripts/prebuild-clean.mjs
```

`npm run build`、`npm run build:mac`、`npm run build:mac:x64` 和 `npm run build:mac:arm64` 都会通过已配置脚本清理 `dist/`。

这个清理只删除构建产物。不要把它替换成会删除 app 用户数据的命令。

## 安全与数据注意事项

- 构建产物位于 `dist/`。
- 构建资源位于 `build/`。
- 运行时用户数据位于 `~/Library/Application Support/Bailongma`。
- 仓库中的运行时数据目录，例如 `data/`、`sandbox/` 和 `voice/*.json`，已被 git 忽略，不应出现在发布示例中。
- 本地 API key、Provider 配置和语音配置不要粘贴到文档或 issue 评论里。
- 重装或替换 `/Applications/Bailongma.app` 和删除用户数据是两件不同的事，排障时要分开处理。

## 发布前检查清单

分享 macOS 构建前：

- 确认工作区状态和最新提交：

```bash
git status --short --branch
git log -1 --oneline
```

- 用目标架构安装依赖：

```bash
npm install
node -p "process.platform + ' ' + process.arch"
```

- 构建目标 macOS 产物：

```bash
npm run build:mac
```

或：

```bash
npm run build:mac:arm64
npm run build:mac:x64
```

- 验证产物：

```bash
npm run smoke:mac-artifacts
```

- 检查签名和 Gatekeeper 行为：

```bash
spctl --assess --verbose "/Applications/Bailongma.app"
codesign --verify --deep --strict --verbose=2 "/Applications/Bailongma.app"
```

- 确认没有本地专用文件被 staged：

```bash
git status --short
```

- 确认本次发布是否需要：
  - Developer ID 签名；
  - Apple 公证；
  - 分开的 x64 和 arm64 DMG；
  - 未来新增 universal app/DMG 流程；
  - 更新 `scripts/build-mac.mjs` 中的 Electron rebuild 版本。
