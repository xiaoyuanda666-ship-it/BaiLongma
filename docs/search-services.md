# 搜索服务

Agent 始终调用 `web_search`，聊天模型与搜索连接独立。现有 DeepSeek、OpenAI 搜索适配器已迁入 `src/search/`，旧导入路径保留兼容转发。

## 用户配置

“设置 → 搜索服务”支持添加多个连接、专用 API Key、复用官方模型凭证、启停、切换默认、场景规则和备用顺序。本页明确保存，测试按钮会向选中的已保存服务发起一次固定公开查询，可能产生服务费用。测试不发送聊天内容。

DeepSeek、OpenAI 官方模型连接自动发现为 `llm-deepseek`、`llm-openai`。模型 Key 更新后搜索使用新凭证；切换聊天模型不会改变搜索默认。关闭或移除自动发现的连接会保留禁用记录。OpenAI 搜索模型可独立设置。

首版支持官方 HTTPS 地址。第三方模型代理不会自动复用凭证；自定义网关需要实现或明确扩展适配器的协议与地址校验。元宝首版采用服务 API Key，不支持腾讯云 SecretId/SecretKey 签名方式。

连接配置保存在用户目录 `search-services.json`；专用 Key 加密后保存在程序数据库 `data/jarvis.db` 的 `search_service_secrets` 表，配置响应和配置文件不包含 Key。沿用系统钥匙串或 AES-256-GCM 加密；旧凭证文件中的搜索 Key 在数据库提交成功后自动迁移并移除，其他类型凭证保持原有存储。空白 Key 保留原值，移除专用连接删除对应密钥；API 的 `clearKey: true` 可清除密钥。引用模型凭证不会删除模型 Key。

## 路由

顺序为本次 `provider` → 运行时 `searchProvider` 任务偏好 → 第一条匹配规则 → 默认连接 → 自动选择第一个配置就绪的启用连接。

- `provider` 使用稳定连接 ID；`deepseek` / `openai` 等适配器名作为兼容别名，匹配第一个启用连接。多账号时使用 ID。
- 语言规则支持 `zh` / `en`；未提供语言时依据查询是否含汉字判断。
- 主题规则匹配工具参数 `topic`：`general`、`news`、`technical`、`academic`。模型负责提供主题提示。
- 域名规则匹配 `domains` 参数及其子域名，不猜测查询词中的网址。
- 规则按列表顺序取第一条；本次查询和上下文不会修改长期偏好。
- 备用切换默认关闭。启用后仅在自动路由发生超时、网络故障、408/429/5xx 或可重试业务错误时尝试指定连接，每个连接最多一次，备用最多五个。
- 显式选择及任务固定偏好不自动切换。认证、参数、能力不匹配、无密钥、空结果不触发故障切换；取消立即结束。

## 能力与证据

`need_content` 是正文偏好；`require_content` 是严格要求，不支持正文的服务会在请求前失败，返回空正文也会失败。搜索层不自动启动浏览器。

DeepSeek 支持返回正文；OpenAI 返回联网回答及引用；腾讯元宝的 `passage` 和 `content` 分别是标准摘要、动态摘要，统一标为 `search_snippet`。

元宝首版使用所有套餐通用的查询字段；单个域名通过 `Site` 下推，多个域名在本地过滤。日期范围也在本地过滤，无时区日期保持 unknown，返回警告说明召回和时区限制。不假装支持完整日期检索或保证指定条数。

返回值包含实际连接 `provider`、协议 `adapter`、`selection_reason`、`fallback_used`、`attempts`、能力、约束、来源和警告。`content_retrieved` 表示内容获取，不保证事实正确；旧证据消费者仍兼容历史 `verified` 字段。

搜索 HTTP 有独立的 30 秒单次超时，不计入聊天 RPM/TPM；按连接统计请求、失败和服务返回的 Token 用量。统计只覆盖当前进程，不是账单或限流器。

## 模块与接口

- `connections.js`：配置验证、凭证引用与自动发现。
- `secret-store.js`：数据库加密密钥、旧数据迁移与事务回滚。
- `registry.js` / `adapters/`：服务协议和能力声明。
- `router.js`：纯路由规则。
- `http.js`：取消、超时、错误分类、脱敏与用量统计。
- `normalize.js`：查询检查、来源过滤、正文预算与结果规范化。
- `service.js`：工具执行与备用尝试。

`GET /settings/search` 返回脱敏配置和本进程用量；`POST /settings/search` 保存完整配置；`POST /settings/search/test` 显式测试一个连接。三者都使用现有本机/Token 权限检查。

添加服务需实现 `search(connection, request, context)` 和 `capabilities`，注册 preset，并确认鉴权地址、摘要/正文语义、日期和域名约束。不能仅修改 Base URL 就宣称兼容。

## 验证

```bash
npm run test:search-services
npm run test:search-settings-ui
npm run check:agent-layers
```

界面测试使用隔离 Electron 窗口和模拟设置接口；服务测试使用临时用户目录和模拟提供商，不需要真实 Key。涉及 SQLite 的完整回归应使用项目 Electron 的 Node 运行时，避免本机 Node 与原生模块 ABI 不匹配。

协议依据：

- [DeepSeek Search](https://api-docs.deepseek.com/guides/search/)
- [腾讯元宝服务 API Key](https://cloud.tencent.cn/document/product/1806/130615)
- [腾讯元宝 SearchPro 字段](https://cloud.tencent.com/document/api/1806/121811)
