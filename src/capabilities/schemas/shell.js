// Shell / 进程工具 schema：run_command / kill_process / list_processes
export const shellSchemas = {
  install_software: {
    type: 'function',
    function: {
      name: 'install_software',
      description: 'Start a non-blocking background Windows winget software install job. Use this FIRST for desktop app installation requests before raw exec_command, browser research, or manual installer downloads. It returns quickly with ok=true, status="started", and job_id; that means the background job has begun, not that installation has finished. The job then checks winget, searches candidates, prefers known modern package ids such as Tencent.QQ.NT before Tencent.QQ for QQ, runs winget show/install, and later sends a background APP_SIGNAL/event when it succeeds, fails, needs user attention, or is cancelled. Do not call this repeatedly for the same app; use list_processes to inspect software_install_jobs. Only fall back to manual vendor download after the final job result says no candidates or all candidates failed.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Software name or search query, e.g. "QQ", "微信", "Chrome".' },
          package_id: { type: 'string', description: 'Optional exact winget package id if already known, e.g. Tencent.QQ.NT.' },
          silent: { type: 'boolean', description: 'Run the installer silently with no setup-wizard clicks. Silent is the DEFAULT, so normally omit this. Pass false only if the user explicitly wants to see/click the installer UI. Note: silent covers the installer wizard only; a machine-scope package may still raise a Windows UAC elevation prompt unless the app itself runs elevated.' }
        },
        required: []
      }
    }
  },

  run_command: {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Control one observable shell command run. action="start" creates a run_id immediately; it returns state="running" when the process continues, so do not guess whether a command is long-running. Then use action="wait" to wait for exit, action="read_output" with cursor for incremental stdout/stderr, action="status" to inspect it, or action="cancel" to stop it. If action is omitted, this keeps legacy behavior: starts the command and waits up to the selected profile timeout. On Windows runs in PowerShell. Use cwd instead of cd-chaining. Do not use this for dedicated file/download/web operations. For a local development/preview server, use a dedicated project cwd, bind to 127.0.0.1/localhost by default, and use action="start", mode="background". Never serve Desktop, Documents, Downloads, home, a drive root, or the sandbox root merely to expose one artifact. LAN listening is appropriate when the user asks another local device to connect; public tunnels require an explicit public-access request.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command to run, such as "node server.js", "npm install", or "python main.py".' },
          action: { type: 'string', enum: ['start', 'status', 'wait', 'read_output', 'cancel'], description: 'start creates a new command run; status, wait, read_output, and cancel require run_id. Omit only for legacy start-and-wait behavior.' },
          run_id: { type: 'string', description: 'The run_id returned by action="start".' },
          mode: { type: 'string', enum: ['auto', 'quick', 'task', 'background', 'strict'], description: 'auto detects a profile; quick is short read-only inspection; task is finite work; background starts a server/watcher; strict is for sensitive command families.' },
          timeout: { type: 'number', description: 'For legacy start or action="wait": maximum seconds to wait for an exit. Every wait result includes timed_out=true|false. Reaching the timeout does not kill the command; it remains running and can be waited on again.' },
          cwd: { type: 'string', description: 'Subdirectory within the sandbox to run the command in, e.g. "myproject". Avoids cd-chaining. Must be a relative path.' },
          wait_for_exit: { type: 'boolean', description: 'With explicit action="start", set true to wait for exit up to timeout. Otherwise start returns immediately with run_id/state.' },
          cursor: { type: 'number', description: 'For read_output or wait: last output_cursor already consumed. Only newer output is returned.' },
          promote_to_background: { type: 'boolean', description: 'Legacy compatibility field; no longer needed because every command has a run_id and remains observable.' },
          background: { type: 'boolean', description: 'Legacy compatibility field. Prefer action="start" and observe the returned run_id.' }
        },
        required: []
      }
    }
  },

  download_file: {
    type: 'function',
    function: {
      name: 'download_file',
      description: 'Download a URL to a local file using structured parameters instead of shelling out through curl, wget, Invoke-WebRequest, or Start-BitsTransfer. This is better for downloads because timeout, redirects, sandbox path checks, parent directory creation, progress events, and file existence verification are handled by the runtime. During long downloads the runtime emits download_start/download_progress/download_complete events that can notify the agent/UI; the final result includes bytes, bytes_human, elapsed_ms, and a progress snapshot.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'HTTP or HTTPS URL to download.' },
          output_path: { type: 'string', description: 'Destination file path. Relative paths are resolved inside the sandbox; absolute paths require the file sandbox to be disabled.' },
          timeout: { type: 'number', description: 'Timeout in seconds, default 120, max 120.' }
        },
        required: ['url', 'output_path']
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
          pid: { type: 'number', description: 'PID of the process to stop.' }
        },
        required: ['pid']
      }
    }
  },

  list_processes: {
    type: 'function',
    function: {
      name: 'list_processes',
      description: 'List background processes with their recent output, plus background software install jobs. Returns ok, count, processes (each with pid, command, status running|exited, exit_code, started_at, exited_at, recent_output), and software_install_jobs with job_id/status/query/package_id/candidates/attempts. Recently exited shell processes are retained for ~5 min; software install jobs are retained longer so final success/failure can be inspected. Use tail to control how many shell output lines to include per process (default 20, max 200).',
      parameters: {
        type: 'object',
        properties: {
          tail: { type: 'number', description: 'Number of recent output lines to return per process, default 20.' }
        }
      }
    }
  },
}
