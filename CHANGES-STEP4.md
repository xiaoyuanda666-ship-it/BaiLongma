# 工具按需注入

动态上下文记忆池改造第 4 步：把每轮注入的 LLM tools schema 从「~35 个全量」
改为「按消息意图 + 上下文标志选择性注入」，目标是降低 system+tools 部分的
token 占用。

## 改动文件

- `src/memory/tool-router.js`（新增）— `selectTools(ctx)` 工具选择器，按领域
  分组 + 关键词匹配 + ActionLog 保活 + Fallback 安全网。
- `src/memory/injector.js` — 替换 `runInjector` 末尾约 30 行 baseTools/条件
  追加逻辑为一次 `selectTools(ctx)` 调用；mmCaps/installedNames/isTick 等
  通过 ctx 参数透传。
- `src/test-tool-router.js`（新增）— 17 个测试 case 覆盖：filesystem/web/
  reminder/exec/media/admin/person_card 各分组关键词、fallback 安全网、
  TICK 广注入、hasTask/hasRecall/startupSelfCheckActive 各种条件、mmCaps
  gate、ActionLog 保活、installedTools 全注入。全部 PASS。

## 分组结构

| 组 | 触发条件 |
|---|---|
| `core` (7) | always — send_message / recall_memory / ui_show 系列 |
| `task_ctrl` | hasTask → full 3 件；否则只 set_task |
| `memory` | senderId / hasRecall / isTick |
| `web` (3) | 关键词命中 OR isTick |
| `filesystem` (5) | 关键词命中 |
| `exec` (3) | 关键词命中 |
| `media` (2) | 关键词命中 |
| `multimodal_gen` | mmCaps 已配 **AND** 关键词命中（双门控） |
| `reminders` | 关键词命中 OR isTick |
| `prefetch` | 关键词命中 OR isTick |
| `ticker` | 关键词命中 OR isTick |
| `hotspot` | 关键词命中 OR isTick |
| `person_card` | 关键词命中 |
| `focus_banner` | 关键词命中 OR hasTask |
| `admin` (8) | 关键词命中（最严格，避免装/卸/连/改名等敏感动作误触发） |
| `installed` | 用户安装的扩展工具永远全注入 |
| `startup_check` | startupSelfCheckActive |

## 预估 token 节省

| 场景 | 注入工具数 | 估算 tokens（@200/工具） |
|---|---|---|
| 改造前（全量） | 35-40 | ~7000-8000 |
| 改造后 worst-case（所有组关键词都命中） | 31 | ~6200 |
| 改造后 minimal-case（fallback 兜底触发） | 17 | ~3400 |
| 典型短问（"prompt cache 是什么"） | ~12-15 | ~2400-3000 |
| 典型长问（含 fetch/读文件） | ~17-22 | ~3400-4400 |

主对话首轮预计从 17-18K tokens 降到 13-14K tokens（约 20-25% 节省）。
实测需要主仓 merge 后跑端到端验证。

## 已知边界 case

1. **关键词反语**：如"没说画图"含 "画图" 子串—— 解决方案是删掉容易反语
   命中的弱触发词，保留更强限定的词组（如"画一张" / "帮我画"）。
   IMAGE_GEN_TRIGGERS 已经做了这种打磨；其他组若发现类似问题同样处理。
2. **跨轮工作流**：agent 上一轮调了 fetch_url，下一轮关键词没命中时
   ActionLog 保活机制会强制注入最近 10 次用过的工具，保证链路不断。
3. **过度激进风险**：宁可多注入也不能漏注入——所有边界 case 倾向"再加一组"
   而不是"省一组"。Fallback 安全网（< 12 个工具时补 web + filesystem）
   是最后一道兜底。
4. **fastUserPath 留接口未启用**：ctx 接受 fastUserPath 参数，但当前 runInjector
   暂不传——保持向后兼容。后续 step 可以扩展。

## 用户审查重点

1. `src/memory/tool-router.js` 关键词集（FILESYSTEM_TRIGGERS / EXEC_TRIGGERS / ...）
   是否符合你的日常用语习惯。中文表达多样，列表可能漏几个常用说法。
2. `src/memory/injector.js` 末尾的 selectTools 调用参数是否完整—— 漏传字段
   会导致工具组被错误省略。
3. Fallback 阈值 `out.size < 12` 是否合理。可以调高更保守、调低更激进。
