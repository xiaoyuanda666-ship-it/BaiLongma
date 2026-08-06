// UI 类工具 schema：hotspot_mode / worldcup_mode / open_doc_panel /
// person_card_mode / focus_banner
// （声明式 Scene 的 ui_set 在 schemas/scene.js）
export const uiSchemas = {
  browser_clear_data: {
    type: 'function',
    function: {
      name: 'browser_clear_data',
      description: 'Destructively clear selected data from BaiLongma dedicated Google Chrome only. It never accesses the user\'s computer/default Chrome profile. This tool is forbidden unless the CURRENT user message explicitly asks to delete/clear Bailongma\'s, the Agent\'s, or "your" browser data. Never call it when closing the browser, switching sizes, recovering from an error, signing out of a website, or doing routine cleanup. browser_close does not delete profile data. Dedicated-Chrome deletion is all-time only; ask a clarifying question when the requested data types or time range are ambiguous.',
      parameters: {
        type: 'object',
        properties: {
          data_types: {
            type: 'array',
            minItems: 1,
            uniqueItems: true,
            items: { type: 'string', enum: ['history', 'cookies', 'site_data', 'cache'] },
            description: 'Data to delete. Login state usually requires both cookies and site_data. No type is selected implicitly.',
          },
          time_range: {
            type: 'string',
            enum: ['last_hour', 'last_day', 'last_7_days', 'last_30_days', 'all_time', 'custom'],
            description: 'Must be all_time for BaiLongma dedicated Chrome. The user\'s default browser is never in scope.',
          },
          since: {
            type: 'string',
            description: 'ISO-8601 start timestamp; required only when time_range=custom.',
          },
          before: {
            type: 'string',
            description: 'Optional exclusive ISO-8601 end timestamp for a custom history range; defaults to now.',
          },
          origins: {
            type: 'array',
            uniqueItems: true,
            items: { type: 'string' },
            description: 'Optional HTTP(S) origins such as https://example.com. Omit to apply to all sites.',
          },
        },
        required: ['data_types', 'time_range'],
      },
    },
  },

  system_browser_open: {
    type: 'function',
    function: {
      name: 'system_browser_open',
      description: 'Open an HTTP(S) URL in the browser installed on the user\'s computer (the macOS/Windows/Linux default browser). This user-owned surface is completely separate from BaiLongma\'s managed live WebContentsView in card/window mode. Use it only when the user explicitly says "用我电脑上的浏览器", "电脑浏览器", "系统/默认浏览器", or an equivalent phrase. Bailongma cannot inspect, click, or continue controlling that external browser after opening it, and their cookies/history are not shared. Do not use browser_navigate or browser_set_display_mode as a substitute for this explicit request.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'Complete http:// or https:// URL to open in the computer\'s default installed browser.',
          },
        },
        required: ['url'],
      },
    },
  },

  browser_set_display_mode: {
    type: 'function',
    function: {
      name: 'browser_set_display_mode',
      description: 'Explicitly choose the presentation of BaiLongma\'s single live managed WebContentsView without navigating or reloading it. card embeds the live page in Brain UI; window moves the exact same page into a draggable native window with standard controls. URL, history, title, and webContents id remain continuous. Neither mode is the computer\'s default browser. Before the first browser_navigate, snapshot, or page interaction in EVERY user turn, you MUST call this tool and choose card or window; there is no default mode. If a browser tool returns BROWSER_DISPLAY_MODE_REQUIRED, call this tool, then retry the exact blocked action. Use window for user takeover, account login, Google OAuth, QR login, CAPTCHA, video, and careful interaction. The Agent must never enter credentials, MFA, CAPTCHA, or OAuth consent.',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['card', 'window'],
            description: 'card embeds the live managed WebContentsView in Brain UI; window moves that same view into its native window.',
          },
          reason: {
            type: 'string',
            description: 'Optional short reason for switching presentation mode.',
          },
        },
        required: ['mode'],
      },
    },
  },

  capability_demo: {
    type: 'function',
    function: {
      name: 'capability_demo',
      description: 'Start BaiLongma\'s visual and spoken capability showcase. When the user is asking what you/BaiLongma can do, or explicitly requests a capability/function demo/showcase, call this tool; it sends and speaks the intro itself while the visual sequence starts, and returns terminal_delivery=true, so do not send a second introduction. Do not call for ordinary feasibility questions like "这个能做吗" or "能不能做 X". The demo runs as a paced sequence: weather card, streamed Chinese article writing, a maximized real Windows CMD window filling the screen with harmless random numbers for about 5 seconds, hotspot panel, then cleanup.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Short reason why this message is a capability-showcase request.' },
        },
        required: []
      }
    }
  },

  worldcup_mode: {
    type: 'function',
    function: {
      name: 'worldcup_mode',
      description: 'Control the World Cup panel (live scores, schedule and group standings for the FIFA World Cup, data from zhibo8.cc in Beijing time). Open it when the user asks about World Cup matches, scores or schedule and a visual panel helps; close it when asked. status checks current state. While the panel is open, current match data is injected into your context automatically.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['show', 'open', 'hide', 'close', 'toggle', 'status'], description: 'show/open opens the worldcup panel; hide/close closes it; toggle switches it; status only checks state.' },
          reason: { type: 'string', description: 'Optional short reason for opening or closing.' },
        },
        required: ['action']
      }
    }
  },

  typhoon_mode: {
    type: 'function',
    function: {
      name: 'typhoon_mode',
      description: 'Control the typhoon monitoring panel. It visualizes live active-typhoon tracks, intensity, wind circles and forecast tracks from the Central Meteorological Observatory. Open it when the user asks to view typhoon paths or monitoring information; close it when asked. status checks current state.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['show', 'open', 'hide', 'close', 'toggle', 'status'], description: 'show/open opens the typhoon panel; hide/close closes it; toggle switches it; status only checks state.' },
          reason: { type: 'string', description: 'Optional short reason for opening or closing.' },
        },
        required: ['action']
      }
    }
  },

  hotspot_mode: {
    type: 'function',
    function: {
      name: 'hotspot_mode',
      description: 'Control the hotspot panel. Use only when the user explicitly asks, when a demo/roleplay needs it, or when the current task truly needs a visual hotspot scene. Do not proactively open it for ordinary Q&A. status checks current state.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['show', 'open', 'hide', 'close', 'toggle', 'status'], description: 'show/open opens the hotspot panel; hide/close closes it; toggle switches it; status only checks state.' },
          reason: { type: 'string', description: 'Optional short reason for opening or closing.' },
        },
        required: ['action']
      }
    }
  },

  open_doc_panel: {
    type: 'function',
    function: {
      name: 'open_doc_panel',
      description: 'Control the configuration documentation panel. Open it when the user needs voice, model, WeChat, or social-platform configuration help, or explicitly asks to open documentation. Close it when it is open but the conversation is unrelated to any configuration topic. Panel contents are injected as context for 30 minutes.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['open', 'close'],
            description: 'open opens the panel; close closes the panel.'
          },
          topic: {
            type: 'string',
            enum: ['voice_asr', 'voice_tts', 'voice_config', 'model_config', 'wechat_config', 'self_architecture', 'ui_design'],
            description: 'Required when action=open. Choose one topic: voice_asr, voice_tts, voice_config, model_config, wechat_config, self_architecture (how BaiLongma works internally), or ui_design (BaiLongma\'s interface / Scene UI design). Do not invent other values. Optional when action=close.'
          },
          reason: { type: 'string', description: 'Optional short reason.' },
        },
        required: ['action']
      }
    }
  },

  person_card_mode: {
    type: 'function',
    function: {
      name: 'person_card_mode',
      description: 'Intent-gated control for the person-card panel. Call only when the user intent is to identify or understand a named real public figure (for example: who they are, why they are known, their biography), or when the user explicitly asks to show, update, or close the person card. Do not call merely because a person is mentioned. Do not call for feature discussions, code or bug reports about the person-card system, projects, products, fictional/unknown targets, writing requests, or ordinary Q&A. If the intent is uncertain, answer normally without opening the card. Basic verified profile data may update an already intended card.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['show', 'open', 'hide', 'close', 'update', 'toggle', 'status'], description: 'show/open/update opens or updates the person card; hide/close closes it; toggle switches it; status only checks state.' },
          name: { type: 'string', description: 'Person name, e.g. Jay Chou.' },
          title: { type: 'string', description: 'Identity or title, e.g. singer / musician.' },
          summary: { type: 'string', description: 'One or two sentence summary. Avoid inventing uncertain information.' },
          knownFor: { type: 'array', items: { type: 'string' }, description: 'Representative works, events, or recognition points the user most needs.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Short tags, e.g. actor or Mandopop.' },
          aliases: { type: 'array', items: { type: 'string' }, description: 'Aliases, English names, or common nicknames.' },
          image: { type: 'string', description: 'Optional large image URL, preferred for the card hero image.' },
          avatar: { type: 'string', description: 'Optional avatar or person image URL.' },
          reason: { type: 'string', description: 'Optional short reason for opening or closing.' },
        },
        required: ['action']
      }
    }
  },

  knowledge_cortex_mode: {
    type: 'function',
    function: {
      name: 'knowledge_cortex_mode',
      description: 'Intent-gated control for the local Knowledge Cortex browser. Call only when the user wants to browse, manage, inspect, or search their own knowledge regions, document collection, or source evidence, or explicitly asks to show or close this browser. Do not call merely because an ordinary question can be answered from an imported document. Do not call for feature discussions, implementation/code/bug reports about Knowledge Cortex, or normal document-grounded Q&A. If the intent is uncertain, answer normally without opening the browser.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['show', 'open', 'hide', 'close', 'update', 'toggle', 'status'], description: 'show/open opens the browser; hide/close closes it; update opens it with optional focus; toggle switches it; status only checks state.' },
          region_id: { type: 'string', description: 'Optional knowledge region id to focus.' },
          query: { type: 'string', description: 'Optional query to execute in the browser after opening.' },
          document_id: { type: 'string', description: 'Optional document id to open in the detail pane.' },
          reason: { type: 'string', description: 'Optional short reason for opening or closing.' },
        },
        required: ['action']
      }
    }
  },

  focus_banner: {
    type: 'function',
    function: {
      name: 'focus_banner',
      description: 'Show a translucent desktop focus banner sticker reminding the user what to focus on. Call when the user says they want to focus on something, enter focus mode, or asks for help focusing on X. The banner can expand to show a task list with checkboxes.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['show', 'update', 'hide'],
            description: 'show displays the banner; update changes content when it already exists; hide closes it.'
          },
          task: {
            type: 'string',
            description: 'Main task title, one short sentence.'
          },
          current_step: {
            type: 'string',
            description: 'Optional current step, shown under the main task when collapsed.'
          },
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', description: 'Subtask text.' },
                done: { type: 'boolean', description: 'Whether completed, default false.' }
              },
              required: ['text']
            },
            description: 'Optional subtask list shown when the banner is expanded.'
          }
        },
        required: ['action']
      }
    }
  },

  terminal_stream: {
    type: 'function',
    function: {
      name: 'terminal_stream',
      description: 'Open, inspect, and close a separate terminal-style progress window (black background, monospace text, with optional Markdown rendering). Use it for visible work logs, especially before/during file writing or artifact generation, so the user can see progress without waiting in Brain UI. The per-round context may tell you a terminal preview window is still visible; use this tool with action=close to dismiss it. After a file write, decide whether this window is still useful: keep it open for articles/reports/essays/notes/plans/Markdown prose that the user should review here; close it for code, config, JSON/data, temporary files, logs, build artifacts, or any file whose content does not need user review in this window after verification. If you open the same generated file in a local editor/viewer/browser, close this preview because that app becomes the review surface.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['open', 'write', 'clear', 'close', 'status'],
            description: 'open shows the terminal window; write appends text; clear clears the stream; close closes the window; status checks current stream state and returns screen/window layout when available.'
          },
          text: {
            type: 'string',
            description: 'Text to append when action=write. Keep it short and factual, like a terminal progress line.'
          },
          stream_id: {
            type: 'string',
            description: 'Optional stream identity. Default is "default". Reuse the same id for one continuous work session.'
          },
          title: {
            type: 'string',
            description: 'Optional terminal window title, e.g. "Writing project files".'
          },
          format: {
            type: 'string',
            enum: ['plain', 'markdown', 'code'],
            description: 'Optional render format. Use markdown for article/report/essay/note previews so the terminal window renders headings, lists, emphasis, and code fences.'
          },
          artifact_kind: {
            type: 'string',
            description: 'Optional artifact kind such as article, report, note, code, log, or file.'
          },
          artifact_path: {
            type: 'string',
            description: 'Optional path of the file/artifact being previewed.'
          },
          hold_open: {
            type: 'boolean',
            description: 'Set true only when the preview itself should remain as the user review surface, such as article/report/essay/note/plan/Markdown prose. Use false for code, config, JSON/data, logs, temporary files, or files opened in another local app.'
          },
          force: {
            type: 'boolean',
            description: 'For action=close only. Use true when the user explicitly asked to close a held article/document preview, or when the same file has been opened in a local editor/viewer/browser. If context says visible_window=yes and hold_open=true, force=true is the expected way to close it.'
          },
          placement: {
            type: 'string',
            enum: ['auto', 'right', 'left', 'top', 'bottom', 'top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'],
            description: 'Optional window placement. Default auto avoids the main Bailongma window when possible; call status first if you need exact screen/window bounds.'
          },
          bounds: {
            type: 'object',
            properties: {
              x: { type: 'number', description: 'Screen x coordinate in physical pixels.' },
              y: { type: 'number', description: 'Screen y coordinate in physical pixels.' },
              width: { type: 'number', description: 'Window width in pixels.' },
              height: { type: 'number', description: 'Window height in pixels.' },
            },
            description: 'Optional explicit window bounds. If provided, the app clamps the window into the active display work area.'
          },
          focus: {
            type: 'boolean',
            description: 'Whether to focus the terminal window after opening. Defaults to true for explicit tool use; write-file previews use false so the main window keeps focus.'
          },
          newline: {
            type: 'boolean',
            description: 'When action=write, append a newline after text. Defaults to true.'
          },
          level: {
            type: 'string',
            enum: ['info', 'success', 'warning', 'error', 'muted'],
            description: 'Optional semantic level for future renderers. Current terminal keeps a simple black/white look.'
          },
        },
        required: ['action']
      }
    }
  },

  voice_retire: {
    type: 'function',
    function: {
      name: 'voice_retire',
      description: 'Gracefully collapse the floating voice orb — the listening ball shown on screen during a voice conversation. Call it when, in a voice conversation, the user asks you to leave / stop / says that is all (退下 / 没事了 / 再见 / 先这样), OR the task is fully complete and no follow-up is expected. It retires only the on-screen ball after you finish speaking; it does NOT end the app or stop you from being reachable. No-op if no orb is currently showing.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Optional short reason, e.g. user said goodbye / task done.' },
        },
        required: []
      }
    }
  },
}
