// Shell / 进程工具 schema：exec_command / kill_process / list_processes
export const shellSchemas = {
  install_software: {
    type: 'function',
    function: {
      name: 'install_software',
      description: 'Install desktop software through a structured Windows winget workflow. Use this FIRST for requests like 安装QQ/微信/Chrome/软件, before raw exec_command, web_search, fetch_url, browser_read, or manual installer downloads. It checks winget, searches candidates, prefers known modern package ids such as Tencent.QQ.NT for QQ, retries alternate winget candidates when a manifest download URL is stale, and returns structured success/failure details. Only fall back to manual vendor download after this tool returns no candidates or all candidates failed.',
      description: 'Start a non-blocking background Windows winget software install job. Use this FIRST for desktop app installation requests before raw exec_command, web_search, fetch_url, browser_read, or manual installer downloads. It returns quickly with ok=true, status="started", and job_id; that means the background job has begun, not that installation has finished. The job then checks winget, searches candidates, prefers known modern package ids such as Tencent.QQ.NT before Tencent.QQ for QQ, runs winget show/install, and later sends a background APP_SIGNAL/event when it succeeds, fails, needs user attention, or is cancelled. Do not call this repeatedly for the same app; use list_processes to inspect software_install_jobs. Only fall back to manual vendor download after the final job result says no candidates or all candidates failed.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Software name or search query, e.g. "QQ", "微信", "Chrome".' },
          package_id: { type: 'string', description: 'Optional exact winget package id if already known, e.g. Tencent.QQ.NT.' },
          silent: { type: 'boolean', description: 'Request silent install when supported. Use true only when the user explicitly asked for silent/no UI installation.' }
        },
        required: []
      }
    }
  },

  exec_command: {
    type: 'function',
    function: {
      name: 'exec_command',
      description: 'Run a shell command. Returns structured JSON with ok, mode, exit_code, stdout, stderr, timed_out, pid. On Windows runs in PowerShell — use PowerShell syntax (e.g. Get-ChildItem, $env:USERPROFILE, Write-Output). Use background=true for long-running servers. Use cwd to run in a sandbox subdirectory instead of cd-chaining. Use promote_to_background=true so a foreground timeout converts the process to background instead of killing it. Do NOT use this tool for operations that have a dedicated tool — those are more reliable and handle encoding/sandbox/verification for you: write a file → write_file (never WriteAllText/Out-File/Set-Content/echo >/python -c with embedded text; the quoting of multi-line content breaks repeatedly); read a file → read_file; list a directory → list_dir; delete a file/dir → delete_file (never Remove-Item/rm); create a directory → make_dir; fetch a web page → fetch_url or browser_read (never curl/Invoke-WebRequest). exec_command is for running programs (node, npm, python script.py, git, opening apps) and for file operations that have no dedicated tool (move/copy/rename, search file contents with findstr/Select-String).',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command to run, such as "node server.js", "npm install", or "python main.py".' },
          background: { type: 'boolean', description: 'Run in the background, default false. Set true when starting a server.' },
          timeout: { type: 'number', description: 'Foreground execution timeout in seconds, default 30, max 120.' },
          cwd: { type: 'string', description: 'Subdirectory within the sandbox to run the command in, e.g. "myproject". Avoids cd-chaining. Must be a relative path.' },
          promote_to_background: { type: 'boolean', description: 'When foreground execution times out, promote to background instead of killing the process. Returns the new pid.' },
          profile: { type: 'string', enum: ['quick', 'task', 'background', 'download', 'strict'], description: 'Optional execution profile. Prefer the dedicated exec_quick_command / exec_task_command / exec_background_command / download_file tools when possible.' }
        },
        required: ['command']
      }
    }
  },

  exec_quick_command: {
    type: 'function',
    function: {
      name: 'exec_quick_command',
      description: 'Run an instant, non-interactive command such as pwd, whoami, rg, dir, Get-ChildItem, or a short read-only inspection. Uses the quick profile with short timeout and fast-lane optimization when safe. Do not use for installs, builds, tests, downloads, servers, prompts, pagers, or commands that may wait for user input.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Short read-only command to run.' },
          timeout: { type: 'number', description: 'Timeout in seconds, default 10, max 30.' },
          cwd: { type: 'string', description: 'Subdirectory within the sandbox to run the command in. Must be relative while the exec sandbox is enabled.' }
        },
        required: ['command']
      }
    }
  },

  exec_task_command: {
    type: 'function',
    function: {
      name: 'exec_task_command',
      description: 'Run a finite but potentially slower command such as npm install, npm test, build, git clone, pip install, or a script that should eventually exit. Uses a longer timeout than quick commands and does not use the persistent-shell fast lane.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Finite command that may take some time but should exit.' },
          timeout: { type: 'number', description: 'Timeout in seconds, default 60, max 120.' },
          cwd: { type: 'string', description: 'Subdirectory within the sandbox to run the command in. Must be relative while the exec sandbox is enabled.' },
          promote_to_background: { type: 'boolean', description: 'When timeout is reached, promote to background instead of killing the process.' }
        },
        required: ['command']
      }
    }
  },

  exec_background_command: {
    type: 'function',
    function: {
      name: 'exec_background_command',
      description: 'Start a long-running command such as a dev server, watcher, tail -f, or service. Immediately returns a pid. Use list_processes to inspect output and kill_process to stop it.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Long-running command to start in the background.' },
          cwd: { type: 'string', description: 'Subdirectory within the sandbox to run the command in. Must be relative while the exec sandbox is enabled.' }
        },
        required: ['command']
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
      description: 'List background processes with their recent output. Returns ok, count, and processes (each with pid, command, status running|exited, exit_code, started_at, exited_at, recent_output). Recently exited processes are retained for ~5 min so you can still read their final output and exit code. Use tail to control how many output lines to include per process (default 20, max 200).',
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
