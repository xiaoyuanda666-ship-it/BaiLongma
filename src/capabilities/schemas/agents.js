// Agent 委派 / 工具市场类 schema：delegate_to_agent / grant_agent_delegation /
// install_tool / uninstall_tool / list_tools / manage_tool_factory
export const agentsSchemas = {
  delegate_to_agent: {
    type: 'function',
    function: {
      name: 'delegate_to_agent',
      description: '将子任务委托给另一个本地 AI Agent 执行。仅在已获得用户授权（agent_delegation_allowed）时可用。适合代码开发、自动化任务等超出自身能力范围的场景。调用前必须通过 send_message 告知用户你打算让谁做什么。',
      parameters: {
        type: 'object',
        properties: {
          agent_id: {
            type: 'string',
            description: 'Agent ID，如 claude-code、codex、hermes、openclaw。',
            enum: ['claude-code', 'codex', 'hermes', 'openclaw']
          },
          prompt: {
            type: 'string',
            description: '发送给目标 Agent 的完整任务指令，应包含足够的上下文。'
          },
          context: {
            type: 'string',
            description: '可选：附加背景信息，会拼接到 prompt 前面。'
          },
          timeout: {
            type: 'number',
            description: '等待 Agent 响应的超时秒数，默认 60，最大 300。'
          }
        },
        required: ['agent_id', 'prompt']
      }
    }
  },

  grant_agent_delegation: {
    type: 'function',
    function: {
      name: 'grant_agent_delegation',
      description: '记录用户对 Agent 委托权限的决定。当用户明确表示同意或拒绝让 Jarvis 指挥其他 AI 小伙伴工作时调用此工具落盘。只调用一次，之后不再重复询问。',
      parameters: {
        type: 'object',
        properties: {
          allowed: {
            type: 'boolean',
            description: 'true 表示用户同意授权，false 表示用户拒绝。'
          },
          note: {
            type: 'string',
            description: '可选：用户原话或简短备注。'
          }
        },
        required: ['allowed']
      }
    }
  },

  install_tool: {
    type: 'function',
    function: {
      name: 'install_tool',
      description: 'Directly install a new tool and register it for future turns. This is a high-risk direct path: for tools you wrote yourself, prefer manage_tool_factory propose -> review -> install so runtime checks and tests gate the install. Tool code is an async function body with variables args and helpers. helpers.fetch and helpers.exec require explicit permissions.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '工具名称，只能含小写字母、数字、下划线，以字母开头，长度 2-50。如 "weather_query"。'
          },
          description: {
            type: 'string',
            description: '工具描述：说明这个工具做什么、何时该调用它。'
          },
          parameters_schema: {
            type: 'object',
            description: 'JSON Schema 对象，描述工具的输入参数。格式：{ "type": "object", "properties": { ... }, "required": [...] }'
          },
          code: {
            type: 'string',
            description: 'async 函数体代码（不含 async function 声明头）。示例：const { text } = args; return text.trim();'
          },
          permissions: {
            type: 'object',
            description: 'Optional capability declaration. Defaults to { network:false, exec:false }. Set network:true only when helpers.fetch is required. Set exec:true only for explicitly user-approved tools that must run shell commands.',
            properties: {
              network: { type: 'boolean', description: 'Allow helpers.fetch / network access.' },
              exec: { type: 'boolean', description: 'Allow helpers.exec shell command execution.' }
            }
          }
        },
        required: ['name', 'description', 'parameters_schema', 'code']
      }
    }
  },

  manage_tool_factory: {
    type: 'function',
    function: {
      name: 'manage_tool_factory',
      description: 'Managed tool factory for self-authored function-call tools. Use this instead of direct install_tool when you write a tool yourself. Flow: action="propose" with schema/code/tests -> action="review" to run runtime safety checks and tests -> action="install" only if approved. Review sees only the artifact package and deterministic policy/test results, not the builder context.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['propose', 'review', 'install', 'get', 'list', 'delete'],
            description: 'Factory action.'
          },
          proposal_id: {
            type: 'string',
            description: 'Proposal id returned by propose. Required for review/install/get/delete.'
          },
          name: {
            type: 'string',
            description: 'Tool name for propose: lowercase letters, digits, underscores, 2-50 chars, starts with a letter.'
          },
          description: {
            type: 'string',
            description: 'Tool description for propose: what the tool does and when to call it.'
          },
          parameters_schema: {
            type: 'object',
            description: 'JSON Schema object for tool input parameters. Required for propose.'
          },
          permissions: {
            type: 'object',
            description: 'Capability declaration. Managed generated tools default to no network and no exec; exec is rejected by the managed review gate.',
            properties: {
              network: { type: 'boolean', description: 'Request network access. Tests still run with network disabled.' },
              exec: { type: 'boolean', description: 'Request shell execution. Managed review rejects this in the first version.' }
            }
          },
          code: {
            type: 'string',
            description: 'async function body using args and helpers. Do not include function wrapper. Must return a string or JSON-serializable result.'
          },
          tests: {
            type: 'array',
            description: 'Required for propose. Runtime tests run in a separate Node process with network/exec disabled. Each test can assert exact result, substring, or parsed JSON.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Test name.' },
                args: { type: 'object', description: 'Arguments passed to the generated tool.' },
                expect: { description: 'Exact expected raw return value.' },
                expected_result: { description: 'Alias for expect.' },
                expect_contains: { type: 'string', description: 'Substring expected in the raw return value.' },
                expect_json: { type: 'object', description: 'Expected parsed JSON object if the tool returns JSON text.' }
              }
            }
          }
        },
        required: ['action']
      }
    }
  },

  uninstall_tool: {
    type: 'function',
    function: {
      name: 'uninstall_tool',
      description: '卸载一个已安装的工具，立即生效，同时删除其持久化文件。',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '要卸载的工具名称。'
          }
        },
        required: ['name']
      }
    }
  },

  list_tools: {
    type: 'function',
    function: {
      name: 'list_tools',
      description: '列出所有可用工具（内置 + 已安装），含名称、描述、来源。适合安装前确认是否已存在、或排查工具问题。',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
}
