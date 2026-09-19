# Changelog

All notable changes to Bailongma will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/).

## [2.2.120] - 2026-09-15

### Added
- `CONTRIBUTING.md` — 贡献指南，包含环境要求、安装步骤、分支规范、PR 流程和测试命令
- `eslint.config.js` — ESLint 10 配置，支持 ESM + Node.js + 浏览器环境
- `.prettierrc` + `.prettierignore` — Prettier 代码格式化配置
- `.github/workflows/ci.yml` — GitHub Actions CI，PR 时自动运行 lint 和 smoke test
- `.github/ISSUE_TEMPLATE/bug_report.md` — Bug 报告模板
- `.github/ISSUE_TEMPLATE/feature_request.md` — 功能请求模板
- `.github/pull_request_template.md` — Pull Request 模板
- `CHANGELOG.md` — 本文件
- `npm run lint` / `npm run lint:fix` — ESLint 检查和自动修复
- `npm run format` / `npm run format:check` — Prettier 格式化和检查
- `npm run test` — 统一 smoke test 入口
- 核心模块 JSDoc 文档（`src/index.js`、`src/api.js`、`src/config.js`）

### Changed
- 15 个源文件经 ESLint 自动修复（`let` → `const`、删除多余分号等）

## [2.2.119] - 2026-08-01

### Added
- 世界杯面板和台风面板
- 视频生成功能
- 知识工作区和浏览器运行时集成

## [2.2.118] - 2026-07-01

### Added
- Agent 时间感知理论实现
- Scene Protocol 声明式 UI 框架
- ACI 预期上下文注入
- 飞书 WebSocket 连接器

## [2.2.0] - 2026-06-01

### Added
- Brain UI 主界面
- 记忆系统（SQLite + FTS5）
- 多模型接入（DeepSeek、MiniMax、OpenAI、Qwen、Moonshot、Zhipu、MiMo）
- 工具系统（文件、Shell、搜索、媒体、提醒等）
- 语音能力（ASR + TTS）
- 社交连接器（Discord、微信）
- Electron 桌面壳
- 局域网 HTTPS 访问
