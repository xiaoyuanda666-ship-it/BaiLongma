# Windows 与 Linux 更新发布

Windows 和 Linux 必须在对应的 x64 系统上构建和发布。发布机只通过 SSH 把产物传到香港服务器；阿里云 OSS AccessKey 仅保存在服务器，不得复制到开发机或仓库。

## Windows x64

在 x64 Windows 环境中安装依赖并配置代码签名后执行：

```powershell
npm run release:win
```

该命令要求 NSIS 安装包具有有效 Authenticode 签名，并检查以下产物：

```text
dist/Bailongma-Setup-<version>.exe
dist/Bailongma-Setup-<version>.exe.blockmap
```

发布目录和清单为：

```text
stable/win/x64/latest.yml
```

只检查现有文件、不连接服务器：

```powershell
npm run upload:win:dry-run
```

正式只上传已有产物：

```powershell
npm run upload:win
```

## Linux x64

在 x64 Linux 环境执行：

```bash
npm run release:linux
```

构建会检查所有关键原生模块和程序均为 Linux x64 ELF，解包 AppImage 检查内容，并验证内嵌 blockmap。预期产物为：

```text
dist/Bailongma-<version>-linux-x64.AppImage
```

发布目录和清单为：

```text
stable/linux/x64/latest-linux.yml
```

只检查现有文件、不连接服务器：

```bash
npm run upload:linux:dry-run
```

正式只上传已有产物：

```bash
npm run upload:linux
```

## 共同发布保证

三个平台的上传命令共用同一套发布实现：

1. 版本必须为数字格式 `x.y.z`，远端版本必须更低；
2. 正式发布前必须输入版本号确认，自动化环境可显式传 `--yes`；
3. 服务器使用全局发布锁，并在锁内再次检查版本；
4. SSH 暂存、香港源站和 OSS 均校验 SHA-512 与文件大小；
5. 带版本号的产物先发布，清单最后发布；源站清单使用原子替换；
6. 发布后分别读取旧版兼容源站清单和带更新请求头的 OSS 清单；
7. Range 请求必须返回 `206`，并且 `Content-Range` 总大小必须匹配本地产物；
8. 同版本文件不可覆盖。失败产物必须通过递增版本重新发布。

新版客户端请求头仍为：

```text
X-Bailongma-Updater: BailongmaUpdater/2
```

未携带该请求头的旧版客户端继续使用香港兼容源站。在确认过渡版本覆盖足够用户之前，不得关闭旧版入口。
