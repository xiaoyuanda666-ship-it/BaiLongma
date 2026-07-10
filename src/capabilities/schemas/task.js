// 任务 / 节奏类工具 schema：set_tick_interval / set_task / complete_task /
// update_task_step / complete_startup_self_check
export const taskSchemas = {
  set_tick_interval: {
    type: 'function',
    function: {
      name: 'set_tick_interval',
      description: 'Adjust your own thinking rhythm by setting the TICK interval for the next span of time. Use shorter intervals during urgent or important work and longer intervals when idle or reflecting. seconds range [0, 36000], ttl range [1, 100]; out-of-range values are clamped.',
      parameters: {
        type: 'object',
        properties: {
          seconds: { type: 'number', description: 'TICK interval in seconds, range [0, 36000].' },
          ttl: { type: 'number', description: 'Number of successful autonomous heartbeat ticks to keep this rhythm, range [1, 100]. Defaults to 10 and then returns to the default rhythm. User/background turns and aborted heartbeats do not consume it.' },
          reason: { type: 'string', description: 'Optional short reason for later self-reference.' },
        },
        required: ['seconds']
      }
    }
  },

  set_task: {
    type: 'function',
    function: {
      name: 'set_task',
      description: 'Start a multi-step task. Provide the overall goal and ordered steps. The system persistently tracks each step and restores after restart. Calling this accelerates TICK rhythm to keep progressing. Only one active task can exist at a time.',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'Overall task goal: what should be completed in the end.' },
          steps: {
            type: 'array',
            items: { type: 'string' },
            description: 'Ordered concrete steps, each describing what to do.'
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
      description: 'Mark the current task fully complete. Stops accelerated TICK, writes a completion record, and clears task state. Call after all steps are complete.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Optional short completion summary.' }
        },
        required: []
      }
    }
  },

  update_task_step: {
    type: 'function',
    function: {
      name: 'update_task_step',
      description: 'Update completion status for one step of the current task. Call immediately when a step is done, failed, or skipped so progress is tracked in real time.',
      parameters: {
        type: 'object',
        properties: {
          step_index: { type: 'number', description: 'Step index starting from 0.' },
          status: {
            type: 'string',
            enum: ['done', 'failed', 'skipped'],
            description: 'Step status: done, failed, or skipped.'
          },
          note: { type: 'string', description: 'Optional note about the step result.' }
        },
        required: ['step_index', 'status']
      }
    }
  },

  complete_startup_self_check: {
    type: 'function',
    function: {
      name: 'complete_startup_self_check',
      description: 'Close the one-time L2 startup diagnostic when you judge the environment sufficiently understood. There is no mandatory checklist: checks may be performed, skipped, or deemed unnecessary. Persist an honest summary/results object based only on real evidence so the diagnostic does not repeat on future startups.',
      parameters: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: 'Brief human-readable summary of the startup self-check result.'
          },
          results: {
            type: 'object',
            description: 'Per-capability result map. Suggested keys: filesystem, web_search, hotspot_panel, music_player, focus_banner, ui_card. Each value should include status and detail.',
            additionalProperties: {
              type: 'object',
              properties: {
                status: {
                  type: 'string',
                  description: 'ok, degraded, error, skipped_no_tracks, skipped_no_ui_client, or another concise status.'
                },
                detail: {
                  type: 'string',
                  description: 'Short detail from the check.'
                }
              }
            }
          }
        },
        required: ['summary', 'results']
      }
    }
  },
}
