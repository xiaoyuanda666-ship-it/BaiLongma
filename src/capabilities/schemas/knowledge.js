// Knowledge-cortex tools deliberately stay separate from memory tools.  A
// knowledge result is evidence from a versioned source, not a fact inferred
// from a conversation.
export const knowledgeSchemas = {
  manage_knowledge_region: {
    type: 'function',
    function: {
      name: 'manage_knowledge_region',
      description: 'Manage named knowledge regions (document collections). Use this for source-backed material such as manuals, project documents, policies, and datasets; do not use it for user preferences or conversation memories. Disabled regions are retained but excluded from automatic retrieval.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'update', 'list', 'get', 'disable'], description: 'create/update save a region, list returns regions, get returns one region, disable marks one region inactive.' },
          region_id: { type: 'string', description: 'Stable region ID. Required for update, get, and disable; optional for create when the storage layer creates one.' },
          name: { type: 'string', description: 'Human-readable region name. Required when creating a region.' },
          description: { type: 'string', description: 'What this region contains and when it should be used.' },
          scope: { type: 'string', description: 'Optional boundary, for example project, team, or personal.' },
          status: { type: 'string', enum: ['active', 'disabled'], description: 'Optional region status. Prefer action=disable to turn a region off.' },
          metadata: { type: 'object', description: 'Optional source, permission, or routing metadata. Do not put secret values here.' },
        },
        required: ['action'],
      },
    },
  },

  import_knowledge: {
    type: 'function',
    function: {
      name: 'import_knowledge',
      description: 'Add source-backed material to a knowledge region. Pass text content or a URI already supplied by the user. This tool does not read arbitrary local files and does not convert the material into conversational memory. Imported content remains traceable to its source and version.',
      parameters: {
        type: 'object',
        properties: {
          region_id: { type: 'string', description: 'Target knowledge region ID.' },
          title: { type: 'string', description: 'Document title.' },
          content: { type: 'string', description: 'Optional text content to ingest directly. Provide content or uri.' },
          uri: { type: 'string', description: 'Optional source URI supplied by the user. Provide content or uri; URI is recorded, not fetched by this tool.' },
          source_type: { type: 'string', description: 'Optional source type such as text, markdown, html, url, or api.' },
          metadata: { type: 'object', description: 'Optional source metadata such as author, tags, or declared version.' },
        },
        required: ['region_id', 'title'],
      },
    },
  },

  search_knowledge: {
    type: 'function',
    function: {
      name: 'search_knowledge',
      description: 'Search source-backed knowledge regions for evidence. Use this for questions about imported documents, a knowledge base, a document library, or answers that should be grounded in supplied materials. Results include source and locator metadata when available; do not present them as personal memories.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language search query.' },
          region_id: { type: 'string', description: 'Optional region restriction.' },
          limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum evidence hits, default 5.' },
          include_disabled: { type: 'boolean', description: 'Whether disabled regions may be searched. Defaults to false.' },
        },
        required: ['query'],
      },
    },
  },

  inspect_knowledge_source: {
    type: 'function',
    function: {
      name: 'inspect_knowledge_source',
      description: 'Inspect an imported knowledge document or a precise evidence chunk, including its source, version, and location metadata. Use this to verify a search hit before making a detailed claim.',
      parameters: {
        type: 'object',
        properties: {
          document_id: { type: 'string', description: 'Knowledge document ID to inspect.' },
          chunk_id: { type: 'string', description: 'Knowledge chunk ID to inspect.' },
        },
      },
    },
  },
}
