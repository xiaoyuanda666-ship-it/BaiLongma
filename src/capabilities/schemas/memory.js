// 记忆类工具 schema：search_memory / probe_memory / upsert_memory / skip_recognition /
// merge_memories / downgrade_memory / skip_consolidation / recall_memory
export const memorySchemas = {
  search_memory: {
    type: 'function',
    function: {
      name: 'search_memory',
      description: 'Search the memory database in batch by multiple keywords using FTS5 full-text search. Each keyword is searched independently, then results are merged and deduplicated. Each result includes matched_by. The recognizer must call this before writing new memories to deduplicate; existing mem_id means update, no match means insert.',
      parameters: {
        type: 'object',
        properties: {
          keywords: {
            type: 'array',
            items: { type: 'string' },
            description: 'Keyword list, 1-8 items. Include Chinese/English synonyms where useful to improve recall.'
          },
          limit_per_keyword: {
            type: 'number',
            description: 'Maximum hits per keyword, default 5.'
          },
          type_filter: {
            type: 'string',
            enum: ['fact', 'person', 'object', 'knowledge', 'article'],
            description: 'Optional memory type filter.'
          }
        },
        required: ['keywords']
      }
    }
  },

  probe_memory: {
    type: 'function',
    function: {
      name: 'probe_memory',
      description: 'Diagnostic probe: ask "if I queried for X right now, what would the memory layer return?" — no side effects, does NOT influence the next turn injection. Use when the user asks "do you remember X?" and you want to verify what memory would surface, or for self-diagnosing recall coverage. Returns matched memory IDs with event_type, salience, and a hint when recall is empty (suggesting extraction vs recall miss).',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Natural-language probe query. Will be tokenized and run against direct FTS + multi-keyword FTS in parallel.'
          }
        },
        required: ['query']
      }
    }
  },

  upsert_memory: {
    type: 'function',
    function: {
      name: 'upsert_memory',
      description: 'Batch insert or update memory nodes. Deduplicates by mem_id: existing mem_id means PATCH while omitted fields are preserved; new mem_id means INSERT. Use search_memory first to decide mem_id. Naming rules: person_{ID}, object_{slug}, article_{url_hash8}, concept_{snake}, fact_{snake}, procedure_{domain}_{snake}, constraint_{domain}_{snake}, lesson_{domain}_{snake}. Procedures/constraints/lessons should use type=knowledge with tags such as kind:procedure, kind:constraint, kind:failure_lesson, domain:desktop_control, trigger:screenshot.',
      parameters: {
        type: 'object',
        properties: {
          memories: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                mem_id:        { type: 'string', description: 'Stable ID following the naming rules.' },
                type:          { type: 'string', enum: ['fact', 'person', 'object', 'knowledge', 'article'], description: 'Memory type. Required for new memories. Reusable procedures, hard constraints, and failure lessons should be stored as type=knowledge plus kind:* tags.' },
                title:         { type: 'string', description: 'Title. For articles, use the article title. Required for new memories.' },
                content:       { type: 'string', description: 'Summary, <= 200 Chinese characters. Required for new memories.' },
                detail:        { type: 'string', description: 'Optional detailed explanation.' },
                entities:      { type: 'array', items: { type: 'string' }, description: 'Entity IDs this memory is about. For memories about the user, include their sender ID (e.g. "ID:000001"). For memories about other people, include their person ID. This enables entity-based memory retrieval.' },
                tags:          { type: 'array', items: { type: 'string' }, description: 'Optional tag array. For actionable memories use kind:procedure, kind:constraint, or kind:failure_lesson, plus domain:* and trigger:* tags so future turns can activate them as policies.' },
                parent_mem_id: { type: 'string', description: 'Optional parent node mem_id.' },
                links:         {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      target_mem_id: { type: 'string' },
                      relation:      { type: 'string', description: 'Relation such as related_to, cites, or contradicts.' }
                    }
                  },
                  description: 'Optional links to other memory nodes.'
                },
                salience: {
                  type: 'integer',
                  minimum: 1,
                  maximum: 5,
                  description: 'Importance score 1-5. 1=trivial detail, 2=ordinary fact, 3=default stable info, 4=meaningful pattern or recurring preference, 5=identity-level / load-bearing belief. Defaults to 3 if omitted.'
                },
                body_path:     { type: 'string', description: 'For article type: full-text file path from web_read body_path.' }
              },
              required: ['mem_id']
            },
            description: 'Memory array for batch insert/update, supports 1-N items.'
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
      description: 'Recognizer-only tool. Call when this turn contains nothing worth long-term storage, explicitly meaning "reviewed, no write needed." This is a valid stop signal; do not force weak content into memory.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Optional short reason.' }
        }
      }
    }
  },

  merge_memories: {
    type: 'function',
    function: {
      name: 'merge_memories',
      description: 'Consolidator-only. Merge multiple semantically-duplicate memories into one. The keep memory is updated with merged_content; drop memories become hidden (visibility=0, merged_into=keep_mem_id) — NOT deleted. Rows + FTS + embedding fully preserved and still reachable by recovery flows; routine search/get* just stops surfacing them. Entities from hidden memories are union-merged into keep. Salience defaults to max(involved) unless merged_salience is set. Use this when 2+ memories say the same thing in different words, or when an old memory is superseded by a newer fact that subsumes it.',
      parameters: {
        type: 'object',
        properties: {
          keep_mem_id:     { type: 'string', description: 'mem_id of the memory to keep (will be updated).' },
          drop_mem_ids:    { type: 'array', items: { type: 'string' }, description: 'mem_ids of memories to hide (soft-delete) after merging their semantic content into keep.' },
          merged_content:  { type: 'string', description: 'New content for the keep memory, <=200 Chinese characters, covering everything the dropped memories said that is still true.' },
          merged_salience: { type: 'integer', minimum: 1, maximum: 5, description: 'Optional. Overrides default max(involved) salience.' },
          reason:          { type: 'string', description: 'Short reason for the merge, for logs.' },
        },
        required: ['keep_mem_id', 'drop_mem_ids', 'merged_content']
      }
    }
  },

  downgrade_memory: {
    type: 'function',
    function: {
      name: 'downgrade_memory',
      description: 'Consolidator-only. Lower the salience of a memory that has become stale or less central but is not outright contradicted (otherwise merge it into the contradicting memory). Reserve aggressive downgrades for memories that no longer seem load-bearing.',
      parameters: {
        type: 'object',
        properties: {
          mem_id:       { type: 'string' },
          new_salience: { type: 'integer', minimum: 1, maximum: 5 },
          reason:       { type: 'string' },
        },
        required: ['mem_id', 'new_salience']
      }
    }
  },

  skip_consolidation: {
    type: 'function',
    function: {
      name: 'skip_consolidation',
      description: 'Consolidator-only. Call when the inspected memory batch contains no duplicates and no stale entries. Valid stop signal.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string' }
        }
      }
    }
  },

  recall_memory: {
    type: 'function',
    function: {
      name: 'recall_memory',
      description: 'Deeply retrieve memories related to a topic, return results immediately, and keep focusing on this topic in the next turn. Deeper than search_memory because it affects the next memory injection direction. Use when you need to recall an experience or concept in depth.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Content or topic to recall.' }
        },
        required: ['query']
      }
    }
  },
}
