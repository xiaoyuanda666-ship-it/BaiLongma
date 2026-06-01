import path from 'path'
import { spawn, spawnSync } from 'child_process'
import { nowTimestamp } from '../../time.js'
import { emitEvent } from '../../events.js'
import { config } from '../../config.js'
import { createMergedAbortSignal, throwIfAborted } from '../abort-utils.js'
import { SANDBOX_ROOT, assertInSandbox } from '../sandbox.js'
import { runOnPersistentShell } from './persistent-shell.js'

// 后台进程注册表：pid → { process, command, cwd, startedAt, outputLines, status, exitCode, exitedAt }
const bgProcesses = new Map()
const BG_OUTPUT_MAX_LINES = 200
// 已退出进程在表中保留多久，供模型回头查询最终输出和退出码（之前是一退出就删，输出全丢）
const BG_RETAIN_EXITED_MS = 5 * 60 * 1000
// 注册表总条目上限，防止长期运行下泄漏
const BG_MAX_ENTRIES = 50
// 前台输出在内存中的累积上限：超过则滚动丢弃头部、保留尾部，避免刷屏命令吃光内存
const FG_BUFFER_MAX = 512 * 1024

const IS_WIN = process.platform === 'win32'

/**
 * 跨平台 spawn shell 命令，确保中文输出不乱码。
 *
 * Windows 编码三层同步（缺一不可，否则中文会乱码）：
 *   1) chcp 65001  → 切换控制台 Active Code Page 到 UTF-8。这一步最关键：
 *      原生程序（git / npm / node / cmd 内建命令 / yt-dlp 等）读取的是 ACP，
 *      不读 PowerShell 的 OutputEncoding。中文 Windows 默认 ACP=936(GBK)，
 *      不切的话原生命令吐 GBK 字节，下游按 UTF-8 解码就是 �。
 *   2) [Console]::OutputEncoding=UTF8  → 告诉 PowerShell 按 UTF-8 解码原生命令输出。
 *   3) [Console]::InputEncoding / $OutputEncoding=UTF8  → PowerShell 自身、
 *      以及向子进程 stdin 写数据的方向也用 UTF-8。
 *
 * 不通过 Node 的 shell: 'powershell.exe' 选项，避免 Windows 下被强行套上
 * cmd /d /s /c 包装（PowerShell 会把这些当作未知参数，特殊字符还可能二次转义）。
 * 直接显式 spawn powershell.exe + -Command 最可控。
 *
 * 调用方仍应对 child.stdout / child.stderr 调用 setEncoding('utf8')，
 * 防止数据 chunk 切在多字节字符中间产生 U+FFFD。
 */
function spawnShellCommand(command, opts = {}) {
  if (IS_WIN) {
    // 用换行拼接而非 `; `：命令末尾若带 # 注释或续行符时更安全。
    //
    // 末尾 `exit $LASTEXITCODE` 至关重要：powershell.exe 在 -Command 模式下，
    // 即使内部原生命令（git / npm / node / yt-dlp 等）以非 0 退出，powershell
    // 进程自身的退出码通常仍是 0。不显式透传的话，下游 child.on('close', code)
    // 永远拿到 0，把失败的命令误判为成功（ok:true、exit_code:0）。
    // 命令前 `$global:LASTEXITCODE = 0` 重置脏值，避免上一条原生命令（chcp）
    // 的退出码被纯 cmdlet 命令继承。cmdlet 的 non-terminating error 不设
    // LASTEXITCODE，这是 PowerShell 固有盲区，此处不强行兜底（宁可漏报失败，
    // 也不把成功的命令误报为失败而触发模型无谓重试）。
    const wrapped = [
      'chcp 65001 > $null',
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
      '[Console]::InputEncoding=[System.Text.Encoding]::UTF8',
      '$OutputEncoding=[System.Text.Encoding]::UTF8',
      '$global:LASTEXITCODE = 0',
      command,
      'exit $LASTEXITCODE',
    ].join('\n')
    return spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', wrapped], opts)
  }
  return spawn(command, { ...opts, shell: true })
}

function resolveExecCwd(cwdArg) {
  // 关键：默认工作目录永远以 SANDBOX_ROOT 为基准，绝不退回 process.cwd()。
  // 打包后从快捷方式启动时 process.cwd() 是 exe 所在的安装目录，
  // 在那里建工作文件会在下次更新（NSIS 覆盖安装清空 $INSTDIR）时被一并删掉，
  // 历史上就因此丢过用户在 spiders/ 下的脚本。SANDBOX_ROOT 在 userData 下，更新动不到。
  //
  // execSandbox === false 的语义只是「放开越界校验、允许显式传绝对 cwd 跑到沙盒外」，
  // 而不是「把默认落点改成安装目录」。所以这里两种情况都用 SANDBOX_ROOT 作基准；
  // 若 cwdArg 是绝对路径，path.resolve 会忽略基准、直接采用它，绝对 cwd 仍然有效。
  if (!cwdArg) return SANDBOX_ROOT
  if (config.security?.execSandbox === false) return path.resolve(SANDBOX_ROOT, cwdArg)
  const resolved = path.resolve(SANDBOX_ROOT, cwdArg)
  assertInSandbox(resolved)
  return resolved
}

function toolJson(payload) {
  return JSON.stringify(payload, null, 2)
}

// 截断展示用输出：保留头部 + 尾部，丢弃中间。
// 命令的关键信息（报错栈、最终结果、退出提示）几乎总在尾部，所以尾部多留。
function trimCommandOutput(value = '', max = 6000) {
  const text = String(value || '')
  if (text.length <= max) return text
  const headLen = Math.floor(max * 0.3)
  const tailLen = max - headLen
  const head = text.slice(0, headLen)
  const tail = text.slice(-tailLen)
  const omitted = text.length - headLen - tailLen
  return `${head}\n\n[输出已截断：省略中间 ${omitted} 字符（原始 ${text.length} 字符），保留首 ${headLen} + 尾 ${tailLen}]\n\n${tail}`
}

// exec_command：在沙盒目录内执行 shell 命令
// background=true 时后台运行，返回 PID；否则等待完成，返回输出
// 判断命令是否大概率长驻/阻塞（dev server、watch、跟随日志等）。命中后超时不 kill 而转后台。
// 命中只影响"超时后的行为"，不改变命令本身能否快速返回，因此宁可宽松：误报代价极低
// （仅当该命令真的超时才转后台而非杀掉），漏报代价是 server 被超时杀掉。
// 既覆盖跨平台/unix（可能经 ssh、WSL、git-bash 执行），也覆盖实际 shell（Windows PowerShell）
// 与各语言生态的 server / watch 模式。
const LONG_RUNNING_PATTERNS = [
  // 跟随日志 / 持续监视（含 PowerShell 的 Get-Content -Wait）
  /\b(watch|tail\s+-f|tail\s+--follow|journalctl\b[^\n]*\s-f|Get-Content\b[^\n]*\s-Wait)\b/i,
  /\b(top|htop|btop)\b/i,
  /\bping\b[^\n]*\s-t\b/i, // Windows: ping -t 持续；unix ping 默认就持续
  // Node 生态 dev/server/watch
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|watch)\b/i,
  /\b(vite|nodemon|next\s+dev|ng\s+serve|nuxt\s+dev|remix\s+dev|astro\s+dev|expo\s+start|http-server|live-server|webpack-dev-server)\b/i,
  /\b(tsc|webpack|rollup|esbuild)\b[^\n]*(\s-w\b|--watch)/i,
  /\bnode\s+[^\n]*\bserver\b/i,
  // Python
  /\b(uvicorn|gunicorn|hypercorn|daphne|flask\s+run|streamlit\s+run)\b/i,
  /\bpython3?\s+[^\n]*\b(runserver|server)\b/i,
  // 其它语言 / 工具栈
  /\b(dotnet\s+(run|watch)|cargo\s+(run|watch)|php\s+artisan\s+serve|rails\s+(s|server)|jekyll\s+serve|hugo\s+server)\b/i,
  /\b(mvn\b[^\n]*spring-boot:run|gradle\b[^\n]*bootRun|go\s+run\b[^\n]*\bserver)/i,
  // 容器 / 编排的阻塞式命令（up 不带 -d、logs -f）
  /\bdocker(\s+compose)?\s+up\b(?!\s+-d)/i,
  /\b(docker(\s+compose)?\s+logs|kubectl\s+logs)\b[^\n]*\s-f\b/i,
  // ssh 到远端跑长任务
  /\bssh\b[\s\S]*\b(watch|tail\s+-f|tail\s+--follow|journalctl\b[^\n]*\s-f|top|htop)\b/i,
]

export function isLikelyLongRunningCommand(command = '') {
  const text = String(command || '').trim()
  if (!text) return false
  return LONG_RUNNING_PATTERNS.some((re) => re.test(text))
}

// 快路径白名单：首 token 属于这些"必然快速结束、只读、无 pager、无交互"的命令才复用长驻 shell。
// 故意排除 git/npm/node/python 等：它们可能很慢、开 pager（git log）或需较长超时，更适合
// 走带完整超时/promote 的独立进程慢路径。误判的代价由 persistent-shell 的软超时兜底。
const FAST_LANE_SAFE_HEADS = new Set([
  'ls', 'dir', 'gci', 'get-childitem', 'pwd', 'get-location', 'gl', 'tree',
  'cat', 'type', 'gc', 'get-content',
  'findstr', 'select-string', 'sls', 'grep', 'rg', 'ag',
  'test-path', 'get-item', 'gi', 'get-itemproperty', 'resolve-path',
  'split-path', 'join-path', 'convert-path',
  'measure-object', 'get-command', 'gcm', 'get-module', 'get-variable',
  'echo', 'write-output',
  'hostname', 'whoami', 'get-date',
  'head', 'tail', 'wc', 'nl', 'basename', 'dirname', 'stat',
])
// 任何可能阻塞 / 分页 / 交互 / 跟随的特征都把命令踢出快路径
const FAST_LANE_BLOCK_RE = /(-Wait|--follow|\s-f\b|\bmore\b|\bless\b|Read-Host|Get-Credential|Out-GridView|Wait-Event|Wait-Process|Start-Sleep|\bpause\b|-Confirm\b)/i

// 命令是否适合走持久 shell 快路径。仅 Windows；任何不确定都返回 false（降级到慢路径）。
export function isFastLaneEligible(command = '') {
  if (!IS_WIN) return false
  const text = String(command || '').trim()
  if (!text || text.length > 2000) return false
  if (/;/.test(text)) return false // 含 ; 串接，难保证每段安全，直接拒绝
  if (isLikelyLongRunningCommand(text)) return false
  if (FAST_LANE_BLOCK_RE.test(text)) return false
  const head = text.split(/[\s;|&(]/)[0].replace(/^['"]/, '').replace(/\.exe$/i, '').toLowerCase()
  return FAST_LANE_SAFE_HEADS.has(head)
}

function terminateProcessTree(child, pid = child?.pid) {
  if (!pid) {
    try { child?.kill?.() } catch {}
    return { ok: false, error: 'missing pid' }
  }
  if (IS_WIN) {
    const result = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    if (result.status === 0) return { ok: true }
    try { child?.kill?.() } catch {}
    return {
      ok: false,
      error: (result.stderr || result.stdout || `taskkill exited with ${result.status}`).trim(),
    }
  }
  try {
    child?.kill?.()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

// 命令是否在试图通过 shell 写文件内容（而非运行程序）。这类用法在 Windows PowerShell -Command
// 模式下对引号 / $ / 反引号 / 三引号转义极其脆弱，HTML/代码这种多行内容几乎必崩，模型还会换着
// 花样重试直到撞 tool loop 上限。命中后直接把它引导到 write_file（原生写 + 读回校验，零转义）。
const SHELL_FILE_WRITE_RE = /\[System\.IO\.File\]::WriteAllText|\bOut-File\b|\bSet-Content\b|\bAdd-Content\b|\bWriteAllLines\b|python3?\s+-c\b[\s\S]*\b(open|write)\b|>\s*['"]?[^\s|>]+\.(html?|css|js|jsx|ts|tsx|json|md|py|txt|xml|svg|vue|c|cpp|java|go|rs|sh|ps1)\b/i
// 本地 shell 在内容到达目标前就因转义失败而拒绝的典型报错
const ESCAPE_FAILURE_RE = /Missing expression after|Missing\s+'\)'|Missing closing|The string is missing the terminator|unterminated (triple-quoted )?string|Unexpected token|ParserError|unexpected EOF/i

export function getCommandFailureHint(command = '', stderr = '', stdout = '') {
  const combined = `${stderr || ''}\n${stdout || ''}`
  const text = String(combined)
  if (SHELL_FILE_WRITE_RE.test(command) && ESCAPE_FAILURE_RE.test(text)) {
    return 'This failed because you tried to write file content through the shell, and PowerShell mangled the quotes/$/backticks/triple-quotes in the content. Do NOT retry with different escaping. Use the write_file tool instead: pass { path, content } with the full file body verbatim — it writes natively (no escaping), creates parent dirs, and verifies the result. write_file accepts an absolute path (e.g. D:\\desktop\\rc-car.html) when the file sandbox is disabled.'
  }
  if (/\bssh\b/i.test(command) && /syntax error:\s*unexpected end of file/i.test(text)) {
    return 'The remote shell command reached bash with broken quoting or an unfinished block. Do not retry the same SSH command. Simplify the remote command, avoid multiline nested quotes from PowerShell, or pass a small bash -lc script with carefully escaped single quotes.'
  }
  if (/\bssh\b/i.test(command) && /unexpected EOF while looking for matching/i.test(text)) {
    return 'SSH itself likely connected, but the remote command quoting was unbalanced. Fix the quote escaping before retrying; this is not evidence that the server service is down.'
  }
  if (/The string is missing the terminator/i.test(text)) {
    return 'Local PowerShell rejected the command before it reached the target. Fix local quote escaping; avoid multiline remote shell snippets inside a single PowerShell command.'
  }
  return null
}

export async function execCommand(args, context = {}) {
  throwIfAborted(context.signal)
  const command = String(args.command || args.cmd || '').trim()
  if (!command) return toolJson({ ok: false, tool: 'exec_command', error: 'missing command' })

  const background = args.background === true || args.background === 'true'
  const autoPromote = isLikelyLongRunningCommand(command)
  const promoteToBackground = args.promote_to_background === true || args.promote_to_background === 'true' || autoPromote
  // schema 说明单位是秒，转换为毫秒；兼容旧调用（如果传入 >1000 视为已是毫秒）
  const rawTimeout = Number(args.timeout) || 30
  const timeoutMs = Math.max(1000, Math.min(rawTimeout < 1000 ? rawTimeout * 1000 : rawTimeout, 120000))

  let execCwd
  try {
    execCwd = resolveExecCwd(args.cwd || '')
  } catch (err) {
    return toolJson({ ok: false, tool: 'exec_command', error: err.message })
  }

  console.log(`[exec_command] ${background ? '[后台]' : '[前台]'} ${command} (cwd: ${execCwd})`)
  emitEvent('exec_command', { command, background, cwd: execCwd, auto_promote: autoPromote })

  if (background) {
    return execBackground(command, execCwd)
  }

  // 快路径：安全只读快命令复用长驻 shell，省去每条 ~550ms 冷启动。
  // 任何不适用（忙、软超时卡住、启动失败、abort 已触发）都返回 null，无缝降级到慢路径。
  if (!promoteToBackground && !context.signal?.aborted && isFastLaneEligible(command)) {
    try {
      const r = await runOnPersistentShell(command, execCwd, timeoutMs)
      if (r) {
        const failureHint = r.exit === 0 ? null : getCommandFailureHint(command, r.stderr, r.stdout)
        return toolJson({
          ok: r.exit === 0,
          tool: 'exec_command',
          mode: 'foreground',
          fast_lane: true,
          command,
          cwd: execCwd,
          exit_code: r.exit,
          stdout: trimCommandOutput(r.stdout),
          stderr: trimCommandOutput(r.stderr),
          error: r.exit === 0 ? null : `command exited with code ${r.exit}`,
          hint: r.exit === 0 ? 'Command completed successfully.' : (failureHint || 'Inspect stderr/stdout before retrying or changing the command.'),
        })
      }
    } catch { /* 降级到慢路径 */ }
  }

  return execForeground(command, timeoutMs, context.signal, execCwd, promoteToBackground)
}

// 注册一个后台进程：挂好输出捕获与退出处理，统一供 execBackground 与前台超时提升复用。
// seedLines 用于前台提升场景，把超时前已累积的 stdout/stderr 带入后台缓冲，避免丢失。
function registerBackgroundProcess(child, command, execCwd, seedLines = []) {
  const pid = child.pid
  const entry = {
    process: child,
    command,
    cwd: execCwd,
    startedAt: nowTimestamp(),
    outputLines: seedLines.slice(-BG_OUTPUT_MAX_LINES),
    status: 'running',
    exitCode: null,
    exitedAt: null,
  }
  bgProcesses.set(pid, entry)
  pruneBackgroundProcesses()

  const pushOutputLine = (stream, data) => {
    const text = data.toString()
    entry.outputLines.push({ stream, text, ts: Date.now() })
    if (entry.outputLines.length > BG_OUTPUT_MAX_LINES) entry.outputLines.shift()
    emitEvent('process_output', { pid, stream, text: text.slice(0, 500) })
  }
  child.stdout?.on('data', (data) => pushOutputLine('stdout', data))
  child.stderr?.on('data', (data) => pushOutputLine('stderr', data))

  child.on('exit', (code) => {
    console.log(`[exec_command] 后台进程 PID ${pid} 退出，code=${code}`)
    entry.status = 'exited'
    entry.exitCode = code
    entry.exitedAt = nowTimestamp()
    emitEvent('process_exit', { pid, command, code })
    // 保留一段时间供查询最终输出，到点再清理；不阻止进程退出
    const t = setTimeout(() => {
      const cur = bgProcesses.get(pid)
      if (cur && cur.status === 'exited') bgProcesses.delete(pid)
    }, BG_RETAIN_EXITED_MS)
    t.unref?.()
  })

  return { pid, entry }
}

// 注册表超出上限时，优先清理最早退出的已结束进程（运行中的永不清理）
function pruneBackgroundProcesses() {
  if (bgProcesses.size <= BG_MAX_ENTRIES) return
  const exited = [...bgProcesses.entries()]
    .filter(([, e]) => e.status === 'exited')
    .sort((a, b) => String(a[1].exitedAt || '').localeCompare(String(b[1].exitedAt || '')))
  while (bgProcesses.size > BG_MAX_ENTRIES && exited.length) {
    bgProcesses.delete(exited.shift()[0])
  }
}

function execBackground(command, execCwd) {
  const child = spawnShellCommand(command, {
    cwd: execCwd,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')

  if (!child.pid) {
    return toolJson({
      ok: false,
      tool: 'exec_command',
      mode: 'background',
      command,
      cwd: execCwd,
      error: 'process did not start',
    })
  }

  const { pid, entry } = registerBackgroundProcess(child, command, execCwd)

  return toolJson({
    ok: true,
    tool: 'exec_command',
    mode: 'background',
    command,
    cwd: execCwd,
    pid,
    started_at: entry.startedAt,
    hint: 'Process is running in the background. Use list_processes to inspect it or kill_process with this pid to stop it.',
  })
}

function execForeground(command, timeoutMs, signal, execCwd, promoteToBackground = false) {
  return new Promise((resolve) => {
    throwIfAborted(signal)
    const child = spawnShellCommand(command, { cwd: execCwd })
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let timer = null

    const finish = (value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      merged?.cleanup()
      resolve(value)
    }

    const merged = createMergedAbortSignal(signal)
    const onAbort = () => {
      terminateProcessTree(child)
      finish(toolJson({
        ok: false,
        tool: 'exec_command',
        mode: 'foreground',
        command,
        cwd: execCwd,
        aborted: true,
        stdout: trimCommandOutput(stdout),
        stderr: trimCommandOutput(stderr),
        error: 'command aborted',
      }))
    }
    if (merged?.signal.aborted) {
      terminateProcessTree(child)
      finish(toolJson({
        ok: false,
        tool: 'exec_command',
        mode: 'foreground',
        command,
        cwd: execCwd,
        aborted: true,
        stdout: '',
        stderr: '',
        error: 'command aborted before start',
      }))
      return
    }
    merged?.signal.addEventListener('abort', onAbort, { once: true })

    timer = setTimeout(() => {
      timedOut = true
      if (promoteToBackground && child.pid) {
        // 把超时前已累积的前台输出作为种子带入后台缓冲，避免丢失
        const seed = []
        if (stdout) seed.push({ stream: 'stdout', text: stdout, ts: Date.now() })
        if (stderr) seed.push({ stream: 'stderr', text: stderr, ts: Date.now() })
        const { pid } = registerBackgroundProcess(child, command, execCwd, seed)
        finish(toolJson({
          ok: true,
          tool: 'exec_command',
          mode: 'promoted_to_background',
          command,
          cwd: execCwd,
          pid,
          stdout: trimCommandOutput(stdout),
          stderr: trimCommandOutput(stderr),
          hint: `Foreground timed out after ${timeoutMs / 1000}s — process promoted to background with pid ${pid}. Use list_processes to monitor it.`,
        }))
      } else {
        terminateProcessTree(child)
        finish(toolJson({
          ok: false,
          tool: 'exec_command',
          mode: 'foreground',
          command,
          cwd: execCwd,
          timed_out: true,
          timeout_ms: timeoutMs,
          stdout: trimCommandOutput(stdout),
          stderr: trimCommandOutput(stderr),
          error: `command timed out after ${timeoutMs / 1000}s`,
          hint: 'If this is a long-running server, rerun with background=true or set promote_to_background=true.',
        }))
      }
    }, timeoutMs)

    child.stdout?.on('data', (d) => {
      if (timedOut) return
      const text = d.toString()
      stdout += text
      if (stdout.length > FG_BUFFER_MAX) stdout = stdout.slice(-FG_BUFFER_MAX)
      emitEvent('exec_output', { mode: 'foreground', stream: 'stdout', command, text: text.slice(0, 300) })
    })
    child.stderr?.on('data', (d) => {
      if (timedOut) return
      const text = d.toString()
      stderr += text
      if (stderr.length > FG_BUFFER_MAX) stderr = stderr.slice(-FG_BUFFER_MAX)
      emitEvent('exec_output', { mode: 'foreground', stream: 'stderr', command, text: text.slice(0, 300) })
    })

    child.on('close', (code) => {
      if (timedOut) return
      const failureHint = code === 0 ? null : getCommandFailureHint(command, stderr, stdout)
      finish(toolJson({
        ok: code === 0,
        tool: 'exec_command',
        mode: 'foreground',
        command,
        cwd: execCwd,
        exit_code: code,
        stdout: trimCommandOutput(stdout),
        stderr: trimCommandOutput(stderr),
        error: code === 0 ? null : `command exited with code ${code}`,
        hint: code === 0 ? 'Command completed successfully.' : (failureHint || 'Inspect stderr/stdout before retrying or changing the command.'),
      }))
    })

    child.on('error', (err) => {
      if (timedOut) return
      finish(toolJson({
        ok: false,
        tool: 'exec_command',
        mode: 'foreground',
        command,
        cwd: execCwd,
        stdout: trimCommandOutput(stdout),
        stderr: trimCommandOutput(stderr),
        error: err.message,
      }))
    })
  })
}

// kill_process：停止后台进程（通过 PID）
export async function execKillProcess(args) {
  const pid = Number(args.pid)
  if (!pid) return toolJson({ ok: false, tool: 'kill_process', error: 'missing pid' })
  const entry = bgProcesses.get(pid)
  if (!entry) return toolJson({ ok: false, tool: 'kill_process', pid, error: 'process not found or already cleaned up' })
  if (entry.status === 'exited') {
    return toolJson({
      ok: true,
      tool: 'kill_process',
      pid,
      command: entry.command,
      stopped: false,
      already_exited: true,
      exit_code: entry.exitCode,
    })
  }
  // 不在此处删除：terminate 会触发 child 的 exit 事件，由 registerBackgroundProcess
  // 统一标记为 exited 并延时清理，模型仍可在保留期内查到最终状态。
  const stopped = terminateProcessTree(entry.process, pid)
  return toolJson({
    ok: stopped.ok,
    tool: 'kill_process',
    pid,
    command: entry.command,
    stopped: stopped.ok,
    error: stopped.ok ? null : stopped.error,
  })
}

// list_processes：列出当前后台进程，包含最近输出行
export async function execListProcesses(args = {}) {
  const tailLines = Math.min(Number(args.tail) || 20, BG_OUTPUT_MAX_LINES)
  const processes = [...bgProcesses.entries()].map(([pid, e]) => ({
    pid,
    command: e.command,
    cwd: e.cwd,
    status: e.status,
    exit_code: e.exitCode,
    started_at: e.startedAt,
    exited_at: e.exitedAt,
    recent_output: e.outputLines.slice(-tailLines).map(({ stream, text, ts }) => ({ stream, text, ts })),
  }))
  return toolJson({
    ok: true,
    tool: 'list_processes',
    count: processes.length,
    processes,
  })
}
