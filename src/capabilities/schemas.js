// 所有工具的 schema 定义
export const TOOL_SCHEMAS = {
  express: {
    type: 'function',
    function: {
      name: 'express',
      description: '向指定 ID 的个体表达内容。这是行为层与外界通讯的唯一出口。可选择表达形式：text（文字）或 voice（语音）。',
      parameters: {
        type: 'object',
        properties: {
          target_id: {
            type: 'string',
            description: '接收方的 ID，格式如 ID:000001'
          },
          content: {
            type: 'string',
            description: '要表达的内容'
          },
          format: {
            type: 'string',
            enum: ['text', 'voice'],
            description: '表达形式，默认 text'
          }
        },
        required: ['target_id', 'content']
      }
    }
  },

  send_message: {
    type: 'function',
    function: {
      name: 'send_message',
      description: '向指定 ID 的个体发送消息。所有对外通讯必须通过此工具，不可直接输出回复内容。',
      parameters: {
        type: 'object',
        properties: {
          target_id: {
            type: 'string',
            description: '接收方的 ID，格式如 ID:000001'
          },
          content: {
            type: 'string',
            description: '消息内容'
          }
        },
        required: ['target_id', 'content']
      }
    }
  },

  read_file: {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取指定路径的文件内容。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '文件的绝对路径或相对路径'
          }
        },
        required: ['path']
      }
    }
  },

  list_dir: {
    type: 'function',
    function: {
      name: 'list_dir',
      description: '列出指定目录下的文件和文件夹。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '目录路径，默认为当前目录'
          }
        },
        required: []
      }
    }
  },

  write_file: {
    type: 'function',
    function: {
      name: 'write_file',
      description: '将内容写入指定文件。文件不存在时自动创建。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '文件路径'
          },
          content: {
            type: 'string',
            description: '要写入的内容'
          }
        },
        required: ['path', 'content']
      }
    }
  },

  web_search: {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for current or unknown information. Use this before fetch_url when you do not already know the exact reliable URL. Returns structured JSON with result titles, URLs, snippets, and ok/error status.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query. Be specific, include product/version/date keywords when relevant.'
          },
          limit: {
            type: 'number',
            description: 'Maximum results to return, default 5, max 8.'
          }
        },
        required: ['query']
      }
    }
  },

  fetch_url: {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Open a known URL with a lightweight HTTP request. Returns structured JSON with ok/status/title/content/body_path/error. Long articles (>=2000 chars) are auto-saved to sandbox/articles/ and content is truncated to a short excerpt; use the returned body_path with read_file to open the full text. Do not use this tool as a search engine. If ok is false because content is empty, blocked, or JS-rendered, try browser_read or another URL; never summarize an error as page content.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'URL to open. Prefer reliable source pages found through web_search.'
          }
        },
        required: ['url']
      }
    }
  },

  browser_read: {
    type: 'function',
    function: {
      name: 'browser_read',
      description: 'Use a real headless Chromium browser to open and render a webpage, wait for JavaScript, scroll, and extract readable text. Use this when fetch_url returns no readable content, a waiting page, or a JS-rendered page. Returns structured JSON with ok/title/content/body_path/error. Long articles (>=2000 chars) are auto-saved to sandbox/articles/ and content is truncated to a short excerpt; use body_path with read_file to open the full text.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'URL to open in the browser.'
          },
          timeout_ms: {
            type: 'number',
            description: 'Navigation/render timeout in milliseconds, default 20000, max 45000.'
          },
          max_chars: {
            type: 'number',
            description: 'Maximum extracted characters to return, default 8000, max 12000.'
          }
        },
        required: ['url']
      }
    }
  },

  delete_file: {
    type: 'function',
    function: {
      name: 'delete_file',
      description: '删除 sandbox 内的文件或目录。目录会递归删除。系统文件（readme.txt、world.txt）不可删除。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '要删除的文件或目录路径（sandbox 内相对路径）' }
        },
        required: ['path']
      }
    }
  },

  make_dir: {
    type: 'function',
    function: {
      name: 'make_dir',
      description: '在 sandbox 内创建目录，支持多级目录（如 projects/myapp/src）。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '要创建的目录路径' }
        },
        required: ['path']
      }
    }
  },

  exec_command: {
    type: 'function',
    function: {
      name: 'exec_command',
      description: 'Run a shell command inside the sandbox directory. Returns structured JSON with ok, mode, exit_code, stdout, stderr, timed_out, pid, and error. Use background=true for long-running servers; otherwise wait for completion and inspect ok/exit_code before continuing.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令，如 "node server.js"、"npm install"、"python main.py"' },
          background: { type: 'boolean', description: '是否后台运行，默认 false。启动服务器时设为 true。' },
          timeout: { type: 'number', description: '前台执行的超时秒数，默认 30，最大 120。' }
        },
        required: ['command']
      }
    }
  },

  kill_process: {
    type: 'function',
    function: {
      name: 'kill_process',
      description: 'Stop a background process by PID. Returns structured JSON with ok, pid, command, stopped, or error.',
      parameters: {
        type: 'object',
        properties: {
          pid: { type: 'number', description: '要停止的进程 PID' }
        },
        required: ['pid']
      }
    }
  },

  list_processes: {
    type: 'function',
    function: {
      name: 'list_processes',
      description: 'List current background processes. Returns structured JSON with ok, count, and processes.',
      parameters: { type: 'object', properties: {} }
    }
  },

  speak: {
    type: 'function',
    function: {
      name: 'speak',
      description: '将文字转化为语音，保存为音频文件。这是声音的出口——可以朗读自己的思考、诗句、或任何想用声音表达的内容。文字长度请控制在 500 字以内。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要转化为语音的文字内容' },
          voice_id: { type: 'string', description: '声音 ID，可选。可用值：male-qn-qingse（青涩男声）、male-qn-jingying（精英男声）、male-qn-badao（霸道男声）、female-shaonv（少女）、female-yujie（御姐）、female-chengshu（成熟女声）、presenter_male（男主播）、presenter_female（女主播）。默认 male-qn-qingse。' },
          filename: { type: 'string', description: '保存的文件名（不含扩展名），可选' },
        },
        required: ['text']
      }
    }
  },

  generate_lyrics: {
    type: 'function',
    function: {
      name: 'generate_lyrics',
      description: '根据创作方向生成一首完整的歌词，包含标题、风格标签和歌词结构。生成后自动保存到 sandbox/lyrics/ 目录。可以将生成的歌词用于 generate_music。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '歌词的创作方向、主题或情感描述' },
          mode: { type: 'string', description: '模式：write_full_song（默认，生成完整歌词）' },
        },
        required: ['prompt']
      }
    }
  },

  set_tick_interval: {
    type: 'function',
    function: {
      name: 'set_tick_interval',
      description: '调节自己的思维节奏——设置下一段时间内 TICK 的间隔。紧急或在处理重要事务时可设短（如 3 秒），空闲或沉思时可设长（如 600 秒）。seconds 范围 [2, 3600]，ttl 范围 [1, 50]（持续多少轮自动回归默认）。越界会被自动 clamp。',
      parameters: {
        type: 'object',
        properties: {
          seconds: { type: 'number', description: 'TICK 间隔秒数，[2, 3600]' },
          ttl: { type: 'number', description: '持续轮数，[1, 50]。到期自动回归默认节奏。不传默认 10。' },
          reason: { type: 'string', description: '简短理由，供自己之后回看。可选。' },
        },
        required: ['seconds']
      }
    }
  },

  manage_reminder: {
    type: 'function',
    function: {
      name: 'manage_reminder',
      description: '管理提醒：创建（一次性 / 每天 / 每周几 / 每月几号）、列出、取消。到时系统会主动给你发系统消息让你继续执行。同 target_id + 同分钟的一次性提醒会自动合并任务，不会重复触发。创建后要 send_message 告诉用户。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'list', 'cancel'],
            description: 'create=新建提醒；list=列出所有待触发提醒；cancel=按 id 取消'
          },
          kind: {
            type: 'string',
            enum: ['once', 'daily', 'weekly', 'monthly'],
            description: '仅 create 用：once=一次性（必须给 due_at）；daily=每天（给 time）；weekly=每周（给 time + weekday）；monthly=每月（给 time + day_of_month）。默认 once。'
          },
          task: {
            type: 'string',
            description: '仅 create 用：到时间后你要执行的事项'
          },
          target_id: {
            type: 'string',
            description: '仅 create 用：这条提醒最终服务的用户 ID，例如 ID:000001；默认使用当前对话对象'
          },
          due_at: {
            type: 'string',
            description: '仅 kind=once 用：提醒触发时间，必须是绝对时间 ISO 8601 字符串，例如 2026-04-21T06:00:00+08:00'
          },
          time: {
            type: 'string',
            description: '仅 daily/weekly/monthly 用：每天/每周/每月的触发时间，HH:MM 格式（按本地时区），例如 09:00'
          },
          weekday: {
            type: 'integer',
            description: '仅 kind=weekly 用：星期几，0=周日，1=周一，...，6=周六',
            minimum: 0,
            maximum: 6
          },
          day_of_month: {
            type: 'integer',
            description: '仅 kind=monthly 用：每月几号，1-31。如果某月没有该日（例如 31 号），会跳到下一个有该日的月份',
            minimum: 1,
            maximum: 31
          },
          id: {
            type: 'integer',
            description: '仅 cancel 用：要取消的提醒 id（从 list 里查）'
          }
        },
        required: ['action']
      }
    }
  },

  manage_prefetch_task: {
    type: 'function',
    function: {
      name: 'manage_prefetch_task',
      description: '管理预热任务——系统会在每次启动前自动 fetch 这些 URL 并注入到上下文里，无需再调 fetch_url。适合定期要查的内容（天气、新闻、价格等）。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['add', 'remove', 'list'],
            description: 'add=添加或更新任务，remove=删除任务，list=查看所有任务',
          },
          source: {
            type: 'string',
            description: '任务唯一标识，建议格式如 "weather:Beijing"、"news:36kr"。add/remove 时必填。',
          },
          label: {
            type: 'string',
            description: '任务显示名称，如"北京天气"。add 时必填。',
          },
          url: {
            type: 'string',
            description: '要预热的 URL。add 时必填。',
          },
          ttl_minutes: {
            type: 'number',
            description: '缓存有效期（分钟），默认 60。天气建议 60，新闻建议 30，日历建议 720。',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: '标签，如 ["weather", "Beijing"]，方便检索。',
          },
        },
        required: ['action'],
      },
    },
  },

  generate_music: {
    type: 'function',
    function: {
      name: 'generate_music',
      description: '根据描述和歌词生成一段音乐，保存为音频文件。可以先用 generate_lyrics 生成歌词，再传入此工具创作完整的歌曲。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '音乐风格和情感的描述，如"忧郁的钢琴曲"、"欢快的流行歌曲"' },
          lyrics: { type: 'string', description: '歌词内容，可选。不提供则生成纯音乐（配合 instrumental: true）' },
          instrumental: { type: 'boolean', description: '是否生成纯器乐（无人声），默认 false' },
        },
        required: ['prompt']
      }
    }
  },

  search_memory: {
    type: 'function',
    function: {
      name: 'search_memory',
      description: '按多个关键词批量检索记忆库（FTS5 全文搜索）。每个关键词独立命中后合并去重，每条结果带 matched_by 字段标注命中关键词。识别器在写入新记忆前必须先调用此工具查重，命中已有 mem_id 则走 update，未命中则 insert。',
      parameters: {
        type: 'object',
        properties: {
          keywords: {
            type: 'array',
            items: { type: 'string' },
            description: '关键词列表，1-8 个。建议同时给中英文/同义词以提高召回。'
          },
          limit_per_keyword: {
            type: 'number',
            description: '每个关键词最多返回几条命中，默认 5。'
          },
          type_filter: {
            type: 'string',
            enum: ['fact', 'person', 'object', 'knowledge', 'article'],
            description: '可选：限定记忆类型。'
          }
        },
        required: ['keywords']
      }
    }
  },

  upsert_memory: {
    type: 'function',
    function: {
      name: 'upsert_memory',
      description: '批量写入或更新记忆节点。按 mem_id 去重：mem_id 命中已存在则 PATCH（未传字段保留），不存在则 INSERT。调用前应先用 search_memory 查重以决定 mem_id。命名规则：person_{ID}、object_{slug}、article_{url_hash8}、concept_{snake}、fact_{snake}。',
      parameters: {
        type: 'object',
        properties: {
          memories: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                mem_id:        { type: 'string', description: '稳定 ID，遵循命名规则。' },
                type:          { type: 'string', enum: ['fact', 'person', 'object', 'knowledge', 'article'], description: '记忆类型，新建必填。' },
                title:         { type: 'string', description: '标题。文章直接用文章标题。新建必填。' },
                content:       { type: 'string', description: '摘要 / 简要，<= 200 字。新建必填。' },
                detail:        { type: 'string', description: '可选：更详细说明。' },
                tags:          { type: 'array', items: { type: 'string' }, description: '可选：标签数组。' },
                parent_mem_id: { type: 'string', description: '可选：父节点 mem_id。' },
                links:         {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      target_mem_id: { type: 'string' },
                      relation:      { type: 'string', description: '如 related_to / cites / contradicts' }
                    }
                  },
                  description: '可选：与其他记忆节点的关联。'
                },
                body_path:     { type: 'string', description: 'article 类型：正文文件路径（来自 fetch_url / browser_read 的 body_path）。' }
              },
              required: ['mem_id']
            },
            description: '一次性批量写入的记忆数组，支持 1-N 条。'
          }
        },
        required: ['memories']
      }
    }
  },

  skip_recognition: {
    type: 'function',
    function: {
      name: 'skip_recognition',
      description: '识别器专用：当本轮输入没有值得长期保存的记忆时调用，明确表示"已检阅，无须写入"。这是合法的终止信号，不要硬塞内容。',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: '可选：简短理由。' }
        }
      }
    }
  },
}

// 根据名称列表获取 schema 数组
export function getToolSchemas(toolNames) {
  return toolNames
    // `express` remains as a backward-compatible executor alias,
    // but we don't expose it to the model. The model should use
    // `send_message` for outbound text messages.
    .filter(name => name !== 'express' && TOOL_SCHEMAS[name])
    .map(name => TOOL_SCHEMAS[name])
}
