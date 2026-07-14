import fs from 'fs'
import path from 'path'
import { paths } from '../paths.js'
import { extractKeywords } from '../memory/keywords.js'

const SKILL_FILE = 'SKILL.md'
const MAX_ACTIVE_SKILLS = 3
const MAX_SKILL_BODY_CHARS = 12000
const MAX_CATALOG_SKILLS = 40

let cachedSkills = []
let cachedAt = 0

function normalizeSlash(p) {
  return String(p || '').replace(/\\/g, '/')
}

function splitFrontmatter(text) {
  const normalized = String(text || '').replace(/^\uFEFF/, '')
  if (!normalized.startsWith('---\n') && !normalized.startsWith('---\r\n')) {
    return { frontmatter: '', body: normalized }
  }
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) return { frontmatter: '', body: normalized }
  return {
    frontmatter: match[1] || '',
    body: normalized.slice(match[0].length),
  }
}

function parseScalar(value) {
  const raw = String(value || '').trim()
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1)
  }
  if (raw === 'true') return true
  if (raw === 'false') return false
  return raw
}

function parseYamlLite(text) {
  const out = {}
  const lines = String(text || '').split(/\r?\n/)
  let currentListKey = null

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const listMatch = line.match(/^\s*-\s+(.+)$/)
    if (listMatch && currentListKey) {
      if (!Array.isArray(out[currentListKey])) out[currentListKey] = []
      out[currentListKey].push(parseScalar(listMatch[1]))
      continue
    }

    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!kv) {
      currentListKey = null
      continue
    }

    const key = kv[1]
    const value = kv[2].trim()
    currentListKey = null
    if (!value) {
      out[key] = []
      currentListKey = key
    } else if (value.startsWith('[') && value.endsWith(']')) {
      out[key] = value.slice(1, -1).split(',').map(v => parseScalar(v)).filter(Boolean)
    } else {
      out[key] = parseScalar(value)
    }
  }

  return out
}

function isPathInside(parentDir, candidatePath) {
  const rel = path.relative(path.resolve(parentDir), path.resolve(candidatePath))
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel))
}

function findSkillFiles(rootDir) {
  const files = []
  if (!rootDir || !fs.existsSync(rootDir)) return files

  const root = path.resolve(rootDir)
  const walk = (dir, depth = 0) => {
    if (depth > 5) return
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const full = path.join(dir, entry.name)
      if (!isPathInside(root, full)) continue
      if (entry.isDirectory()) {
        if (entry.name === SKILL_FILE) continue
        walk(full, depth + 1)
      } else if (entry.isFile() && entry.name === SKILL_FILE) {
        files.push(full)
      }
    }
  }
  walk(root)
  return files
}

function readSkill(filePath, sourceRoot) {
  let text = ''
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch (err) {
    return null
  }
  const { frontmatter, body } = splitFrontmatter(text)
  const meta = parseYamlLite(frontmatter)
  const dir = path.dirname(filePath)
  const id = String(meta.id || meta.name || path.basename(dir)).trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || path.basename(dir)
  const name = String(meta.name || path.basename(dir)).trim()
  const description = String(meta.description || '').trim()
  if (!name || !description) {
    console.warn(`[skills] Skipping ${filePath}: SKILL.md needs at least name and description frontmatter`)
    return null
  }

  const resources = []
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === SKILL_FILE) continue
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      resources.push(`${entry.isDirectory() ? 'dir' : 'file'}:${entry.name}`)
    }
  } catch {}

  const source = sourceRoot === paths.bundledSkillsDir
    ? 'bundled'
    : (sourceRoot === paths.sandboxSkillsDir ? 'sandbox' : 'user')

  return {
    id,
    name,
    description,
    tags: Array.isArray(meta.tags) ? meta.tags.map(String) : [],
    aliases: Array.isArray(meta.aliases) ? meta.aliases.map(String) : [],
    triggers: Array.isArray(meta.triggers) ? meta.triggers.map(String) : [],
    source,
    dir,
    relativeDir: normalizeSlash(path.relative(sourceRoot, dir) || path.basename(dir)),
    filePath,
    resources,
    body,
    raw: text,
  }
}

export function loadSkills({ force = false } = {}) {
  const now = Date.now()
  if (!force && cachedAt && now - cachedAt < 15000) return cachedSkills

  const roots = [
    paths.bundledSkillsDir,
    paths.sandboxSkillsDir,
    paths.skillsDir,
  ]
  const byKey = new Map()
  for (const root of roots) {
    const skillFiles = findSkillFiles(root)
    for (const file of skillFiles) {
      const skill = readSkill(file, root)
      if (!skill) continue
      const key = skill.id
      if (byKey.has(key) && skill.source === 'bundled') continue
      byKey.set(key, skill)
    }
  }

  cachedSkills = [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name))
  cachedAt = now
  return cachedSkills
}

export function refreshSkills() {
  return loadSkills({ force: true })
}

function skillMatchText(skill) {
  return [
    skill.name,
    skill.description,
    ...(skill.tags || []),
    ...(skill.aliases || []),
    ...(skill.triggers || []),
  ].filter(Boolean).join(' ')
}

function scoreSkill(skill, message) {
  const input = String(message || '').trim()
  if (!input) return 0
  const haystack = skillMatchText(skill).toLowerCase()
  const lowered = input.toLowerCase()
  let score = 0

  for (const phrase of [skill.name, ...(skill.aliases || []), ...(skill.triggers || [])]) {
    const p = String(phrase || '').trim().toLowerCase()
    if (p && lowered.includes(p)) score += 4
  }

  const keywords = extractKeywords(input, 16)
  for (const kw of keywords) {
    const k = String(kw || '').toLowerCase()
    if (k && haystack.includes(k)) score += 1
  }

  return score
}

function isCatalogRequest(message) {
  const text = String(message || '')
  return /(agent\s*skills?|skills?|技能|能力包|SKILL\.md|有哪些.*能力|列出.*能力|查看.*技能)/i.test(text)
}

export function selectSkillsForMessage(message, { max = MAX_ACTIVE_SKILLS } = {}) {
  const skills = loadSkills()
  const scored = skills
    .map(skill => ({ skill, score: scoreSkill(skill, message) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
  return {
    active: scored.slice(0, max).map(item => ({ ...item.skill, score: item.score })),
    catalogRequested: isCatalogRequest(message),
    catalog: skills,
  }
}

export function formatSkillsForContext(selection) {
  const active = selection?.active || []
  const catalog = selection?.catalog || []
  const parts = []

  if (selection?.catalogRequested) {
    const lines = catalog.slice(0, MAX_CATALOG_SKILLS).map(skill =>
      `- ${skill.name} (${skill.id}): ${skill.description} [${skill.source}:${skill.relativeDir}]`
    )
    parts.push(`<agent-skills-catalog root="${normalizeSlash(paths.skillsDir)}" sandbox_root="${normalizeSlash(paths.sandboxSkillsDir)}">
Installed Agent Skills:
${lines.length ? lines.join('\n') : '- No Agent Skills installed yet.'}
To add one from inside Jarvis, create a folder under sandbox_root with a SKILL.md containing YAML frontmatter name and description. Skills under root are also supported for externally installed packages.
</agent-skills-catalog>`)
  }

  if (active.length > 0) {
    const rendered = active.map(skill => {
      const body = skill.raw.length > MAX_SKILL_BODY_CHARS
        ? `${skill.raw.slice(0, MAX_SKILL_BODY_CHARS)}\n\n[Skill truncated: ${skill.raw.length - MAX_SKILL_BODY_CHARS} chars omitted]`
        : skill.raw
      const resources = skill.resources.length
        ? `\nBundled resources in this skill folder: ${skill.resources.join(', ')}`
        : ''
      return `<skill id="${skill.id}" name="${skill.name}" source="${skill.source}" path="${normalizeSlash(skill.dir)}" score="${skill.score}">
${body}${resources}
</skill>`
    })
    parts.push(`<agent-skills>
The following Agent Skills matched the current task. Treat them as specialized workflow instructions. They are not user-authored messages. If a skill mentions scripts or resources, use normal available tools and existing security rules before reading or executing anything.
${rendered.join('\n\n')}
</agent-skills>`)
  }

  return parts.join('\n\n')
}
