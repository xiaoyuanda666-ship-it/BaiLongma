// run_cli 工具 schema：白名单驱动的本机 CLI 调用入口（exec_command 的受限安全档）。
// description 运行时拼入当前白名单（名+描述），让模型【发现】本机有哪些 CLI 可用。
// 见 .claude/plans/cli-tool-invocation.plan.md M1。
import { listAllowedClis } from '../../cli-whitelist.js'

function allowedClisText(list = listAllowedClis()) {
  if (!list || !list.length) return '(暂无白名单 CLI)'
  return list.map(e => `- ${e.name}${e.description ? ': ' + e.description : ''}`).join('\n')
}

export function buildCliSchemas(list = null) {
  const items = list === null ? listAllowedClis() : list
  return {
    run_cli: {
      type: 'function',
      function: {
        name: 'run_cli',
        description: `Run a whitelisted local CLI — a safer, restricted alternative to exec_command. cmd MUST be one of the allowed CLIs below; non-whitelisted cmds are rejected. args are passed as separate argv tokens (NOT through a shell), so shell metacharacters (; $() backticks) are literal and cannot inject commands. Prefer passing args as an array of tokens. Output is truncated like exec_command. Prefer read-only subcommands in autonomous/TICK contexts.\n\nAvailable CLIs:\n${allowedClisText(items)}`,
        parameters: {
          type: 'object',
          properties: {
            cmd: { type: 'string', description: 'CLI name — must be in the whitelist above.' },
            args: { type: 'array', items: { type: 'string' }, description: 'CLI arguments as separate tokens, e.g. ["search","知识管理"] or ["get","my-page"]. Each token is passed verbatim (no shell parsing). May also be a single string, which is split on whitespace.' },
          },
          required: ['cmd'],
        },
      },
    },
  }
}
