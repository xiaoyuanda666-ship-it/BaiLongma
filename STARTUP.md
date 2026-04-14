# Jarvis 启动手册

## 目录结构

```
D:\claude\jarvis\
├── src/              核心代码
├── sandbox/          Jarvis 的文件沙盒（journal.txt、readme.txt、world.txt）
├── data/             数据库（jarvis.db，自动创建）
├── .env              API 密钥（不可提交到 git）
├── dashboard.html    前台页面
├── brain.html        后台监控页面
└── package.json
```

---

## 前置条件

- Node.js >= 18
- `.env` 文件存在于 `D:\claude\jarvis\` 目录下，内容：

```
MINIMAX_API_KEY=sk-cp-xxxxxxxxxxxxxxxx
```

---

## 启动 Jarvis（含 Web 服务器）

Jarvis 启动时会**自动启动内置 HTTP 服务器**（端口 3721），无需单独启动 Web 服务。

打开终端，进入项目目录：

```bash
cd D:\claude\jarvis
npm start
```

正常启动后终端会输出：

```
[Provider] 已注册: minimax
Jarvis 启动中...
[API] 监听 http://127.0.0.1:3721
[API]   POST /message  — 发消息给意识体
[API]   GET  /events   — SSE 实时流
[API]   GET  /memories — 查询记忆
[API]   GET  /status   — 状态
```

> ⚠️ 必须用 `npm start`，不能用 `node src/index.js`。
> 因为需要 `--env-file=.env` 加载 API 密钥，直接运行 node 会导致 401 错误。

---

## 开发模式（文件修改后自动重启）

```bash
cd D:\claude\jarvis
npm run dev
```

---

## 访问页面

| 页面 | 地址 | 说明 |
|------|------|------|
| 前台 Dashboard | http://localhost:3721/ | 查看 Jarvis 的消息和响应 |
| 后台 Brain Monitor | http://localhost:3721/brain.html | 查看注入器、识别器、思考流、记忆 |

---

## 向 Jarvis 发送消息

**方法一：PowerShell**

```powershell
Invoke-RestMethod -Uri 'http://localhost:3721/message' `
  -Method POST `
  -ContentType 'application/json; charset=utf-8' `
  -Body ([System.Text.Encoding]::UTF8.GetBytes('{"from_id":"Yuanda","content":"你好","channel":"API"}'))
```

**方法二：curl（推荐在 Git Bash 中使用）**

```bash
curl -s -X POST http://localhost:3721/message \
  -H "Content-Type: application/json" \
  -d '{"from_id":"Yuanda","content":"你好","channel":"API"}'
```

参数说明：
- `from_id`：发送者 ID（如 `Yuanda`）
- `content`：消息内容
- `channel`：来源渠道，默认 `API`

---

## 查询 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/status` | 运行状态和记忆总数 |
| GET | `/memories?limit=20` | 查询最近记忆，支持 `search=关键词` |
| GET | `/quota` | 查看 API 配额使用情况 |
| GET | `/events` | SSE 实时事件流（供页面订阅） |
| DELETE | `/memories/:id` | 删除指定记忆（常用于删除约束） |
| PATCH | `/memories/:id` | 修改记忆的 content 或 detail |

---

## 停止 Jarvis

**方法一：终端直接 Ctrl+C**

**方法二：如果是后台运行，找到进程 PID 并杀掉**

```powershell
# 查找占用 3721 端口的进程
netstat -ano | findstr :3721

# 杀掉对应 PID（替换为实际 PID）
taskkill /F /PID 12345
```

---

## 清除记忆并重启（完全重置）

```powershell
# 1. 找到并杀掉 Jarvis 进程
netstat -ano | findstr :3721
taskkill /F /PID <PID>

# 2. 删除数据库
del D:\claude\jarvis\data\jarvis.db
del D:\claude\jarvis\data\jarvis.db-shm
del D:\claude\jarvis\data\jarvis.db-wal

# 3. 重新启动
cd D:\claude\jarvis
npm start
```

---

## 常见问题

**启动报 `EADDRINUSE: address already in use 0.0.0.0:3721`**

说明端口已被占用（通常是上一次的 Jarvis 进程没有正常退出）。
按照"停止 Jarvis"一节找到 PID 并杀掉，再重新启动。

**启动报 `401 login fail`**

API 密钥未加载。确认 `.env` 文件存在且格式正确，并且使用 `npm start` 而不是直接 `node`。

**识别器/注入器 LLM 调用失败**

通常是 API 配额不足或网络问题，等一段时间后会自动恢复。查看 `/quota` 接口了解配额状态。
