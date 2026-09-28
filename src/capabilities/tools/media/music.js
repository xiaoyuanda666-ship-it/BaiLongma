import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import {
  upsertMusicTrack,
  getMusicTrack,
  searchMusicLibrary,
  listMusicLibrary,
  updateMusicLrc,
  deleteMusicTrack as dbDeleteMusicTrack,
} from '../../../db.js'
import { emitEvent } from '../../../runtime/events.js'
import { paths } from '../../../paths.js'
import { SANDBOX_ROOT } from '../../sandbox.js'

const IS_WIN = process.platform === 'win32'

const MUSIC_AUDIO_EXTS = new Set(['.mp3', '.flac', '.wav', '.aac', '.ogg', '.m4a', '.opus'])

async function fetchLrcFromNet(title, artist) {
  const headers = { 'User-Agent': 'BaiLongma/1.0' }
  // 策略1：精确匹配（title + artist）
  try {
    const params = new URLSearchParams({ track_name: title })
    if (artist) params.set('artist_name', artist)
    const res = await fetch(`https://lrclib.net/api/get?${params}`, {
      signal: AbortSignal.timeout(8000), headers,
    })
    if (res.ok) {
      const data = await res.json()
      const lrc = data.syncedLyrics || data.plainLyrics || null
      if (lrc) return lrc
    }
  } catch {}
  // 策略2：仅 title 关键词搜索，取第一条结果
  try {
    const params = new URLSearchParams({ q: title })
    const res = await fetch(`https://lrclib.net/api/search?${params}`, {
      signal: AbortSignal.timeout(8000), headers,
    })
    if (res.ok) {
      const list = await res.json()
      if (Array.isArray(list) && list.length > 0) {
        const hit = list[0]
        return hit.syncedLyrics || hit.plainLyrics || null
      }
    }
  } catch {}
  return null
}

function decodeProcessOutput(chunks) {
  const buffer = Buffer.concat(chunks)
  if (buffer.length === 0) return ''

  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buffer)
  if (!utf8.includes('\uFFFD') || !IS_WIN) return utf8

  try {
    return new TextDecoder('gb18030', { fatal: false }).decode(buffer)
  } catch {
    return utf8
  }
}

function runProcess(file, args = [], cwd, options = {}) {
  const timeoutMs = Number(options.timeoutMs) || 120000
  return new Promise((resolve) => {
    const stdoutChunks = []
    const stderrChunks = []
    let child = null
    let settled = false
    let timer = null

    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }

    try {
      child = spawn(file, args, {
        cwd: cwd || paths.musicDir,
        windowsHide: true,
        shell: IS_WIN && /\.(cmd|bat)$/i.test(file),
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
        },
      })
    } catch (err) {
      finish({ code: -1, stdout: '', stderr: err.message })
      return
    }

    timer = setTimeout(() => {
      try { child.kill() } catch {}
      finish({
        code: -1,
        stdout: decodeProcessOutput(stdoutChunks),
        stderr: `process timed out after ${timeoutMs}ms`,
      })
    }, timeoutMs)

    child.stdout?.on('data', d => { stdoutChunks.push(Buffer.from(d)) })
    child.stderr?.on('data', d => { stderrChunks.push(Buffer.from(d)) })
    child.on('close', code => finish({
      code,
      stdout: decodeProcessOutput(stdoutChunks),
      stderr: decodeProcessOutput(stderrChunks),
    }))
    child.on('error', err => finish({
      code: -1,
      stdout: decodeProcessOutput(stdoutChunks),
      stderr: err.message,
    }))
  })
}

const YTDLP_LOCAL = path.join(paths.musicDir, 'yt-dlp.exe')
const YTDLP_URL   = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
// 国内裸连 GitHub release 经常超时/失败，准备几个镜像兜底（按序尝试）。
const YTDLP_DOWNLOAD_SOURCES = [
  YTDLP_URL,
  `https://gh-proxy.com/${YTDLP_URL}`,
  `https://ghfast.top/${YTDLP_URL}`,
]

function splitNonEmptyLines(text) {
  return String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
}

function compactProcessError(result) {
  const lines = splitNonEmptyLines(`${result?.stderr || ''}\n${result?.stdout || ''}`)
  return (lines.slice(-8).join(' | ') || `exit code ${result?.code ?? 'unknown'}`).slice(0, 700)
}

function normalizeYtDlpCommand(spec, version = '') {
  return {
    file: spec.file,
    argsPrefix: Array.isArray(spec.argsPrefix) ? spec.argsPrefix : [],
    label: spec.label || [spec.file, ...(spec.argsPrefix || [])].join(' '),
    local: Boolean(spec.local),
    version: String(version || '').trim(),
  }
}

function ytdlpCommandKey(command) {
  return `${command.file}\0${(command.argsPrefix || []).join('\0')}`
}

async function probeYtDlpCommand(spec) {
  const result = await runProcess(spec.file, [...(spec.argsPrefix || []), '--version'], paths.musicDir, { timeoutMs: 15000 })
  if (result.code !== 0) return null
  const version = splitNonEmptyLines(result.stdout)[0] || splitNonEmptyLines(result.stderr)[0] || ''
  return normalizeYtDlpCommand(spec, version)
}

function runYtDlp(command, args = [], options = {}) {
  return runProcess(command.file, [...(command.argsPrefix || []), ...args], paths.musicDir, options)
}

async function downloadLocalYtDlp() {
  emitEvent('action', { tool: 'music', summary: 'yt-dlp 未安装或不可用，正在准备本地副本', detail: YTDLP_URL })

  for (const src of YTDLP_DOWNLOAD_SOURCES) {
    try {
      const res = await fetch(src, { signal: AbortSignal.timeout(60000) })
      if (!res.ok) continue
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length < 1_000_000) continue
      const tmp = `${YTDLP_LOCAL}.download`
      fs.writeFileSync(tmp, buf)
      fs.renameSync(tmp, YTDLP_LOCAL)
      try { fs.chmodSync(YTDLP_LOCAL, 0o755) } catch {}
      const local = await probeYtDlpCommand({ file: YTDLP_LOCAL, label: 'local yt-dlp.exe', local: true })
      if (local) return local
    } catch {}
  }
  return null
}

async function resolveYtDlpCommands({ forceLocalRefresh = false } = {}) {
  const specs = []
  if (fs.existsSync(YTDLP_LOCAL) && !forceLocalRefresh) {
    specs.push({ file: YTDLP_LOCAL, label: 'local yt-dlp.exe', local: true })
  }
  specs.push({ file: 'yt-dlp', label: 'PATH yt-dlp' })
  if (IS_WIN) {
    specs.push({ file: 'yt-dlp.exe', label: 'PATH yt-dlp.exe' })
    specs.push({ file: 'yt-dlp.cmd', label: 'PATH yt-dlp.cmd' })
    specs.push({ file: 'yt-dlp.bat', label: 'PATH yt-dlp.bat' })
  }
  specs.push({ file: 'python', argsPrefix: ['-m', 'yt_dlp'], label: 'python -m yt_dlp' })
  if (IS_WIN) specs.push({ file: 'py', argsPrefix: ['-m', 'yt_dlp'], label: 'py -m yt_dlp' })

  const commands = []
  const seen = new Set()
  for (const spec of specs) {
    const command = await probeYtDlpCommand(spec)
    if (!command) continue
    const key = ytdlpCommandKey(command)
    if (seen.has(key)) continue
    seen.add(key)
    commands.push(command)
  }

  if (forceLocalRefresh || commands.length === 0) {
    const local = await downloadLocalYtDlp()
    if (local && !seen.has(ytdlpCommandKey(local))) commands.push(local)
  }

  return commands.sort((a, b) => {
    const versionCmp = String(b.version).localeCompare(String(a.version))
    if (versionCmp) return versionCmp
    return Number(b.local) - Number(a.local)
  })
}

function shouldRefreshYtDlp(failures) {
  const text = failures.map(f => f.error || '').join('\n')
  return /HTTP Error 412|Precondition Failed|Unable to download JSON metadata|signature|nsig|Unsupported URL|Sign in to confirm/i.test(text)
}

function uniqueStrings(values) {
  const out = []
  const seen = new Set()
  for (const value of values) {
    const s = String(value || '').trim()
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

function applyKnownMusicAliases(query) {
  let q = String(query || '').trim()
  q = q.replace(/肖斯塔科维奇|蕭士塔高維契|萧斯塔科维奇|老肖/gi, 'Shostakovich')
  q = q.replace(/第二圆舞曲|第二圓舞曲|圆舞曲二号|圓舞曲二號/gi, 'Waltz No 2')
  return q
}

function buildMusicQueryVariants(query) {
  const raw = String(query || '').trim()
  const aliased = applyKnownMusicAliases(raw)
  const variants = [raw, aliased]
  if (/Waltz\s*No\.?\s*2|第二[圆圓]舞曲/i.test(raw)) {
    variants.push('Shostakovich Waltz No 2', 'Dmitri Shostakovich Waltz No. 2')
  }
  return uniqueStrings(variants)
}

function inferTrackMetaFromFile(filePath) {
  const ext = path.extname(filePath)
  const base = path.basename(filePath, ext).trim()
  const parts = base.split(/\s+-\s+/).map(p => p.trim()).filter(Boolean)
  if (parts.length >= 2) {
    return { artist: parts[0], title: parts.slice(1).join(' - ') }
  }
  return { artist: '', title: base }
}

function scanMusicDirIntoLibrary(musicDir) {
  const added = []
  let entries = []
  try {
    entries = fs.readdirSync(musicDir, { withFileTypes: true })
  } catch {
    return added
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const ext = path.extname(entry.name).toLowerCase()
    if (!MUSIC_AUDIO_EXTS.has(ext)) continue
    const filePath = path.join(musicDir, entry.name)
    const meta = inferTrackMetaFromFile(filePath)
    const track = upsertMusicTrack({ title: meta.title, artist: meta.artist, filePath })
    added.push({ id: track.id, title: track.title, artist: track.artist, file_path: track.file_path })
  }
  return added
}

function searchMusicLibraryVariants(query, limit = 20) {
  const rows = []
  const seen = new Set()
  for (const variant of buildMusicQueryVariants(query)) {
    for (const row of searchMusicLibrary(variant, limit)) {
      const key = row.file_path || row.id
      if (seen.has(key)) continue
      seen.add(key)
      rows.push(row)
      if (rows.length >= limit) return rows
    }
  }
  return rows
}

async function fetchYoutubeWatchUrls(query) {
  try {
    const params = new URLSearchParams({ search_query: query })
    const res = await fetch(`https://www.youtube.com/results?${params}`, {
      signal: AbortSignal.timeout(12000),
      headers: {
        'User-Agent': 'Mozilla/5.0 BaiLongma/1.0',
        'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
      },
    })
    if (!res.ok) return []
    const html = await res.text()
    const ids = []
    for (const match of html.matchAll(/(?:watch\?v=|\"videoId\":\"|%2Fwatch%3Fv%3D)([A-Za-z0-9_-]{11})/g)) {
      ids.push(match[1])
      if (ids.length >= 8) break
    }
    return uniqueStrings(ids).slice(0, 3).map(id => `https://www.youtube.com/watch?v=${id}`)
  } catch {
    return []
  }
}

async function fetchBilibiliVideoUrls(query) {
  try {
    const params = new URLSearchParams({ search_type: 'video', keyword: query })
    const res = await fetch(`https://api.bilibili.com/x/web-interface/search/type?${params}`, {
      signal: AbortSignal.timeout(12000),
      headers: {
        'User-Agent': 'Mozilla/5.0 BaiLongma/1.0',
        Referer: 'https://search.bilibili.com/',
      },
    })
    if (!res.ok) return []
    const data = await res.json()
    const rows = Array.isArray(data?.data?.result) ? data.data.result : []
    const urls = []
    for (const row of rows) {
      if (row?.bvid) urls.push(`https://www.bilibili.com/video/${row.bvid}`)
      else if (row?.arcurl) urls.push(String(row.arcurl).replace(/^http:/, 'https:'))
      if (urls.length >= 3) break
    }
    return uniqueStrings(urls)
  } catch {
    return []
  }
}

async function buildMusicDownloadTargets(query, platform) {
  const variants = buildMusicQueryVariants(query)
  const primaryQuery = variants[0] || query
  const aliasedQuery = variants[1] || primaryQuery
  const [youtubeDirect, biliDirect] = await Promise.all([
    fetchYoutubeWatchUrls(aliasedQuery),
    fetchBilibiliVideoUrls(aliasedQuery),
  ])
  const youtubeSearch = variants.map(q => `ytsearch1:${q}`)
  const biliSearch = variants.map(q => `bilisearch1:${q}`)

  const groups = platform === 'bilibili'
    ? [biliDirect, biliSearch, youtubeDirect, youtubeSearch]
    : [youtubeDirect, youtubeSearch, biliDirect, biliSearch]
  return uniqueStrings(groups.flat())
}

async function tryYtDlpDownload(commands, targets, dlArgs) {
  const failures = []
  for (const command of commands) {
    for (const target of targets) {
      emitEvent('action', { tool: 'music', summary: `正在尝试下载：${command.label}`, detail: String(target).slice(0, 120) })
      let result = await runYtDlp(command, [...dlArgs, target], { timeoutMs: 180000 })
      if (result.code !== 0 && /ssl|EOF occurred in violation of protocol/i.test(result.stderr)) {
        result = await runYtDlp(command, [...dlArgs, '--no-check-certificates', target], { timeoutMs: 180000 })
      }
      if (result.code === 0) return { ok: true, result, command, target, failures }
      failures.push({ command: command.label, target, error: compactProcessError(result) })
    }
  }
  return { ok: false, failures }
}

export async function execMusic(args = {}) {
  const action = String(args.action || 'list').trim()
  const musicDir = paths.musicDir

  // ── list ──────────────────────────────────────────────────────────────────
  if (action === 'list') {
    const rows = listMusicLibrary(Number(args.limit) || 50)
    return JSON.stringify({ ok: true, count: rows.length, tracks: rows })
  }

  // ── search ────────────────────────────────────────────────────────────────
  if (action === 'search') {
    const q = String(args.query || '').trim()
    if (!q) return JSON.stringify({ ok: false, error: 'query required' })
    const limit = Number(args.limit) || 20
    let rows = searchMusicLibraryVariants(q, limit)
    let scanned = 0
    if (!rows.length) {
      scanned = scanMusicDirIntoLibrary(musicDir).length
      rows = searchMusicLibraryVariants(q, limit)
    }
    return JSON.stringify({ ok: true, count: rows.length, tracks: rows, scanned })
  }

  // ── scan ──────────────────────────────────────────────────────────────────
  if (action === 'scan') {
    const added = scanMusicDirIntoLibrary(musicDir)
    return JSON.stringify({ ok: true, scanned: added.length, tracks: added })
  }

  // ── add ───────────────────────────────────────────────────────────────────
  if (action === 'add') {
    const filePath = String(args.path || '').trim()
    if (!filePath) return JSON.stringify({ ok: false, error: 'path required' })
    if (!fs.existsSync(filePath)) return JSON.stringify({ ok: false, error: `file not found: ${filePath}` })
    const ext = path.extname(filePath).toLowerCase()
    if (!MUSIC_AUDIO_EXTS.has(ext)) return JSON.stringify({ ok: false, error: `unsupported format: ${ext}` })
    const meta = inferTrackMetaFromFile(filePath)
    const track = upsertMusicTrack({
      title: String(args.title || meta.title),
      artist: String(args.artist || meta.artist || ''),
      album: String(args.album || ''),
      filePath,
    })
    return JSON.stringify({ ok: true, track })
  }

  // ── download ──────────────────────────────────────────────────────────────
  if (action === 'download') {
    // 自动解析 yt-dlp 路径（没有则自动下载）
    const url = String(args.url || '').trim()
    // query 兜底：没有明确 URL 时，用关键词让 yt-dlp 自己搜索并下载第一条，
    // 这样 agent 不必凭空找/猜一个真实视频 URL（这是放歌失败的主因）。
    const query = String(args.query || '').trim()
      || [String(args.title || '').trim(), String(args.artist || '').trim()].filter(Boolean).join(' ')

    if (!url && query) {
      let existing = searchMusicLibraryVariants(query, 1)
      if (!existing.length) {
        scanMusicDirIntoLibrary(musicDir)
        existing = searchMusicLibraryVariants(query, 1)
      }
      const track = existing.find(row => row?.file_path && fs.existsSync(row.file_path))
      if (track) return JSON.stringify({ ok: true, track, reused: true, lrc_fetched: Boolean(track.lrc) })
    }

    const ytdlpCommands = await resolveYtDlpCommands()
    if (!ytdlpCommands.length) {
      return JSON.stringify({ ok: false, error: 'yt-dlp 不可用：本机未找到可执行版本，且本地副本自动准备失败。请检查网络，或手动把 yt-dlp.exe 放到 music 目录。' })
    }

    // 构造按序尝试的下载目标：
    //  - 有明确 URL → 只用它
    //  - 否则用关键词搜索：按 platform 选搜索源，另一平台自动兜底
    const platform = String(args.platform || '').trim().toLowerCase()
    let targets = []
    if (url) {
      targets = [url]
    } else if (query) {
      targets = await buildMusicDownloadTargets(query, platform)
    } else {
      return JSON.stringify({ ok: false, error: 'download 需要 url 或 query（歌名/歌手），至少给一个' })
    }
    if (!targets.length) return JSON.stringify({ ok: false, error: '没有找到可尝试的音乐下载目标' })

    // 文件命名：Agent 传了 title 就用干净标题命名。query 直下时 yt-dlp 默认用
    // 视频标题（一长串脏名），用 title/artist 命名既好看，定位文件也更稳。
    const wantArtist = String(args.artist || '').trim()
    const wantTitle = String(args.title || '').trim()
    const niceName = wantTitle
      ? (wantArtist ? `${wantArtist} - ${wantTitle}` : wantTitle)
          .replace(/[\\/:*?"<>|\x00-\x1f]/g, '').trim().slice(0, 100)
      : ''

    // Download: print final filepath after conversion
    const outTemplate = (niceName
      ? path.join(musicDir, `${niceName}.%(ext)s`)
      : path.join(musicDir, '%(title)s.%(ext)s')
    ).replace(/\\/g, '/')
    const dlArgs = ['-x', '--audio-format', 'mp3', '--audio-quality', '192K', '--no-playlist', '--print', 'after_move:filepath', '-o', outTemplate]

    // 下载同步阻塞 30s–2min，先 emit 一条进度 action，让用户在界面看到“正在下载”，
    // 而不是面对一段静默以为卡死。
    emitEvent('action', { tool: 'music', summary: `正在下载歌曲：${niceName || query || url}`, detail: '' })

    const downloadStartedAt = Date.now()
    let attempt = await tryYtDlpDownload(ytdlpCommands, targets, dlArgs)
    if (!attempt.ok && shouldRefreshYtDlp(attempt.failures)) {
      const refreshed = await resolveYtDlpCommands({ forceLocalRefresh: true })
      if (refreshed.length) {
        attempt = await tryYtDlpDownload(refreshed, targets, dlArgs)
      }
    }

    if (!attempt.ok) {
      const lastErr = attempt.failures.slice(-3).map(f => `${f.command} ${f.target}: ${f.error}`).join(' || ')
      return JSON.stringify({
        ok: false,
        error: `yt-dlp failed: ${lastErr.slice(0, 700)}`,
        attempts: attempt.failures.slice(-5),
      })
    }

    const { result } = attempt

    // Parse output filepath (last non-empty line)
    const lines = result.stdout.trim().split('\n').map(l => l.trim()).filter(Boolean)
    let filePath = lines[lines.length - 1] || ''

    // Fallback: scan for newest mp3 in musicDir
    if (!filePath || !fs.existsSync(filePath)) {
      const files = fs.readdirSync(musicDir)
        .filter(f => f.toLowerCase().endsWith('.mp3'))
        .map(f => ({ f, mt: fs.statSync(path.join(musicDir, f)).mtimeMs }))
        .filter(x => x.mt >= downloadStartedAt - 15000)
        .sort((a, b) => b.mt - a.mt)
      if (files.length) filePath = path.join(musicDir, files[0].f)
    }

    if (!filePath || !fs.existsSync(filePath)) {
      return JSON.stringify({ ok: false, error: 'Download completed but could not locate output file' })
    }

    const meta = inferTrackMetaFromFile(filePath)
    const title  = String(args.title  || meta.title)
    const artist = String(args.artist || meta.artist || '')

    // Auto-fetch lyrics
    let lrc = ''
    if (title) {
      lrc = await fetchLrcFromNet(title, artist) || ''
    }

    const track = upsertMusicTrack({ title, artist, album: String(args.album || ''), filePath, lrc, sourceUrl: url || query })
    return JSON.stringify({ ok: true, track, lrc_fetched: Boolean(lrc), source: attempt.target, downloader: attempt.command?.label })
  }

  // ── get_lyrics ────────────────────────────────────────────────────────────
  if (action === 'get_lyrics') {
    const id = Number(args.id)
    let title  = String(args.title  || '').trim()
    let artist = String(args.artist || '').trim()

    if (id) {
      const track = getMusicTrack(id)
      if (!track) return JSON.stringify({ ok: false, error: `track id=${id} not found` })
      if (!title)  title  = track.title
      if (!artist) artist = track.artist
    }
    if (!title) return JSON.stringify({ ok: false, error: 'title required' })

    const lrc = await fetchLrcFromNet(title, artist)
    if (!lrc) return JSON.stringify({ ok: true, id: id || null, title, artist, lrc: null, hint: 'lyrics not found on lrclib.net' })

    if (id) updateMusicLrc(id, lrc)
    return JSON.stringify({ ok: true, id: id || null, title, artist, lrc_length: lrc.length, lrc })
  }

  // ── delete ────────────────────────────────────────────────────────────────
  if (action === 'delete') {
    const id = Number(args.id)
    if (!id) return JSON.stringify({ ok: false, error: 'id required' })
    const track = getMusicTrack(id)
    if (!track) return JSON.stringify({ ok: false, error: `track id=${id} not found` })
    dbDeleteMusicTrack(id)
    return JSON.stringify({ ok: true, deleted: { id, title: track.title } })
  }

  return JSON.stringify({ ok: false, error: `unknown action: ${action}` })
}
