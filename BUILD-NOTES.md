# Build Notes

记录 `electron-builder --win` 打包过程中遇到的问题及解决方案。

---

## 问题一：Array buffer allocation failed

**错误信息**
```
⨯ Array buffer allocation failed
  at readFileHandle (node:internal/fs/promises:542:23)
  at addWinAsarIntegrity (electron-builder/.../electronWin.ts:8:18)
```

**触发条件**  
`dist/` 目录存在旧构建产物时再次运行 `npm run build`。electron-builder 在写入 asar integrity 签名前会将已有的 `app.asar` 整体读入内存，文件体积（含 playwright）超出 Node.js 单次 Buffer 分配上限。

**解决**  
构建前先删除旧产物：
```bash
rm -rf dist
```

---

## 问题二：Go 打包器 OOM（runtime: pageAlloc: out of memory）

**错误信息**
```
fatal error: pageAlloc: out of memory

runtime.(*pageAlloc).grow ...
internal/cpu.doinit() ...
runtime.schedinit() ...
```

**触发条件**  
删除 `dist/` 后重新构建，electron-builder 内部的 Go 二进制（`app-builder`）在初始化阶段就崩溃。项目依赖 `playwright`（含完整浏览器二进制），使打包体积极大，超过 Go 运行时可申请的连续内存。

**解决**  
该 Go 二进制不受 `NODE_OPTIONS` 控制，无法直接调大。实际上根因是 `@electron/rebuild` 阶段已经把系统内存耗尽，见问题三。

---

## 问题三：@electron/rebuild 阶段 Node.js 堆 OOM

**错误信息**
```
FATAL ERROR: Committing semi space failed. Allocation failed - JavaScript heap out of memory
⨯ Rebuilder failed with exit code: 134
```

**触发条件**  
`npm run build` 默认在每次打包前都会执行 `@electron/rebuild`，对所有 native addon 重新编译以匹配 Electron 版本。项目含 `better-sqlite3` 和 `playwright`，依赖链庞大，重编译过程中堆溢出。

**根本原因**  
`postinstall`（`electron-builder install-app-deps`）已经完整做过一次 native 重建，`npm run build` 再做一次是冗余的。

**解决**  

1. 在 `package.json` 的 `build` 字段中禁用自动重建：

```json
"build": {
  "npmRebuild": false,
  ...
}
```

2. 运行构建时增大 Node.js 堆上限：

```bash
NODE_OPTIONS=--max-old-space-size=4096 npm run build
```

> **注意**：`npmRebuild: false` 后，如果更换了 Electron 版本或修改了 native 依赖，需要手动执行一次重建：
> ```bash
> npm run postinstall
> ```

---

## 最终可用的构建流程

```bash
# 1. 安装 / 重建 native 依赖（版本变更后必做，平时可跳过）
npm run postinstall

# 2. 清理旧产物（可选，防止旧 asar 读取 OOM）
rm -rf dist

# 3. 构建
NODE_OPTIONS=--max-old-space-size=4096 npm run build
```

产物路径：`dist/Bailongma Setup <version>.exe`

---

## package.json 关键配置

```json
"build": {
  "npmRebuild": false,
  "asar": true,
  "asarUnpack": [
    "**/node_modules/better-sqlite3/**",
    "**/node_modules/playwright/**",
    "**/node_modules/playwright-core/**"
  ]
}
```

`playwright` 和 `better-sqlite3` 已配置为 `asarUnpack`，它们的文件不会被打进 asar 压缩包，可避免运行时解压开销，同时也降低了 asar 本身的体积压力。
