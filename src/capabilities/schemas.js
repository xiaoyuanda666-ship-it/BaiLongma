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
      description: '将文字转化为语音，保存为音频文件。仅用于创作性内容（诗句、散文、旁白、歌词朗读等），不要用于普通的对话回复——对话语音回复由系统自动处理，无需调用此工具。文字长度请控制在 500 字以内。',
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

  media_mode: {
    type: 'function',
    function: {
      name: 'media_mode',
      description: `控制 brain-ui 的媒体舞台。video 从右侧打开，image 从左侧打开，music 从右侧弹出唱片机卡片。
视频 URL 规则（重要，违反会导致黑屏）：
  - YouTube：必须使用完整 watch URL（https://www.youtube.com/watch?v=xxx）或 youtu.be 短链。只传 videoId 字符串无效。必须是公开可嵌入的视频（非私有、非区域限制、非需登录）。
  - Bilibili：必须包含 BV 号（https://www.bilibili.com/video/BVxxxxx）。
  - 直链视频：必须是可直接访问的 .mp4/.webm 等格式 URL，需确认链接有效且允许跨域。
  - 严禁：不要传推测出来的 URL；不要传无法访问的私有视频；不要传平台分享页但非嵌入页的链接。
  - 建议：在 search 工具里先找到并确认视频存在后，再调用 media_mode。优先选择官方频道、播放量高的公开视频。
按 V 键只是暂停并收起面板（内容保留），close/hide action 才真正销毁视频。
音乐模式规则：
  - src 传本地文件绝对路径（用 file:// 前缀）或 HTTP 直链音频。播放前先用 list_directory 或 search_files 确认文件存在。
  - lrc 是可选的 LRC 格式歌词文本（[mm:ss.xx]歌词行），有就传，没有留空即可。
  - 播放音乐时不需要回复消息，直接调用工具执行即可。
  - 按 M 键收起/展开面板。`,
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['video', 'camera', 'image', 'music'], description: 'video=右侧视频模式；camera=右侧摄像头视频；image=左侧图片模式；music=右侧唱片机音乐模式' },
          action: { type: 'string', enum: ['show', 'hide', 'close', 'play', 'pause', 'seek', 'set_volume', 'update'], description: 'show 显示/加载媒体；hide/close 关闭并销毁；play/pause 控制播放；seek 跳转；set_volume 调音量' },
          url: { type: 'string', description: '媒体 URL（video/image 用）。必须是完整可访问 URL，参见工具描述规则' },
          src: { type: 'string', description: '音频文件路径（music 模式用）。本地文件用 file:///绝对路径，或 HTTP 直链' },
          title: { type: 'string', description: '媒体标题，可选' },
          artist: { type: 'string', description: '艺术家/歌手名（music 模式用），可选' },
          lrc: { type: 'string', description: 'LRC 格式歌词文本（music 模式用），可选。格式：[mm:ss.xx]歌词行' },
          cover: { type: 'string', description: '封面图片路径或 URL（music 模式用），可选' },
          alt: { type: 'string', description: '图片替代说明，可选' },
          autoplay: { type: 'boolean', description: '是否自动播放，默认 true' },
          muted: { type: 'boolean', description: '是否静音直链视频，默认 false' },
          volume: { type: 'number', description: '音量 0-1' },
          currentTime: { type: 'number', description: '跳转到的秒数' },
          camera: { type: 'boolean', description: 'mode=video 时显式打开摄像头；默认 false' },
        },
        required: ['mode']
      }
    }
  },

  music: {
    type: 'function',
    function: {
      name: 'music',
      description: `管理和播放本地音乐库。音乐文件存放在 music 目录下。
支持的操作：
  - list：列出音乐库所有曲目（含 id、title、artist、file_path）
  - search：按歌曲名或艺术家名搜索
  - download：用 yt-dlp 从 YouTube/BiliBili URL 下载为 mp3 并入库。下载后自动尝试获取歌词。
  - add：把已存在的本地音频文件（mp3/flac/wav/aac）添加到库
  - scan：扫描 music 目录，把所有音频文件批量入库
  - get_lyrics：从 lrclib.net 获取 LRC 格式歌词并保存到库（需要 title + artist）
  - delete：按 id 从库中移除曲目（不删除实际文件）
播放时：用 media_mode 工具（mode=music，src=文件路径）弹出唱片机。播放前不需要发消息给用户，直接执行即可。`,
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'search', 'download', 'add', 'scan', 'get_lyrics', 'delete'], description: '操作类型' },
          query:  { type: 'string', description: 'search 时的搜索词（歌名或艺术家）' },
          url:    { type: 'string', description: 'download 时的 YouTube/BiliBili URL' },
          path:   { type: 'string', description: 'add 时的本地音频文件绝对路径' },
          title:  { type: 'string', description: '曲目名称，add/download/get_lyrics 时可提供' },
          artist: { type: 'string', description: '艺术家名，add/download/get_lyrics 时可提供' },
          album:  { type: 'string', description: '专辑名，可选' },
          id:     { type: 'number', description: 'get_lyrics/delete 时指定曲目 id' },
          limit:  { type: 'number', description: 'list/search 返回条数上限，默认 50' },
        },
        required: ['action']
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

  generate_image: {
    type: 'function',
    function: {
      name: 'generate_image',
      description: '根据文字描述生成一张图片。图片生成每日限额 50 次。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '图片内容描述，越详细越好' },
          aspect_ratio: { type: 'string', description: '宽高比，可选值：1:1（默认）、16:9、4:3、3:4、9:16' },
          n: { type: 'number', description: '生成数量，1-4，默认 1' },
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

  ui_show: {
    type: 'function',
    function: {
      name: 'ui_show',
      description: '在用户界面上推送一张可视化卡片。仅当 UI 表达比纯文字更简洁、更直观时使用——能用一句话说清的事别开卡片。可用组件清单见标记为 skill.ui 的技能记忆；当前内置：WeatherCard。',
      parameters: {
        type: 'object',
        properties: {
          component: { type: 'string', description: '组件类型名，必须在注册表内（如 WeatherCard）' },
          props:     { type: 'object', description: '组件参数，需符合该组件的 propsSchema' },
          hint: {
            type: 'object',
            description: '可选展示提示，控制卡片的形态。所有字段都有合理默认值。',
            properties: {
              placement: { type: 'string', enum: ['notification', 'center', 'floating'], description: 'notification=右上滑入堆叠（通知性，默认）；center=居中带遮罩（重要/需确认）；floating=自由浮动可拖动（工具类/长留）' },
              size:      { description: '尺寸：sm | md | lg | xl，或 { w, h } 像素对象。默认 md。', oneOf: [{ type: 'string', enum: ['sm', 'md', 'lg', 'xl'] }, { type: 'object', properties: { w: { type: ['number', 'string'] }, h: { type: ['number', 'string'] } } }] },
              draggable: { type: 'boolean', description: '是否可拖动。floating 默认 true，其他默认 false。' },
              modal:     { type: 'boolean', description: '是否带半透明遮罩。center 默认 true。' },
              enter:     { type: 'string', description: '入场动画，默认按 placement 推断' },
              exit:      { type: 'string', description: '出场动画，默认按 placement 推断' }
            }
          }
        },
        required: ['component', 'props']
      }
    }
  },

  ui_hide: {
    type: 'function',
    function: {
      name: 'ui_hide',
      description: '关闭一张已显示的卡片（会跑出场动画）。一般情况下让用户自己关，仅在卡片信息已失效时主动调用。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'ui_show 返回的卡片实例 id' }
        },
        required: ['id']
      }
    }
  },

  ui_update: {
    type: 'function',
    function: {
      name: 'ui_update',
      description: '更新一张已显示卡片的内容（不会重放入场动画）。常用：用户问别的城市的天气时改 props，而不是开新卡。',
      parameters: {
        type: 'object',
        properties: {
          id:    { type: 'string', description: 'ui_show 返回的卡片实例 id' },
          props: { type: 'object', description: '新的 props，会与原 props 浅合并' }
        },
        required: ['id', 'props']
      }
    }
  },

  ui_show_inline: {
    type: 'function',
    function: {
      name: 'ui_show_inline',
      description: '当现有组件无法满足表达需求时，临场写一个组件并立刻显示。两种模式：inline-template（仅 HTML+CSS，安全简单）、inline-script（完整 Web Component class，有交互/状态/动画）。优先选 inline-template，能不写 JS 就别写。验证可用且用户停留 dwell 良好后可调 ui_register 把它转正成永久组件。',
      parameters: {
        type: 'object',
        properties: {
          mode:     { type: 'string', enum: ['inline-template', 'inline-script'], description: 'inline-template=纯模板，inline-script=完整 Web Component' },
          template: { type: 'string', description: 'mode=inline-template 必填。纯 HTML 结构字符串，用 ${propName} 占位。绝对不要在 template 里写 <style> 标签——CSS 必须放在 styles 参数里，否则 CSS 代码会被当文字渲染出来。' },
          styles:   { type: 'string', description: 'mode=inline-template 可选但强烈建议填写。所有 CSS 写在这里（不带 <style> 标签，只写规则），系统自动注入 Shadow DOM。不要把 CSS 放进 template。' },
          code:     { type: 'string', description: 'mode=inline-script 必填。须以 export default class extends HTMLElement 开头，含 set props(v) 方法' },
          props:    { type: 'object', description: '组件参数对象。模板没用到字段时可省略，会兜底成空对象。' },
          hint: {
            type: 'object',
            description: '可选展示提示，与 ui_show 的 hint 字段含义一致：placement / size / draggable / modal / enter / exit',
            properties: {
              placement: { type: 'string', enum: ['notification', 'center', 'floating'] },
              size:      { description: 'sm | md | lg | xl 或 { w, h }', oneOf: [{ type: 'string', enum: ['sm', 'md', 'lg', 'xl'] }, { type: 'object' }] },
              draggable: { type: 'boolean' },
              modal:     { type: 'boolean' },
              enter:     { type: 'string' },
              exit:      { type: 'string' }
            }
          }
        },
        required: ['mode']
      }
    }
  },

  manage_app: {
    type: 'function',
    function: {
      name: 'manage_app',
      description: '管理已生成的交互式应用（游戏/工具）：保存为永久应用、重新打开、列出、删除。inline-script 组件在生成时代码已自动落盘为草稿，用 save 提升为正式应用后可随时 open 恢复。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['save', 'open', 'list', 'delete'],
            description: 'save=把 inline-script 草稿保存为永久应用；open=重新挂载已保存的应用（自动恢复上次状态）；list=列出所有已保存应用；delete=删除应用'
          },
          name: {
            type: 'string',
            description: '应用名，英文小写 snake_case，作为存储目录名，如 chess / todo_app。save / open / delete 必填。'
          },
          label: {
            type: 'string',
            description: '可选：中文显示名，如"中国象棋"。save 时填写。'
          },
          draft_id: {
            type: 'string',
            description: 'save 时必填：ui_show_inline 返回的组件实例 id（scratch-xxx）'
          },
          state: {
            type: 'object',
            description: '可选：保存或打开时附带的状态。save 时传当前游戏状态；open 时传则覆盖磁盘上的已存状态。'
          },
          hint: {
            type: 'object',
            description: '可选：UI 展示参数（placement / size / draggable），save 时写入 meta，open 时复用。'
          }
        },
        required: ['action']
      }
    }
  },

  ui_patch: {
    type: 'function',
    function: {
      name: 'ui_patch',
      description: '向已挂载的应用组件发送操作指令或状态更新。组件内通过 this._app.onPatch() 监听。适用于游戏回合、状态机、画布更新等需要 agent 主动推送变化的场景。',
      parameters: {
        type: 'object',
        properties: {
          id:   { type: 'string', description: 'ui_show_inline 或 ui_show 返回的组件实例 id' },
          op:   { type: 'string', description: '操作名，由组件内部定义，如 applyMove、setState、nextRound' },
          data: { type: 'object', description: '操作数据，由组件内部解释' },
        },
        required: ['id', 'op']
      }
    }
  },

  ui_register: {
    type: 'function',
    function: {
      name: 'ui_register',
      description: '把一个已经验证可用的内联组件转为永久组件：写 .js 文件 + 更新 registry + 写 ui-components.json + seed 一条 skill.ui 技能记忆。一般在内联组件成功使用 ≥2 次、用户没有立刻关闭、有 dwell 信号时调用。注册后，下次同类需求直接走 ui_show 就能复用。',
      parameters: {
        type: 'object',
        properties: {
          component_name: { type: 'string', description: 'PascalCase 组件名，未占用，如 TodoCard / VideoPlayer' },
          code:           { type: 'string', description: '完整 Web Component class 代码，须含 static tagName / static propsSchema / static enter / static exit 字段，并以 customElements.define 注册收尾' },
          props_schema:   { type: 'object', description: '与 code 内 propsSchema 一致的对象，用于后端校验镜像（{ field: { type, required } }）' },
          use_case:       { type: 'string', description: '什么时候该用这个组件——会写入 skill.ui 记忆作为命中条件' },
          example_call:   { type: 'string', description: 'ui_show 形式的调用示例' }
        },
        required: ['component_name', 'code', 'props_schema', 'use_case', 'example_call']
      }
    }
  },

  set_task: {
    type: 'function',
    function: {
      name: 'set_task',
      description: '开启一个多步任务。提供任务总目标和具体步骤列表，系统将持久化追踪每步状态，重启后自动恢复。调用后 TICK 节奏加速以持续推进任务。每次只能有一个活跃任务。',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: '任务的总体目标，说明最终要完成什么' },
          steps: {
            type: 'array',
            items: { type: 'string' },
            description: '按顺序执行的具体步骤列表，每步说明要做什么'
          }
        },
        required: ['description', 'steps']
      }
    }
  },

  complete_task: {
    type: 'function',
    function: {
      name: 'complete_task',
      description: '标记当前任务全部完成。将停止加速 TICK，写入完成记录，清除任务状态。所有步骤完成后调用。',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '任务完成情况的简短总结（可选）' }
        },
        required: []
      }
    }
  },

  update_task_step: {
    type: 'function',
    function: {
      name: 'update_task_step',
      description: '更新当前任务某个步骤的完成状态。每完成、失败或跳过一个步骤时立即调用，用于实时追踪进度。',
      parameters: {
        type: 'object',
        properties: {
          step_index: { type: 'number', description: '步骤编号，从 0 开始（第一步为 0，第二步为 1）' },
          status: {
            type: 'string',
            enum: ['done', 'failed', 'skipped'],
            description: '步骤状态：done（完成）、failed（失败）、skipped（跳过）'
          },
          note: { type: 'string', description: '该步骤执行结果的补充说明（可选）' }
        },
        required: ['step_index', 'status']
      }
    }
  },

  recall_memory: {
    type: 'function',
    function: {
      name: 'recall_memory',
      description: '深度检索与指定主题相关的记忆，立即返回结果，并在下一轮持续聚焦此主题。比 search_memory 更深层——不只当场返回结果，还影响下一轮的记忆注入方向。适合需要深入回忆某段经历或某个概念时使用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '想要回忆的内容或主题' }
        },
        required: ['query']
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
