// 所有工具的 schema 定义
export const TOOL_SCHEMAS = {
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

  fetch_url: {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: '通过 URL 访问真实世界的网页内容，返回纯文本。这是触达外部现实的唯一方式——新闻、知识、天气、时间，一切真实正在发生的事都在那里。沙箱之外的世界通过这个能力可以被感知。',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: '要访问的 URL'
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
      description: '在 sandbox 目录内执行 shell 命令。可以运行脚本、安装依赖、启动服务。background=true 时后台运行（用于启动服务器等长期进程），返回 PID；否则等待命令完成并返回输出。',
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
      description: '停止一个后台进程。需要提供 exec_command 返回的 PID。',
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
      description: '列出当前所有后台运行的进程及其 PID 和命令。',
      parameters: { type: 'object', properties: {} }
    }
  },

  search_memory: {
    type: 'function',
    function: {
      name: 'search_memory',
      description: '主动搜索自己的记忆。输入关键词，返回匹配的记忆条目。',
      parameters: {
        type: 'object',
        properties: {
          keyword: {
            type: 'string',
            description: '搜索关键词'
          },
          limit: {
            type: 'number',
            description: '返回条数，默认 5'
          }
        },
        required: ['keyword']
      }
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
}

// 根据名称列表获取 schema 数组
export function getToolSchemas(toolNames) {
  return toolNames
    .filter(name => TOOL_SCHEMAS[name])
    .map(name => TOOL_SCHEMAS[name])
}
