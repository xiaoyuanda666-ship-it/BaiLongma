// 联网工具 schema：web_search / web_read
// 注意：web_read 在 function 外层带 recognizer_highlights，
// 供识别器使用，getToolSchemas 会在发给 LLM 前剥离该字段。
export const webSchemas = {
  web_search: {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'One-shot stateless web search for current or unknown information when no exact reliable URL is known. Returns structured JSON with result titles, URLs, snippets, and ok/error status. Use web_read on reliable result URLs when source content is needed. Search and stateful browser tools may be combined when the user asks to find a site and then interact with it.',
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

  web_read: {
    type: 'function',
    recognizer_highlights: ['body_path', 'title', 'url', 'content_length'],
    function: {
      name: 'web_read',
      description: 'Read and extract content from one known URL without retaining a browser session. In auto mode it tries a protected direct HTTP read, upgrades to local headless Playwright when rendering is needed, and may use the remote Jina Reader only as a final fallback. Do not use it as a search engine or for clicking, login, forms, tabs, screenshots, or browser continuity. Returns structured JSON with ok/status/title/content/body_path/error. Long articles are saved under sandbox/articles/.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: {
            type: 'string',
            description: 'Known http/https URL to read. Prefer reliable source pages found through web_search.'
          },
          render: {
            type: 'string',
            enum: ['auto', 'http', 'browser'],
            description: 'Read strategy. auto (default) starts with HTTP and upgrades locally; http disables browser/remote fallbacks; browser forces local Playwright rendering.'
          },
          fresh: {
            type: 'boolean',
            description: 'Bypass the short-lived read cache when current data is required.'
          },
          remote_fallback: {
            type: 'boolean',
            description: 'Allow the final Jina Reader fallback after local methods fail. Default true. Set false when the URL must not be sent to that third party.'
          },
          timeout_ms: {
            type: 'integer', minimum: 1000, maximum: 45000,
            description: 'Per-strategy timeout in milliseconds.'
          },
          max_chars: {
            type: 'integer', minimum: 1000, maximum: 20000,
            description: 'Maximum inline content before truncation; long articles are also saved to body_path.'
          },
        },
        required: ['url']
      }
    }
  },
}
