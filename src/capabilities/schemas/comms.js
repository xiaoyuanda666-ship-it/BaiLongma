// 通信类工具 schema：express（兼容别名，不暴露给模型）、send_message
export const commsSchemas = {
  express: {
    type: 'function',
    function: {
      name: 'express',
      description: 'Express content to an individual by ID. This is the behavior-layer communication outlet. Supports text or voice format.',
      parameters: {
        type: 'object',
        properties: {
          target_id: {
            type: 'string',
            description: 'Recipient ID, such as ID:000001.'
          },
          content: {
            type: 'string',
            description: 'Content to express.'
          },
          format: {
            type: 'string',
            enum: ['text', 'voice'],
            description: 'Expression format, default text.'
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
      description: [
        'Send a message to an individual by ID. All outbound communication must use this tool; do not output reply content directly.',
        '',
        'Guidance (no longer enforced by the runtime — your responsibility to follow):',
        '',
        '## Targeting',
        '• target_id should be an ID that appears in the conversation context injected into this prompt (e.g. recent messages or the explicitly listed targets). Do not invent IDs or send to people who are not part of the current context.',
        '',
        '## Brevity is the rule, not the option',
        '• Match length to the question. "你好" → one short greeting. "1+1?" → "2". A 5-item list → just the 5 items. Do not pad with closing remarks.',
        '• Cut all trailing pleasantries and filler: "刚记下的", "中午了", "都是日常用得最多的", "有需要随时叫我", "为您效劳", "希望对你有帮助" — none of these add information. Stop the message at the answer.',
        '• Never restate what the user just asked. They know what they asked.',
        '• Never describe the steps you took ("我查了一下", "让我看看") unless the user explicitly asked for the process.',
        '• Do not say the same thing twice in different words. If you already wrote "我不认识 ID:000099", do not add "它没有出现在我的上下文里" — pick one.',
        '',
        '## One action, one message',
        '• Do not send "我去做" before a tool call and then "做完了" after. Call the tool, then send ONE message with the result. If you sent a heads-up before the tool, do not repeat the same content after the tool returns.',
        '• When a single user turn deserves a reply, send exactly one send_message in that turn. Multiple sends in one turn are only acceptable when the contents are genuinely different (e.g. a status update during a long task that takes many seconds).',
        '• For document or knowledge-base lookup questions, retrieve silently and send exactly one final answer. Never send “let me search”, retries, tool names, query syntax, ranking details, or other implementation mechanics to the user.',
        '• NEVER split a closing pleasantry into a second send_message. If you already sent the main reply and feel tempted to follow up with "有需要随时叫我", "希望对你有帮助", "还有什么需要吗", "为您效劳", "祝你..." — STOP. Those lines add zero information; merge them into nothing, not into a second call. The runtime will suppress such follow-up sends as filler.',
        '',
        '## A message is written TO the user, never a note to yourself',
        '• send_message content is delivered verbatim to the user. It must be addressed TO them, in second person — not internal monologue ABOUT them or ABOUT what you are doing.',
        '• Your reasoning, plans, and decisions — including the decision NOT to reply — stay in your thinking. They are never message content. Examples of self-talk that must NEVER be sent: "已经和用户打过招呼了，不需要再发第二条", "安静等待", "我先观察一下", "这条不用回了", "I should stay quiet now".',
        '• If you conclude that no reply is needed, simply do not call send_message — end the turn silently. Do NOT announce that you are staying silent; announcing it IS sending a message, which defeats the decision.',
        '',
        '## Respect the user\'s attention',
        '• A "你好"/"在吗" greeting deserves a brief greeting back. Do not steer it toward a topic the user did not raise. If you have a pending thought from your own tick loop, hold it until the user shows interest.',
        '• Your tick-loop thoughts are NOT part of the conversation the user sees. Do not summarize them as "we talked about X" — the user did not talk about X with you.',
        '',
        'The same canonical user ID (e.g. ID:000001) may be reachable on multiple channels — use the optional channel parameter to override the default routing.',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          target_id: {
            type: 'string',
            description: 'Recipient ID, such as ID:000001. Use an ID that appears in the conversation context of this prompt.'
          },
          content: {
            type: 'string',
            description: 'Message text. Delivered verbatim. Required unless image_path or media_path is provided. When sending media, this becomes the optional caption.'
          },
          image_path: {
            type: 'string',
            description: 'Optional local image path to send through WeChat ClawBot. Supported image extensions: .png, .jpg, .jpeg, .gif, .webp, .bmp. Use content as an optional caption.'
          },
          media_path: {
            type: 'string',
            description: 'Optional local media path to send through WeChat ClawBot. Images are sent as images, videos as videos, and other files as file attachments. Use content as an optional caption.'
          },
          channel: {
            type: 'string',
            enum: ['WECHAT', 'DISCORD', 'FEISHU', 'WECOM', 'TUI', 'AUTO'],
            description: 'Optional delivery channel. AUTO (default) follows the channel of the user\'s most recent message — if they last reached you on WECHAT, your message goes to WECHAT (this also holds for follow-ups triggered later by reminders or ticks). Pass an explicit channel (e.g. TUI for long-form output that belongs on the local UI) to override.'
          }
        },
        required: ['target_id']
      }
    }
  },
}
